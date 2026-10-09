//! Driver basado en ODBC/CLI: Informix (DRDA o SQLI) y conexiones ODBC genéricas. The Informix dialect (catalog
//! queries, batches split per statement, DDL, database switching…) works over any `Link`: ODBC/CLI here, or the JDBC
//! bridge (jdbc.rs).

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, bail, Result};

use crate::model::*;
use crate::mssql::{cell_i64, cell_str, fmt_rows, kind_from_type};
use crate::odbc::*;
use crate::session::{first_keyword, Canceller, Driver, FkColumn};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Informix,
    Generic,
}

/// What the driver needs from a connection: run a statement, read metadata, transactions, cancel and reconnect.
pub trait Link: Send + Sized + 'static {
    type Stmt: LinkStmt;
    /// Runs one statement. `fetch`: rows the caller reads first (the JDBC bridge sends them with its answer).
    fn exec(&mut self, sql: &str, fetch: usize) -> Result<Self::Stmt>;
    /// Every row of the first result (metadata queries).
    fn query_all(&self, sql: &str) -> Result<Vec<Vec<Cell>>>;
    fn set_autocommit(&mut self, on: bool) -> Result<()>;
    fn end_tran(&mut self, commit: bool) -> Result<()>;
    /// Product and version of the server.
    fn server_info(&self) -> String;
    /// Cancels, from another thread, what the connection is running; it keeps working after `reconnect`.
    fn canceller(&self) -> Canceller;
    /// A new connection in place of this one (Informix changes database by reconnecting).
    fn reconnect(&mut self, cfg: &ConnConfig, database: Option<&str>) -> Result<()>;
    /// Generic ODBC sources need the catalog functions of the ODBC connection itself.
    fn odbc(&self) -> Option<&OdbcConn> {
        None
    }
    /// The connection was cut (a cancel the server did not obey, on JDBC): the next operation opens a new one.
    fn reset_pending(&self) -> bool {
        false
    }
}

/// A statement run on a `Link`: its results, read in pages.
pub trait LinkStmt: Send {
    fn num_cols(&mut self) -> Result<usize>;
    /// Describes the current result and prepares to read it.
    fn begin_result(&mut self, ncols: usize) -> Result<()>;
    fn columns(&self) -> &[ColumnInfo];
    fn in_result(&self) -> bool;
    /// Up to `n` rows of the current result, and whether more remain.
    fn read(&mut self, n: usize) -> Result<(Vec<Vec<Cell>>, bool)>;
    fn row_count(&self) -> i64;
    /// Moves to the next result of the statement; false when there is none.
    fn more_results(&mut self) -> Result<bool>;
    fn messages(&mut self) -> &mut Vec<String>;
}

impl Link for OdbcConn {
    type Stmt = Stmt;

    fn exec(&mut self, sql: &str, _fetch: usize) -> Result<Stmt> {
        let mut st = self.alloc_stmt()?;
        st.register_cancel(self.cancel_slot.clone());
        st.exec(sql)?;
        Ok(st)
    }

    fn query_all(&self, sql: &str) -> Result<Vec<Vec<Cell>>> {
        OdbcConn::query_all(self, sql)
    }

    fn set_autocommit(&mut self, on: bool) -> Result<()> {
        OdbcConn::set_autocommit(self, on)
    }

    fn end_tran(&mut self, commit: bool) -> Result<()> {
        OdbcConn::end_tran(self, commit)
    }

    fn server_info(&self) -> String {
        format!("{} {}", self.info(SQL_DBMS_NAME), self.info(SQL_DBMS_VER)).trim().to_string()
    }

    fn canceller(&self) -> Canceller {
        let slot = self.cancel_slot.clone();
        let api = self.api.clone();
        Arc::new(move || cancel_stmt(&api, &slot))
    }

    fn reconnect(&mut self, cfg: &ConnConfig, database: Option<&str>) -> Result<()> {
        if is_drda(cfg) {
            crate::drivers::cli_acr_off(None, &cfg.host, cfg.port.unwrap_or(9089), database.unwrap_or(&cfg.database));
        }
        let mut conn = OdbcConn::connect(self.api.clone(), &conn_string(cfg, database), 20).map_err(|e| explain_odbc(cfg, e))?;
        conn.cancel_slot = self.cancel_slot.clone();
        *self = conn;
        Ok(())
    }

    fn odbc(&self) -> Option<&OdbcConn> {
        Some(self)
    }
}

impl LinkStmt for Stmt {
    fn num_cols(&mut self) -> Result<usize> {
        Stmt::num_cols(self)
    }

    fn begin_result(&mut self, ncols: usize) -> Result<()> {
        Stmt::begin_result(self, ncols)
    }

    fn columns(&self) -> &[ColumnInfo] {
        &self.columns
    }

    fn in_result(&self) -> bool {
        self.in_result
    }

    fn read(&mut self, n: usize) -> Result<(Vec<Vec<Cell>>, bool)> {
        Stmt::read(self, n)
    }

    fn row_count(&self) -> i64 {
        Stmt::row_count(self)
    }

    fn more_results(&mut self) -> Result<bool> {
        Stmt::more_results(self)
    }

    fn messages(&mut self) -> &mut Vec<String> {
        &mut self.messages
    }
}

/// Informix (DRDA or SQLI, ODBC or JDBC) and generic ODBC sources, over a `Link`.
pub struct LinkDriver<L: Link> {
    cfg: ConnConfig,
    dialect: Dialect,
    conn: L,
    stmt: Option<L::Stmt>,
    /// Statements of a batch still to run (Informix runs one statement per call: the batch is split).
    pending: VecDeque<String>,
    /// Statements of a script dropped with its open result, told in the next execute's messages.
    discarded: usize,
    autocommit: bool,
    in_tx: bool,
    database: String,
    /// Informix: `database` es la base en la que está la sesión (se pregunta solo si no se sabe: un DATABASE del
    /// usuario la cambia).
    db_known: bool,
    quote: String,
}

pub type OdbcDriver = LinkDriver<OdbcConn>;

impl LinkDriver<OdbcConn> {
    pub fn connect(cfg: ConnConfig, lib_path: String) -> Result<OdbcDriver> {
        // Before the IBM CLI driver loads (it reads its db2dsdriver.cfg then): no reconnection of its own.
        if is_drda(&cfg) {
            crate::drivers::cli_acr_off(Some(std::path::Path::new(&lib_path)), &cfg.host, cfg.port.unwrap_or(9089), &cfg.database);
        }
        let api = Api::load(&lib_path)?;
        let conn = OdbcConn::connect(api, &conn_string(&cfg, None), 20).map_err(|e| explain_odbc(&cfg, e))?;
        LinkDriver::over(cfg, conn)
    }
}

impl<L: Link> LinkDriver<L> {
    /// The driver over an open connection: runs the startup script and reads what it needs.
    pub fn over(cfg: ConnConfig, mut conn: L) -> Result<LinkDriver<L>> {
        let dialect = if cfg.kind == DbKind::Informix {
            Dialect::Informix
        } else {
            Dialect::Generic
        };
        run_startup(&mut conn, &cfg)?;
        let quote = match conn.odbc().map(|c| c.info(SQL_IDENTIFIER_QUOTE_CHAR)).unwrap_or_default().trim() {
            "" => "\"".to_string(),
            q => q.to_string(),
        };
        let mut d = LinkDriver {
            database: cfg.database.trim().to_string(),
            db_known: !cfg.database.trim().is_empty(),
            cfg,
            dialect,
            conn,
            stmt: None,
            pending: VecDeque::new(),
            discarded: 0,
            autocommit: true,
            in_tx: false,
            quote,
        };
        if d.database.is_empty() {
            d.database = d.current_database().unwrap_or_default();
        }
        Ok(d)
    }

    /// After a connection was cut: a new one in its place, on the same database (startup script and manual mode
    /// again). If it cannot be opened now, the next operation tries again.
    fn recover(&mut self) {
        if !self.conn.reset_pending() {
            return;
        }
        let db = self.database.clone();
        // Back in the database it had: it is known again.
        if self.reconnect((!db.is_empty()).then_some(db.as_str())).is_ok() && !db.is_empty() {
            self.db_known = true;
        }
    }

    /// An error of a statement: if it cut the connection, a new one is opened now, and the user is told when an
    /// open transaction was lost with it.
    fn after_error(&mut self, e: anyhow::Error) -> anyhow::Error {
        if !self.conn.reset_pending() {
            return e;
        }
        let lost = self.in_tx;
        self.recover();
        if lost {
            anyhow!("{e}\nLa transacción que estaba abierta se ha perdido: sus cambios se han deshecho.")
        } else {
            e
        }
    }

    /// Closes the open result; the statements of its script still waiting are dropped (and told on the next run).
    fn drop_pending(&mut self) {
        self.stmt = None;
        self.discarded += self.pending.len();
        self.pending.clear();
    }

