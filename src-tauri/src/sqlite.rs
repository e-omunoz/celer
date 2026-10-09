//! Driver SQLite embebido. El motor va dentro del binario: no hace falta instalar nada.

use std::cell::Cell as StdCell;
use std::ffi::{CStr, CString};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

use crate::model::*;
use crate::session::{Canceller, Driver, FkColumn};

const BINARY_PREVIEW: usize = 4096;

struct SharedCancel {
    handle: rusqlite::InterruptHandle,
    busy: AtomicBool,
}

struct Cursor {
    stmt: *mut rusqlite::ffi::sqlite3_stmt,
    ncols: usize,
    rest: String,
    peeked: Option<Vec<Cell>>,
}

unsafe impl Send for Cursor {}

impl Drop for Cursor {
    fn drop(&mut self) {
        if !self.stmt.is_null() {
            unsafe { rusqlite::ffi::sqlite3_finalize(self.stmt) };
            self.stmt = ptr::null_mut();
        }
    }
}

struct Prepared {
    stmt: *mut rusqlite::ffi::sqlite3_stmt,
    ncols: usize,
    rest: String,
}

pub struct SqliteDriver {
    cursor: Option<Cursor>,
    cancel: Arc<SharedCancel>,
    database: String,
    path: String,
    conn: Connection,
    busy_guard: StdCell<bool>,
    /// Statements of a script dropped with its open result, told in the next execute's messages.
    discarded: usize,
    /// The session's transaction mode. In manual mode (false) each statement outside a transaction opens one first,
    /// so a COMMIT or ROLLBACK (the console's buttons or typed) does not leave it in autocommit.
    autocommit: bool,
}

impl SqliteDriver {
    pub fn connect(cfg: ConnConfig) -> Result<SqliteDriver> {
        let path = sqlite_path(&cfg)?;
        let conn = if path == ":memory:" {
            open_memory(&cfg.id)?
        } else {
            if let Some(parent) = std::path::Path::new(&path).parent() {
                if !parent.as_os_str().is_empty() && !cfg.read_only {
                    std::fs::create_dir_all(parent)?;
                }
            }
            let flags = if cfg.read_only {
                OpenFlags::SQLITE_OPEN_READ_ONLY
            } else {
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
            };
            Connection::open_with_flags(&path, flags)?
        };
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        for sql in crate::startup::statements(&cfg) {
            conn.execute_batch(&sql).map_err(|e| crate::startup::failed(&sql, e))?;
        }
        let cancel = Arc::new(SharedCancel {
            handle: conn.get_interrupt_handle(),
            busy: AtomicBool::new(false),
        });
        Ok(SqliteDriver {
            cursor: None,
            cancel,
            database: "main".into(),
            path,
            conn,
            busy_guard: StdCell::new(false),
            discarded: 0,
            autocommit: true,
        })
    }

    fn enter(&self) {
        self.cancel.busy.store(true, Ordering::Relaxed);
        self.busy_guard.set(true);
    }

    fn leave(&self) {
        if self.busy_guard.get() {
            self.cancel.busy.store(false, Ordering::Relaxed);
            self.busy_guard.set(false);
        }
    }

    fn fail(&self, rc: i32) -> Result<()> {
        if rc == rusqlite::ffi::SQLITE_INTERRUPT {
            bail!("Consulta cancelada");
        }
        let db = unsafe { self.conn.handle() };
        let msg = unsafe { CStr::from_ptr(rusqlite::ffi::sqlite3_errmsg(db)) };
        bail!("{}", msg.to_string_lossy());
    }

    fn prepare_next(&self, sql: &str) -> Result<Option<Prepared>> {
        if sql.trim().is_empty() {
            return Ok(None);
        }
        let c = CString::new(sql).map_err(|_| anyhow!("El SQL contiene un carácter nulo"))?;
        let mut stmt = ptr::null_mut();
        let mut tail: *const std::ffi::c_char = ptr::null();
        let db = unsafe { self.conn.handle() };
        let rc =
            unsafe { rusqlite::ffi::sqlite3_prepare_v2(db, c.as_ptr(), -1, &mut stmt, &mut tail) };
        if rc != rusqlite::ffi::SQLITE_OK {
            return self.fail(rc).map(|_| None);
        }
        if stmt.is_null() {
            return Ok(None);
        }
        let rest = if tail.is_null() {
            String::new()
        } else {
            let off = unsafe { tail.offset_from(c.as_ptr()) }.max(0) as usize;
            let bytes = c.as_bytes();
            String::from_utf8_lossy(&bytes[off.min(bytes.len())..]).into_owned()
        };
        let ncols = unsafe { rusqlite::ffi::sqlite3_column_count(stmt) } as usize;
        Ok(Some(Prepared { stmt, ncols, rest }))
    }

    fn finalize_stmt(stmt: *mut rusqlite::ffi::sqlite3_stmt) {
        if !stmt.is_null() {
            unsafe { rusqlite::ffi::sqlite3_finalize(stmt) };
        }
    }

    fn read_row(&self, stmt: *mut rusqlite::ffi::sqlite3_stmt, ncols: usize) -> Vec<Cell> {
        (0..ncols).map(|i| read_cell(stmt, i as i32)).collect()
    }

