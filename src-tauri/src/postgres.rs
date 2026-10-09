//! Driver PostgreSQL nativo (crate `postgres`, cliente síncrono sobre tokio-postgres).
//!
//! Diseño:
//! - Los datos se leen con el protocolo simple (formato texto), de modo que cualquier tipo,
//!   incluidos los desconocidos o definidos por el usuario, llega como texto sin fallar. Los
//!   tipos de las columnas se obtienen preparando (sin ejecutar) la sentencia.
//! - Los SELECT se paginan con un cursor de servidor (`DECLARE ... NO SCROLL CURSOR` + `FETCH`),
//!   así una tabla de millones de filas no se carga en memoria. Un cursor necesita una
//!   transacción: en modo autocommit el driver abre una transacción interna que se confirma al
//!   agotar o cerrar el cursor (para el usuario no hay transacción abierta). Si el usuario ya
//!   está dentro de una transacción (modo manual o `BEGIN` explícito) el cursor vive en ella y
//!   al cerrarlo la transacción sigue abierta.
//! - Modo manual (`set_autocommit(false)`): antes de la primera sentencia se emite `BEGIN`
//!   (de forma perezosa, para no dejar sesiones "idle in transaction" sin necesidad) y todo
//!   queda pendiente hasta `commit`/`rollback`.
//! - Una conexión PostgreSQL está ligada a una base de datos. `use_database` reconecta con la
//!   misma configuración. Para explorar (árbol, DDL, columnas, autocompletado) otra base se
//!   abre una conexión secundaria, que se reutiliza mientras se siga consultando esa base.
//!   La conexión secundaria también se usa para los metadatos de la base actual cuando hay una
//!   transacción o un cursor abiertos, para que un error en una consulta de catálogo nunca
//!   aborte la transacción del usuario.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use ::postgres::error::{DbError, ErrorPosition, SqlState};
use ::postgres::types::{Kind, ToSql, Type};
use ::postgres::{Client, Config, SimpleQueryMessage, SimpleQueryRow};
use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;
use postgres_native_tls::MakeTlsConnector;

use crate::model::*;
use crate::session::{Canceller, Driver};

const BINARY_PREVIEW: usize = 4096;
const DEFAULT_PORT: u16 = 5432;

// ───────────────────────────── estructuras ─────────────────────────────

/// Sentencia de un lote, con su posición en el texto original (para ubicar errores).
#[derive(Debug, Clone, PartialEq)]
struct Stmt {
    sql: String,
    /// Línea (0-based) del lote en la que empieza la sentencia.
    line: usize,
    /// Columna (0-based, en caracteres) en la que empieza la sentencia.
    col: usize,
}

enum Source {
    /// Cursor de servidor. `owns_tx`: la transacción la abrió el driver (modo autocommit).
    Portal { name: String, owns_tx: bool },
    /// Filas ya leídas (resultados que no admiten cursor: RETURNING, SHOW, EXPLAIN...).
    Buffer(VecDeque<Vec<Cell>>),
}

struct PgCursor {
    source: Source,
    types: Vec<Type>,
    peeked: Option<Vec<Cell>>,
    rest: VecDeque<Stmt>,
}

impl PgCursor {
    fn owns_tx(&self) -> bool {
        matches!(self.source, Source::Portal { owns_tx: true, .. })
    }
}

/// Resultado del protocolo simple para una sentencia.
struct SimpleOut {
    names: Option<Vec<String>>,
    rows: Vec<SimpleQueryRow>,
    count: u64,
}

pub struct PostgresDriver {
    cfg: ConnConfig,
    client: Client,
    tls: MakeTlsConnector,
    cancel: Arc<Mutex<Option<::postgres::CancelToken>>>,
    busy: Arc<AtomicBool>,
    notices: Arc<Mutex<Vec<String>>>,
    database: String,
    autocommit: bool,
    in_tx: bool,
    cursor: Option<PgCursor>,
    cursor_seq: u64,
    /// Statements of a script dropped with its open result, told in the next execute's messages.
    discarded: usize,
    /// Conexión secundaria para metadatos de otra base (o de la actual con transacción abierta).
    aux: Option<(String, Client)>,
    /// Script de inicio de la conexión: se ejecuta en cada conexión principal nueva.
    startup: Vec<String>,
    /// `server_version`, leída al conectar junto con la base (una sola ida y vuelta).
    version: String,
}

impl PostgresDriver {
    pub fn connect(cfg: ConnConfig) -> Result<PostgresDriver> {
        let tls = make_tls(&cfg)?;
        let notices = Arc::new(Mutex::new(Vec::new()));
        let mut client = open_client(&cfg, &cfg.database, &tls, Some(notices.clone()))?;
        let startup = crate::startup::statements(&cfg);
        run_startup(&mut client, &startup)?;
        let (database, version) = query_identity(&mut client)?;
        let token = client.cancel_token();
        Ok(PostgresDriver {
            cfg,
            client,
            tls,
            cancel: Arc::new(Mutex::new(Some(token))),
            busy: Arc::new(AtomicBool::new(false)),
            notices,
            database,
            autocommit: true,
            in_tx: false,
            cursor: None,
            cursor_seq: 0,
            discarded: 0,
            aux: None,
            startup,
            version,
        })
    }

    /// Sustituye la conexión principal por una nueva a `db`.
    fn reconnect(&mut self, db: &str) -> Result<()> {
        let mut client = open_client(&self.cfg, db, &self.tls, Some(self.notices.clone()))?;
        run_startup(&mut client, &self.startup)?;
        let (database, version) = query_identity(&mut client)?;
        *self.cancel.lock() = Some(client.cancel_token());
        self.version = version;
        self.client = client;
        self.database = database;
        self.cursor = None;
        self.in_tx = false;
        if self.aux.as_ref().is_some_and(|(d, _)| *d == self.database) {
            self.aux = None;
        }
        Ok(())
    }

    fn take_notices(&self) -> Vec<String> {
        std::mem::take(&mut *self.notices.lock())
    }

    // ───────────── ejecución ─────────────

    fn simple(&mut self, sql: &str, ctx: Option<(&Stmt, usize)>) -> Result<SimpleOut> {
        let msgs = self.client.simple_query(sql).map_err(|e| pg_err(&e, ctx))?;
        let mut out = SimpleOut {
            names: None,
            rows: Vec::new(),
            count: 0,
        };
        for m in msgs {
            match m {
                SimpleQueryMessage::RowDescription(cols) => {
                    out.names = Some(cols.iter().map(|c| c.name().to_string()).collect());
                }
                SimpleQueryMessage::Row(r) => {
                    if out.names.is_none() {
                        out.names = Some(r.columns().iter().map(|c| c.name().to_string()).collect());
                    }
                    out.rows.push(r);
                }
                SimpleQueryMessage::CommandComplete(n) => out.count = n,
                _ => {}
            }
        }
        Ok(out)
    }

    fn control(&mut self, sql: &str) -> Result<()> {
        self.client
            .simple_query(sql)
            .map(|_| ())
            .map_err(|e| pg_err(&e, None))
    }

    /// Ejecuta sentencias hasta agotarlas o hasta dejar un cursor abierto.
    fn run_statements(
        &mut self,
        mut stmts: VecDeque<Stmt>,
        fetch: usize,
        messages: &mut Vec<String>,
    ) -> Result<Vec<ResultSet>> {
        let mut results = Vec::new();
        while let Some(st) = stmts.pop_front() {
            let words = keywords(&st.sql, 6);
            let kw = words.first().map(String::as_str).unwrap_or("");
            if !self.autocommit && !self.in_tx && !is_tx_control(&words) && !no_tx_block(&words) {
                self.control("BEGIN")?;
                self.in_tx = true;
            }
            let res = self.run_one(&st, &words, fetch);
            messages.extend(self.take_notices());
            let (rs, cursor) = res?;
            track_tx(&words, &mut self.in_tx);
            if let Some(n) = rs.rows_affected {
                messages.push(count_message(kw, n));
            }
            results.push(rs);
            if let Some(mut c) = cursor {
                c.rest = stmts;
                self.cursor = Some(c);
                break;
            }
        }
        Ok(results)
    }

    fn run_one(
        &mut self,
        st: &Stmt,
        words: &[String],
        fetch: usize,
    ) -> Result<(ResultSet, Option<PgCursor>)> {
        let kw = words.first().map(String::as_str).unwrap_or("");
        if kw == "COPY" && has_word(&st.sql, &["STDIN", "STDOUT"]) {
            bail!("COPY ... FROM STDIN / TO STDOUT no está soportado aquí; usa COPY con un fichero del servidor o INSERT/SELECT");
        }
        if !may_return_rows(kw, &st.sql) {
            let out = self.simple(&st.sql, Some((st, 0)))?;
            return Ok(self.materialize(out, None, fetch));
        }
        // Preparar (sin ejecutar) para conocer las columnas y sus tipos.
        let prepared = self
            .client
            .prepare(&st.sql)
            .map_err(|e| pg_err(&e, Some((st, 0))))?;
        let types: Vec<Type> = prepared
            .columns()
            .iter()
            .map(|c| c.type_().clone())
            .collect();
        let columns: Vec<ColumnInfo> = prepared
            .columns()
            .iter()
            .map(|c| ColumnInfo {
                name: c.name().to_string(),
                type_name: type_label(c.type_()),
                kind: kind_of(c.type_()),
            })
            .collect();
        drop(prepared);
        if columns.is_empty() || !cursorable(kw, &st.sql) {
            let out = self.simple(&st.sql, Some((st, 0)))?;
            let typed = if columns.is_empty() {
                None
            } else {
                Some((columns, types))
            };
            return Ok(self.materialize(out, typed, fetch));
        }

        // Cursor de servidor.
        let owns_tx = !self.in_tx;
        if owns_tx {
            self.control("BEGIN")?;
        }
        self.cursor_seq += 1;
        let name = format!("celer_cur_{}", self.cursor_seq);
        let prefix = format!("DECLARE {} NO SCROLL CURSOR FOR\n", qi(&name));
        let declare = format!("{prefix}{}", st.sql);
        let first = self
            .simple(&declare, Some((st, prefix.chars().count())))
            .and_then(|_| self.simple(&format!("FETCH FORWARD {} FROM {}", fetch + 1, qi(&name)), None));
        let out = match first {
            Ok(o) => o,
            Err(e) => {
                if owns_tx {
                    let _ = self.control("ROLLBACK");
                }
                return Err(e);
            }
        };
        let mut rows: Vec<Vec<Cell>> = out.rows.iter().map(|r| row_cells(r, &types)).collect();
        if rows.len() > fetch {
            let peeked = rows.pop();
            let rs = ResultSet {
                columns,
                rows,
                has_more: true,
                rows_affected: None,
            };
            let cursor = PgCursor {
                source: Source::Portal { name, owns_tx },
                types,
                peeked,
                rest: VecDeque::new(),
            };
            return Ok((rs, Some(cursor)));
        }
        // Cabe en una página: cerrar ya.
        let close = if owns_tx {
            "COMMIT".to_string()
        } else {
            format!("CLOSE {}", qi(&name))
        };
        self.control(&close)?;
        Ok((
            ResultSet {
                columns,
                rows,
                has_more: false,
                rows_affected: None,
            },
            None,
        ))
    }