    fn execute_batch(&mut self, sql: &str, fetch: usize) -> Result<ExecOutput> {
        let t0 = Instant::now();
        self.drop_pending();
        let mut out = ExecOutput::default();
        out.messages.extend(crate::session::discarded_note(std::mem::take(&mut self.discarded)));
        self.pending = split_batch(sql, self.dialect).into();
        if self.pending.iter().any(|st| matches!(first_keyword(st).as_str(), "DATABASE" | "CLOSE" | "CONNECT" | "DISCONNECT")) {
            self.db_known = false;
        }
        let r = self.run_pending(fetch.max(1), &mut out.results, &mut out.messages);
        out.in_transaction = self.in_tx;
        r?;
        if self.stmt.is_some() {
            out.messages.extend(crate::session::pending_note(self.pending.len()));
        }
        out.elapsed_ms = t0.elapsed().as_millis() as u64;
        Ok(out)
    }

    fn fetch_more(&mut self, n: usize) -> Result<FetchOutput> {
        let mut out = FetchOutput::default();
        let Some(st) = self.stmt.as_mut() else {
            return Ok(out);
        };
        if st.in_result() {
            match st.read(n.max(1)) {
                Ok((rows, more)) => {
                    out.rows = rows;
                    out.has_more = more;
                }
                Err(e) => {
                    self.stmt = None;
                    self.pending.clear();
                    return Err(e);
                }
            }
        }
        if !out.has_more {
            let st = self.stmt.as_mut().unwrap();
            if st.more_results()? {
                let mut msgs = vec![];
                out.extra = self.pump(n.max(1), &mut msgs)?;
            } else {
                self.stmt = None;
            }
        }
        // The rest of a split batch.
        if self.stmt.is_none() && !self.pending.is_empty() {
            let mut msgs = vec![];
            self.run_pending(n.max(1), &mut out.extra, &mut msgs)?;
        }
        Ok(out)
    }

    /// The ODBC connection, for generic ODBC sources (catalog functions).
    fn odbc(&self) -> Result<&OdbcConn> {
        self.conn.odbc().ok_or_else(|| anyhow!("Solo disponible en conexiones ODBC"))
    }

    /// Runs the batch's statements in turn, adding their results, until one leaves rows to read (its cursor stays
    /// open for `fetch`) or none is left. An error stops the batch: the statements after it do not run.
    fn run_pending(&mut self, fetch: usize, results: &mut Vec<ResultSet>, messages: &mut Vec<String>) -> Result<()> {
        let total = self.pending.len();
        while self.stmt.is_none() {
            let Some(sql) = self.pending.pop_front() else { break };
            let r = self.conn.exec(&sql, fetch);
            if !self.autocommit {
                self.in_tx = true;
            }
            let st = match r {
                Ok(st) => st,
                Err(e) => {
                    let done = total - self.pending.len();
                    self.pending.clear();
                    if total > 1 {
                        bail!("Sentencia {done} de {total}: {e}");
                    }
                    bail!(e);
                }
            };
            self.stmt = Some(st);
            results.extend(self.pump(fetch, messages)?);
        }
        Ok(())
    }

    fn q(&self, rows: &str) -> Result<Vec<Vec<Cell>>> {
        self.conn.query_all(rows)
    }

    /// Generic ODBC: the foreign keys SQLForeignKeys lists for a table (`table` None: for every table of the source,
    /// which only some drivers accept), joined per key in KEY_SEQ order.
    fn generic_foreign_keys(&self, cat: &str, sch: &str, table: Option<&str>) -> Result<Vec<SchemaForeignKey>> {
        let rows = self.odbc()?.catalog_fks([Some(cat), Some(sch), table])?;
        let mut rows: Vec<&Vec<Cell>> = rows.iter().filter(|r| r.len() >= 12).collect();
        // Per key, its columns in KEY_SEQ order (drivers sort by table and KEY_SEQ, not always by key first).
        rows.sort_by_key(|r| (cell_str(&r[4]), cell_str(&r[5]), cell_str(&r[6]), cell_str(&r[11]), cell_str(&r[0]), cell_str(&r[1]), cell_str(&r[2]), cell_i64(&r[8])));
        Ok(crate::session::group_foreign_keys(rows.into_iter().map(|r| {
            let (fk_cat, fk_sch, fk_table) = (cell_str(&r[4]), cell_str(&r[5]), cell_str(&r[6]));
            let name = match cell_str(&r[11]) {
                n if n.is_empty() => format!("fk_{fk_table}_{}", cell_str(&r[2])),
                n => n,
            };
            FkColumn {
                key: [fk_cat.as_str(), &fk_sch, &fk_table, &name, &cell_str(&r[0]), &cell_str(&r[1]), &cell_str(&r[2])].join("\u{0}"),
                name,
                table: ObjectRef::new(&fk_cat, &fk_sch, &fk_table, "table"),
                column: cell_str(&r[7]),
                target: ObjectRef::new(&cell_str(&r[0]), &cell_str(&r[1]), &cell_str(&r[2]), "table"),
                target_column: cell_str(&r[3]),
            }
        })))
    }

    /// Informix: every foreign key of a database in one catalog query. A key's columns are the parts of its index (and
    /// of the referenced constraint's index): the query gives one row per key, side and column, with the index's parts,
    /// whose order puts the columns in key order. Only the tables of the explorer's Tablas folder.
    fn ifx_schema_foreign_keys(&self, db: &str) -> Result<Vec<SchemaForeignKey>> {
        let rows = self.q(&ifx_schema_fks_sql(&self.ifx_db(db)))?;
        // Per constrid: name, owner, table, referenced owner and table, and each side's (position, column).
        struct Key {
            id: i64,
            fk: SchemaForeignKey,
            sides: [Vec<(usize, String)>; 2],
        }
        let mut keys: Vec<Key> = Vec::new();
        for r in &rows {
            let (side, id, colno) = (cell_i64(&r[0]).clamp(0, 1) as usize, cell_i64(&r[1]), cell_i64(&r[23]));
            let Some(pos) = r[7..23].iter().position(|p| colno != 0 && cell_i64(p).abs() == colno) else { continue };
            let at = match keys.iter().position(|k| k.id == id) {
                Some(at) => at,
                None => {
                    let fk = SchemaForeignKey {
                        name: cell_str(&r[2]),
                        table: ObjectRef::new(db, &cell_str(&r[3]), &cell_str(&r[4]), "table"),
                        columns: vec![],
                        target: ObjectRef::new(db, &cell_str(&r[5]), &cell_str(&r[6]), "table"),
                        target_columns: vec![],
                    };
                    keys.push(Key { id, fk, sides: [vec![], vec![]] });
                    keys.len() - 1
                }
            };
            keys[at].sides[side].push((pos, cell_str(&r[24])));
        }
        Ok(keys
            .into_iter()
            .map(|mut k| {
                for side in k.sides.iter_mut() {
                    side.sort();
                }
                k.fk.columns = k.sides[0].iter().map(|(_, c)| c.clone()).collect();
                k.fk.target_columns = k.sides[1].iter().map(|(_, c)| c.clone()).collect();
                k.fk
            })
            .collect())
    }

    /// Prefijo "base:" de Informix para consultar catálogos de otra base de datos.
    fn ifx_db(&self, db: &str) -> String {
        if db.is_empty() {
            String::new()
        } else {
            format!("{db}:")
        }
    }

    fn pump(&mut self, fetch: usize, messages: &mut Vec<String>) -> Result<Vec<ResultSet>> {
        let mut results = Vec::new();
        loop {
            let Some(st) = self.stmt.as_mut() else { break };
            let n = st.num_cols()?;
            if n > 0 {
                st.begin_result(n)?;
                let (rows, more) = st.read(fetch)?;
                results.push(ResultSet {
                    columns: st.columns().to_vec(),
                    rows,
                    has_more: more,
                    rows_affected: None,
                });
                if more {
                    messages.append(st.messages());
                    return Ok(results);
                }
            } else {
                let c = st.row_count();
                if c >= 0 {
                    results.push(ResultSet::count(c));
                }
            }
            match st.more_results() {
                Ok(true) => continue,
                Ok(false) => break,
                Err(e) => {
                    messages.push(e.to_string());
                    break;
                }
            }
        }
        if let Some(mut st) = self.stmt.take() {
            messages.append(st.messages());
        }
        Ok(results)
    }

    fn ifx_tabid(&self, o: &ObjectRef) -> Result<i64> {
        let rows = self.q(&format!(
            "SELECT tabid FROM {}systables WHERE tabname = {} AND owner = {}",
            self.ifx_db(&o.database),
            lit(&o.name),
            lit(&o.schema)
        ))?;
        rows.first()
            .map(|r| cell_i64(&r[0]))
            .ok_or_else(|| anyhow!("No se encontró {}", o.name))
    }