    fn columns_of(&self, stmt: *mut rusqlite::ffi::sqlite3_stmt, ncols: usize) -> Vec<ColumnInfo> {
        (0..ncols)
            .map(|i| {
                let name = unsafe {
                    let p = rusqlite::ffi::sqlite3_column_name(stmt, i as i32);
                    if p.is_null() {
                        format!("col{}", i + 1)
                    } else {
                        CStr::from_ptr(p).to_string_lossy().into_owned()
                    }
                };
                let decl = unsafe {
                    let p = rusqlite::ffi::sqlite3_column_decltype(stmt, i as i32);
                    if p.is_null() {
                        String::new()
                    } else {
                        CStr::from_ptr(p).to_string_lossy().into_owned()
                    }
                };
                let kind = kind_from_decl(&decl);
                ColumnInfo {
                    name,
                    type_name: if decl.is_empty() { "any".into() } else { decl },
                    kind,
                }
            })
            .collect()
    }

    /// Runs a statement without rows: the rows it changed, or None when it changes none by nature (DDL, BEGIN, PRAGMA…).
    /// changes() keeps the count of the last INSERT/UPDATE/DELETE, so it is only read for one of those.
    fn step_change(&self, stmt: *mut rusqlite::ffi::sqlite3_stmt, kw: &str) -> Result<Option<i64>> {
        let db = unsafe { self.conn.handle() };
        let before = unsafe { rusqlite::ffi::sqlite3_total_changes64(db) };
        let rc = unsafe { rusqlite::ffi::sqlite3_step(stmt) };
        if rc != rusqlite::ffi::SQLITE_DONE && rc != rusqlite::ffi::SQLITE_OK {
            return self.fail(rc).map(|_| None);
        }
        let changed = unsafe { rusqlite::ffi::sqlite3_total_changes64(db) } != before;
        let dml = matches!(kw, "INSERT" | "UPDATE" | "DELETE" | "REPLACE");
        Ok((dml || changed).then(|| self.conn.changes() as i64))
    }

    /// Ejecuta el lote. El primer resultado que no cabe en `fetch` queda abierto.
    fn run_batch(&mut self, sql: &str, fetch: usize, messages: &mut Vec<String>) -> Result<Vec<ResultSet>> {
        let mut results = Vec::new();
        let mut rest = sql.to_string();
        while !rest.trim().is_empty() {
            let kw = crate::session::first_keyword(&rest);
            let Some(prep) = self.prepare_next(&rest)? else {
                break;
            };
            rest = prep.rest;
            if !self.autocommit && self.conn.is_autocommit() && !no_implicit_tx(&kw) {
                if let Err(e) = self.conn.execute_batch("BEGIN") {
                    Self::finalize_stmt(prep.stmt);
                    return Err(e.into());
                }
            }
            if prep.ncols == 0 {
                let changed = match self.step_change(prep.stmt, &kw) {
                    Ok(n) => n,
                    Err(e) => {
                        Self::finalize_stmt(prep.stmt);
                        return Err(e);
                    }
                };
                Self::finalize_stmt(prep.stmt);
                messages.push(match changed {
                    Some(1) => "1 fila afectada".into(),
                    Some(n) => format!("{n} filas afectadas"),
                    None if kw.is_empty() => "Sentencia ejecutada".into(),
                    None => format!("{kw} ejecutado"),
                });
                results.push(ResultSet::count(changed.unwrap_or(0)));
                continue;
            }
            let columns = self.columns_of(prep.stmt, prep.ncols);
            let mut rows = Vec::new();
            let mut peeked = None;
            loop {
                let rc = unsafe { rusqlite::ffi::sqlite3_step(prep.stmt) };
                if rc == rusqlite::ffi::SQLITE_ROW {
                    let row = self.read_row(prep.stmt, prep.ncols);
                    if rows.len() >= fetch {
                        peeked = Some(row);
                        break;
                    }
                    rows.push(row);
                } else if rc == rusqlite::ffi::SQLITE_DONE {
                    break;
                } else {
                    Self::finalize_stmt(prep.stmt);
                    return self.fail(rc).map(|_| Vec::new());
                }
            }
            let has_more = peeked.is_some();
            results.push(ResultSet {
                columns,
                rows,
                has_more,
                rows_affected: None,
            });
            if has_more {
                self.cursor = Some(Cursor {
                    stmt: prep.stmt,
                    ncols: prep.ncols,
                    rest,
                    peeked,
                });
                break;
            }
            Self::finalize_stmt(prep.stmt);
        }
        Ok(results)
    }