    /// Convierte la salida del protocolo simple en un resultado; si hay más filas que `fetch`
    /// el resto queda en un cursor en memoria.
    fn materialize(
        &self,
        out: SimpleOut,
        typed: Option<(Vec<ColumnInfo>, Vec<Type>)>,
        fetch: usize,
    ) -> (ResultSet, Option<PgCursor>) {
        let (columns, types) = match (typed, &out.names) {
            (Some(t), _) => t,
            (None, Some(names)) => (
                names
                    .iter()
                    .map(|n| ColumnInfo {
                        name: n.clone(),
                        type_name: "text".into(),
                        kind: ColKind::Text,
                    })
                    .collect(),
                vec![Type::TEXT; names.len()],
            ),
            (None, None) => return (ResultSet::count(out.count as i64), None),
        };
        let mut all: VecDeque<Vec<Cell>> = out.rows.iter().map(|r| row_cells(r, &types)).collect();
        let take = all.len().min(fetch);
        let rows: Vec<Vec<Cell>> = all.drain(..take).collect();
        let has_more = !all.is_empty();
        let rs = ResultSet {
            columns,
            rows,
            has_more,
            rows_affected: None,
        };
        if has_more {
            let peeked = all.pop_front();
            (
                rs,
                Some(PgCursor {
                    source: Source::Buffer(all),
                    types,
                    peeked,
                    rest: VecDeque::new(),
                }),
            )
        } else {
            (rs, None)
        }
    }

    /// Lee hasta `n` filas del cursor (sin contar la ya leída por adelantado).
    fn read_cursor(&mut self, n: usize) -> Result<Vec<Vec<Cell>>> {
        let (name, types) = match self.cursor.as_mut() {
            Some(PgCursor {
                source: Source::Buffer(buf),
                ..
            }) => {
                let k = buf.len().min(n);
                return Ok(buf.drain(..k).collect());
            }
            Some(PgCursor {
                source: Source::Portal { name, .. },
                types,
                ..
            }) => (name.clone(), types.clone()),
            None => return Ok(vec![]),
        };
        if n == 0 {
            return Ok(vec![]);
        }
        let out = self.simple(&format!("FETCH FORWARD {n} FROM {}", qi(&name)), None)?;
        Ok(out.rows.iter().map(|r| row_cells(r, &types)).collect())
    }

    fn fetch_inner(&mut self, n: usize) -> Result<FetchOutput> {
        let mut rows = Vec::with_capacity(n + 1);
        if let Some(p) = self.cursor.as_mut().and_then(|c| c.peeked.take()) {
            rows.push(p);
        }
        let want = (n + 1).saturating_sub(rows.len());
        match self.read_cursor(want) {
            Ok(mut more) => rows.append(&mut more),
            Err(e) => {
                // El cursor ya no es utilizable.
                if let Some(c) = self.cursor.take() {
                    if c.owns_tx() {
                        let _ = self.control("ROLLBACK");
                    }
                }
                return Err(e);
            }
        }
        if rows.len() > n {
            let peeked = rows.pop();
            if let Some(c) = self.cursor.as_mut() {
                c.peeked = peeked;
            }
            return Ok(FetchOutput {
                rows,
                has_more: true,
                extra: vec![],
            });
        }
        // Agotado: cerrar y continuar con el resto del lote.
        let rest = self
            .cursor
            .as_mut()
            .map(|c| std::mem::take(&mut c.rest))
            .unwrap_or_default();
        self.close_cursor()?;
        let mut messages = Vec::new();
        let extra = if rest.is_empty() {
            vec![]
        } else {
            self.run_statements(rest, n, &mut messages)?
        };
        Ok(FetchOutput {
            rows,
            has_more: self.cursor.is_some(),
            extra,
        })
    }

    /// Consulta el estado real de la transacción en el servidor.
    fn refresh_tx_state(&mut self) {
        if let Some(c) = &self.cursor {
            if c.owns_tx() {
                self.in_tx = false;
                return;
            }
        }
        // En una transacción explícita, now() es el inicio de la transacción y difiere del
        // inicio de esta sentencia; en autocommit ambos coinciden.
        match self
            .client
            .simple_query("SELECT pg_catalog.now() <> pg_catalog.statement_timestamp()")
        {
            Ok(msgs) => {
                for m in msgs {
                    if let SimpleQueryMessage::Row(r) = m {
                        self.in_tx = r.try_get(0).ok().flatten() == Some("t");
                    }
                }
            }
            Err(e) => {
                if e.code() == Some(&SqlState::IN_FAILED_SQL_TRANSACTION) {
                    self.in_tx = true;
                }
            }
        }
        let _ = self.take_notices();
    }

    fn ensure_connected(&mut self, messages: &mut Vec<String>) -> Result<()> {
        if self.client.is_closed() {
            let db = self.database.clone();
            self.reconnect(&db)?;
            messages.push("Se perdió la conexión y se ha restablecido".into());
        }
        Ok(())
    }

    // ───────────── metadatos ─────────────

    fn aux_client(&mut self, db: &str) -> Result<&mut Client> {
        let reuse = matches!(&self.aux, Some((d, c)) if d == db && !c.is_closed());
        if !reuse {
            self.aux = None;
            let c = open_client(&self.cfg, db, &self.tls, None)?;
            self.aux = Some((db.to_string(), c));
        }
        Ok(&mut self.aux.as_mut().expect("conexión secundaria").1)
    }

    /// Consulta de catálogo en la base `db` (vacía = actual). Todas las columnas como texto.
    fn meta(
        &mut self,
        db: &str,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Vec<Option<String>>>> {
        let same_db = db.is_empty() || db == self.database;
        if same_db && !self.in_tx && self.cursor.is_none() && !self.client.is_closed() {
            return text_rows(&mut self.client, sql, params);
        }
        let target = if db.is_empty() {
            self.database.clone()
        } else {
            db.to_string()
        };
        let client = self.aux_client(&target)?;
        text_rows(client, sql, params)
    }

    fn rel_oid(&mut self, obj: &ObjectRef) -> Result<Option<(String, String)>> {
        let rows = self.meta(
            &obj.database,
            "SELECT c.oid::text, c.relkind::text FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = COALESCE(NULLIF($1::text, ''), current_schema()) AND c.relname = $2::text",
            &[&obj.schema, &obj.name],
        )?;
        Ok(rows.into_iter().next().map(|r| (s(&r, 0), s(&r, 1))))
    }

    fn columns_rows(&mut self, obj: &ObjectRef) -> Result<Vec<Vec<Option<String>>>> {
        self.meta(
            &obj.database,
            "SELECT a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull::text, \
               (EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)))::text, \
               a.attidentity::text, a.attgenerated::text, pg_catalog.pg_get_expr(d.adbin, d.adrelid), \
               COALESCE(bt.typname, t.typname)::text, COALESCE(bt.typcategory, t.typcategory)::text \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
             JOIN pg_catalog.pg_type t ON t.oid = a.atttypid \
             LEFT JOIN pg_catalog.pg_type bt ON t.typtype = 'd' AND bt.oid = t.typbasetype \
             LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum \
             WHERE n.nspname = COALESCE(NULLIF($1::text, ''), current_schema()) AND c.relname = $2::text \
             ORDER BY a.attnum",
            &[&obj.schema, &obj.name],
        )
    }

    fn table_ddl(&mut self, obj: &ObjectRef, oid: &str, relkind: &str) -> Result<String> {
        let db = obj.database.clone();
        let q = self.qualified_name(obj);
        let cols = self.meta(
            &db,
            &format!(
                "SELECT a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull::text, \
                   a.attidentity::text, a.attgenerated::text, pg_catalog.pg_get_expr(d.adbin, d.adrelid), \
                   pg_catalog.col_description(a.attrelid, a.attnum) \
                 FROM pg_catalog.pg_attribute a \
                 LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE a.attrelid = {oid} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
            ),
            &[],
        )?;
        let cons = self.meta(
            &db,
            &format!(
                "SELECT conname::text, pg_catalog.pg_get_constraintdef(oid, true) FROM pg_catalog.pg_constraint \
                 WHERE conrelid = {oid} AND contype IN ('p','u','c','f','x') \
                 ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'x' THEN 3 ELSE 4 END, conname"
            ),
            &[],
        )?;
        let idx = self.meta(
            &db,
            &format!(
                "SELECT pg_catalog.pg_get_indexdef(i.indexrelid) FROM pg_catalog.pg_index i \
                 JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid \
                 WHERE i.indrelid = {oid} AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k \
                   WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid AND k.contype IN ('p','u','x')) \
                 ORDER BY ic.relname"
            ),
            &[],
        )?;
        let extra = self.meta(
            &db,
            &format!(
                "SELECT pg_catalog.obj_description({oid}, 'pg_class'), \
                   CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END \
                 FROM pg_catalog.pg_class c WHERE c.oid = {oid}"
            ),
            &[],
        )?;
        let trg = self.meta(
            &db,
            &format!(
                "SELECT pg_catalog.pg_get_triggerdef(oid, true) FROM pg_catalog.pg_trigger \
                 WHERE tgrelid = {oid} AND NOT tgisinternal ORDER BY tgname"
            ),
            &[],
        )?;

        let mut lines = Vec::new();
        for r in &cols {
            let mut l = format!("    {} {}", qi(&s(r, 0)), s(r, 1));
            let default = r.get(5).cloned().flatten();
            match (s(r, 3).as_str(), s(r, 4).as_str()) {
                ("a", _) => l.push_str(" GENERATED ALWAYS AS IDENTITY"),
                ("d", _) => l.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
                (_, "s") => l.push_str(&format!(
                    " GENERATED ALWAYS AS ({}) STORED",
                    default.clone().unwrap_or_default()
                )),
                (_, "v") => l.push_str(&format!(
                    " GENERATED ALWAYS AS ({})",
                    default.clone().unwrap_or_default()
                )),
                _ => {
                    if let Some(d) = &default {
                        l.push_str(&format!(" DEFAULT {d}"));
                    }
                }
            }
            if s(r, 2) == "true" {
                l.push_str(" NOT NULL");
            }
            lines.push(l);
        }
        for r in &cons {
            lines.push(format!("    CONSTRAINT {} {}", qi(&s(r, 0)), s(r, 1)));
        }
        let head = if relkind == "f" {
            "CREATE FOREIGN TABLE"
        } else {
            "CREATE TABLE"
        };
        let mut out = format!("{head} {q} (\n{}\n)", lines.join(",\n"));
        let (comment, partkey) = extra
            .first()
            .map(|r| (r.first().cloned().flatten(), r.get(1).cloned().flatten()))
            .unwrap_or((None, None));
        if let Some(pk) = partkey {
            out.push_str(&format!("\nPARTITION BY {pk}"));
        }
        out.push_str(";\n");
        for r in &idx {
            out.push_str(&format!("\n{};", s(r, 0)));
        }
        if !idx.is_empty() {
            out.push('\n');
        }
        if let Some(c) = comment {
            out.push_str(&format!("\nCOMMENT ON TABLE {q} IS {};\n", ql(&c)));
        }
        let mut col_comments = false;
        for r in &cols {
            if let Some(Some(c)) = r.get(6) {
                if !col_comments {
                    out.push('\n');
                    col_comments = true;
                }
                out.push_str(&format!(
                    "COMMENT ON COLUMN {q}.{} IS {};\n",
                    qi(&s(r, 0)),
                    ql(c)
                ));
            }
        }
        for r in &trg {
            out.push_str(&format!("\n{};\n", s(r, 0)));
        }
        Ok(out.trim_end().to_string() + "\n")
    }

    fn sequence_ddl(&mut self, obj: &ObjectRef, oid: &str) -> Result<String> {
        let rows = self.meta(
            &obj.database,
            &format!(
                "SELECT s.seqtypid::regtype::text, s.seqincrement::text, s.seqmin::text, s.seqmax::text, \
                   s.seqstart::text, s.seqcache::text, s.seqcycle::text, \
                   CASE WHEN pg_catalog.has_sequence_privilege(s.seqrelid, 'SELECT,USAGE') \
                        THEN pg_catalog.pg_sequence_last_value(s.seqrelid)::text END, \
                   (SELECT pg_catalog.quote_ident(tn.nspname) || '.' || pg_catalog.quote_ident(tc.relname) || '.' || pg_catalog.quote_ident(ta.attname) \
                      FROM pg_catalog.pg_depend dp JOIN pg_catalog.pg_class tc ON tc.oid = dp.refobjid \
                      JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace \
                      JOIN pg_catalog.pg_attribute ta ON ta.attrelid = dp.refobjid AND ta.attnum = dp.refobjsubid \
                      WHERE dp.classid = 'pg_catalog.pg_class'::regclass AND dp.objid = s.seqrelid AND dp.deptype IN ('a','i') LIMIT 1) \
                 FROM pg_catalog.pg_sequence s WHERE s.seqrelid = {oid}"
            ),
            &[],
        )?;
        let r = rows
            .first()
            .ok_or_else(|| anyhow!("Secuencia no encontrada: {}", obj.name))?;
        let mut out = format!(
            "CREATE SEQUENCE {}\n    AS {}\n    INCREMENT BY {}\n    MINVALUE {}\n    MAXVALUE {}\n    START WITH {}\n    CACHE {}\n    {};\n",
            self.qualified_name(obj),
            s(r, 0),
            s(r, 1),
            s(r, 2),
            s(r, 3),
            s(r, 4),
            s(r, 5),
            if s(r, 6) == "true" { "CYCLE" } else { "NO CYCLE" }
        );
        if let Some(Some(owner)) = r.get(8) {
            out.push_str(&format!("-- propiedad de: {owner}\n"));
        }
        if let Some(Some(last)) = r.get(7) {
            out.push_str(&format!("-- último valor: {last}\n"));
        }
        Ok(out)
    }

    fn function_ddl(&mut self, obj: &ObjectRef) -> Result<String> {
        let rows = self.meta(
            &obj.database,
            "SELECT pg_catalog.pg_get_functiondef(p.oid) FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = COALESCE(NULLIF($1::text, ''), current_schema()) AND p.proname = $2::text \
               AND p.prokind IN ('f','p','w') ORDER BY p.oid",
            &[&obj.schema, &obj.name],
        )?;
        if rows.is_empty() {
            bail!("No se encontró la función {}", obj.name);
        }
        Ok(rows
            .iter()
            .map(|r| format!("{};", s(r, 0).trim_end()))
            .collect::<Vec<_>>()
            .join("\n\n")
            + "\n")
    }
}

// ───────────────────────────── Driver ─────────────────────────────

impl Driver for PostgresDriver {
    fn execute(&mut self, sql: &str, fetch: usize) -> Result<ExecOutput> {
        let t0 = std::time::Instant::now();
        let mut messages = Vec::new();
        self.close_cursor()?;
        messages.extend(crate::session::discarded_note(std::mem::take(&mut self.discarded)));
        self.ensure_connected(&mut messages)?;
        let _ = self.take_notices();
        let stmts: VecDeque<Stmt> = split_statements(sql).into();
        self.busy.store(true, Ordering::SeqCst);
        let result = self.run_statements(stmts, fetch.max(1), &mut messages);
        self.busy.store(false, Ordering::SeqCst);
        self.refresh_tx_state();
        let results = result?;
        messages.extend(crate::session::pending_note(self.cursor.as_ref().map_or(0, |c| c.rest.len())));
        Ok(ExecOutput {
            results,
            messages,
            elapsed_ms: t0.elapsed().as_millis() as u64,
            in_transaction: self.in_tx,
        })
    }