    /// (nombre, tipo, nullable, pk, serial, default)
    fn ifx_columns(
        &self,
        o: &ObjectRef,
    ) -> Result<Vec<(String, String, bool, bool, bool, Option<String>)>> {
        let db = self.ifx_db(&o.database);
        let tabid = self.ifx_tabid(o)?;
        let cols = self.q(&format!(
            "SELECT c.colname, c.coltype, c.collength, c.colno, c.extended_id, d.type, d.default \
             FROM {db}syscolumns c, OUTER {db}sysdefaults d \
             WHERE c.tabid = {tabid} AND d.tabid = c.tabid AND d.colno = c.colno ORDER BY c.colno"
        ))?;
        let pk = self.ifx_pk_colnos(&db, tabid)?;
        Ok(cols
            .iter()
            .map(|r| {
                let coltype = cell_i64(&r[1]);
                let base = coltype & 0xFF;
                let ty = ifx_type(coltype, cell_i64(&r[2]), cell_i64(&r[4]));
                let colno = cell_i64(&r[3]);
                let default = match cell_str(&r[5]).as_str() {
                    "L" => {
                        let v = cell_str(&r[6]);
                        // El literal se guarda con el tipo delante en algunos casos ("123 ").
                        Some(if matches!(base, 0 | 13 | 15 | 16 | 40) {
                            lit(v.trim_end())
                        } else {
                            v.trim().to_string()
                        })
                    }
                    "U" => Some("USER".into()),
                    "C" => Some("CURRENT".into()),
                    "N" => Some("NULL".into()),
                    "T" => Some("TODAY".into()),
                    "S" => Some("DBSERVERNAME".into()),
                    _ => None,
                };
                (
                    cell_str(&r[0]),
                    ty,
                    coltype & 0x100 == 0,
                    pk.contains(&colno),
                    matches!(base, 6 | 18 | 53),
                    default,
                )
            })
            .collect())
    }