    fn query(&self, sql: &str, params: impl rusqlite::Params) -> Result<Vec<Vec<Cell>>> {
        let mut stmt = self.conn.prepare(sql)?;
        let n = stmt.column_count();
        let mut rows = stmt.query(params)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let mut cells = Vec::with_capacity(n);
            for i in 0..n {
                cells.push(match row.get_ref(i)? {
                    ValueRef::Null => Cell::Null,
                    ValueRef::Integer(v) => Cell::int(v),
                    ValueRef::Real(v) => Cell::num(v),
                    ValueRef::Text(v) => Cell::Text(String::from_utf8_lossy(v).into_owned()),
                    ValueRef::Blob(v) => Cell::hex(v, 128),
                });
            }
            out.push(cells);
        }
        Ok(out)
    }

    fn fetch_inner(&mut self, n: usize) -> Result<FetchOutput> {
        let (stmt, ncols, first) = {
            let cur = self
                .cursor
                .as_mut()
                .ok_or_else(|| anyhow!("no hay cursor"))?;
            (cur.stmt, cur.ncols, cur.peeked.take())
        };
        let mut rows = Vec::new();
        if let Some(row) = first {
            rows.push(row);
        }
        let mut done = false;
        while rows.len() < n {
            let rc = unsafe { rusqlite::ffi::sqlite3_step(stmt) };
            if rc == rusqlite::ffi::SQLITE_ROW {
                rows.push(self.read_row(stmt, ncols));
            } else if rc == rusqlite::ffi::SQLITE_DONE {
                done = true;
                break;
            } else {
                self.cursor = None;
                return self.fail(rc).map(|_| FetchOutput::default());
            }
        }
        if !done && rows.len() >= n {
            let rc = unsafe { rusqlite::ffi::sqlite3_step(stmt) };
            if rc == rusqlite::ffi::SQLITE_ROW {
                let row = self.read_row(stmt, ncols);
                if let Some(cur) = self.cursor.as_mut() {
                    cur.peeked = Some(row);
                }
                return Ok(FetchOutput {
                    rows,
                    has_more: true,
                    extra: vec![],
                    messages: vec![],
                });
            } else if rc == rusqlite::ffi::SQLITE_DONE {
                done = true;
            } else {
                self.cursor = None;
                return self.fail(rc).map(|_| FetchOutput::default());
            }
        }
        if !done {
            let has_more = self
                .cursor
                .as_ref()
                .and_then(|c| c.peeked.as_ref())
                .is_some();
            return Ok(FetchOutput {
                rows,
                has_more,
                extra: vec![],
                messages: vec![],
            });
        }
        let rest = self
            .cursor
            .as_ref()
            .map(|c| c.rest.clone())
            .unwrap_or_default();
        self.cursor = None;
        let extra = if rest.trim().is_empty() {
            vec![]
        } else {
            self.run_batch(&rest, n, &mut Vec::new())?
        };
        Ok(FetchOutput {
            rows,
            has_more: self.cursor.is_some(),
            extra,
            messages: vec![],
        })
    }

    fn schema_of<'a>(&self, db: &'a str, schema: &'a str) -> &'a str {
        if !schema.is_empty() && schema != "main" {
            schema
        } else if !db.is_empty() {
            db
        } else {
            "main"
        }
    }

    fn catalog(&self, schema: &str) -> String {
        format!("{}.sqlite_schema", qi(schema))
    }
}

/// The referenced column of a row `f` of pragma_foreign_key_list (`schema`: the query parameter with the schema):
/// `REFERENCES t` without columns points to t's primary key, whose column in the same position is looked up.
fn fk_to(schema: &str) -> String {
    format!("COALESCE(f.\"to\", (SELECT p.name FROM pragma_table_info(f.\"table\", {schema}) p WHERE p.pk = f.seq + 1))")
}

impl Driver for SqliteDriver {
    fn execute(&mut self, sql: &str, fetch: usize) -> Result<ExecOutput> {
        self.close_cursor()?;
        let t0 = std::time::Instant::now();
        self.enter();
        let mut messages: Vec<String> =
            crate::session::discarded_note(std::mem::take(&mut self.discarded)).into_iter().collect();
        let results = self.run_batch(sql, fetch.max(1), &mut messages);
        self.leave();
        let results = results?;
        if let Some(c) = &self.cursor {
            messages.extend(crate::session::pending_note(count_statements(&c.rest)));
        }
        let in_transaction = !self.conn.is_autocommit();
        Ok(ExecOutput {
            results,
            messages,
            elapsed_ms: t0.elapsed().as_millis() as u64,
            in_transaction,
        })
    }

    fn fetch(&mut self, n: usize) -> Result<FetchOutput> {
        let n = n.max(1);
        if self.cursor.is_none() {
            bail!(crate::session::CURSOR_CLOSED);
        }
        self.enter();
        let result = self.fetch_inner(n);
        self.leave();
        result
    }

    fn close_cursor(&mut self) -> Result<()> {
        if let Some(c) = self.cursor.take() {
            self.discarded += count_statements(&c.rest);
        }
        Ok(())
    }

    fn set_autocommit(&mut self, on: bool) -> Result<bool> {
        self.close_cursor()?;
        if on && !self.conn.is_autocommit() {
            self.conn.execute_batch("COMMIT")?;
        }
        // Manual mode opens the transaction with the next statement (run_batch).
        self.autocommit = on;
        Ok(!self.conn.is_autocommit())
    }

    fn commit(&mut self) -> Result<bool> {
        self.close_cursor()?;
        if !self.conn.is_autocommit() {
            self.conn.execute_batch("COMMIT")?;
        }
        Ok(!self.conn.is_autocommit())
    }

    fn rollback(&mut self) -> Result<bool> {
        self.close_cursor()?;
        if !self.conn.is_autocommit() {
            self.conn.execute_batch("ROLLBACK")?;
        }
        Ok(!self.conn.is_autocommit())
    }