    fn fetch(&mut self, n: usize) -> Result<FetchOutput> {
        if self.cursor.is_none() {
            bail!(crate::session::CURSOR_CLOSED);
        }
        self.busy.store(true, Ordering::SeqCst);
        let r = self.fetch_inner(n.max(1));
        self.busy.store(false, Ordering::SeqCst);
        if self.cursor.is_none() {
            self.refresh_tx_state();
        }
        r
    }

    fn close_cursor(&mut self) -> Result<()> {
        if let Some(c) = self.cursor.take() {
            self.discarded += c.rest.len();
            if let Source::Portal { name, owns_tx } = c.source {
                if owns_tx {
                    // COMMIT cierra el cursor; si la transacción falló equivale a ROLLBACK.
                    if self.control("COMMIT").is_err() {
                        let _ = self.control("ROLLBACK");
                    }
                } else {
                    // En una transacción abortada el CLOSE falla, pero el cursor ya no existe.
                    let _ = self.control(&format!("CLOSE {}", qi(&name)));
                }
            }
        }
        Ok(())
    }

    fn set_autocommit(&mut self, on: bool) -> Result<bool> {
        self.close_cursor()?;
        if on && !self.autocommit && self.in_tx {
            self.control("COMMIT")?;
        }
        self.autocommit = on;
        self.refresh_tx_state();
        Ok(self.in_tx)
    }

    fn commit(&mut self) -> Result<bool> {
        self.close_cursor()?;
        if self.in_tx {
            self.control("COMMIT")?;
        }
        self.refresh_tx_state();
        Ok(self.in_tx)
    }

    fn rollback(&mut self) -> Result<bool> {
        self.close_cursor()?;
        if self.in_tx {
            self.control("ROLLBACK")?;
        }
        self.refresh_tx_state();
        Ok(self.in_tx)
    }

