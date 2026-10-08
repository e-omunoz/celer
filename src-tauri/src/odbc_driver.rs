//! Driver basado en ODBC/CLI: Informix (DRDA o SQLI) y conexiones ODBC genéricas.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;

use crate::model::*;
use crate::mssql::{cell_i64, cell_str, fmt_rows, kind_from_type};
use crate::odbc::*;
use crate::session::{Canceller, Driver};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Informix,
    Generic,
}

pub struct OdbcDriver {
    cfg: ConnConfig,
    lib_path: String,
    dialect: Dialect,
    conn: OdbcConn,
    stmt: Option<Stmt>,
    /// Statements of a batch still to run (Informix runs one statement per call: the batch is split).
    pending: VecDeque<String>,
    cancel_slot: Arc<Mutex<usize>>,
    autocommit: bool,
    in_tx: bool,
    database: String,
    quote: String,
}

impl OdbcDriver {
    pub fn connect(cfg: ConnConfig, lib_path: String) -> Result<OdbcDriver> {
        let dialect = if cfg.kind == DbKind::Informix {
            Dialect::Informix
        } else {
            Dialect::Generic
        };
        let api = Api::load(&lib_path)?;
        let conn = OdbcConn::connect(api, &conn_string(&cfg, None), 20)?;
        run_startup(&conn, &cfg)?;
        let quote = match conn.info(SQL_IDENTIFIER_QUOTE_CHAR).trim() {
            "" => "\"".to_string(),
            q => q.to_string(),
        };
        let mut d = OdbcDriver {
            database: cfg.database.clone(),
            cfg,
            lib_path,
            dialect,
            conn,
            stmt: None,
            pending: VecDeque::new(),
            cancel_slot: Arc::new(Mutex::new(0)),
            autocommit: true,
            in_tx: false,
            quote,
        };
        if d.database.is_empty() {
            d.database = d.current_database().unwrap_or_default();
        }
        Ok(d)
    }

    /// Runs the batch's statements in turn, adding their results, until one leaves rows to read (its cursor stays
    /// open for `fetch`) or none is left. An error stops the batch: the statements after it do not run.
    fn run_pending(&mut self, fetch: usize, results: &mut Vec<ResultSet>, messages: &mut Vec<String>) -> Result<()> {
        let total = self.pending.len();
        while self.stmt.is_none() {
            let Some(sql) = self.pending.pop_front() else { break };
            let mut st = self.conn.alloc_stmt()?;
            st.register_cancel(self.cancel_slot.clone());
            let r = st.exec(&sql);
            if !self.autocommit {
                self.in_tx = true;
            }
            if let Err(e) = r {
                let done = total - self.pending.len();
                self.pending.clear();
                if total > 1 {
                    bail!("Sentencia {done} de {total}: {e}");
                }
                bail!(e);
            }
            self.stmt = Some(st);
            results.extend(self.pump(fetch, messages)?);
        }
        Ok(())
    }