    fn children(&mut self, path: &[String]) -> Result<Vec<MetaNode>> {
        self.close_cursor()?;
        match path {
            [] => {
                let rows = self.query(
                    "SELECT name, file FROM pragma_database_list ORDER BY seq",
                    [],
                )?;
                Ok(rows
                    .into_iter()
                    .map(|r| {
                        let name = cell_string(&r[0]);
                        let file = cell_string(&r[1]);
                        MetaNode::branch(name.clone(), "database", vec![name])
                            .with_detail(if file.is_empty() { None } else { Some(file) })
                    })
                    .collect())
            }
            [db] => Ok(vec![MetaNode::branch(
                "main",
                "schema",
                vec![db.clone(), "main".into()],
            )]),
            [db, schema] => Ok(["Tablas", "Vistas", "Índices", "Triggers"]
                .into_iter()
                .zip(["tables", "views", "indexes", "triggers"])
                .map(|(label, key)| {
                    MetaNode::branch(
                        label,
                        "folder",
                        vec![db.clone(), schema.clone(), key.into()],
                    )
                })
                .collect()),
            [db, schema, folder] => {
                let sch = self.schema_of(db, schema);
                let cat = self.catalog(sch);
                let (sql, kind, branch) = match folder.as_str() {
                    "tables" => (format!("SELECT name, sql FROM {cat} WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"), "table", true),
                    "views" => (format!("SELECT name, sql FROM {cat} WHERE type = 'view' ORDER BY name"), "view", true),
                    "indexes" => (format!("SELECT name, sql FROM {cat} WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"), "index", false),
                    "triggers" => (format!("SELECT name, sql FROM {cat} WHERE type = 'trigger' ORDER BY name"), "trigger", false),
                    _ => return Ok(vec![]),
                };
                let rows = self.query(&sql, [])?;
                let mut nodes = Vec::new();
                for r in rows {
                    let name = cell_string(&r[0]);
                    let obj = ObjectRef::new(db, schema, &name, kind);
                    let detail = if kind == "table" {
                        let q = format!("{}.{}", qi(sch), qi(&name));
                        self.query(&format!("SELECT COUNT(*) FROM {q}"), [])
                            .ok()
                            .and_then(|c| c.first().map(|row| fmt_count(&row[0])))
                    } else {
                        None
                    };
                    let node = if branch {
                        MetaNode::branch(
                            name,
                            kind,
                            vec![db.clone(), schema.clone(), folder.clone(), obj.name.clone()],
                        )
                    } else {
                        MetaNode::leaf(name, kind, None)
                    };
                    nodes.push(node.with_obj(obj).with_detail(detail));
                }
                Ok(nodes)
            }
            [db, schema, folder, name] => {
                let kind = if folder == "views" { "view" } else { "table" };
                let sch = self.schema_of(db, schema);
                let cols = self.query(
                    "SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?1, ?2)",
                    rusqlite::params![name, sch],
                )?;
                let mut nodes: Vec<MetaNode> = cols
                    .iter()
                    .map(|r| {
                        let mut detail = cell_string(&r[1]);
                        if detail.is_empty() {
                            detail = "any".into();
                        }
                        if cell_i64(&r[4]) > 0 {
                            detail.push_str(" · PK");
                        }
                        if cell_i64(&r[2]) == 1 {
                            detail.push_str(" · not null");
                        }
                        let k = if cell_i64(&r[4]) > 0 {
                            "pkcolumn"
                        } else {
                            "column"
                        };
                        MetaNode::leaf(cell_string(&r[0]), k, Some(detail))
                    })
                    .collect();
                if kind == "table" {
                    let base = vec![db.clone(), schema.clone(), folder.clone(), name.clone()];
                    for (label, key) in [("Índices", "indexes"), ("Claves foráneas", "fks")] {
                        let mut p = base.clone();
                        p.push(key.into());
                        nodes.push(MetaNode::branch(label, "folder", p));
                    }
                }
                Ok(nodes)
            }
            [db, schema, _folder, name, sub] => {
                let sch = self.schema_of(db, schema);
                match sub.as_str() {
                    "indexes" => {
                        let rows = self.query(
                            "SELECT name, \"unique\", origin FROM pragma_index_list(?1, ?2)",
                            rusqlite::params![name, sch],
                        )?;
                        let mut nodes = Vec::new();
                        for r in rows {
                            let iname = cell_string(&r[0]);
                            let cols = self.query(
                                "SELECT name FROM pragma_index_info(?1, ?2)",
                                rusqlite::params![iname, sch],
                            )?;
                            let list = cols
                                .iter()
                                .map(|c| cell_string(&c[0]))
                                .collect::<Vec<_>>()
                                .join(", ");
                            let mut det = format!("({list})");
                            if cell_string(&r[2]) == "pk" {
                                det.push_str(" · PK");
                            } else if cell_i64(&r[1]) == 1 {
                                det.push_str(" · único");
                            }
                            nodes.push(MetaNode::leaf(iname, "index", Some(det)));
                        }
                        Ok(nodes)
                    }
                    "fks" => {
                        let rows = self.query(&format!("SELECT f.id, f.\"table\", f.\"from\", {} FROM pragma_foreign_key_list(?1, ?2) f ORDER BY f.id, f.seq", fk_to("?2")), rusqlite::params![name, sch])?;
                        let mut grouped: Vec<(i64, String, Vec<String>, Vec<String>)> = Vec::new();
                        for r in rows {
                            let id = cell_i64(&r[0]);
                            let table = cell_string(&r[1]);
                            let from = cell_string(&r[2]);
                            let to = cell_string(&r[3]);
                            if let Some(g) = grouped.last_mut().filter(|g| g.0 == id) {
                                g.2.push(from);
                                g.3.push(to);
                            } else {
                                grouped.push((id, table, vec![from], vec![to]));
                            }
                        }
                        Ok(grouped
                            .into_iter()
                            .map(|(id, table, from, to)| {
                                // Same "cols → table(cols)" shape on every engine; `obj` is the referenced table.
                                MetaNode::leaf(
                                    format!("fk{id}"),
                                    "key",
                                    Some(format!("{} → {}({})", from.join(", "), table, to.join(", "))),
                                )
                                .with_obj(ObjectRef::new(db, sch, &table, "table"))
                            })
                            .collect())
                    }
                    _ => Ok(vec![]),
                }
            }
            _ => Ok(vec![]),
        }
    }