    fn ifx_pk_colnos(&self, db: &str, tabid: i64) -> Result<Vec<i64>> {
        let parts = (1..=16)
            .map(|i| format!("i.part{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let rows = self.q(&format!(
            "SELECT {parts} FROM {db}sysconstraints c, {db}sysindexes i \
             WHERE c.tabid = {tabid} AND c.constrtype = 'P' AND i.idxname = c.idxname AND i.tabid = c.tabid"
        ))?;
        Ok(rows
            .first()
            .map(|r| {
                r.iter()
                    .map(|c| cell_i64(c).abs())
                    .filter(|n| *n > 0)
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Column names of an index of table `tabid`, in key order.
    fn ifx_index_cols(&self, db: &str, tabid: i64, idxname: &str) -> Result<Vec<String>> {
        let parts = (1..=16).map(|i| format!("part{i}")).collect::<Vec<_>>().join(", ");
        let rows = self.q(&format!("SELECT {parts} FROM {db}sysindexes WHERE tabid = {tabid} AND idxname = {}", lit(idxname)))?;
        let Some(row) = rows.first() else { return Ok(vec![]) };
        let cols = self.q(&format!("SELECT colno, TRIM(colname) FROM {db}syscolumns WHERE tabid = {tabid}"))?;
        Ok(row
            .iter()
            .map(cell_i64)
            .filter(|n| *n != 0)
            .filter_map(|n| cols.iter().find(|c| cell_i64(&c[0]) == n.abs()).map(|c| cell_str(&c[1])))
            .collect())
    }

    /// Primary key or unique constraints (`kind` 'P' or 'U') of table `tabid`: their columns, in key order.
    fn ifx_key_constraints(&self, db: &str, tabid: i64, kind: char) -> Result<Vec<Vec<String>>> {
        let rows = self.q(&format!(
            "SELECT idxname FROM {db}sysconstraints WHERE tabid = {tabid} AND constrtype = '{kind}' ORDER BY constrname"
        ))?;
        rows.iter().map(|r| self.ifx_index_cols(db, tabid, &cell_str(&r[0]))).collect()
    }

    /// Foreign keys of a table: (constraint, columns, referenced owner, referenced table, referenced columns, ON
    /// DELETE CASCADE).
    #[allow(clippy::type_complexity)]
    fn ifx_foreign_keys(&self, o: &ObjectRef) -> Result<Vec<(String, Vec<String>, String, String, Vec<String>, bool)>> {
        let db = self.ifx_db(&o.database);
        let tabid = self.ifx_tabid(o)?;
        let rows = self.q(&format!(
            // Index names as stored: the ones Informix generates for constraints start with a space (" 101_2").
            "SELECT TRIM(c.constrname), c.idxname, r.ptabid, TRIM(pt.tabname), TRIM(pt.owner), pc.idxname, r.delrule \
             FROM {db}sysconstraints c, {db}sysreferences r, {db}systables pt, {db}sysconstraints pc \
             WHERE c.tabid = {tabid} AND c.constrtype = 'R' AND r.constrid = c.constrid \
               AND pt.tabid = r.ptabid AND pc.constrid = r.primary ORDER BY 1"
        ))?;
        rows.iter()
            .map(|r| {
                let cols = self.ifx_index_cols(&db, tabid, &cell_str(&r[1]))?;
                let ref_cols = self.ifx_index_cols(&db, cell_i64(&r[2]), &cell_str(&r[5]))?;
                Ok((cell_str(&r[0]), cols, cell_str(&r[4]), cell_str(&r[3]), ref_cols, cell_str(&r[6]).trim() == "C"))
            })
            .collect()
    }

    fn ifx_indexes(&self, o: &ObjectRef) -> Result<Vec<(String, bool, String, bool)>> {
        let db = self.ifx_db(&o.database);
        let tabid = self.ifx_tabid(o)?;
        let parts = (1..=16)
            .map(|i| format!("part{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let cols = self.q(&format!(
            "SELECT colno, colname FROM {db}syscolumns WHERE tabid = {tabid}"
        ))?;
        let name_of = |n: i64| {
            cols.iter()
                .find(|r| cell_i64(&r[0]) == n.abs())
                .map(|r| {
                    let mut s = cell_str(&r[1]);
                    if n < 0 {
                        s.push_str(" DESC");
                    }
                    s
                })
                .unwrap_or_default()
        };
        let pk_idx: Vec<String> = self
            .q(&format!("SELECT idxname FROM {db}sysconstraints WHERE tabid = {tabid} AND constrtype IN ('P','U','R')"))?
            .iter()
            .map(|r| cell_str(&r[0]).trim().to_string())
            .collect();
        let rows = self.q(&format!("SELECT idxname, idxtype, {parts} FROM {db}sysindexes WHERE tabid = {tabid} ORDER BY idxname"))?;
        Ok(rows
            .iter()
            .map(|r| {
                let name = cell_str(&r[0]).trim().to_string();
                let unique = cell_str(&r[1]).trim() == "U";
                let colnames: Vec<String> = r[2..]
                    .iter()
                    .map(cell_i64)
                    .filter(|n| *n != 0)
                    .map(name_of)
                    .collect();
                let constraint = pk_idx.contains(&name);
                (name, unique, colnames.join(", "), constraint)
            })
            .collect())
    }

    fn generic_columns(&self, o: &ObjectRef) -> Result<Vec<TableColumn>> {
        let rows = self.odbc()?.catalog_columns(&o.database, &o.schema, &o.name)?;
        let pks: Vec<String> = self
            .odbc()?
            .catalog_pks(&o.database, &o.schema, &o.name)
            .unwrap_or_default()
            .iter()
            .map(|r| cell_str(&r[3]))
            .collect();
        Ok(rows
            .iter()
            .map(|r| {
                let ty = cell_str(&r[5]).to_lowercase();
                let size = cell_i64(&r[6]);
                let name = cell_str(&r[3]);
                let type_name = if matches!(ty.as_str(), "varchar" | "char" | "nvarchar" | "nchar")
                {
                    format!("{ty}({size})")
                } else {
                    ty.clone()
                };
                TableColumn {
                    primary_key: pks.contains(&name),
                    name,
                    type_name,
                    nullable: cell_i64(&r[10]) != 0,
                    identity: ty.contains("identity") || ty.contains("serial"),
                    default: r.get(12).and_then(|c| match c {
                        Cell::Text(s) if !s.is_empty() => Some(s.clone()),
                        _ => None,
                    }),
                    kind: kind_from_type(&ty),
                }
            })
            .collect())
    }

    fn reconnect(&mut self, database: Option<&str>) -> Result<()> {
        self.stmt = None;
        self.pending.clear();
        self.conn.reconnect(&self.cfg, database)?;
        run_startup(&mut self.conn, &self.cfg)?;
        if !self.autocommit {
            self.conn.set_autocommit(false)?;
        }
        self.in_tx = false;
        Ok(())
    }
}

/// The statements of a batch as the server must get them: Informix (over DRDA) runs one statement per call, so
/// a script is split (`;` outside strings and comments); an SPL routine (its body has `;`) goes whole, from
/// CREATE [DBA] PROCEDURE/FUNCTION to its END PROCEDURE/END FUNCTION. Other ODBC sources get the text as it is.
fn split_batch(sql: &str, dialect: Dialect) -> Vec<String> {
    if dialect != Dialect::Informix {
        return vec![sql.to_string()];
    }
    let parts = crate::startup::split(sql, DbKind::Informix);
    if parts.is_empty() {
        return vec![sql.to_string()];
    }
    let mut out: Vec<String> = Vec::new();
    // Inside a routine: its pieces go back together (a line break before each `;`, so a `--` comment that ended a
    // piece does not swallow it).
    let mut routine: Option<String> = None;
    for part in parts {
        let words = code_words(&part);
        if let Some(body) = routine.as_mut() {
            body.push_str("\n;\n");
            body.push_str(&part);
        } else {
            let w = |i: usize| words.get(i).map(String::as_str).unwrap_or("");
            let at = if w(1) == "DBA" { 2 } else { 1 };
            if w(0) == "CREATE" && matches!(w(at), "PROCEDURE" | "FUNCTION") && w(at + 1) != "FROM" && !ends_routine(&words) {
                routine = Some(part);
                continue;
            }
            out.push(part);
            continue;
        }
        if ends_routine(&words) {
            out.extend(routine.take());
        }
    }
    out.extend(routine);
    out
}

/// Whether the words of a piece close an SPL routine (END PROCEDURE, END FUNCTION).
fn ends_routine(words: &[String]) -> bool {
    words.windows(2).any(|p| p[0] == "END" && matches!(p[1].as_str(), "PROCEDURE" | "FUNCTION"))
}

/// The words of Informix SQL in upper case, without comments (`--`, `/* */`, `{ }`) or strings.
fn code_words(sql: &str) -> Vec<String> {
    let c: Vec<char> = sql.chars().collect();
    let mut code = String::new();
    let mut i = 0;
    while i < c.len() {
        let next = c.get(i + 1).copied();
        let skip_to = |from: usize, end: &str| -> usize {
            let rest: String = c[from..].iter().collect();
            rest.find(end).map_or(c.len(), |p| from + rest[..p].chars().count() + end.chars().count())
        };
        match c[i] {
            '-' if next == Some('-') => {
                i = skip_to(i, "\n");
                code.push(' ');
            }
            '/' if next == Some('*') => {
                i = skip_to(i + 2, "*/");
                code.push(' ');
            }
            '{' => {
                i = skip_to(i, "}");
                code.push(' ');
            }
            q @ ('\'' | '"') => {
                let mut k = i + 1;
                while k < c.len() && !(c[k] == q && c.get(k + 1) != Some(&q)) {
                    k += if c[k] == q { 2 } else { 1 };
                }
                i = k + 1;
                code.push(' ');
            }
            ch => {
                code.push(ch);
                i += 1;
            }
        }
    }
    code.to_uppercase().split(|ch: char| !(ch.is_alphanumeric() || ch == '_')).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

/// El script de inicio de la conexión, en cada conexión nueva (todavía en autocommit).
fn run_startup<L: Link>(conn: &mut L, cfg: &ConnConfig) -> Result<()> {
    for sql in crate::startup::statements(cfg) {
        conn.exec(&sql, 1).map_err(|e| crate::startup::failed(&sql, e))?;
    }
    Ok(())
}

/// Construye la cadena de conexión según el tipo de conexión. An empty database is left out (`DATABASE=;` makes the
/// IBM CLI driver fail with CLI0199E; DRDA needs one, which lib.rs asks for before connecting).
/// Informix over DRDA, through IBM's CLI driver (the Client SDK's ODBC driver is "sqli"; JDBC does not come here).
fn is_drda(cfg: &ConnConfig) -> bool {
    cfg.kind == DbKind::Informix && cfg.informix_mode != "sqli"
}

pub fn conn_string(cfg: &ConnConfig, database: Option<&str>) -> String {
    let db = database.unwrap_or(&cfg.database).trim();
    let pwd = cfg.password.clone().unwrap_or_default();
    let esc = |s: &str| {
        if s.contains(';') || s.contains('}') {
            format!("{{{}}}", s.replace('}', "}}"))
        } else {
            s.to_string()
        }
    };
    let database_kv = if db.is_empty() { String::new() } else { format!("DATABASE={db};") };
    let mut s = match (cfg.kind, cfg.informix_mode.as_str()) {
        (DbKind::Informix, "sqli") => format!(
            "DRIVER={{{IFX_ODBC_DRIVER}}};HOST={};SERVICE={};SERVER={};{database_kv}PROTOCOL=onsoctcp;UID={};PWD={};",
            cfg.host,
            cfg.port.unwrap_or(9088),
            cfg.instance,
            esc(&cfg.user),
            esc(&pwd)
        ),
        (DbKind::Informix, _) => format!(
            "{database_kv}HOSTNAME={};PORT={};PROTOCOL=TCPIP;UID={};PWD={};",
            cfg.host,
            cfg.port.unwrap_or(9089),
            esc(&cfg.user),
            esc(&pwd)
        ),
        _ => {
            let mut s = cfg.odbc_conn_str.trim().trim_end_matches(';').to_string();
            if !s.is_empty() {
                s.push(';');
            }
            if !cfg.user.is_empty() {
                s.push_str(&format!("UID={};", esc(&cfg.user)));
            }
            if !pwd.is_empty() {
                s.push_str(&format!("PWD={};", esc(&pwd)));
            }
            if database.is_some() {
                s.push_str(&database_kv);
            }
            s
        }
    };
    let extra = cfg.extra.trim();
    if !extra.is_empty() {
        s.push_str(extra);
        if !extra.ends_with(';') {
            s.push(';');
        }
    }
    s
}

/// An ODBC / IBM CLI connection error for Informix with what to do about it. A leading `INFORMIX_GUIDE:<topic>:`
/// makes the interface offer its guide on that topic (sdk, drda, locale, server).
pub fn explain_odbc(cfg: &ConnConfig, e: anyhow::Error) -> anyhow::Error {
    if cfg.kind != DbKind::Informix {
        return e;
    }
    let text = e.to_string();
    let hint = |topic: &str, what: &str| anyhow!("INFORMIX_GUIDE:{topic}: {what}\n\n{text}");
    let sqli = cfg.informix_mode == "sqli";
    if sqli && text.contains("[IM002]") {
        return hint("sdk", &format!("El driver ODBC del Informix Client SDK ({IFX_ODBC_DRIVER}) no está instalado. Elige el protocolo «Automático» o «SQLI (JDBC)», que no lo necesitan, o instala el Client SDK."));
    }
    if text.contains("CLI0199E") {
        return hint("drda", "El driver IBM CLI rechazó la cadena de conexión: revisa la base de datos y los parámetros extra.");
    }
    if !sqli && text.contains("SQL30081N") {
        return hint("drda", &format!("No hay respuesta DRDA en {}:{}. Muchos servidores Informix solo escuchan SQLI (onsoctcp, puerto 9088): prueba el protocolo «Automático» o «SQLI (JDBC)», o pide a los DBA un alias drsoctcp.", cfg.host, cfg.port.unwrap_or(9089)));
    }
    let lower = text.to_lowercase();
    if lower.contains("-23101") || lower.contains("-23197") || lower.contains("locale") {
        return hint("locale", "El locale de la conexión no es el de la base de datos: indícalo en Parámetros extra, por ejemplo DB_LOCALE=es_ES.819.");
    }
    if lower.contains("-25596") || lower.contains("-908") || lower.contains("-761") || lower.contains("sqlhosts") {
        return hint("server", "Revisa el campo INFORMIXSERVER: debe ser el nombre del servidor (DBSERVERNAME) o uno de sus alias.");
    }
    e
}

fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Traduce coltype/collength de syscolumns de Informix a un nombre de tipo legible.
pub fn ifx_type(coltype: i64, len: i64, extended_id: i64) -> String {
    const QUAL: [&str; 16] = [
        "YEAR",
        "",
        "MONTH",
        "",
        "DAY",
        "",
        "HOUR",
        "",
        "MINUTE",
        "",
        "SECOND",
        "FRACTION(1)",
        "FRACTION(2)",
        "FRACTION(3)",
        "FRACTION(4)",
        "FRACTION(5)",
    ];
    let q = |n: i64| QUAL.get(n as usize).copied().unwrap_or("");
    let qual_range = |len: i64| {
        let first = (len % 256) / 16;
        let last = len % 16;
        let f = if first >= 11 { "FRACTION" } else { q(first) };
        format!("{} TO {}", f, q(last))
    };
    match coltype & 0xFF {
        0 => format!("CHAR({len})"),
        1 => "SMALLINT".into(),
        2 => "INTEGER".into(),
        3 => "FLOAT".into(),
        4 => "SMALLFLOAT".into(),
        5 | 8 => {
            let name = if coltype & 0xFF == 5 {
                "DECIMAL"
            } else {
                "MONEY"
            };
            let (p, s) = (len / 256, len % 256);
            if s == 255 {
                format!("{name}({p})")
            } else {
                format!("{name}({p},{s})")
            }
        }
        6 => "SERIAL".into(),
        7 => "DATE".into(),
        9 => "NULL".into(),
        10 => format!("DATETIME {}", qual_range(len)),
        11 => "BYTE".into(),
        12 => "TEXT".into(),
        13 | 16 => {
            let name = if coltype & 0xFF == 13 {
                "VARCHAR"
            } else {
                "NVARCHAR"
            };
            let (max, min) = (len % 256, len / 256);
            if min > 0 {
                format!("{name}({max},{min})")
            } else {
                format!("{name}({max})")
            }
        }
        14 => {
            // The first field can have more digits (DAY(5)): collength / 256 counts every digit of the qualifier.
            let (first, last) = ((len % 256) / 16, len % 16);
            let trailing: i64 = [2, 4, 6, 8, 10].iter().filter(|&&f| f > first && f <= last.min(10)).map(|_| 2).sum::<i64>() + (last - 10).max(0);
            let leading = len / 256 - trailing;
            let default = if first == 0 { 4 } else { 2 };
            if first < 11 && leading > 0 && leading != default {
                format!("INTERVAL {}({leading}) TO {}", q(first), q(last))
            } else {
                format!("INTERVAL {}", qual_range(len))
            }
        }
        15 => format!("NCHAR({len})"),
        17 => "INT8".into(),
        18 => "SERIAL8".into(),
        19 => "SET".into(),
        20 => "MULTISET".into(),
        21 => "LIST".into(),
        22 => "ROW".into(),
        40 => {
            if extended_id == 1 {
                format!("LVARCHAR({len})")
            } else {
                "LVARCHAR".into()
            }
        }
        41 => match extended_id {
            5 => "BOOLEAN".into(),
            10 => "BLOB".into(),
            11 => "CLOB".into(),
            _ => "OPAQUE".into(),
        },
        43 => format!("LVARCHAR({len})"),
        45 => "BOOLEAN".into(),
        52 => "BIGINT".into(),
        53 => "BIGSERIAL".into(),
        t => format!("TIPO({t})"),
    }
}

/// Every foreign key of an Informix database (`db`: its "base:" prefix, or ""): one row per key, side (0: the
/// referencing table, 1: the referenced one) and column of that side's index, with the index's 16 parts to put the
/// columns in key order. Columns: side, constrid, constraint, owner, table, referenced owner, referenced table,
/// part1…part16, colno, colname. Only the tables the explorer lists (tabtype 'T', tabid >= 100).
pub fn ifx_schema_fks_sql(db: &str) -> String {
    let parts = |alias: &str| (1..=16).map(|i| format!("{alias}.part{i}")).collect::<Vec<_>>().join(", ");
    let abs_parts = |alias: &str| (1..=16).map(|i| format!("ABS({alias}.part{i})")).collect::<Vec<_>>().join(", ");
    let head = "TRIM(c.constrname), TRIM(ct.owner), TRIM(ct.tabname), TRIM(pt.owner), TRIM(pt.tabname)";
    let from = format!("{db}sysconstraints c, {db}systables ct, {db}sysreferences r, {db}systables pt");
    let keys = "c.constrtype = 'R' AND ct.tabid = c.tabid AND ct.tabtype = 'T' AND ct.tabid >= 100 AND r.constrid = c.constrid AND pt.tabid = r.ptabid";
    format!(
        "SELECT 0, c.constrid, {head}, {}, col.colno, TRIM(col.colname) \
         FROM {from}, {db}sysindexes ci, {db}syscolumns col \
         WHERE {keys} AND ci.tabid = c.tabid AND ci.idxname = c.idxname AND col.tabid = c.tabid AND col.colno IN ({}) \
         UNION ALL \
         SELECT 1, c.constrid, {head}, {}, col.colno, TRIM(col.colname) \
         FROM {from}, {db}sysconstraints pc, {db}sysindexes pi, {db}syscolumns col \
         WHERE {keys} AND pc.constrid = r.primary AND pi.tabid = r.ptabid AND pi.idxname = pc.idxname \
           AND col.tabid = r.ptabid AND col.colno IN ({})",
        parts("ci"),
        abs_parts("ci"),
        parts("pi"),
        abs_parts("pi")
    )
}

const IFX_SYSTEM_DBS: [&str; 6] = [
    "sysmaster",
    "sysutils",
    "sysuser",
    "sysadmin",
    "sysha",
    "syscdcv1",
];

impl<L: Link> Driver for LinkDriver<L> {
    fn execute(&mut self, sql: &str, fetch: usize) -> Result<ExecOutput> {
        self.recover();
        self.execute_batch(sql, fetch).map_err(|e| self.after_error(e))
    }

    fn fetch(&mut self, n: usize) -> Result<FetchOutput> {
        self.fetch_more(n).map_err(|e| self.after_error(e))
    }

    fn close_cursor(&mut self) -> Result<()> {
        self.drop_pending();
        Ok(())
    }

    fn set_autocommit(&mut self, on: bool) -> Result<bool> {
        self.recover();
        self.drop_pending();
        if on && self.in_tx {
            self.conn.end_tran(true)?;
        }
        self.conn.set_autocommit(on)?;
        self.autocommit = on;
        self.in_tx = false;
        Ok(false)
    }

    fn commit(&mut self) -> Result<bool> {
        self.recover();
        self.drop_pending();
        self.conn.end_tran(true)?;
        self.in_tx = false;
        Ok(false)
    }

    fn rollback(&mut self) -> Result<bool> {
        self.recover();
        self.drop_pending();
        self.conn.end_tran(false)?;
        self.in_tx = false;
        Ok(false)
    }

    fn children(&mut self, path: &[String]) -> Result<Vec<MetaNode>> {
        self.recover();
        let mut p: Vec<&str> = path.iter().map(|s| s.as_str()).collect();
        // The interface also asks with the other engines' order [db, schema(owner), folder, table, …]: the tree
        // here is [db, folder, owner, table, …].
        if self.dialect == Dialect::Informix && p.len() >= 4 && matches!(p[2], "tables" | "views") && !matches!(p[1], "tables" | "views") {
            p.swap(1, 2);
        }
        if self.dialect == Dialect::Generic {
            return match p.as_slice() {
                [] => Ok(vec![
                    MetaNode::branch("Tablas", "folder", vec!["TABLE".into()]),
                    MetaNode::branch("Vistas", "folder", vec!["VIEW".into()]),
                ]),
                [ty] => {
                    let rows = self.odbc()?.catalog_tables(None, None, Some("%"), Some(ty))?;
                    let kind = if *ty == "VIEW" { "view" } else { "table" };
                    Ok(rows
                        .iter()
                        .take(20000)
                        .map(|r| {
                            let (cat, sch, name) =
                                (cell_str(&r[0]), cell_str(&r[1]), cell_str(&r[2]));
                            let label = if sch.is_empty() {
                                name.clone()
                            } else {
                                format!("{sch}.{name}")
                            };
                            MetaNode::branch(
                                label,
                                kind,
                                vec![ty.to_string(), cat.clone(), sch.clone(), name.clone()],
                            )
                            .with_obj(ObjectRef::new(&cat, &sch, &name, kind))
                        })
                        .collect())
                }
                [ty, cat, sch, name] => {
                    let cols = self.generic_columns(&ObjectRef::new(cat, sch, name, "table"))?;
                    let mut nodes: Vec<MetaNode> = cols
                        .into_iter()
                        .map(|c| {
                            let mut d = c.type_name.clone();
                            if c.primary_key {
                                d.push_str(" · PK");
                            }
                            if !c.nullable {
                                d.push_str(" · not null");
                            }
                            MetaNode::leaf(
                                c.name,
                                if c.primary_key { "pkcolumn" } else { "column" },
                                Some(d),
                            )
                        })
                        .collect();
                    if *ty == "TABLE" && self.odbc()?.has_foreign_keys() {
                        nodes.push(MetaNode::branch("Claves foráneas", "folder", [path.to_vec(), vec!["fks".into()]].concat()));
                    }
                    Ok(nodes)
                }
                // SQLForeignKeys of the table: "cols → schema.table(cols)" and `obj` the referenced table, as elsewhere.
                ["TABLE", cat, sch, name, "fks"] => Ok(self
                    .generic_foreign_keys(cat, sch, Some(name))?
                    .into_iter()
                    .map(|fk| {
                        let target = if fk.target.schema.is_empty() { fk.target.name.clone() } else { format!("{}.{}", fk.target.schema, fk.target.name) };
                        MetaNode::leaf(fk.name, "key", Some(format!("{} → {target}({})", fk.columns.join(", "), fk.target_columns.join(", ")))).with_obj(fk.target)
                    })
                    .collect()),
                _ => Ok(vec![]),
            };
        }
        match p.as_slice() {
            [] => {
                let rows = self.q("SELECT TRIM(name) FROM sysmaster:sysdatabases ORDER BY 1")?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        let n = cell_str(&r[0]);
                        let detail = if IFX_SYSTEM_DBS.contains(&n.as_str()) {
                            Some("sistema".to_string())
                        } else {
                            None
                        };
                        MetaNode::branch(n.clone(), "database", vec![n]).with_detail(detail)
                    })
                    .collect())
            }
            [db] => Ok([
                ("Tablas", "tables"),
                ("Vistas", "views"),
                ("Procedimientos", "procedures"),
                ("Funciones", "functions"),
                ("Sinónimos", "synonyms"),
                ("Secuencias", "sequences"),
            ]
            .iter()
            .map(|(l, k)| MetaNode::branch(*l, "folder", vec![db.to_string(), k.to_string()]))
            .collect()),
            [db, folder] => {
                let d = self.ifx_db(db);
                let (sql, kind, branch) = match *folder {
                    "tables" => (format!("SELECT TRIM(tabname), TRIM(owner), nrows FROM {d}systables WHERE tabtype = 'T' AND tabid >= 100 ORDER BY 1"), "table", true),
                    "views" => (format!("SELECT TRIM(tabname), TRIM(owner), NULL FROM {d}systables WHERE tabtype = 'V' AND tabid >= 100 ORDER BY 1"), "view", true),
                    "synonyms" => (format!("SELECT TRIM(tabname), TRIM(owner), NULL FROM {d}systables WHERE tabtype IN ('P','S') AND tabid >= 100 ORDER BY 1"), "synonym", false),
                    "sequences" => (format!("SELECT TRIM(tabname), TRIM(owner), NULL FROM {d}systables WHERE tabtype = 'Q' AND tabid >= 100 ORDER BY 1"), "sequence", false),
                    "procedures" | "functions" => (
                        format!(
                            "SELECT TRIM(procname), TRIM(owner), NULL FROM {d}sysprocedures WHERE isproc = '{}' AND internal = 'f' \
                             AND mode IN ('O','D','R','T') AND procid > (SELECT NVL(MAX(procid), 0) FROM {d}sysprocedures WHERE mode IN ('d','o','r','t','p')) ORDER BY 1",
                            if *folder == "procedures" { "t" } else { "f" }
                        ),
                        if *folder == "procedures" { "procedure" } else { "function" },
                        false,
                    ),
                    _ => return Ok(vec![]),
                };
                let rows = self.q(&sql)?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        let (n, owner) = (cell_str(&r[0]), cell_str(&r[1]));
                        let obj = ObjectRef::new(db, &owner, &n, kind);
                        let detail = match &r[2] {
                            Cell::Null => None,
                            c if cell_i64(c) > 0 => Some(format!("~{}", fmt_rows(cell_i64(c)))),
                            _ => None,
                        };
                        let node = if branch {
                            MetaNode::branch(
                                n.clone(),
                                kind,
                                vec![db.to_string(), folder.to_string(), owner, n],
                            )
                        } else {
                            MetaNode::leaf(n, kind, None)
                        };
                        node.with_obj(obj).with_detail(detail)
                    })
                    .collect())
            }
            [db, folder, owner, name] => {
                let o = ObjectRef::new(
                    db,
                    owner,
                    name,
                    if *folder == "views" { "view" } else { "table" },
                );
                let cols = self.ifx_columns(&o)?;
                let mut nodes: Vec<MetaNode> = cols
                    .into_iter()
                    .map(|(n, ty, nullable, pk, _serial, _)| {
                        let mut d = ty.to_lowercase();
                        if pk {
                            d.push_str(" · PK");
                        }
                        if !nullable {
                            d.push_str(" · not null");
                        }
                        MetaNode::leaf(n, if pk { "pkcolumn" } else { "column" }, Some(d))
                    })
                    .collect();
                if *folder == "tables" {
                    let base = vec![db.to_string(), folder.to_string(), owner.to_string(), name.to_string()];
                    nodes.push(MetaNode::branch("Índices", "folder", [base.clone(), vec!["indexes".into()]].concat()));
                    nodes.push(MetaNode::branch("Claves foráneas", "folder", [base, vec!["fks".into()]].concat()));
                }
                Ok(nodes)
            }
            [db, _folder, owner, name, "fks"] => {
                let o = ObjectRef::new(db, owner, name, "table");
                // `obj` is the referenced table, so the interface can jump to it (same format as the other engines).
                Ok(self
                    .ifx_foreign_keys(&o)?
                    .into_iter()
                    .map(|(constraint, cols, ref_owner, ref_table, ref_cols, _)| {
                        MetaNode::leaf(constraint, "key", Some(format!("{} → {}({})", cols.join(", "), ref_table, ref_cols.join(", "))))
                            .with_obj(ObjectRef::new(db, &ref_owner, &ref_table, "table"))
                    })
                    .collect())
            }
            [db, _folder, owner, name, "indexes"] => {
                let o = ObjectRef::new(db, owner, name, "table");
                Ok(self
                    .ifx_indexes(&o)?
                    .into_iter()
                    .map(|(n, unique, cols, _)| {
                        let mut d = format!("({cols})");
                        if unique {
                            d.push_str(" · único");
                        }
                        MetaNode::leaf(n, "index", Some(d))
                    })
                    .collect())
            }
            _ => Ok(vec![]),
        }
    }

    /// Informix: one catalog query (sysconstraints, sysreferences, sysindexes, syscolumns) for the database. Generic
    /// ODBC: SQLForeignKeys with no table, which some drivers answer with every key of the source; if the driver
    /// refuses (the standard says it may) or answers nothing, SQLForeignKeys table by table.
    fn schema_foreign_keys(&mut self, path: &[String]) -> Result<Vec<SchemaForeignKey>> {
        self.recover();
        if self.dialect == Dialect::Informix {
            let [db] = path else { return crate::session::per_table_foreign_keys(self, path) };
            return self.ifx_schema_foreign_keys(db);
        }
        if !self.odbc()?.has_foreign_keys() {
            return Ok(vec![]);
        }
        let tables = self.odbc()?.catalog_tables(None, None, Some("%"), Some("TABLE"))?;
        let listed = |fk: &SchemaForeignKey| tables.iter().any(|r| cell_str(&r[0]) == fk.table.database && cell_str(&r[1]) == fk.table.schema && cell_str(&r[2]) == fk.table.name);
        if let Ok(all) = self.generic_foreign_keys("", "", None) {
            if !all.is_empty() {
                return Ok(all.into_iter().filter(listed).collect());
            }
        }
        let mut out = Vec::new();
        for r in tables.iter().take(20000) {
            out.extend(self.generic_foreign_keys(&cell_str(&r[0]), &cell_str(&r[1]), Some(&cell_str(&r[2])))?);
        }
        Ok(out)
    }

    fn table_columns(&mut self, obj: &ObjectRef) -> Result<Vec<TableColumn>> {
        self.recover();
        if self.dialect == Dialect::Generic {
            return self.generic_columns(obj);
        }
        Ok(self
            .ifx_columns(obj)?
            .into_iter()
            .map(|(name, ty, nullable, pk, serial, default)| TableColumn {
                kind: kind_from_type(&ty),
                name,
                type_name: ty.to_lowercase(),
                nullable,
                primary_key: pk,
                identity: serial,
                default,
            })
            .collect())
    }

    fn ddl(&mut self, obj: &ObjectRef) -> Result<String> {
        self.recover();
        let qn = self.qualified_name(obj);
        if self.dialect == Dialect::Generic {
            if obj.kind != "table" {
                bail!("La definición no está disponible para conexiones ODBC genéricas");
            }
            let cols = self.generic_columns(obj)?;
            let mut lines: Vec<String> = cols
                .iter()
                .map(|c| {
                    format!(
                        "    {} {}{}",
                        self.quote_ident(&c.name),
                        c.type_name.to_uppercase(),
                        if c.nullable { "" } else { " NOT NULL" }
                    )
                })
                .collect();
            let pk: Vec<String> = cols
                .iter()
                .filter(|c| c.primary_key)
                .map(|c| self.quote_ident(&c.name))
                .collect();
            if !pk.is_empty() {
                lines.push(format!("    PRIMARY KEY ({})", pk.join(", ")));
            }
            return Ok(format!("CREATE TABLE {qn} (\n{}\n);", lines.join(",\n")));
        }
        let db = self.ifx_db(&obj.database);
        match obj.kind.as_str() {
            "table" => {
                let cols = self.ifx_columns(obj)?;
                let mut lines: Vec<String> = cols
                    .iter()
                    .map(|(n, ty, nullable, _, _, def)| {
                        let mut l = format!("    {n} {ty}");
                        if let Some(d) = def {
                            l.push_str(&format!(" DEFAULT {d}"));
                        }
                        if !nullable {
                            l.push_str(" NOT NULL");
                        }
                        l
                    })
                    .collect();
                // Keys in their own column order (not the table's), then the foreign keys.
                let tabid = self.ifx_tabid(obj)?;
                for pk in self.ifx_key_constraints(&db, tabid, 'P')? {
                    lines.push(format!("    PRIMARY KEY ({})", pk.join(", ")));
                }
                for unique in self.ifx_key_constraints(&db, tabid, 'U')? {
                    lines.push(format!("    UNIQUE ({})", unique.join(", ")));
                }
                for (_, cols, ref_owner, ref_table, ref_cols, cascade) in self.ifx_foreign_keys(obj)? {
                    let cascade = if cascade { " ON DELETE CASCADE" } else { "" };
                    lines.push(format!("    FOREIGN KEY ({}) REFERENCES {ref_owner}.{ref_table} ({}){cascade}", cols.join(", "), ref_cols.join(", ")));
                }
                let mut out = format!(
                    "CREATE TABLE {}.{} (\n{}\n);\n",
                    obj.schema,
                    obj.name,
                    lines.join(",\n")
                );
                for (n, unique, cols, constraint) in self.ifx_indexes(obj)? {
                    if constraint {
                        continue;
                    }
                    out.push_str(&format!(
                        "\nCREATE {}INDEX {} ON {}.{} ({});",
                        if unique { "UNIQUE " } else { "" },
                        n,
                        obj.schema,
                        obj.name,
                        cols
                    ));
                }
                Ok(out)
            }
            "view" => {
                let tabid = self.ifx_tabid(obj)?;
                let rows = self.q(&format!(
                    "SELECT viewtext FROM {db}sysviews WHERE tabid = {tabid} ORDER BY seqno"
                ))?;
                Ok(rows
                    .iter()
                    .map(|r| cell_str(&r[0]))
                    .collect::<String>()
                    .trim()
                    .to_string())
            }
            "procedure" | "function" => {
                let rows = self.q(&format!(
                    "SELECT b.data FROM {db}sysprocbody b, {db}sysprocedures p WHERE p.procname = {} AND p.owner = {} \
                     AND b.procid = p.procid AND b.datakey = 'T' ORDER BY p.procid, b.seqno",
                    lit(&obj.name),
                    lit(&obj.schema)
                ))?;
                if rows.is_empty() {
                    bail!("No hay definición disponible");
                }
                Ok(rows
                    .iter()
                    .map(|r| cell_str(&r[0]))
                    .collect::<String>()
                    .trim()
                    .to_string())
            }
            "synonym" => {
                let tabid = self.ifx_tabid(obj)?;
                let rows = self.q(&format!(
                    "SELECT TRIM(NVL(s.servername,'')), TRIM(NVL(s.dbname,'')), TRIM(NVL(s.owner,'')), TRIM(NVL(s.tabname,'')), TRIM(NVL(t.owner,'')), TRIM(NVL(t.tabname,'')) \
                     FROM {db}syssyntable s, OUTER {db}systables t WHERE s.tabid = {tabid} AND t.tabid = s.btabid"
                ))?;
                let r = rows
                    .first()
                    .ok_or_else(|| anyhow!("Sinónimo no encontrado"))?;
                let target = if !cell_str(&r[3]).is_empty() {
                    let mut t = String::new();
                    if !cell_str(&r[1]).is_empty() {
                        t.push_str(&cell_str(&r[1]));
                        if !cell_str(&r[0]).is_empty() {
                            t.push_str(&format!("@{}", cell_str(&r[0])));
                        }
                        t.push(':');
                    }
                    format!("{t}{}.{}", cell_str(&r[2]), cell_str(&r[3]))
                } else {
                    format!("{}.{}", cell_str(&r[4]), cell_str(&r[5]))
                };
                Ok(format!(
                    "CREATE SYNONYM {}.{} FOR {};",
                    obj.schema, obj.name, target
                ))
            }
            "sequence" => {
                let tabid = self.ifx_tabid(obj)?;
                let rows = self.q(&format!("SELECT start_val, inc_val, min_val, max_val, cycle FROM {db}syssequences WHERE tabid = {tabid}"))?;
                let r = rows
                    .first()
                    .ok_or_else(|| anyhow!("Secuencia no encontrada"))?;
                Ok(format!(
                    "CREATE SEQUENCE {}.{}\n    START WITH {}\n    INCREMENT BY {}\n    MINVALUE {}\n    MAXVALUE {}\n    {};",
                    obj.schema,
                    obj.name,
                    cell_str(&r[0]),
                    cell_str(&r[1]),
                    cell_str(&r[2]),
                    cell_str(&r[3]),
                    if cell_str(&r[4]) == "1" { "CYCLE" } else { "NOCYCLE" }
                ))
            }
            _ => bail!("Definición no disponible para este tipo de objeto"),
        }
    }

    fn completion(&mut self, database: &str) -> Result<CompletionSchema> {
        self.recover();
        let mut out = CompletionSchema::default();
        if self.dialect == Dialect::Generic {
            let rows = self
                .odbc()?
                .catalog_tables(None, None, Some("%"), Some("TABLE,VIEW"))?;
            for r in rows.iter().take(3000) {
                out.tables.push(CompletionTable {
                    schema: cell_str(&r[1]),
                    name: cell_str(&r[2]),
                    columns: vec![],
                });
            }
            return Ok(out);
        }
        let d = self.ifx_db(database);
        let rows = self.q(&format!(
            "SELECT TRIM(t.owner), TRIM(t.tabname), TRIM(c.colname) FROM {d}systables t, {d}syscolumns c \
             WHERE c.tabid = t.tabid AND t.tabid >= 100 AND t.tabtype IN ('T','V') ORDER BY t.tabname, t.owner, c.colno"
        ))?;
        for r in rows {
            let (s, t, c) = (cell_str(&r[0]), cell_str(&r[1]), cell_str(&r[2]));
            match out.tables.last_mut() {
                Some(last) if last.schema == s && last.name == t => last.columns.push(c),
                _ => out.tables.push(CompletionTable {
                    schema: s,
                    name: t,
                    columns: vec![c],
                }),
            }
        }
        Ok(out)
    }

    fn databases(&mut self) -> Result<Vec<String>> {
        self.recover();
        if self.dialect == Dialect::Generic {
            let rows = self
                .odbc()?
                .catalog_tables(Some("%"), Some(""), Some(""), None)
                .unwrap_or_default();
            let mut v: Vec<String> = rows
                .iter()
                .map(|r| cell_str(&r[0]))
                .filter(|s| !s.is_empty())
                .collect();
            v.dedup();
            return Ok(v);
        }
        let rows = self.q("SELECT TRIM(name) FROM sysmaster:sysdatabases ORDER BY 1")?;
        Ok(rows.iter().map(|r| cell_str(&r[0])).collect())
    }

    fn current_database(&mut self) -> Result<String> {
        self.recover();
        if self.dialect == Dialect::Informix {
            if self.db_known {
                return Ok(self.database.clone());
            }
            let rows = self.q("SELECT TRIM(DBINFO('dbname')) FROM systables WHERE tabid = 1")?;
            self.database = rows.first().map(|r| cell_str(&r[0])).unwrap_or_default();
            self.db_known = true;
            return Ok(self.database.clone());
        }
        Ok(self.odbc()?.info(SQL_DATABASE_NAME))
    }

    fn use_database(&mut self, db: &str) -> Result<()> {
        self.recover();
        // Informix changes database by reconnecting: not when the session is already there (known, or asked to the
        // server after a DATABASE statement run by the user).
        if self.dialect == Dialect::Informix && self.current_database().is_ok_and(|current| current == db) {
            self.database = db.to_string();
            return Ok(());
        }
        if self.dialect == Dialect::Generic {
            self.stmt = None;
            self.pending.clear();
            self.odbc()?.set_catalog(db)?;
        } else {
            self.reconnect(Some(db))?;
        }
        self.database = db.to_string();
        self.db_known = true;
        Ok(())
    }

    fn qualified_name(&self, o: &ObjectRef) -> String {
        if self.dialect == Dialect::Informix {
            let owner = if o.schema.is_empty() {
                String::new()
            } else {
                format!("{}.", o.schema)
            };
            if o.database.is_empty() || o.database == self.database {
                return format!("{owner}{}", o.name);
            }
            return format!("{}:{owner}{}", o.database, o.name);
        }
        [&o.database, &o.schema, &o.name]
            .iter()
            .filter(|s| !s.is_empty())
            .map(|s| self.quote_ident(s))
            .collect::<Vec<_>>()
            .join(".")
    }

    fn quote_ident(&self, s: &str) -> String {
        if self.dialect == Dialect::Informix {
            // Sin DELIMIDENT, Informix no admite identificadores entre comillas.
            return s.to_string();
        }
        let q = &self.quote;
        if q == " " {
            return s.to_string();
        }
        format!("{q}{}{q}", s.replace(q.as_str(), &format!("{q}{q}")))
    }

    fn server_info(&mut self) -> Result<String> {
        Ok(self.conn.server_info())
    }

    fn canceller(&self) -> Canceller {
        self.conn.canceller()
    }

    /// Informix: la consulta más barata del catálogo. Otros orígenes ODBC: no hay una consulta que valga para todos,
    /// pero sí una función de catálogo (SQLTables de una tabla que no existe), que los drivers de servidor resuelven con
    /// una ida y vuelta; sus cortes se reconocen además por el SQLSTATE (08S01…).
    fn ping(&mut self) -> Result<()> {
        if self.stmt.is_some() {
            return Ok(());
        }
        if self.dialect != Dialect::Informix {
            return self.odbc()?.catalog_tables(None, None, Some("celer_ping_no_table"), Some("TABLE")).map(|_| ());
        }
        self.q("SELECT 1 FROM systables WHERE tabid = 1").map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn informix_batches_are_split() {
        use super::{split_batch, Dialect};
        let parts = split_batch("DELETE FROM t WHERE id = 4;\nUPDATE t SET n = 'a;b' WHERE id = 2;\n-- fin; comentario\nINSERT INTO t VALUES (5);\n-- DELETE FROM t WHERE id = 3;", Dialect::Informix);
        assert_eq!(parts.len(), 3, "{parts:?}");
        assert!(parts[1].contains("'a;b'"));
        assert!(parts[2].ends_with("INSERT INTO t VALUES (5)"));
        // A routine's body keeps its semicolons; other ODBC sources get the text as it is.
        assert_eq!(split_batch("CREATE PROCEDURE p() LET x = 1; END PROCEDURE;", Dialect::Informix).len(), 1);
        assert_eq!(split_batch("SELECT 1; SELECT 2", Dialect::Generic).len(), 1);
        // A routine mentioned in a comment or a string does not keep the script whole.
        let parts = split_batch("-- after this: CREATE PROCEDURE later\nCREATE TABLE a (x INT);\nCREATE TABLE b (y INT);\nINSERT INTO a VALUES ('CREATE FUNCTION f');", Dialect::Informix);
        assert_eq!(parts.len(), 3, "{parts:?}");
        // dbschema output: tables and one SPL routine (kept whole, with its semicolons), then more statements.
        let script = "CREATE TABLE a (x INT);\n{ routine }\nCREATE DBA PROCEDURE p(n INT) RETURNING INT;\n  DEFINE i INT; -- a ; comment\n  LET i = n + 1;\n  RETURN i;\nEND PROCEDURE\n  DOCUMENT 'uno; dos';\nCREATE FUNCTION f() RETURNING INT; RETURN 1; END FUNCTION;\nGRANT EXECUTE ON p TO public;";
        let parts = split_batch(script, Dialect::Informix);
        assert_eq!(parts.len(), 4, "{parts:#?}");
        assert!(parts[1].starts_with("{ routine }\nCREATE DBA PROCEDURE p") && parts[1].ends_with("DOCUMENT 'uno; dos'"), "{}", parts[1]);
        assert!(parts[1].contains("-- a ; comment\n  LET i = n + 1\n;\nRETURN i\n;\nEND PROCEDURE"), "{}", parts[1]);
        assert!(parts[2].starts_with("CREATE FUNCTION f()") && parts[2].ends_with("END FUNCTION"), "{}", parts[2]);
        assert_eq!(parts[3], "GRANT EXECUTE ON p TO public");
        // A routine read from a file is one statement.
        assert_eq!(split_batch("CREATE PROCEDURE FROM 'p.sql'; SELECT 1 FROM systables", Dialect::Informix).len(), 2);
    }

    use super::*;

    #[test]
    fn empty_database_is_left_out() {
        let mut cfg = ConnConfig { kind: DbKind::Informix, host: "db".into(), user: "u".into(), password: Some("p;w".into()), ..Default::default() };
        cfg.informix_mode = "drda".into();
        let s = conn_string(&cfg, None);
        assert!(!s.contains("DATABASE="), "{s}");
        assert!(s.contains("PWD={p;w};"), "{s}");
        cfg.informix_mode = "sqli".into();
        cfg.instance = "ol_srv".into();
        let s = conn_string(&cfg, None);
        assert!(!s.contains("DATABASE=") && s.contains("SERVER=ol_srv;") && s.contains("SERVICE=9088;"), "{s}");
        assert!(conn_string(&cfg, Some("ventas")).contains("DATABASE=ventas;"));
        cfg.database = " stock ".into();
        assert!(conn_string(&cfg, None).contains("DATABASE=stock;"));
    }

    #[test]
    fn odbc_errors_explained() {
        let mut cfg = ConnConfig { kind: DbKind::Informix, ..Default::default() };
        cfg.informix_mode = "sqli".into();
        let e = explain_odbc(&cfg, anyhow!("[IM002] [Microsoft][ODBC Driver Manager] Data source name not found")).to_string();
        assert!(e.starts_with("INFORMIX_GUIDE:sdk: "), "{e}");
        assert!(e.contains("[IM002]"), "the original message stays: {e}");
        cfg.informix_mode = "drda".into();
        let e = explain_odbc(&cfg, anyhow!("[08001] [IBM][CLI Driver] SQL30081N  A communication error has been detected.")).to_string();
        assert!(e.starts_with("INFORMIX_GUIDE:drda: "), "{e}");
        let e = explain_odbc(&cfg, anyhow!("[HY000] [IBM][CLI Driver] CLI0199E  Invalid connection string attribute.")).to_string();
        assert!(e.starts_with("INFORMIX_GUIDE:drda: "), "{e}");
        assert_eq!(explain_odbc(&cfg, anyhow!("[42000] syntax")).to_string(), "[42000] syntax");
        let generic = ConnConfig { kind: DbKind::Odbc, ..Default::default() };
        assert_eq!(explain_odbc(&generic, anyhow!("[IM002] x")).to_string(), "[IM002] x");
    }

    #[test]
    fn informix_types() {
        assert_eq!(ifx_type(0, 10, 0), "CHAR(10)");
        assert_eq!(ifx_type(262, 4, 0), "SERIAL");
        assert_eq!(ifx_type(5, 12 * 256 + 2, 0), "DECIMAL(12,2)");
        assert_eq!(ifx_type(13, 150, 0), "VARCHAR(150)");
        assert_eq!(ifx_type(10, 19 * 256 + 0x0A, 0), "DATETIME YEAR TO SECOND");
        assert_eq!(
            ifx_type(10, 23 * 256 + 0x0D, 0),
            "DATETIME YEAR TO FRACTION(3)"
        );
        assert_eq!(ifx_type(41, 1, 5), "BOOLEAN");
        // INTERVAL: collength / 256 is every digit, so the leading field's precision is what the others leave.
        assert_eq!(ifx_type(14, 7 * 256 + 0x46, 0), "INTERVAL DAY(5) TO HOUR");
        assert_eq!(ifx_type(14, 4 * 256 + 0x46, 0), "INTERVAL DAY TO HOUR");
        assert_eq!(ifx_type(14, 5 * 256 + 0x44, 0), "INTERVAL DAY(5) TO DAY");
        assert_eq!(ifx_type(14, 6 * 256 + 0x02, 0), "INTERVAL YEAR TO MONTH");
        assert_eq!(ifx_type(14, 8 * 256 + 0x02, 0), "INTERVAL YEAR(6) TO MONTH");
        assert_eq!(ifx_type(14, 6 * 256 + 0x6A, 0), "INTERVAL HOUR TO SECOND");
        assert_eq!(ifx_type(14, 8 * 256 + 0x8D, 0), "INTERVAL MINUTE(3) TO FRACTION(3)");
        assert_eq!(ifx_type(14, 3 * 256 + 0xBD, 0), "INTERVAL FRACTION TO FRACTION(3)");
    }
}