    fn children(&mut self, path: &[String]) -> Result<Vec<MetaNode>> {
        let p: Vec<&str> = path.iter().map(String::as_str).collect();
        match p.as_slice() {
            [] => {
                let rows = self.meta(
                    "",
                    "SELECT datname::text, pg_catalog.shobj_description(oid, 'pg_database') FROM pg_catalog.pg_database \
                     WHERE NOT datistemplate AND datallowconn ORDER BY datname",
                    &[],
                )?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        let n = s(r, 0);
                        MetaNode::branch(n.clone(), "database", vec![n])
                            .with_detail(r.get(1).cloned().flatten())
                    })
                    .collect())
            }
            [db] => {
                let rows = self.meta(
                    db,
                    "SELECT n.nspname::text, CASE WHEN n.nspname IN ('pg_catalog','information_schema') THEN 'sistema' END \
                     FROM pg_catalog.pg_namespace n \
                     WHERE n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp_' \
                     ORDER BY CASE WHEN n.nspname = 'public' THEN 0 \
                                   WHEN n.nspname IN ('pg_catalog','information_schema') THEN 2 ELSE 1 END, n.nspname",
                    &[],
                )?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        let n = s(r, 0);
                        MetaNode::branch(n.clone(), "schema", vec![db.to_string(), n])
                            .with_detail(r.get(1).cloned().flatten())
                    })
                    .collect())
            }
            [db, schema] => Ok([
                ("Tablas", "tables"),
                ("Vistas", "views"),
                ("Vistas materializadas", "matviews"),
                ("Funciones", "functions"),
                ("Procedimientos", "procedures"),
                ("Secuencias", "sequences"),
            ]
            .iter()
            .map(|(label, key)| {
                MetaNode::branch(
                    *label,
                    "folder",
                    vec![db.to_string(), schema.to_string(), key.to_string()],
                )
            })
            .collect()),
            [db, schema, folder] => {
                let schema_s = schema.to_string();
                let (sql, kind, branch) = match *folder {
                    "tables" => (
                        "SELECT c.relname::text, CASE c.relkind WHEN 'p' THEN 'particionada' WHEN 'f' THEN 'externa' END, \
                           c.reltuples::bigint::text \
                         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                         WHERE n.nspname = $1::text AND c.relkind IN ('r','p','f') AND NOT c.relispartition ORDER BY 1",
                        "table",
                        true,
                    ),
                    "views" => (
                        "SELECT c.relname::text, NULL::text, NULL::text \
                         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                         WHERE n.nspname = $1::text AND c.relkind = 'v' ORDER BY 1",
                        "view",
                        true,
                    ),
                    "matviews" => (
                        "SELECT c.relname::text, CASE WHEN NOT c.relispopulated THEN 'sin datos' END, c.reltuples::bigint::text \
                         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                         WHERE n.nspname = $1::text AND c.relkind = 'm' ORDER BY 1",
                        "view",
                        true,
                    ),
                    "functions" | "procedures" => (
                        if *folder == "functions" {
                            "SELECT p.proname::text, '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ') → ' || \
                               pg_catalog.pg_get_function_result(p.oid), NULL::text \
                             FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
                             WHERE n.nspname = $1::text AND p.prokind IN ('f','w') \
                               AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass \
                                               AND d.objid = p.oid AND d.deptype = 'e') \
                             ORDER BY 1, 2"
                        } else {
                            "SELECT p.proname::text, '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')', NULL::text \
                             FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
                             WHERE n.nspname = $1::text AND p.prokind = 'p' \
                               AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass \
                                               AND d.objid = p.oid AND d.deptype = 'e') \
                             ORDER BY 1, 2"
                        },
                        if *folder == "functions" {
                            "function"
                        } else {
                            "procedure"
                        },
                        false,
                    ),
                    "sequences" => (
                        "SELECT c.relname::text, s.seqtypid::regtype::text, NULL::text \
                         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                         JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid \
                         WHERE n.nspname = $1::text AND c.relkind = 'S' ORDER BY 1",
                        "sequence",
                        false,
                    ),
                    _ => return Ok(vec![]),
                };
                let rows = self.meta(db, sql, &[&schema_s])?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        let n = s(r, 0);
                        let mut detail: Vec<String> = Vec::new();
                        if let Some(Some(d)) = r.get(1) {
                            detail.push(d.clone());
                        }
                        if let Some(Some(t)) = r.get(2) {
                            if let Some(c) = fmt_approx(t.parse().unwrap_or(-1)) {
                                detail.push(c);
                            }
                        }
                        let obj = ObjectRef::new(db, schema, &n, kind);
                        let node = if branch {
                            MetaNode::branch(
                                n.clone(),
                                kind,
                                vec![db.to_string(), schema.to_string(), folder.to_string(), n],
                            )
                        } else {
                            MetaNode::leaf(n, kind, None)
                        };
                        node.with_obj(obj).with_detail(if detail.is_empty() {
                            None
                        } else {
                            Some(detail.join(" · "))
                        })
                    })
                    .collect())
            }
            [db, schema, folder, name] => {
                let o = ObjectRef::new(db, schema, name, "table");
                let cols = self.columns_rows(&o)?;
                let mut nodes: Vec<MetaNode> = cols
                    .iter()
                    .map(|r| {
                        let pk = s(r, 3) == "true";
                        let mut detail = s(r, 1);
                        if pk {
                            detail.push_str(" · PK");
                        }
                        if !s(r, 4).is_empty() {
                            detail.push_str(" · identity");
                        } else if !s(r, 5).is_empty() {
                            detail.push_str(" · generada");
                        }
                        if s(r, 2) == "true" {
                            detail.push_str(" · not null");
                        }
                        MetaNode::leaf(s(r, 0), if pk { "pkcolumn" } else { "column" }, Some(detail))
                    })
                    .collect();
                let subs: &[(&str, &str)] = match *folder {
                    "tables" => &[
                        ("Índices", "indexes"),
                        ("Claves foráneas", "fks"),
                        ("Triggers", "triggers"),
                    ],
                    "matviews" => &[("Índices", "indexes")],
                    _ => &[],
                };
                for (label, key) in subs {
                    nodes.push(MetaNode::branch(
                        *label,
                        "folder",
                        vec![
                            db.to_string(),
                            schema.to_string(),
                            folder.to_string(),
                            name.to_string(),
                            key.to_string(),
                        ],
                    ));
                }
                Ok(nodes)
            }
            [db, schema, _folder, name, sub] => {
                let args: [&(dyn ToSql + Sync); 2] = [schema, name];
                match *sub {
                    "indexes" => {
                        let rows = self.meta(
                            db,
                            "SELECT i.relname::text, ix.indisprimary::text, ix.indisunique::text, am.amname::text, \
                               (SELECT string_agg(pg_catalog.pg_get_indexdef(ix.indexrelid, k, true), ', ' ORDER BY k) \
                                  FROM generate_series(1, ix.indnkeyatts::int) k) \
                             FROM pg_catalog.pg_index ix \
                             JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid \
                             JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid \
                             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                             JOIN pg_catalog.pg_am am ON am.oid = i.relam \
                             WHERE n.nspname = $1::text AND c.relname = $2::text \
                             ORDER BY ix.indisprimary DESC, i.relname",
                            &args,
                        )?;
                        Ok(rows
                            .iter()
                            .map(|r| {
                                let mut det = format!("({})", s(r, 4));
                                if s(r, 1) == "true" {
                                    det.push_str(" · PK");
                                } else if s(r, 2) == "true" {
                                    det.push_str(" · único");
                                }
                                det.push_str(&format!(" · {}", s(r, 3)));
                                let n = s(r, 0);
                                MetaNode::leaf(n.clone(), "index", Some(det))
                                    .with_obj(ObjectRef::new(db, schema, &n, "index"))
                            })
                            .collect())
                    }
                    "fks" => {
                        let rows = self.meta(
                            db,
                            "SELECT co.conname::text, \
                               (SELECT string_agg(pg_catalog.quote_ident(a.attname), ', ' ORDER BY k.ord) \
                                  FROM unnest(co.conkey) WITH ORDINALITY k(attnum, ord) \
                                  JOIN pg_catalog.pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.attnum), \
                               co.confrelid::regclass::text, \
                               (SELECT string_agg(pg_catalog.quote_ident(a.attname), ', ' ORDER BY k.ord) \
                                  FROM unnest(co.confkey) WITH ORDINALITY k(attnum, ord) \
                                  JOIN pg_catalog.pg_attribute a ON a.attrelid = co.confrelid AND a.attnum = k.attnum), \
                               rn.nspname::text, rc.relname::text \
                             FROM pg_catalog.pg_constraint co \
                             JOIN pg_catalog.pg_class c ON c.oid = co.conrelid \
                             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                             JOIN pg_catalog.pg_class rc ON rc.oid = co.confrelid \
                             JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace \
                             WHERE co.contype = 'f' AND n.nspname = $1::text AND c.relname = $2::text \
                             ORDER BY co.conname",
                            &args,
                        )?;
                        // `obj` is the referenced table, so the UI can jump to it.
                        Ok(rows
                            .iter()
                            .map(|r| {
                                MetaNode::leaf(
                                    s(r, 0),
                                    "key",
                                    Some(format!("{} → {}({})", s(r, 1), s(r, 2), s(r, 3))),
                                )
                                .with_obj(ObjectRef::new(db, &s(r, 4), &s(r, 5), "table"))
                            })
                            .collect())
                    }
                    "triggers" => {
                        let rows = self.meta(
                            db,
                            "SELECT t.tgname::text, \
                               CASE WHEN t.tgtype::int & 2 = 2 THEN 'BEFORE' WHEN t.tgtype::int & 64 = 64 THEN 'INSTEAD OF' ELSE 'AFTER' END || ' ' || \
                               concat_ws(' OR ', CASE WHEN t.tgtype::int & 4 = 4 THEN 'INSERT' END, CASE WHEN t.tgtype::int & 16 = 16 THEN 'UPDATE' END, \
                                         CASE WHEN t.tgtype::int & 8 = 8 THEN 'DELETE' END, CASE WHEN t.tgtype::int & 32 = 32 THEN 'TRUNCATE' END) \
                               || CASE WHEN t.tgenabled = 'D' THEN ' · deshabilitado' ELSE '' END \
                             FROM pg_catalog.pg_trigger t \
                             JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
                             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                             WHERE NOT t.tgisinternal AND n.nspname = $1::text AND c.relname = $2::text \
                             ORDER BY t.tgname",
                            &args,
                        )?;
                        Ok(rows
                            .iter()
                            .map(|r| {
                                let n = s(r, 0);
                                MetaNode::leaf(n.clone(), "trigger", r.get(1).cloned().flatten())
                                    .with_obj(ObjectRef::new(db, schema, &n, "trigger"))
                            })
                            .collect())
                    }
                    _ => Ok(vec![]),
                }
            }
            _ => Ok(vec![]),
        }
    }

    fn table_columns(&mut self, obj: &ObjectRef) -> Result<Vec<TableColumn>> {
        let rows = self.columns_rows(obj)?;
        Ok(rows
            .iter()
            .map(|r| {
                let default = r.get(6).cloned().flatten();
                TableColumn {
                    name: s(r, 0),
                    type_name: s(r, 1),
                    nullable: s(r, 2) != "true",
                    primary_key: s(r, 3) == "true",
                    identity: !s(r, 4).is_empty()
                        || !s(r, 5).is_empty()
                        || default
                            .as_deref()
                            .is_some_and(|d| d.starts_with("nextval(")),
                    default,
                    kind: kind_from_category(&s(r, 8), &s(r, 7)),
                }
            })
            .collect())
    }

    fn ddl(&mut self, obj: &ObjectRef) -> Result<String> {
        match obj.kind.as_str() {
            "function" | "procedure" => return self.function_ddl(obj),
            "trigger" => {
                let rows = self.meta(
                    &obj.database,
                    "SELECT pg_catalog.pg_get_triggerdef(t.oid, true) FROM pg_catalog.pg_trigger t \
                     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = COALESCE(NULLIF($1::text, ''), current_schema()) AND t.tgname = $2::text ORDER BY c.relname",
                    &[&obj.schema, &obj.name],
                )?;
                if rows.is_empty() {
                    bail!("No se encontró el trigger {}", obj.name);
                }
                return Ok(rows
                    .iter()
                    .map(|r| format!("{};", s(r, 0)))
                    .collect::<Vec<_>>()
                    .join("\n\n")
                    + "\n");
            }
            _ => {}
        }
        let Some((oid, relkind)) = self.rel_oid(obj)? else {
            bail!("No se encontró el objeto {}", self.qualified_name(obj));
        };
        let q = self.qualified_name(obj);
        match relkind.as_str() {
            "r" | "p" | "f" => self.table_ddl(obj, &oid, &relkind),
            "v" | "m" => {
                let rows = self.meta(
                    &obj.database,
                    &format!("SELECT pg_catalog.pg_get_viewdef({oid}, true)"),
                    &[],
                )?;
                let def = rows.first().map(|r| s(r, 0)).unwrap_or_default();
                let def = def.trim().trim_end_matches(';').trim_end();
                if relkind == "v" {
                    Ok(format!("CREATE OR REPLACE VIEW {q} AS\n{def};\n"))
                } else {
                    let idx = self.meta(
                        &obj.database,
                        &format!(
                            "SELECT pg_catalog.pg_get_indexdef(i.indexrelid) FROM pg_catalog.pg_index i \
                             JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = {oid} ORDER BY ic.relname"
                        ),
                        &[],
                    )?;
                    let mut out = format!("CREATE MATERIALIZED VIEW {q} AS\n{def}\nWITH DATA;\n");
                    for r in &idx {
                        out.push_str(&format!("\n{};", s(r, 0)));
                    }
                    Ok(out.trim_end().to_string() + "\n")
                }
            }
            "S" => self.sequence_ddl(obj, &oid),
            "i" | "I" => {
                let rows = self.meta(
                    &obj.database,
                    &format!("SELECT pg_catalog.pg_get_indexdef({oid})"),
                    &[],
                )?;
                Ok(format!("{};\n", rows.first().map(|r| s(r, 0)).unwrap_or_default()))
            }
            other => bail!("No hay DDL disponible para este tipo de objeto ({other})"),
        }
    }

    fn completion(&mut self, database: &str) -> Result<CompletionSchema> {
        let rows = self.meta(
            database,
            "SELECT n.nspname::text, c.relname::text, a.attname::text \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
             WHERE c.relkind IN ('r','p','v','m','f') \
               AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp_' \
             ORDER BY n.nspname, c.relname, a.attnum \
             LIMIT 200000",
            &[],
        )?;
        let mut out = CompletionSchema::default();
        for r in rows {
            let (sc, t, c) = (s(&r, 0), s(&r, 1), s(&r, 2));
            match out.tables.last_mut() {
                Some(last) if last.schema == sc && last.name == t => last.columns.push(c),
                _ => out.tables.push(CompletionTable {
                    schema: sc,
                    name: t,
                    columns: vec![c],
                }),
            }
        }
        Ok(out)
    }

    fn databases(&mut self) -> Result<Vec<String>> {
        let rows = self.meta(
            "",
            "SELECT datname::text FROM pg_catalog.pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname",
            &[],
        )?;
        Ok(rows.iter().map(|r| s(r, 0)).collect())
    }

    fn current_database(&mut self) -> Result<String> {
        Ok(self.database.clone())
    }

    fn use_database(&mut self, db: &str) -> Result<()> {
        if db.is_empty() || db == self.database {
            return Ok(());
        }
        if self.in_tx {
            bail!("Hay una transacción abierta: confirma o deshaz los cambios antes de cambiar de base de datos");
        }
        self.close_cursor()?;
        self.reconnect(db)
    }

    fn qualified_name(&self, o: &ObjectRef) -> String {
        if o.schema.is_empty() {
            qi(&o.name)
        } else {
            format!("{}.{}", qi(&o.schema), qi(&o.name))
        }
    }

    fn quote_ident(&self, s: &str) -> String {
        qi(s)
    }

    fn server_info(&mut self) -> Result<String> {
        let ver = if self.version.is_empty() {
            let rows = self.meta("", "SELECT current_setting('server_version')", &[])?;
            rows.first().map(|r| s(r, 0)).unwrap_or_else(|| "?".into())
        } else {
            self.version.clone()
        };
        let ver = ver.split_whitespace().next().unwrap_or("?").to_string();
        let host = if self.cfg.host.trim().is_empty() {
            "localhost"
        } else {
            self.cfg.host.trim()
        };
        Ok(format!(
            "PostgreSQL {ver} — {host}:{}/{}",
            self.cfg.port.unwrap_or(DEFAULT_PORT),
            self.database
        ))
    }

    /// La consulta vacía del protocolo, con 5 s de límite.
    fn ping(&mut self) -> Result<()> {
        self.client.is_valid(Duration::from_secs(5)).map_err(|e| pg_err(&e, None))
    }

    fn broken(&self) -> bool {
        self.client.is_closed()
    }

    fn canceller(&self) -> Canceller {
        let cancel = self.cancel.clone();
        let busy = self.busy.clone();
        let tls = self.tls.clone();
        Arc::new(move || {
            if !busy.load(Ordering::SeqCst) {
                return;
            }
            if let Some(token) = cancel.lock().clone() {
                let tls = tls.clone();
                // cancel_query crea su propio runtime de tokio: se lanza en un hilo aparte para
                // poder llamarlo también desde dentro de un runtime asíncrono.
                let _ = std::thread::Builder::new()
                    .name("celer-pg-cancel".into())
                    .spawn(move || {
                        let _ = token.cancel_query(tls);
                    });
            }
        })
    }
}

// ───────────────────────────── conexión ─────────────────────────────

fn make_tls(cfg: &ConnConfig) -> Result<MakeTlsConnector> {
    let mut b = native_tls::TlsConnector::builder();
    if cfg.trust_cert {
        b.danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }
    Ok(MakeTlsConnector::new(b.build()?))
}

pub(crate) fn sslmode(encryption: &str) -> &'static str {
    match encryption.trim().to_ascii_lowercase().as_str() {
        "off" | "disable" | "disabled" | "false" | "no" => "disable",
        "login" | "prefer" | "optional" => "prefer",
        _ => "require",
    }
}