    /// One query: pragma_foreign_key_list joined to every table of the schema's catalog (the explorer's tables), one
    /// row per column pair in key order.
    fn schema_foreign_keys(&mut self, path: &[String]) -> Result<Vec<SchemaForeignKey>> {
        self.close_cursor()?;
        let [db, schema] = path else { return crate::session::per_table_foreign_keys(self, path) };
        let sch = self.schema_of(db, schema).to_string();
        let rows = self.query(
            &format!(
                "SELECT m.name, f.id, f.\"table\", f.\"from\", {} FROM {} m, pragma_foreign_key_list(m.name, ?1) f \
                 WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, f.id, f.seq",
                fk_to("?1"),
                self.catalog(&sch)
            ),
            rusqlite::params![sch],
        )?;
        Ok(crate::session::group_foreign_keys(rows.iter().map(|r| {
            let table = cell_string(&r[0]);
            FkColumn {
                key: format!("{table}\u{0}{}", cell_i64(&r[1])),
                name: format!("fk{}", cell_i64(&r[1])),
                table: ObjectRef::new(db, schema, &table, "table"),
                column: cell_string(&r[3]),
                target: ObjectRef::new(db, &sch, &cell_string(&r[2]), "table"),
                target_column: cell_string(&r[4]),
            }
        })))
    }

    fn table_columns(&mut self, obj: &ObjectRef) -> Result<Vec<TableColumn>> {
        self.close_cursor()?;
        let sch = self.schema_of(&obj.database, &obj.schema);
        let rows = self.query(
            "SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?1, ?2) ORDER BY cid",
            rusqlite::params![obj.name, sch],
        )?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let type_name = {
                    let t = cell_string(&r[1]);
                    if t.is_empty() {
                        "any".into()
                    } else {
                        t
                    }
                };
                TableColumn {
                    name: cell_string(&r[0]),
                    kind: kind_from_decl(&type_name),
                    nullable: cell_i64(&r[2]) == 0,
                    primary_key: cell_i64(&r[4]) > 0,
                    identity: type_name.to_ascii_lowercase().contains("int") && cell_i64(&r[4]) > 0,
                    default: match &r[3] {
                        Cell::Null => None,
                        other => Some(cell_string(other)),
                    },
                    type_name,
                }
            })
            .collect())
    }

    fn ddl(&mut self, obj: &ObjectRef) -> Result<String> {
        self.close_cursor()?;
        let sch = self.schema_of(&obj.database, &obj.schema);
        let cat = self.catalog(sch);
        let rows = self.query(
            &format!("SELECT sql FROM {cat} WHERE name = ?1"),
            rusqlite::params![obj.name],
        )?;
        match rows.first().map(|r| &r[0]) {
            Some(Cell::Text(s)) if !s.trim().is_empty() => {
                Ok(format!("{};", s.trim().trim_end_matches(';')))
            }
            _ => bail!("No hay definición disponible para {}", obj.name),
        }
    }

    fn completion(&mut self, database: &str) -> Result<CompletionSchema> {
        self.close_cursor()?;
        let sch = if database.is_empty() {
            self.database.as_str()
        } else {
            database
        };
        let sch = if sch.is_empty() { "main" } else { sch };
        let cat = self.catalog(sch);
        let rows = self.query(
            &format!("SELECT m.name, p.name FROM {cat} m JOIN pragma_table_info(m.name, ?1) p WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid"),
            rusqlite::params![sch],
        )?;
        let mut out = CompletionSchema::default();
        for r in rows {
            let (t, c) = (cell_string(&r[0]), cell_string(&r[1]));
            match out.tables.last_mut() {
                Some(last) if last.name == t => last.columns.push(c),
                _ => out.tables.push(CompletionTable {
                    schema: sch.to_string(),
                    name: t,
                    columns: vec![c],
                }),
            }
        }
        Ok(out)
    }

    fn databases(&mut self) -> Result<Vec<String>> {
        let rows = self.query("SELECT name FROM pragma_database_list ORDER BY seq", [])?;
        Ok(rows.into_iter().map(|r| cell_string(&r[0])).collect())
    }

    fn current_database(&mut self) -> Result<String> {
        Ok(self.database.clone())
    }

    fn use_database(&mut self, db: &str) -> Result<()> {
        let rows = self.query(
            "SELECT name FROM pragma_database_list WHERE name = ?1",
            rusqlite::params![db],
        )?;
        if rows.is_empty() {
            bail!("Base de datos no encontrada: {db}");
        }
        self.database = db.to_string();
        Ok(())
    }

    fn qualified_name(&self, o: &ObjectRef) -> String {
        let sch = if !o.schema.is_empty() {
            o.schema.as_str()
        } else if !o.database.is_empty() {
            o.database.as_str()
        } else {
            "main"
        };
        format!("{}.{}", qi(sch), qi(&o.name))
    }

    fn quote_ident(&self, s: &str) -> String {
        qi(s)
    }

    fn server_info(&mut self) -> Result<String> {
        let rows = self.query("SELECT sqlite_version()", [])?;
        let ver = rows
            .first()
            .map(|r| cell_string(&r[0]))
            .unwrap_or_else(|| "?".into());
        Ok(format!("SQLite {ver} — {}", self.path))
    }

    fn canceller(&self) -> Canceller {
        let cancel = self.cancel.clone();
        Arc::new(move || {
            if cancel.busy.load(Ordering::Relaxed) {
                cancel.handle.interrupt();
            }
        })
    }
}