    fn q(&self, rows: &str) -> Result<Vec<Vec<Cell>>> {
        self.conn.query_all(rows)
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
                    columns: st.columns.clone(),
                    rows,
                    has_more: more,
                    rows_affected: None,
                });
                if more {
                    messages.append(&mut st.messages);
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
            messages.append(&mut st.messages);
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

    /// Foreign keys of a table: (constraint, columns, referenced owner, referenced table, referenced columns).
    fn ifx_foreign_keys(&self, o: &ObjectRef) -> Result<Vec<(String, Vec<String>, String, String, Vec<String>)>> {
        let db = self.ifx_db(&o.database);
        let tabid = self.ifx_tabid(o)?;
        let rows = self.q(&format!(
            // Index names as stored: the ones Informix generates for constraints start with a space (" 101_2").
            "SELECT TRIM(c.constrname), c.idxname, r.ptabid, TRIM(pt.tabname), TRIM(pt.owner), pc.idxname \
             FROM {db}sysconstraints c, {db}sysreferences r, {db}systables pt, {db}sysconstraints pc \
             WHERE c.tabid = {tabid} AND c.constrtype = 'R' AND r.constrid = c.constrid \
               AND pt.tabid = r.ptabid AND pc.constrid = r.primary ORDER BY 1"
        ))?;
        rows.iter()
            .map(|r| {
                let cols = self.ifx_index_cols(&db, tabid, &cell_str(&r[1]))?;
                let ref_cols = self.ifx_index_cols(&db, cell_i64(&r[2]), &cell_str(&r[5]))?;
                Ok((cell_str(&r[0]), cols, cell_str(&r[4]), cell_str(&r[3]), ref_cols))
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
        let rows = self.conn.catalog_columns(&o.database, &o.schema, &o.name)?;
        let pks: Vec<String> = self
            .conn
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
        let api = Api::load(&self.lib_path)?;
        let conn = OdbcConn::connect(api, &conn_string(&self.cfg, database), 20)?;
        run_startup(&conn, &self.cfg)?;
        if !self.autocommit {
            conn.set_autocommit(false)?;
        }
        self.conn = conn;
        self.in_tx = false;
        Ok(())
    }
}

/// The statements of a batch as the server must get them: Informix (over DRDA) runs one statement per call, so
/// a script is split (`;` outside strings and comments); a routine definition (its body has `;`) goes whole.
/// Other ODBC sources get the text as it is.
fn split_batch(sql: &str, dialect: Dialect) -> Vec<String> {
    if dialect != Dialect::Informix {
        return vec![sql.to_string()];
    }
    let words = sql.to_uppercase().split_whitespace().collect::<Vec<_>>().join(" ");
    let routine = ["CREATE PROCEDURE", "CREATE FUNCTION", "CREATE DBA PROCEDURE", "CREATE DBA FUNCTION", "CREATE TRIGGER"].iter().any(|k| words.contains(k));
    if routine {
        return vec![sql.to_string()];
    }
    let parts = crate::startup::split(sql, DbKind::Informix);
    if parts.is_empty() {
        vec![sql.to_string()]
    } else {
        parts
    }
}

/// El script de inicio de la conexión, en cada conexión nueva (todavía en autocommit).
fn run_startup(conn: &OdbcConn, cfg: &ConnConfig) -> Result<()> {
    for sql in crate::startup::statements(cfg) {
        conn.alloc_stmt()?.exec(&sql).map_err(|e| crate::startup::failed(&sql, e))?;
    }
    Ok(())
}

/// Construye la cadena de conexión según el tipo de conexión.
pub fn conn_string(cfg: &ConnConfig, database: Option<&str>) -> String {
    let db = database.unwrap_or(&cfg.database);
    let pwd = cfg.password.clone().unwrap_or_default();
    let esc = |s: &str| {
        if s.contains(';') || s.contains('}') {
            format!("{{{}}}", s.replace('}', "}}"))
        } else {
            s.to_string()
        }
    };
    let mut s = match (cfg.kind, cfg.informix_mode.as_str()) {
        (DbKind::Informix, "sqli") => format!(
            "DRIVER={{IBM INFORMIX ODBC DRIVER (64-bit)}};HOST={};SERVICE={};SERVER={};DATABASE={};PROTOCOL=onsoctcp;UID={};PWD={};",
            cfg.host,
            cfg.port.unwrap_or(9088),
            cfg.instance,
            db,
            esc(&cfg.user),
            esc(&pwd)
        ),
        (DbKind::Informix, _) => format!(
            "DATABASE={};HOSTNAME={};PORT={};PROTOCOL=TCPIP;UID={};PWD={};",
            db,
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
            if let Some(d) = database {
                s.push_str(&format!("DATABASE={d};"));
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
        14 => format!("INTERVAL {}", qual_range(len)),
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

const IFX_SYSTEM_DBS: [&str; 6] = [
    "sysmaster",
    "sysutils",
    "sysuser",
    "sysadmin",
    "sysha",
    "syscdcv1",
];

impl Driver for OdbcDriver {
    fn execute(&mut self, sql: &str, fetch: usize) -> Result<ExecOutput> {
        let t0 = Instant::now();
        self.stmt = None;
        self.pending = split_batch(sql, self.dialect).into();
        let mut out = ExecOutput::default();
        let r = self.run_pending(fetch.max(1), &mut out.results, &mut out.messages);
        out.in_transaction = self.in_tx;
        r?;
        out.elapsed_ms = t0.elapsed().as_millis() as u64;
        Ok(out)
    }

    fn fetch(&mut self, n: usize) -> Result<FetchOutput> {
        let mut out = FetchOutput::default();
        let Some(st) = self.stmt.as_mut() else {
            return Ok(out);
        };
        if st.in_result {
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

    fn close_cursor(&mut self) -> Result<()> {
        self.stmt = None;
        self.pending.clear();
        Ok(())
    }

    fn set_autocommit(&mut self, on: bool) -> Result<bool> {
        self.stmt = None;
        self.pending.clear();
        if on && self.in_tx {
            self.conn.end_tran(true)?;
        }
        self.conn.set_autocommit(on)?;
        self.autocommit = on;
        self.in_tx = false;
        Ok(false)
    }

    fn commit(&mut self) -> Result<bool> {
        self.stmt = None;
        self.pending.clear();
        self.conn.end_tran(true)?;
        self.in_tx = false;
        Ok(false)
    }

    fn rollback(&mut self) -> Result<bool> {
        self.stmt = None;
        self.pending.clear();
        self.conn.end_tran(false)?;
        self.in_tx = false;
        Ok(false)
    }

    fn children(&mut self, path: &[String]) -> Result<Vec<MetaNode>> {
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
                    let rows = self.conn.catalog_tables(None, None, Some("%"), Some(ty))?;
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
                [_, cat, sch, name] => {
                    let cols = self.generic_columns(&ObjectRef::new(cat, sch, name, "table"))?;
                    Ok(cols
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
                        .collect())
                }
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
                    .map(|(constraint, cols, ref_owner, ref_table, ref_cols)| {
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

    fn table_columns(&mut self, obj: &ObjectRef) -> Result<Vec<TableColumn>> {
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
                let pk: Vec<String> = cols.iter().filter(|c| c.3).map(|c| c.0.clone()).collect();
                if !pk.is_empty() {
                    lines.push(format!("    PRIMARY KEY ({})", pk.join(", ")));
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
        let mut out = CompletionSchema::default();
        if self.dialect == Dialect::Generic {
            let rows = self
                .conn
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
        if self.dialect == Dialect::Generic {
            let rows = self
                .conn
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
        if self.dialect == Dialect::Informix {
            let rows = self.q("SELECT TRIM(DBINFO('dbname')) FROM systables WHERE tabid = 1")?;
            return Ok(rows.first().map(|r| cell_str(&r[0])).unwrap_or_default());
        }
        Ok(self.conn.info(SQL_DATABASE_NAME))
    }

    fn use_database(&mut self, db: &str) -> Result<()> {
        // Informix changes database by reconnecting: not when the session is already there (asked to the server,
        // since a DATABASE statement run by the user also moves it).
        if self.dialect == Dialect::Informix && self.current_database().is_ok_and(|current| current == db) {
            self.database = db.to_string();
            return Ok(());
        }
        if self.dialect == Dialect::Generic {
            self.stmt = None;
            self.pending.clear();
            self.conn.set_catalog(db)?;
        } else {
            self.reconnect(Some(db))?;
        }
        self.database = db.to_string();
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
        Ok(format!(
            "{} {}",
            self.conn.info(SQL_DBMS_NAME),
            self.conn.info(SQL_DBMS_VER)
        )
        .trim()
        .to_string())
    }

    fn canceller(&self) -> Canceller {
        let slot = self.cancel_slot.clone();
        let api = self.conn.api.clone();
        Arc::new(move || cancel_stmt(&api, &slot))
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
    }

    use super::*;
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
    }
}