/// Construye la cadena libpq (`clave='valor' ...`). `extra` admite `k=v;k=v` (o uno por línea)
/// y sus valores prevalecen sobre los generados.
fn conn_string(cfg: &ConnConfig, database: &str) -> Result<String> {
    fn push(out: &mut String, k: &str, v: &str) {
        out.push_str(k);
        out.push_str("='");
        for ch in v.chars() {
            if ch == '\'' || ch == '\\' {
                out.push('\\');
            }
            out.push(ch);
        }
        out.push_str("' ");
    }
    let mut out = String::new();
    let host = cfg.host.trim();
    push(&mut out, "host", if host.is_empty() { "localhost" } else { host });
    push(&mut out, "port", &cfg.port.unwrap_or(DEFAULT_PORT).to_string());
    if !cfg.user.trim().is_empty() {
        push(&mut out, "user", cfg.user.trim());
    }
    if let Some(pw) = &cfg.password {
        push(&mut out, "password", pw);
    }
    if !database.trim().is_empty() {
        push(&mut out, "dbname", database.trim());
    }
    push(&mut out, "sslmode", sslmode(&cfg.encryption));
    push(&mut out, "application_name", "Celer");
    push(&mut out, "connect_timeout", "15");
    for part in cfg.extra.split([';', '\n', '\r']) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let Some((k, v)) = part.split_once('=') else {
            bail!("Parámetro extra no válido (se espera clave=valor): {part}");
        };
        let v = v.trim();
        let v = v
            .strip_prefix('\'')
            .and_then(|x| x.strip_suffix('\''))
            .unwrap_or(v);
        push(&mut out, k.trim(), v);
    }
    Ok(out.trim_end().to_string())
}

fn open_client(
    cfg: &ConnConfig,
    database: &str,
    tls: &MakeTlsConnector,
    notices: Option<Arc<Mutex<Vec<String>>>>,
) -> Result<Client> {
    let mut config: Config = conn_string(cfg, database)?
        .parse()
        .map_err(|e: ::postgres::Error| anyhow!("Configuración de conexión no válida: {e}"))?;
    match notices {
        Some(n) => config.notice_callback(move |e| n.lock().push(fmt_notice(&e))),
        None => config.notice_callback(|_| {}),
    };
    config.keepalives_idle(Duration::from_secs(60));
    config.keepalives_interval(Duration::from_secs(15));
    let mut client = config.connect(tls.clone()).map_err(|e| pg_err(&e, None))?;
    // A read-only connection is also enforced by the server, on every connection the driver opens.
    if cfg.read_only {
        client
            .batch_execute("SET default_transaction_read_only = on")
            .map_err(|e| pg_err(&e, None))?;
    }
    Ok(client)
}

/// El script de inicio, sentencia a sentencia, con el protocolo simple (sin transacción implícita).
fn run_startup(client: &mut Client, startup: &[String]) -> Result<()> {
    for sql in startup {
        client.batch_execute(sql).map_err(|e| crate::startup::failed(sql, pg_err(&e, None)))?;
    }
    Ok(())
}

/// La base y la versión del servidor en una sola ida y vuelta (protocolo simple: sin preparar la sentencia antes).
fn query_identity(client: &mut Client) -> Result<(String, String)> {
    let msgs = client
        .simple_query("SELECT current_database()::text, current_setting('server_version')")
        .map_err(|e| pg_err(&e, None))?;
    for m in msgs {
        if let SimpleQueryMessage::Row(r) = m {
            return Ok((r.get(0).unwrap_or_default().to_string(), r.get(1).unwrap_or_default().to_string()));
        }
    }
    Ok((String::new(), String::new()))
}