fn sqlite_path(cfg: &ConnConfig) -> Result<String> {
    let raw = if !cfg.file_path.trim().is_empty() {
        cfg.file_path.trim()
    } else if cfg.database.trim() == ":memory:" || cfg.host.trim() == ":memory:" {
        ":memory:"
    } else if !cfg.database.trim().is_empty() {
        cfg.database.trim()
    } else {
        ""
    };
    if raw.is_empty() {
        bail!("Indica la ruta del fichero SQLite");
    }
    Ok(raw.to_string())
}

/// One handle per in-memory connection, so its database lives while the connection is open (SQLite drops a memory
/// database with its last handle) and not only while some session has it.
fn memory_keepers() -> &'static std::sync::Mutex<std::collections::HashMap<String, Connection>> {
    static KEEPERS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Connection>>> =
        std::sync::OnceLock::new();
    KEEPERS.get_or_init(Default::default)
}

/// A ':memory:' database shared by every session of the connection (explorer, consoles, tables): a named in-memory
/// database with a shared cache. Without a connection id (a connection test) it is a private one.
fn open_memory(conn_id: &str) -> Result<Connection> {
    let name: String = conn_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if name.is_empty() {
        return Ok(Connection::open_in_memory()?);
    }
    let uri = format!("file:celer-mem-{name}?mode=memory&cache=shared");
    let open = || {
        Connection::open_with_flags(
            &uri,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_URI,
        )
    };
    let mut keepers = memory_keepers().lock().unwrap_or_else(|e| e.into_inner());
    if !keepers.contains_key(&name) {
        keepers.insert(name, open()?);
    }
    Ok(open()?)
}

/// Disconnecting an in-memory connection drops its database (once its sessions close too).
pub fn forget_memory(conn_id: &str) {
    let name: String = conn_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    memory_keepers().lock().unwrap_or_else(|e| e.into_inner()).remove(&name);
}

fn qi(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Statements that control the transaction themselves or cannot run inside one: manual mode opens none for them.
fn no_implicit_tx(kw: &str) -> bool {
    matches!(
        kw,
        "BEGIN" | "COMMIT" | "END" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "VACUUM" | "ATTACH" | "DETACH" | "PRAGMA"
    )
}

/// Statements in the rest of a script (pieces with only comments do not count). `sqlite3_complete` says where
/// one ends, so a `;` inside a string or a trigger body does not split it.
fn count_statements(sql: &str) -> usize {
    let complete = |chunk: &str| {
        CString::new(chunk).is_ok_and(|c| unsafe { rusqlite::ffi::sqlite3_complete(c.as_ptr()) } != 0)
    };
    let code = |chunk: &str| !crate::session::first_keyword(chunk).is_empty();
    let mut n = 0;
    let mut start = 0;
    for (i, ch) in sql.char_indices() {
        if ch == ';' && complete(&sql[start..=i]) {
            n += usize::from(code(&sql[start..=i]));
            start = i + 1;
        }
    }
    n + usize::from(code(&sql[start..]))
}

fn kind_from_decl(decl: &str) -> ColKind {
    let t = decl.to_ascii_lowercase();
    if t.contains("int") {
        ColKind::Number
    } else if t.contains("char") || t.contains("clob") || t.contains("text") || t.contains("string")
    {
        ColKind::Text
    } else if t.contains("blob") || t.contains("binary") {
        ColKind::Binary
    } else if t.contains("real")
        || t.contains("floa")
        || t.contains("doub")
        || t.contains("num")
        || t.contains("dec")
    {
        ColKind::Number
    } else if t.contains("date") || t.contains("time") {
        ColKind::Date
    } else if t.contains("bool") {
        ColKind::Bool
    } else {
        ColKind::Other
    }
}

fn read_cell(stmt: *mut rusqlite::ffi::sqlite3_stmt, i: i32) -> Cell {
    match unsafe { rusqlite::ffi::sqlite3_column_type(stmt, i) } {
        t if t == rusqlite::ffi::SQLITE_NULL => Cell::Null,
        t if t == rusqlite::ffi::SQLITE_INTEGER => {
            Cell::int(unsafe { rusqlite::ffi::sqlite3_column_int64(stmt, i) })
        }
        t if t == rusqlite::ffi::SQLITE_FLOAT => {
            Cell::num(unsafe { rusqlite::ffi::sqlite3_column_double(stmt, i) })
        }
        t if t == rusqlite::ffi::SQLITE_BLOB => {
            let n = unsafe { rusqlite::ffi::sqlite3_column_bytes(stmt, i) } as usize;
            let p = unsafe { rusqlite::ffi::sqlite3_column_blob(stmt, i) } as *const u8;
            if p.is_null() || n == 0 {
                Cell::Text("0x".into())
            } else {
                Cell::hex(unsafe { std::slice::from_raw_parts(p, n) }, BINARY_PREVIEW)
            }
        }
        _ => {
            let n = unsafe { rusqlite::ffi::sqlite3_column_bytes(stmt, i) } as usize;
            let p = unsafe { rusqlite::ffi::sqlite3_column_text(stmt, i) };
            if p.is_null() {
                Cell::Null
            } else {
                let bytes = unsafe { std::slice::from_raw_parts(p, n) };
                Cell::Text(String::from_utf8_lossy(bytes).into_owned())
            }
        }
    }
}

fn cell_string(c: &Cell) -> String {
    match c {
        Cell::Null => String::new(),
        Cell::Bool(v) => v.to_string(),
        Cell::Int(v) => v.to_string(),
        Cell::Num(v) => v.to_string(),
        Cell::Text(v) => v.clone(),
    }
}

fn cell_i64(c: &Cell) -> i64 {
    match c {
        Cell::Int(v) => *v,
        Cell::Num(v) => *v as i64,
        Cell::Bool(v) => i64::from(*v),
        Cell::Text(v) => v.parse().unwrap_or(0),
        Cell::Null => 0,
    }
}

fn fmt_count(c: &Cell) -> String {
    let n = cell_i64(c);
    if n == 1 {
        "1 fila".into()
    } else {
        format!("{n} filas")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> SqliteDriver {
        let mut cfg = ConnConfig::default();
        cfg.kind = DbKind::Sqlite;
        cfg.file_path = ":memory:".into();
        SqliteDriver::connect(cfg).unwrap()
    }

    #[test]
    fn runs_the_startup_script() {
        let mut cfg = ConnConfig::default();
        cfg.kind = DbKind::Sqlite;
        cfg.file_path = ":memory:".into();
        cfg.startup_sql = "-- inicio\nCREATE TEMP TABLE boot(x); INSERT INTO boot VALUES ('a;b');".into();
        let mut d = SqliteDriver::connect(cfg.clone()).unwrap();
        let out = d.execute("SELECT x FROM boot", 10).unwrap();
        assert_eq!(out.results[0].rows.len(), 1);
        cfg.startup_sql = "SELEC 1".into();
        let err = SqliteDriver::connect(cfg).err().expect("script erróneo");
        assert!(err.to_string().contains("script de inicio"), "{err}");
    }

    #[test]
    fn pages_metadata_and_script() {
        let mut d = mem();
        let created = d
            .execute(
                "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\n\
                 INSERT INTO t(name) VALUES ('a'),('b'),('c');",
                10,
            )
            .unwrap();
        assert!(created
            .results
            .iter()
            .any(|r| r.rows_affected == Some(3) || r.rows_affected == Some(1)));

        let out = d
            .execute("SELECT id, name FROM t ORDER BY id; SELECT 'z' AS k;", 2)
            .unwrap();
        assert_eq!(out.results.len(), 1);
        assert_eq!(out.results[0].rows.len(), 2);
        assert!(out.results[0].has_more);
        assert_eq!(out.results[0].columns[1].name, "name");

        let more = d.fetch(10).unwrap();
        assert_eq!(more.rows.len(), 1);
        assert!(!more.rows.is_empty());
        assert_eq!(more.extra.len(), 1);
        assert_eq!(cell_string(&more.extra[0].rows[0][0]), "z");

        let kids = d.children(&[]).unwrap();
        assert_eq!(kids[0].name, "main");
        let tables = d
            .children(&["main".into(), "main".into(), "tables".into()])
            .unwrap();
        assert_eq!(tables[0].name, "t");
        assert!(tables[0].detail.as_deref().unwrap().contains("3"));

        let obj = ObjectRef::new("main", "main", "t", "table");
        let cols = d.table_columns(&obj).unwrap();
        assert!(cols[0].primary_key);
        assert!(!cols[1].nullable);
        let ddl = d.ddl(&obj).unwrap();
        assert!(ddl.to_ascii_lowercase().contains("create table"));
        let comp = d.completion("main").unwrap();
        assert_eq!(
            comp.tables[0].columns,
            vec!["id".to_string(), "name".to_string()]
        );
        assert!(d.server_info().unwrap().starts_with("SQLite"));
    }

    #[test]
    fn tells_statements_left_behind_an_open_result() {
        let mut d = mem();
        d.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, flag INT DEFAULT 0); INSERT INTO t(id) VALUES (1),(2),(3)", 10)
            .unwrap();
        let out = d
            .execute("SELECT * FROM t; UPDATE t SET flag = 1; -- fin\nSELECT ';'; /* x */", 2)
            .unwrap();
        assert!(out.results[0].has_more);
        assert!(out.messages.iter().any(|m| m.starts_with("Quedan 2 sentencias")), "{:?}", out.messages);
        let out = d.execute("SELECT SUM(flag) FROM t", 10).unwrap();
        assert_eq!(cell_i64(&out.results[0].rows[0][0]), 0);
        assert!(out.messages.iter().any(|m| m.starts_with("No se ejecutaron 2 sentencias")), "{:?}", out.messages);
        // Read to the end, they run and nothing is reported as dropped.
        d.execute("SELECT * FROM t; UPDATE t SET flag = 1", 2).unwrap();
        d.fetch(10).unwrap();
        let out = d.execute("SELECT SUM(flag) FROM t", 10).unwrap();
        assert_eq!(cell_i64(&out.results[0].rows[0][0]), 3);
        assert!(out.messages.iter().all(|m| !m.contains("sentencia")), "{:?}", out.messages);
        // Reading the catalog (autocompletion) closes the open result: fetch says so instead of a last page.
        assert!(d.execute("SELECT * FROM t", 2).unwrap().results[0].has_more);
        d.completion("main").unwrap();
        assert!(d.fetch(10).is_err());
        assert_eq!(count_statements("CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET flag = 2; END; SELECT 1"), 2);
    }

    #[test]
    fn counts_only_rows_a_statement_changed() {
        let mut d = mem();
        let out = d
            .execute("CREATE TABLE t (x); INSERT INTO t VALUES (1),(2),(3); CREATE INDEX ix ON t (x); BEGIN; DELETE FROM t WHERE x > 5; COMMIT", 10)
            .unwrap();
        let counts: Vec<Option<i64>> = out.results.iter().map(|r| r.rows_affected).collect();
        assert_eq!(counts, [Some(0), Some(3), Some(0), Some(0), Some(0), Some(0)]);
        assert_eq!(out.messages, ["CREATE ejecutado", "3 filas afectadas", "CREATE ejecutado", "BEGIN ejecutado", "0 filas afectadas", "COMMIT ejecutado"]);
    }

    #[test]
    fn memory_is_shared_by_the_connection_sessions() {
        let open = |id: &str| {
            let mut cfg = ConnConfig::default();
            cfg.kind = DbKind::Sqlite;
            cfg.id = id.into();
            cfg.database = ":memory:".into();
            SqliteDriver::connect(cfg).unwrap()
        };
        let mut console = open("mem-test-a");
        console.execute("CREATE TABLE t (x); INSERT INTO t VALUES (1)", 10).unwrap();
        let mut explorer = open("mem-test-a");
        let tables = explorer.children(&["main".into(), "main".into(), "tables".into()]).unwrap();
        assert_eq!(tables.len(), 1);
        // Every session closing does not drop it while the connection is open.
        drop(console);
        drop(explorer);
        let mut again = open("mem-test-a");
        assert_eq!(cell_i64(&again.execute("SELECT COUNT(*) FROM t", 10).unwrap().results[0].rows[0][0]), 1);
        // Another connection has its own; disconnecting drops it.
        assert!(open("mem-test-b").execute("SELECT * FROM t", 10).is_err());
        forget_memory("mem-test-a");
        drop(again);
        assert!(open("mem-test-a").execute("SELECT * FROM t", 10).is_err());
        forget_memory("mem-test-a");
        forget_memory("mem-test-b");
    }

    #[test]
    fn transactions() {
        let mut d = mem();
        d.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)", 10)
            .unwrap();
        assert!(!d.set_autocommit(false).unwrap());
        assert!(d.execute("INSERT INTO t(name) VALUES ('x')", 10).unwrap().in_transaction);
        assert!(d.rollback().unwrap() == false);
        let out = d.execute("SELECT COUNT(*) FROM t", 10).unwrap();
        assert_eq!(cell_i64(&out.results[0].rows[0][0]), 0);
        // Still manual after a commit, a rollback, or a COMMIT typed in the console.
        d.execute("INSERT INTO t(name) VALUES ('a')", 10).unwrap();
        d.commit().unwrap();
        assert!(d.execute("INSERT INTO t(name) VALUES ('b')", 10).unwrap().in_transaction);
        d.rollback().unwrap();
        d.execute("INSERT INTO t(name) VALUES ('c'); COMMIT; INSERT INTO t(name) VALUES ('d')", 10).unwrap();
        d.rollback().unwrap();
        let out = d.execute("SELECT group_concat(name, '') FROM (SELECT name FROM t ORDER BY id)", 10).unwrap();
        assert_eq!(cell_string(&out.results[0].rows[0][0]), "ac");
        d.rollback().unwrap();
        // Back to autocommit: nothing waits for a commit.
        assert!(!d.set_autocommit(true).unwrap());
        assert!(!d.execute("INSERT INTO t(name) VALUES ('e')", 10).unwrap().in_transaction);
    }
}