/// Ejecuta una consulta de catálogo (protocolo extendido) y devuelve las columnas como texto.
fn text_rows(
    client: &mut Client,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Vec<Vec<Option<String>>>> {
    let rows = client.query(sql, params).map_err(|e| pg_err(&e, None))?;
    Ok(rows
        .iter()
        .map(|row| (0..row.len()).map(|i| any_text(row, i)).collect())
        .collect())
}

fn any_text(row: &::postgres::Row, i: usize) -> Option<String> {
    if let Ok(v) = row.try_get::<_, Option<String>>(i) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, Option<i64>>(i) {
        return v.map(|x| x.to_string());
    }
    if let Ok(v) = row.try_get::<_, Option<i32>>(i) {
        return v.map(|x| x.to_string());
    }
    if let Ok(v) = row.try_get::<_, Option<bool>>(i) {
        return v.map(|x| x.to_string());
    }
    if let Ok(v) = row.try_get::<_, Option<f64>>(i) {
        return v.map(|x| x.to_string());
    }
    if let Ok(v) = row.try_get::<_, Option<u32>>(i) {
        return v.map(|x| x.to_string());
    }
    None
}

fn s(r: &[Option<String>], i: usize) -> String {
    r.get(i).cloned().flatten().unwrap_or_default()
}

// ───────────────────────────── errores y avisos ─────────────────────────────

fn fmt_notice(e: &DbError) -> String {
    let mut m = format!("{}: {}", e.severity(), e.message());
    if let Some(d) = e.detail() {
        m.push_str(&format!("\nDetalle: {d}"));
    }
    if let Some(h) = e.hint() {
        m.push_str(&format!("\nSugerencia: {h}"));
    }
    m
}

/// Error legible. `ctx`: sentencia ejecutada y nº de caracteres antepuestos a su texto
/// (para traducir la posición del error a línea/columna del lote original).
fn pg_err(e: &::postgres::Error, ctx: Option<(&Stmt, usize)>) -> anyhow::Error {
    if let Some(db) = e.as_db_error() {
        if *db.code() == SqlState::QUERY_CANCELED {
            return anyhow!("Consulta cancelada");
        }
        let mut m = format!("{} {}: {}", db.severity(), db.code().code(), db.message());
        if let Some(d) = db.detail() {
            m.push_str(&format!("\nDetalle: {d}"));
        }
        if let Some(h) = db.hint() {
            m.push_str(&format!("\nSugerencia: {h}"));
        }
        if let (Some(ErrorPosition::Original(pos)), Some((st, prefix))) = (db.position(), ctx) {
            if let Some((l, c)) = locate(st, *pos as usize, prefix) {
                m.push_str(&format!("\nPosición: línea {l}, columna {c}"));
            }
        }
        if let Some(w) = db.where_() {
            m.push_str(&format!("\nContexto: {w}"));
        }
        return anyhow!(m);
    }
    if e.is_closed() {
        return anyhow!("Se perdió la conexión con el servidor PostgreSQL");
    }
    anyhow!("{e}")
}

/// Línea y columna (1-based) en el lote de la posición `pos` (1-based, en caracteres).
fn locate(st: &Stmt, pos: usize, prefix: usize) -> Option<(usize, usize)> {
    let idx = pos.checked_sub(1)?.checked_sub(prefix)?;
    let mut line = 0;
    let mut col = 0;
    for (i, ch) in st.sql.chars().enumerate() {
        if i == idx {
            break;
        }
        if ch == '\n' {
            line += 1;
            col = 0;
        } else {
            col += 1;
        }
    }
    let col = if line == 0 { st.col + col } else { col };
    Some((st.line + line + 1, col + 1))
}

fn count_message(kw: &str, n: i64) -> String {
    match kw {
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "COPY" => {
            if n == 1 {
                "1 fila afectada".into()
            } else {
                format!("{n} filas afectadas")
            }
        }
        "SELECT" | "WITH" => format!("{n} filas"),
        "" => "Sentencia ejecutada".into(),
        k => format!("{k} ejecutado"),
    }
}

// ───────────────────────────── tipos ─────────────────────────────

fn qi(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn ql(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn fmt_approx(n: i64) -> Option<String> {
    match n {
        n if n < 0 => None,
        1 => Some("~1 fila".into()),
        n => Some(format!("~{n} filas")),
    }
}

/// Nombre del tipo para mostrar (`_int4` → `int4[]`).
fn type_label(ty: &Type) -> String {
    match ty.kind() {
        Kind::Array(inner) => format!("{}[]", type_label(inner)),
        _ => ty.name().to_string(),
    }
}

fn kind_of(ty: &Type) -> ColKind {
    match ty.kind() {
        Kind::Domain(base) => kind_of(base),
        Kind::Enum(_) => ColKind::Text,
        Kind::Array(_) | Kind::Range(_) | Kind::Composite(_) => ColKind::Other,
        _ => kind_from_typname(ty.name()),
    }
}

fn kind_from_typname(name: &str) -> ColKind {
    match name {
        "int2" | "int4" | "int8" | "float4" | "float8" | "numeric" | "money" | "oid" | "xid"
        | "xid8" | "cid" => ColKind::Number,
        "bool" => ColKind::Bool,
        "text" | "varchar" | "bpchar" | "char" | "name" | "citext" | "uuid" | "unknown" => {
            ColKind::Text
        }
        "date" | "time" | "timetz" | "timestamp" | "timestamptz" => ColKind::Date,
        "bytea" => ColKind::Binary,
        _ => ColKind::Other,
    }
}

/// Familia de tipo a partir de `pg_type.typcategory` (para columnas de catálogo).
fn kind_from_category(cat: &str, typname: &str) -> ColKind {
    match cat {
        "N" if !typname.starts_with("reg") => ColKind::Number,
        "B" => ColKind::Bool,
        "S" | "E" => ColKind::Text,
        "D" => ColKind::Date,
        _ => kind_from_typname(typname),
    }
}

fn base_type(ty: &Type) -> &Type {
    match ty.kind() {
        Kind::Domain(b) => base_type(b),
        _ => ty,
    }
}

/// Convierte un valor en formato texto de PostgreSQL en una celda según su tipo.
fn text_cell(v: Option<&str>, ty: &Type) -> Cell {
    let Some(v) = v else { return Cell::Null };
    let ty = base_type(ty);
    match *ty {
        Type::INT2 | Type::INT4 | Type::INT8 | Type::OID => match v.parse::<i64>() {
            Ok(n) => Cell::int(n),
            Err(_) => Cell::Text(v.to_string()),
        },
        Type::FLOAT4 | Type::FLOAT8 => match v.parse::<f64>() {
            Ok(f) if f.is_finite() => Cell::Num(f),
            _ => Cell::Text(v.to_string()),
        },
        Type::BOOL => match v {
            "t" => Cell::Bool(true),
            "f" => Cell::Bool(false),
            _ => Cell::Text(v.to_string()),
        },
        Type::BYTEA => match decode_bytea_hex(v) {
            Some(b) => Cell::hex(&b, BINARY_PREVIEW),
            None => Cell::Text(v.to_string()),
        },
        _ => Cell::Text(v.to_string()),
    }
}

fn decode_bytea_hex(v: &str) -> Option<Vec<u8>> {
    let h = v.strip_prefix("\\x")?.as_bytes();
    if h.len() % 2 != 0 {
        return None;
    }
    let nib = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    h.chunks(2)
        .map(|p| Some(nib(p[0])? << 4 | nib(p[1])?))
        .collect()
}

fn row_cells(r: &SimpleQueryRow, types: &[Type]) -> Vec<Cell> {
    (0..r.len())
        .map(|i| {
            let ty = types.get(i).unwrap_or(&Type::TEXT);
            text_cell(r.try_get(i).ok().flatten(), ty)
        })
        .collect()
}

// ───────────────────────────── análisis léxico ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
enum Tok<'a> {
    Word(&'a str),
    Semi(usize),
    /// Cualquier otro contenido significativo (cadenas, números, signos...).
    Other,
}

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c >= 0x80
}

fn is_ident(c: u8) -> bool {
    is_ident_start(c) || c.is_ascii_digit()
}

/// Recorre el SQL ignorando comentarios, cadenas, identificadores entrecomillados y cadenas
/// con dólar (`$$...$$`, `$tag$...$tag$`).
fn lex<'a>(sql: &'a str, mut f: impl FnMut(Tok<'a>)) {
    let b = sql.as_bytes();
    let n = b.len();
    let mut i = 0;
    // Salta una cadena entre comillas simples que empieza en `i`; `esc`: admite \ (E'...').
    let skip_string = |mut i: usize, esc: bool| -> usize {
        i += 1;
        while i < n {
            if esc && b[i] == b'\\' {
                i += 2;
                continue;
            }
            if b[i] == b'\'' {
                if i + 1 < n && b[i + 1] == b'\'' {
                    i += 2;
                    continue;
                }
                return i + 1;
            }
            i += 1;
        }
        n
    };
    while i < n {
        let c = b[i];
        if c == b'-' && i + 1 < n && b[i + 1] == b'-' {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
        } else if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            let mut depth = 1;
            i += 2;
            while i < n && depth > 0 {
                if b[i] == b'/' && i + 1 < n && b[i + 1] == b'*' {
                    depth += 1;
                    i += 2;
                } else if b[i] == b'*' && i + 1 < n && b[i + 1] == b'/' {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        } else if c == b'\'' {
            i = skip_string(i, false);
            f(Tok::Other);
        } else if c == b'"' {
            i += 1;
            while i < n {
                if b[i] == b'"' {
                    if i + 1 < n && b[i + 1] == b'"' {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            f(Tok::Other);
        } else if c == b'$' {
            // ¿Cadena con dólar? $tag$ con tag vacío o identificador que no empieza por dígito.
            let mut j = i + 1;
            while j < n && is_ident(b[j]) {
                j += 1;
            }
            let valid_tag = j < n && b[j] == b'$' && (j == i + 1 || !b[i + 1].is_ascii_digit());
            if valid_tag {
                let tag = &sql[i..=j];
                match sql[j + 1..].find(tag) {
                    Some(p) => i = j + 1 + p + tag.len(),
                    None => i = n,
                }
            } else {
                i += 1;
            }
            f(Tok::Other);
        } else if c == b';' {
            f(Tok::Semi(i));
            i += 1;
        } else if is_ident_start(c) {
            let start = i;
            i += 1;
            while i < n && (is_ident(b[i]) || b[i] == b'$') {
                i += 1;
            }
            let w = &sql[start..i];
            if i < n && b[i] == b'\'' && (w == "E" || w == "e") {
                i = skip_string(i, true);
                f(Tok::Other);
            } else {
                f(Tok::Word(w));
            }
        } else {
            if !c.is_ascii_whitespace() {
                f(Tok::Other);
            }
            i += 1;
        }
    }
}

/// Primeras `n` palabras clave (en mayúsculas), sin comentarios ni literales.
fn keywords(sql: &str, n: usize) -> Vec<String> {
    let mut out = Vec::new();
    lex(sql, |t| {
        if let Tok::Word(w) = t {
            if out.len() < n {
                out.push(w.to_ascii_uppercase());
            }
        }
    });
    out
}

fn has_word(sql: &str, words: &[&str]) -> bool {
    let mut found = false;
    lex(sql, |t| {
        if let Tok::Word(w) = t {
            if !found && words.iter().any(|x| w.eq_ignore_ascii_case(x)) {
                found = true;
            }
        }
    });
    found
}

/// Divide un lote en sentencias por `;`, respetando cadenas, comentarios, cadenas con dólar
/// y cuerpos `BEGIN ATOMIC ... END`.
fn split_statements(sql: &str) -> Vec<Stmt> {
    let mut cuts = Vec::new();
    let mut prev = String::new();
    let mut atomic = 0i32;
    lex(sql, |t| match t {
        Tok::Word(w) => {
            let u = w.to_ascii_uppercase();
            if atomic > 0 {
                if u == "CASE" {
                    atomic += 1;
                } else if u == "END" {
                    atomic -= 1;
                }
            } else if u == "ATOMIC" && prev == "BEGIN" {
                atomic = 1;
            }
            prev = u;
        }
        Tok::Semi(p) => {
            if atomic == 0 {
                cuts.push(p);
            }
            prev.clear();
        }
        Tok::Other => {}
    });
    cuts.push(sql.len());
    let mut out = Vec::new();
    let mut start = 0;
    for cut in cuts {
        let piece = &sql[start..cut];
        let lead = piece.len() - piece.trim_start().len();
        let text = piece.trim();
        if !text.is_empty() {
            let mut any = false;
            lex(text, |t| {
                if !matches!(t, Tok::Semi(_)) {
                    any = true;
                }
            });
            if any {
                let before = &sql[..start + lead];
                let line = before.matches('\n').count();
                let col = before
                    .rsplit('\n')
                    .next()
                    .map(|l| l.chars().count())
                    .unwrap_or(0);
                out.push(Stmt {
                    sql: text.to_string(),
                    line,
                    col,
                });
            }
        }
        start = (cut + 1).min(sql.len());
    }
    out
}

/// La sentencia puede devolver filas: se prepara para conocer sus columnas.
fn may_return_rows(kw: &str, sql: &str) -> bool {
    match kw {
        "SELECT" | "WITH" | "VALUES" | "TABLE" | "SHOW" | "EXPLAIN" | "FETCH" | "CALL" => true,
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" => has_word(sql, &["RETURNING"]),
        _ => false,
    }
}

/// La sentencia admite `DECLARE CURSOR` (consulta pura, sin modificar datos).
fn cursorable(kw: &str, sql: &str) -> bool {
    match kw {
        "SELECT" | "VALUES" | "TABLE" => true,
        "WITH" => !has_word(sql, &["INSERT", "UPDATE", "DELETE", "MERGE"]),
        _ => false,
    }
}

fn is_tx_control(words: &[String]) -> bool {
    matches!(
        words.first().map(String::as_str),
        Some("BEGIN" | "START" | "COMMIT" | "END" | "ROLLBACK" | "ABORT")
    ) || (words.first().map(String::as_str) == Some("PREPARE")
        && words.get(1).map(String::as_str) == Some("TRANSACTION"))
}

/// Sentencias que PostgreSQL no permite dentro de un bloque de transacción.
fn no_tx_block(words: &[String]) -> bool {
    let w = |i: usize| words.get(i).map(String::as_str).unwrap_or("");
    match w(0) {
        "VACUUM" => true,
        "ALTER" if w(1) == "SYSTEM" => true,
        "DISCARD" if w(1) == "ALL" => true,
        "CREATE" | "DROP" if matches!(w(1), "DATABASE" | "TABLESPACE" | "SUBSCRIPTION") => true,
        "ALTER" if w(1) == "SUBSCRIPTION" => true,
        "REINDEX" if matches!(w(1), "DATABASE" | "SYSTEM") => true,
        "COMMIT" | "ROLLBACK" if w(1) == "PREPARED" => true,
        "CREATE" | "DROP" | "REINDEX" => words.iter().any(|x| x == "CONCURRENTLY"),
        _ => false,
    }
}

/// Actualiza el estado de transacción tras una sentencia de control ejecutada con éxito.
fn track_tx(words: &[String], in_tx: &mut bool) {
    let w = |i: usize| words.get(i).map(String::as_str).unwrap_or("");
    match w(0) {
        "BEGIN" | "START" => *in_tx = true,
        "COMMIT" | "END" | "ROLLBACK" | "ABORT" => {
            if w(1) == "PREPARED" || words.iter().any(|x| x == "TO") {
                return; // COMMIT PREPARED / ROLLBACK TO SAVEPOINT
            }
            let chain = words.iter().any(|x| x == "CHAIN") && !words.iter().any(|x| x == "NO");
            *in_tx = chain;
        }
        "PREPARE" if w(1) == "TRANSACTION" => *in_tx = false,
        _ => {}
    }
}

// ───────────────────────────── tests ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sqls(v: &[Stmt]) -> Vec<&str> {
        v.iter().map(|s| s.sql.as_str()).collect()
    }

    #[test]
    fn split_basic_and_quotes() {
        let v = split_statements("select 1; select 'a;b' ; select \"x;y\" from t;;\n -- solo comentario;\n");
        assert_eq!(
            sqls(&v),
            vec!["select 1", "select 'a;b'", "select \"x;y\" from t"]
        );
        let v = split_statements("select 'it''s; ok'; select E'a\\';b'; select 2");
        assert_eq!(
            sqls(&v),
            vec!["select 'it''s; ok'", "select E'a\\';b'", "select 2"]
        );
        let v = split_statements("/* a; /* anidado; */ b; */ select 1; -- x;y\nselect 2");
        assert_eq!(v.len(), 2);
        assert!(v[0].sql.ends_with("select 1"));
        assert_eq!(v[1].sql, "-- x;y\nselect 2");
    }

    #[test]
    fn split_dollar_quotes() {
        let sql = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\n\
                   DO $body$ BEGIN RAISE NOTICE 'x;$$;y'; END $body$;\n\
                   SELECT $1, a$b FROM t; SELECT $tag$ ; $other$ ; $tag$";
        let v = split_statements(sql);
        assert_eq!(v.len(), 4, "{v:?}");
        assert!(v[0].sql.starts_with("CREATE FUNCTION") && v[0].sql.ends_with("plpgsql"));
        assert!(v[1].sql.starts_with("DO $body$") && v[1].sql.ends_with("$body$"));
        assert_eq!(v[2].sql, "SELECT $1, a$b FROM t");
        assert_eq!(v[3].sql, "SELECT $tag$ ; $other$ ; $tag$");
        assert_eq!(v[1].line, 1);
        assert_eq!(v[2].line, 2);
        assert_eq!(v[3].col, 23);
    }

    #[test]
    fn split_begin_atomic() {
        let sql = "CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN a > 0 THEN 1 ELSE 0 END; SELECT 2; END; SELECT 3";
        let v = split_statements(sql);
        assert_eq!(v.len(), 2, "{v:?}");
        assert!(v[0].sql.ends_with("END"));
        assert_eq!(v[1].sql, "SELECT 3");
        // BEGIN de transacción normal
        let v = split_statements("BEGIN; UPDATE t SET a = 1; COMMIT;");
        assert_eq!(sqls(&v), vec!["BEGIN", "UPDATE t SET a = 1", "COMMIT"]);
    }

    #[test]
    fn keyword_helpers() {
        assert_eq!(keywords("  -- c\n /* x */ (select 1)", 2), vec!["SELECT"]);
        assert!(may_return_rows("INSERT", "insert into t values (1) returning id"));
        assert!(!may_return_rows("INSERT", "insert into t values ('returning')"));
        assert!(cursorable("WITH", "with x as (select 1) select * from x"));
        assert!(!cursorable("WITH", "with x as (delete from t returning *) select * from x"));
        let w = keywords("create index concurrently i on t(a)", 6);
        assert!(no_tx_block(&w));
        assert!(no_tx_block(&keywords("VACUUM ANALYZE t", 6)));
        assert!(!no_tx_block(&keywords("create index i on t(a)", 6)));
        let mut tx = false;
        track_tx(&keywords("begin", 6), &mut tx);
        assert!(tx);
        track_tx(&keywords("rollback to savepoint a", 6), &mut tx);
        assert!(tx);
        track_tx(&keywords("commit and chain", 6), &mut tx);
        assert!(tx);
        track_tx(&keywords("end", 6), &mut tx);
        assert!(!tx);
        assert!(is_tx_control(&keywords("start transaction", 6)));
    }

    #[test]
    fn type_mapping() {
        assert!(matches!(text_cell(Some("42"), &Type::INT4), Cell::Int(42)));
        assert!(matches!(
            text_cell(Some("9007199254740993"), &Type::INT8),
            Cell::Text(ref s) if s == "9007199254740993"
        ));
        assert!(matches!(text_cell(Some("1.5"), &Type::FLOAT8), Cell::Num(v) if v == 1.5));
        assert!(matches!(text_cell(Some("NaN"), &Type::FLOAT8), Cell::Text(ref s) if s == "NaN"));
        assert!(matches!(text_cell(Some("t"), &Type::BOOL), Cell::Bool(true)));
        assert!(matches!(
            text_cell(Some("12345678901234567890.0123456789"), &Type::NUMERIC),
            Cell::Text(ref s) if s == "12345678901234567890.0123456789"
        ));
        assert!(matches!(
            text_cell(Some("\\xdeadBEEF"), &Type::BYTEA),
            Cell::Text(ref s) if s == "0xDEADBEEF"
        ));
        assert!(matches!(text_cell(Some("\\x"), &Type::BYTEA), Cell::Text(ref s) if s == "0x"));
        assert!(matches!(text_cell(None, &Type::INT4), Cell::Null));
        assert!(matches!(
            text_cell(Some("{1,2}"), &Type::INT4_ARRAY),
            Cell::Text(ref s) if s == "{1,2}"
        ));
        assert_eq!(type_label(&Type::INT4_ARRAY), "int4[]");
        assert_eq!(kind_of(&Type::INT8), ColKind::Number);
        assert_eq!(kind_of(&Type::NUMERIC), ColKind::Number);
        assert_eq!(kind_of(&Type::TIMESTAMPTZ), ColKind::Date);
        assert_eq!(kind_of(&Type::BYTEA), ColKind::Binary);
        assert_eq!(kind_of(&Type::UUID), ColKind::Text);
        assert_eq!(kind_of(&Type::JSONB), ColKind::Other);
        assert_eq!(kind_of(&Type::TEXT_ARRAY), ColKind::Other);
        assert_eq!(kind_from_category("N", "numeric"), ColKind::Number);
        assert_eq!(kind_from_category("U", "bytea"), ColKind::Binary);
        assert_eq!(kind_from_category("U", "uuid"), ColKind::Text);
        assert_eq!(kind_from_category("A", "_int4"), ColKind::Other);
    }

    #[test]
    fn conn_string_building() {
        let mut cfg = ConnConfig::default();
        cfg.host = "db.local".into();
        cfg.port = Some(6543);
        cfg.user = "o'neil".into();
        cfg.password = Some("p\\w".into());
        cfg.encryption = "login".into();
        cfg.extra = "application_name=x; connect_timeout=5".into();
        let s = conn_string(&cfg, "ventas").unwrap();
        assert!(s.contains("user='o\\'neil'"));
        assert!(s.contains("password='p\\\\w'"));
        assert!(s.contains("sslmode='prefer'"));
        assert!(s.contains("dbname='ventas'"));
        assert!(s.ends_with("application_name='x' connect_timeout='5'"));
        let parsed: std::result::Result<Config, _> = s.parse();
        assert!(parsed.is_ok());
        assert_eq!(sslmode("off"), "disable");
        assert_eq!(sslmode("required"), "require");
        cfg.extra = "nonsense".into();
        assert!(conn_string(&cfg, "").is_err());
    }

    #[test]
    fn error_location() {
        let st = Stmt {
            sql: "select\n  nope from t".into(),
            line: 3,
            col: 4,
        };
        assert_eq!(locate(&st, 1, 0), Some((4, 5)));
        assert_eq!(locate(&st, 10, 0), Some((5, 3)));
        assert_eq!(locate(&st, 15, 5), Some((5, 3)));
    }

    // ───────── integración (requiere CELER_PG_TEST) ─────────

    fn test_cfg() -> Option<ConnConfig> {
        let spec = std::env::var("CELER_PG_TEST").ok()?;
        let mut cfg = ConnConfig::default();
        cfg.kind = DbKind::Postgres;
        cfg.encryption = "off".into();
        for part in spec.split_whitespace() {
            if let Some((k, v)) = part.split_once('=') {
                match k {
                    "host" => cfg.host = v.into(),
                    "port" => cfg.port = v.parse().ok(),
                    "user" => cfg.user = v.into(),
                    "password" => cfg.password = Some(v.into()),
                    "dbname" => cfg.database = v.into(),
                    "sslmode" => cfg.encryption = v.into(),
                    _ => {}
                }
            }
        }
        Some(cfg)
    }

    fn driver() -> Option<PostgresDriver> {
        let cfg = test_cfg()?;
        Some(PostgresDriver::connect(cfg).expect("conexión de prueba"))
    }

    fn txt(c: &Cell) -> String {
        match c {
            Cell::Null => "NULL".into(),
            Cell::Bool(b) => b.to_string(),
            Cell::Int(i) => i.to_string(),
            Cell::Num(f) => f.to_string(),
            Cell::Text(s) => s.clone(),
        }
    }

    /// ¿Hay una transacción abierta en el servidor? (consulta directa, sin pasar por el driver)
    fn server_in_tx(d: &mut PostgresDriver) -> bool {
        let rows = d
            .client
            .simple_query("SELECT now() <> statement_timestamp()")
            .unwrap();
        rows.iter().any(|m| matches!(m, SimpleQueryMessage::Row(r) if r.get(0) == Some("t")))
    }

    /// Ajustes › Ejecución › tiempo máximo: the core's deadline cancels through the driver and the session answers again.
    #[test]
    fn pg_query_timeout_cancels() {
        let Some(mut d) = driver() else { return };
        let t0 = std::time::Instant::now();
        let cancel = d.canceller();
        let r = crate::session::with_deadline(cancel, 1, || d.execute("SELECT pg_sleep(20)", 10));
        assert_eq!(r.err(), Some(crate::session::timeout_error(1)));
        assert!(t0.elapsed() < std::time::Duration::from_secs(10), "{:?}", t0.elapsed());
        assert_eq!(txt(&d.execute("SELECT 7", 10).unwrap().results[0].rows[0][0]), "7");
    }

    /// Ayuda › Registro de errores: a PostgreSQL error with a value in it is logged without the value.
    #[test]
    fn pg_error_log_entry_is_scrubbed() {
        let Some(mut d) = driver() else { return };
        let e = d.execute("SELECT 'celer-secret-42'::int", 10).expect_err("valor no numérico").to_string();
        crate::errlog::assert_scrubbed("PostgreSQL", &e, "celer-secret-42");
        let cfg = test_cfg().unwrap();
        crate::assert_report_banner("PostgreSQL", &d.server_info().unwrap(), &[&cfg.host, &cfg.user, &cfg.database]);
    }

    #[test]
    fn pg_read_only_enforced_by_server() {
        let Some(mut cfg) = test_cfg() else { return };
        cfg.read_only = true;
        let mut d = PostgresDriver::connect(cfg).expect("conexión de prueba");
        let out = d.execute("SHOW default_transaction_read_only", 10).unwrap();
        assert_eq!(txt(&out.results[0].rows[0][0]), "on");
        // Something the core's keyword check would not catch is still refused by the server.
        let e = d.execute("WITH x AS (DELETE FROM public.events WHERE false RETURNING 1) SELECT * FROM x", 10);
        assert!(e.is_err());
    }

    #[test]
    fn pg_paging_with_server_cursor() {
        let Some(mut d) = driver() else { return };
        let out = d
            .execute("SELECT id, kind, payload FROM public.events ORDER BY id; SELECT 'z' AS k", 1000)
            .unwrap();
        assert_eq!(out.results.len(), 1);
        let rs = &out.results[0];
        assert_eq!(rs.rows.len(), 1000);
        assert!(rs.has_more);
        assert!(!out.in_transaction, "autocommit: el cursor interno no cuenta como transacción");
        assert_eq!(rs.columns[0].kind, ColKind::Number);
        assert_eq!(rs.columns[2].type_name, "jsonb");
        let mut total = rs.rows.len();
        let mut last_id = txt(&rs.rows[999][0]);
        let mut extra = vec![];
        loop {
            let f = d.fetch(50_000).unwrap();
            total += f.rows.len();
            if let Some(r) = f.rows.last() {
                last_id = txt(&r[0]);
            }
            if !f.has_more {
                extra = f.extra;
                break;
            }
        }
        assert_eq!(total, 200_000);
        assert_eq!(last_id, "200000");
        assert_eq!(extra.len(), 1);
        assert_eq!(txt(&extra[0].rows[0][0]), "z");
        assert!(!server_in_tx(&mut d), "la transacción interna debe cerrarse al agotar el cursor");

        // Cerrar el cursor a medias tampoco deja una transacción abierta.
        let out = d.execute("SELECT * FROM public.events", 10).unwrap();
        assert!(out.results[0].has_more);
        d.close_cursor().unwrap();
        assert!(!server_in_tx(&mut d));
        // Y ejecutar otra cosa con un cursor pendiente lo cierra.
        d.execute("SELECT * FROM public.events", 10).unwrap();
        let out = d.execute("SELECT count(*) FROM public.events", 10).unwrap();
        assert_eq!(txt(&out.results[0].rows[0][0]), "200000");
        assert!(!out.in_transaction);
        assert!(!server_in_tx(&mut d));

        // Statements behind a paged result: told when it opens, and when they are dropped.
        let out = d.execute("SELECT * FROM public.events; SELECT 1; SELECT 2", 10).unwrap();
        assert!(out.messages.iter().any(|m| m.starts_with("Quedan 2 sentencias")), "{:?}", out.messages);
        let out = d.execute("SELECT 3", 10).unwrap();
        assert!(out.messages.iter().any(|m| m.starts_with("No se ejecutaron 2 sentencias")), "{:?}", out.messages);
        let out = d.execute("SELECT 4", 10).unwrap();
        assert!(out.messages.is_empty(), "{:?}", out.messages);
    }

    #[test]
    fn pg_types_and_messages() {
        let Some(mut d) = driver() else { return };
        let out = d
            .execute(
                "SELECT c_bigint, c_numeric, c_bool, c_bytea, c_uuid, c_jsonb, c_tstz, c_int_arr, c_point, c_enum, c_double, c_interval \
                 FROM public.type_showcase ORDER BY id",
                100,
            )
            .unwrap();
        let rs = &out.results[0];
        assert_eq!(rs.rows.len(), 3);
        let r = &rs.rows[0];
        assert_eq!(txt(&r[0]), "9007199254740993");
        assert_eq!(txt(&r[1]), "12345678901234567890.0123456789");
        assert!(matches!(r[2], Cell::Bool(true)));
        assert_eq!(txt(&r[3]), "0xDEADBEEF");
        assert_eq!(txt(&r[4]), "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
        assert!(txt(&r[5]).contains("[1, 2, 3]"));
        assert!(txt(&r[6]).starts_with("2026-10-07"));
        assert_eq!(txt(&r[7]), "{1,2,3}");
        assert_eq!(txt(&r[8]), "(1.5,2)");
        assert_eq!(txt(&r[9]), "gold");
        assert!(rs.rows[1].iter().all(|c| matches!(c, Cell::Null)));
        assert_eq!(txt(&rs.rows[2][10]), "Infinity");
        assert_eq!(rs.columns[1].kind, ColKind::Number);
        assert_eq!(rs.columns[3].kind, ColKind::Binary);
        assert_eq!(rs.columns[7].type_name, "int4[]");
        assert_eq!(rs.columns[9].kind, ColKind::Text);

        // Avisos del servidor, DO con $$ y recuentos.
        let out = d
            .execute(
                "DO $$ BEGIN RAISE NOTICE 'hola; desde DO'; END $$;\n\
                 SELECT sales.order_total(1);\n\
                 CREATE TEMP TABLE tmp_x (id int);\n\
                 INSERT INTO tmp_x VALUES (1), (2) RETURNING id;\n\
                 UPDATE tmp_x SET id = id + 1",
                100,
            )
            .unwrap();
        assert_eq!(out.results.len(), 5);
        assert!(out.messages.iter().any(|m| m.contains("hola; desde DO")), "{:?}", out.messages);
        assert!(out.messages.iter().any(|m| m.contains("Pedido 1")), "{:?}", out.messages);
        assert_eq!(out.results[3].rows.len(), 2);
        assert_eq!(out.results[4].rows_affected, Some(2));

        // Errores con posición y recuperación.
        let err = d.execute("SELECT 1;\n\nSELECT nope FROM public.countries", 10).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("42703") && msg.contains("línea 3"), "{msg}");
        let out = d.execute("SELECT 1", 10).unwrap();
        assert!(!out.in_transaction);
        assert!(d.execute("COPY public.countries TO STDOUT", 10).is_err());
        // SHOW / EXPLAIN / RETURNING se leen enteros y se paginan en memoria.
        let out = d.execute("EXPLAIN SELECT * FROM public.events", 1).unwrap();
        assert_eq!(out.results[0].columns[0].name, "QUERY PLAN");
        let out = d
            .execute("CREATE TEMP TABLE ret_t AS SELECT g FROM generate_series(1, 25) g; DELETE FROM ret_t RETURNING g; SELECT 'fin'", 10)
            .unwrap();
        assert_eq!(out.results[1].rows.len(), 10);
        assert!(out.results[1].has_more);
        let f = d.fetch(10).unwrap();
        assert!(f.has_more && f.rows.len() == 10);
        let f = d.fetch(10).unwrap();
        assert!(!f.has_more && f.rows.len() == 5);
        assert_eq!(txt(&f.extra[0].rows[0][0]), "fin");
        // Sentencia SELECT ... INTO (no devuelve filas).
        let out = d
            .execute("SELECT 1 AS a INTO TEMP sel_into; SELECT * FROM sel_into", 10)
            .unwrap();
        assert_eq!(out.results[0].rows_affected, Some(1));
        assert_eq!(out.results[1].rows.len(), 1);
    }

    #[test]
    fn pg_transactions() {
        let Some(mut d) = driver() else { return };
        d.execute("CREATE TEMP TABLE tx_t (id int)", 10).unwrap();
        // Modo manual: BEGIN implícito hasta commit/rollback.
        assert!(!d.set_autocommit(false).unwrap());
        let out = d.execute("INSERT INTO tx_t VALUES (1)", 10).unwrap();
        assert!(out.in_transaction);
        // Un cursor dentro de la transacción del usuario no la cierra.
        let out = d.execute("SELECT * FROM public.events", 5).unwrap();
        assert!(out.in_transaction && out.results[0].has_more);
        d.close_cursor().unwrap();
        assert!(server_in_tx(&mut d));
        assert!(!d.rollback().unwrap());
        let out = d.execute("SELECT count(*) FROM tx_t", 10).unwrap();
        assert_eq!(txt(&out.results[0].rows[0][0]), "0");
        assert!(out.in_transaction);
        d.execute("INSERT INTO tx_t VALUES (2)", 10).unwrap();
        assert!(!d.commit().unwrap());
        // Un error deja la transacción abortada (sigue abierta) hasta deshacerla.
        d.execute("SELECT 1/0", 10).unwrap_err();
        let out = d.execute("SELECT 1", 10);
        assert!(out.is_err());
        assert!(!d.rollback().unwrap());
        assert!(!d.set_autocommit(true).unwrap());
        let out = d.execute("SELECT count(*) FROM tx_t", 10).unwrap();
        assert_eq!(txt(&out.results[0].rows[0][0]), "1");
        assert!(!out.in_transaction);
        // BEGIN explícito en modo autocommit.
        let out = d.execute("BEGIN; INSERT INTO tx_t VALUES (3)", 10).unwrap();
        assert!(out.in_transaction);
        let out = d.execute("ROLLBACK", 10).unwrap();
        assert!(!out.in_transaction);
        // VACUUM no se envuelve en transacción en modo manual.
        d.set_autocommit(false).unwrap();
        d.execute("VACUUM tx_t", 10).unwrap();
        d.set_autocommit(true).unwrap();
        // Errores en autocommit no dejan transacción abierta.
        d.execute("SELECT * FROM public.events WHERE 1/(id - 5000) > 0", 10_000)
            .unwrap_err();
        assert!(!server_in_tx(&mut d));
    }

    #[test]
    fn pg_cancel() {
        let Some(mut d) = driver() else { return };
        let cancel = d.canceller();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            cancel();
        });
        let t0 = std::time::Instant::now();
        let err = d.execute("SELECT pg_sleep(20)", 10).unwrap_err();
        t.join().unwrap();
        assert!(err.to_string().contains("cancelada"), "{err}");
        assert!(t0.elapsed() < Duration::from_secs(10));
        assert!(d.execute("SELECT 1", 10).is_ok());
    }

    #[test]
    fn pg_metadata() {
        let Some(mut d) = driver() else { return };
        let db = d.current_database().unwrap();
        assert_eq!(db, "celer");
        assert!(d.server_info().unwrap().starts_with("PostgreSQL 17"));
        let dbs = d.children(&[]).unwrap();
        assert!(dbs.iter().any(|n| n.name == "celer"));
        assert!(dbs.iter().any(|n| n.name == "analytics"));
        assert!(d.databases().unwrap().contains(&"analytics".to_string()));
        let schemas = d.children(&["celer".into()]).unwrap();
        assert_eq!(schemas[0].name, "public");
        assert!(schemas.iter().any(|n| n.name == "sales"));
        assert!(!schemas.iter().any(|n| n.name.starts_with("pg_toast")));
        assert_eq!(schemas.last().unwrap().detail.as_deref(), Some("sistema"));

        let p = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let tables = d.children(&p(&["celer", "public", "tables"])).unwrap();
        let ev = tables.iter().find(|n| n.name == "events").unwrap();
        assert_eq!(ev.kind, "table");
        assert!(ev.detail.as_deref().unwrap().starts_with("~"), "{:?}", ev.detail);
        assert_eq!(ev.obj.as_ref().unwrap().kind, "table");
        let views = d.children(&p(&["celer", "public", "views"])).unwrap();
        assert!(views.iter().any(|n| n.name == "v_active_customers"));
        let mv = d.children(&p(&["celer", "public", "matviews"])).unwrap();
        assert!(mv.iter().any(|n| n.name == "mv_customer_totals"));
        let funcs = d.children(&p(&["celer", "public", "functions"])).unwrap();
        assert!(funcs.iter().any(|n| n.name == "full_name"));
        assert!(!funcs.iter().any(|n| n.name == "crypt"), "funciones de extensiones ocultas");
        let procs = d.children(&p(&["celer", "sales", "procedures"])).unwrap();
        assert!(procs.iter().any(|n| n.name == "cancel_order"));
        let seqs = d.children(&p(&["celer", "sales", "sequences"])).unwrap();
        assert!(seqs.iter().any(|n| n.name == "ticket_seq"));

        let cols = d
            .children(&p(&["celer", "public", "tables", "customers"]))
            .unwrap();
        assert_eq!(cols[0].name, "id");
        assert_eq!(cols[0].kind, "pkcolumn");
        assert!(cols[0].detail.as_deref().unwrap().contains("identity"));
        assert!(cols.iter().any(|n| n.kind == "folder" && n.path.last().unwrap() == "fks"));
        let idx = d
            .children(&p(&["celer", "public", "tables", "customers", "indexes"]))
            .unwrap();
        assert!(idx.iter().any(|n| n.name == "customers_email_uq" && n.detail.as_deref().unwrap().contains("único")));
        assert!(idx.iter().any(|n| n.detail.as_deref().unwrap().contains("PK")));
        let fks = d
            .children(&p(&["celer", "sales", "tables", "order_lines", "fks"]))
            .unwrap();
        assert_eq!(fks.len(), 2);
        assert!(fks.iter().any(|n| n.detail.as_deref().unwrap().contains("sales.products(sku)")));
        assert!(fks.iter().any(|n| n.obj.as_ref().is_some_and(|o| o.schema == "sales" && o.name == "products")));
        let trg = d
            .children(&p(&["celer", "public", "tables", "customers", "triggers"]))
            .unwrap();
        assert_eq!(trg[0].name, "customers_touch");

        // Otra base de datos sin cambiar la actual.
        let other = d.children(&p(&["analytics"])).unwrap();
        assert!(other.iter().any(|n| n.name == "reporting"));
        let ot = d.children(&p(&["analytics", "reporting", "tables"])).unwrap();
        assert_eq!(ot[0].name, "daily_visits");
        assert_eq!(d.current_database().unwrap(), "celer");

        // Columnas para el editor.
        let obj = ObjectRef::new("celer", "public", "customers", "table");
        let tc = d.table_columns(&obj).unwrap();
        assert!(tc[0].primary_key && tc[0].identity && !tc[0].nullable);
        let credit = tc.iter().find(|c| c.name == "credit").unwrap();
        assert_eq!(credit.type_name, "numeric(12,2)");
        assert_eq!(credit.kind, ColKind::Number);
        assert!(credit.default.as_deref().unwrap().starts_with('0'));
        let tier = tc.iter().find(|c| c.name == "tier").unwrap();
        assert_eq!(tier.kind, ColKind::Text);
        let tags = tc.iter().find(|c| c.name == "tags").unwrap();
        assert!(tags.nullable && tags.type_name == "text[]");

        // DDL.
        let ddl = d.ddl(&obj).unwrap();
        for needle in [
            "CREATE TABLE \"public\".\"customers\"",
            "GENERATED ALWAYS AS IDENTITY",
            "PRIMARY KEY (id)",
            "REFERENCES countries(code)",
            "CHECK (credit >= ",
            "CREATE UNIQUE INDEX customers_email_uq",
            "COMMENT ON COLUMN",
            "CREATE TRIGGER customers_touch",
        ] {
            assert!(ddl.contains(needle), "falta {needle}:\n{ddl}");
        }
        let v = d
            .ddl(&ObjectRef::new("celer", "sales", "v_order_totals", "view"))
            .unwrap();
        assert!(v.starts_with("CREATE OR REPLACE VIEW \"sales\".\"v_order_totals\" AS"));
        let m = d
            .ddl(&ObjectRef::new("celer", "public", "mv_customer_totals", "view"))
            .unwrap();
        assert!(m.contains("CREATE MATERIALIZED VIEW") && m.contains("mv_customer_totals_pk"));
        let f = d
            .ddl(&ObjectRef::new("celer", "sales", "order_total", "function"))
            .unwrap();
        assert!(f.contains("CREATE OR REPLACE FUNCTION sales.order_total"));
        let sq = d
            .ddl(&ObjectRef::new("celer", "sales", "ticket_seq", "sequence"))
            .unwrap();
        assert!(sq.contains("INCREMENT BY 5") && sq.contains("CYCLE"));
        let t = d
            .ddl(&ObjectRef::new("celer", "public", "customers_touch", "trigger"))
            .unwrap();
        assert!(t.starts_with("CREATE TRIGGER customers_touch"));
        let other_ddl = d
            .ddl(&ObjectRef::new("analytics", "reporting", "daily_visits", "table"))
            .unwrap();
        assert!(other_ddl.contains("\"reporting\".\"daily_visits\""));
        let odd = d
            .ddl(&ObjectRef::new("celer", "sales", "Mixed Case \"Table\"", "table"))
            .unwrap();
        assert!(odd.contains("\"sales\".\"Mixed Case \"\"Table\"\"\""));

        // Autocompletado.
        let comp = d.completion("").unwrap();
        let orders = comp
            .tables
            .iter()
            .find(|t| t.schema == "sales" && t.name == "orders")
            .unwrap();
        assert_eq!(orders.columns[0], "id");
        assert!(comp.tables.iter().any(|t| t.name == "v_active_customers"));
        assert!(!comp.tables.iter().any(|t| t.schema == "pg_catalog"));

        assert_eq!(
            d.qualified_name(&ObjectRef::new("celer", "sales", "a\"b", "table")),
            "\"sales\".\"a\"\"b\""
        );

        // Cambio de base de datos.
        d.use_database("analytics").unwrap();
        assert_eq!(d.current_database().unwrap(), "analytics");
        let out = d.execute("SELECT count(*) FROM reporting.daily_visits", 10).unwrap();
        assert_eq!(txt(&out.results[0].rows[0][0]), "90");
        // Metadatos de la base actual mientras hay un cursor abierto (conexión secundaria).
        d.execute("SELECT * FROM reporting.daily_visits", 5).unwrap();
        let back = d.children(&p(&["celer", "public", "tables"])).unwrap();
        assert!(back.iter().any(|n| n.name == "events"));
        assert_eq!(d.fetch(1000).unwrap().rows.len(), 85);
        d.use_database("celer").unwrap();
        assert_eq!(d.current_database().unwrap(), "celer");
    }
}
