//! Driver nativo de SQL Server (protocolo TDS con `tiberius`, sin drivers externos).

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use futures_util::TryStreamExt;
use parking_lot::Mutex;
use tiberius::{AuthMethod, Client, ColumnData, ColumnType, Config, EncryptionLevel, FromSql, QueryItem, SqlBrowser};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};
use tokio_util::sync::CancellationToken;

use crate::model::*;
use crate::session::{first_keyword, Canceller, Driver};

type Cli = Client<Compat<TcpStream>>;

const BINARY_PREVIEW: usize = 4096;

enum Item {
    Meta(Vec<ColumnInfo>),
    Row(Vec<Cell>),
    Count(i64),
    Error(String),
}

struct Cursor {
    rx: mpsc::Receiver<Item>,
    done: oneshot::Receiver<Option<Cli>>,
    peeked: Option<Item>,
}

pub struct MssqlDriver {
    cfg: ConnConfig,
    rt: tokio::runtime::Runtime,
    client: Option<Cli>,
    cursor: Option<Cursor>,
    cancel: Arc<Mutex<Option<CancellationToken>>>,
    database: String,
    autocommit: bool,
    in_tx: bool,
}

impl MssqlDriver {
    pub fn connect(cfg: ConnConfig) -> Result<MssqlDriver> {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        let client = rt.block_on(connect_client(&cfg, None))?;
        let mut d = MssqlDriver {
            database: cfg.database.clone(),
            cfg,
            rt,
            client: Some(client),
            cursor: None,
            cancel: Arc::new(Mutex::new(None)),
            autocommit: true,
            in_tx: false,
        };
        if d.database.is_empty() {
            d.database = d.current_database().unwrap_or_default();
        }
        Ok(d)
    }

    /// Devuelve el cliente, reconectando si la conexión se perdió o se canceló.
    fn take_client(&mut self) -> Result<Cli> {
        if let Some(c) = self.client.take() {
            return Ok(c);
        }
        let db = if self.database.is_empty() { None } else { Some(self.database.clone()) };
        let mut c = self.rt.block_on(connect_client(&self.cfg, db))?;
        if !self.autocommit {
            self.rt.block_on(async { c.simple_query("SET IMPLICIT_TRANSACTIONS ON").await?.into_results().await })?;
        }
        self.in_tx = false;
        Ok(c)
    }

    fn start(&mut self, sql: String, dml: bool) -> Result<()> {
        self.close_cursor()?;
        let client = self.take_client()?;
        let token = CancellationToken::new();
        *self.cancel.lock() = Some(token.clone());
        let (tx, rx) = mpsc::channel(1024);
        let (dtx, drx) = oneshot::channel();
        self.rt.spawn(async move {
            let c = run_query(client, sql, dml, tx, token).await;
            let _ = dtx.send(c);
        });
        self.cursor = Some(Cursor { rx, done: drx, peeked: None });
        Ok(())
    }

    fn next_item(&mut self) -> Option<Item> {
        let cur = self.cursor.as_mut()?;
        if let Some(it) = cur.peeked.take() {
            return Some(it);
        }
        self.rt.block_on(cur.rx.recv())
    }

    fn peek_back(&mut self, it: Item) {
        if let Some(cur) = self.cursor.as_mut() {
            cur.peeked = Some(it);
        }
    }

    /// Termina el cursor tras consumir todo el flujo y recupera el cliente.
    fn finish(&mut self) {
        if let Some(cur) = self.cursor.take() {
            drop(cur.rx);
            self.client = self.rt.block_on(cur.done).ok().flatten();
        }
        *self.cancel.lock() = None;
    }

    /// Lee resultados hasta que uno supera `fetch` filas (queda abierto) o acaba el lote.
    fn pump(&mut self, fetch: usize, messages: &mut Vec<String>) -> Vec<ResultSet> {
        let mut results = Vec::new();
        let mut current: Option<ResultSet> = None;
        loop {
            match self.next_item() {
                Some(Item::Meta(cols)) => {
                    if let Some(rs) = current.take() {
                        results.push(rs);
                    }
                    current = Some(ResultSet { columns: cols, rows: Vec::new(), has_more: false, rows_affected: None });
                }
                Some(Item::Row(r)) => {
                    let rs = current.get_or_insert_with(|| ResultSet {
                        columns: vec![],
                        rows: vec![],
                        has_more: false,
                        rows_affected: None,
                    });
                    if rs.rows.len() >= fetch {
                        rs.has_more = true;
                        results.push(current.take().unwrap());
                        self.peek_back(Item::Row(r));
                        return results;
                    }
                    rs.rows.push(r);
                }
                Some(Item::Count(n)) => {
                    if let Some(rs) = current.take() {
                        results.push(rs);
                    }
                    results.push(ResultSet::count(n));
                }
                Some(Item::Error(m)) => messages.push(m),
                None => {
                    if let Some(rs) = current.take() {
                        results.push(rs);
                    }
                    self.finish();
                    return results;
                }
            }
        }
    }

    fn query_rows(&mut self, sql: &str) -> Result<Vec<Vec<Cell>>> {
        self.close_cursor()?;
        let mut client = self.take_client()?;
        let sql = sql.to_string();
        let (res, client) = self.rt.block_on(async move {
            let r: Result<Vec<Vec<Cell>>> = async {
                let rows = client.simple_query(sql).await?.into_first_result().await?;
                Ok(rows.into_iter().map(row_to_cells).collect())
            }
            .await;
            (r, client)
        });
        self.client = Some(client);
        res
    }

    fn refresh_tx_state(&mut self) {
        if self.autocommit {
            self.in_tx = false;
            return;
        }
        if self.cursor.is_some() {
            self.in_tx = true;
            return;
        }
        self.in_tx = self
            .query_rows("SELECT @@TRANCOUNT")
            .ok()
            .and_then(|r| r.first().and_then(|r| r.first()).map(cell_i64))
            .unwrap_or(0)
            > 0;
    }

    fn obj_id(&self, o: &ObjectRef) -> String {
        format!("OBJECT_ID({})", ql(&self.qualified_name(o)))
    }

    fn columns_query(&self, o: &ObjectRef) -> String {
        let db = qi(&o.database);
        format!(
            "SELECT c.name, ty.name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, \
             CASE WHEN EXISTS(SELECT 1 FROM {db}.sys.index_columns ic JOIN {db}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
               WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END, \
             dc.definition, c.is_computed, cc.definition \
             FROM {db}.sys.columns c JOIN {db}.sys.types ty ON ty.user_type_id = c.user_type_id \
             LEFT JOIN {db}.sys.default_constraints dc ON dc.object_id = c.default_object_id \
             LEFT JOIN {db}.sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id \
             WHERE c.object_id = {} ORDER BY c.column_id",
            self.obj_id(o)
        )
    }

    fn table_ddl(&mut self, o: &ObjectRef) -> Result<String> {
        let cols = self.query_rows(&self.columns_query(o))?;
        if cols.is_empty() {
            bail!("No se encontró el objeto {}", self.qualified_name(o));
        }
        let mut lines = Vec::new();
        for r in &cols {
            let name = cell_str(&r[0]);
            if cell_i64(&r[9]) == 1 {
                lines.push(format!("    {} AS {}", qi(&name), cell_str(&r[10])));
                continue;
            }
            let ty = mssql_type(&cell_str(&r[1]), cell_i64(&r[2]), cell_i64(&r[3]), cell_i64(&r[4]));
            let mut l = format!("    {} {}", qi(&name), ty);
            if cell_i64(&r[6]) == 1 {
                l.push_str(" IDENTITY(1,1)");
            }
            l.push_str(if cell_i64(&r[5]) == 1 { " NULL" } else { " NOT NULL" });
            if let Cell::Text(d) = &r[8] {
                l.push_str(&format!(" DEFAULT {d}"));
            }
            lines.push(l);
        }
        let db = qi(&o.database);
        let oid = self.obj_id(o);
        let idx = self.query_rows(&format!(
            "SELECT i.name, i.is_primary_key, i.is_unique, i.type_desc, \
               STUFF((SELECT ', ' + QUOTENAME(c.name) + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END \
                      FROM {db}.sys.index_columns ic JOIN {db}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                      WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0 \
                      ORDER BY ic.key_ordinal FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, ''), \
               i.is_unique_constraint \
             FROM {db}.sys.indexes i WHERE i.object_id = {oid} AND i.type > 0 ORDER BY i.is_primary_key DESC, i.name"
        ))?;
        for r in idx.iter().filter(|r| cell_i64(&r[1]) == 1) {
            let clustered = if cell_str(&r[3]).starts_with("CLUSTERED") { " CLUSTERED" } else { " NONCLUSTERED" };
            lines.push(format!("    CONSTRAINT {} PRIMARY KEY{} ({})", qi(&cell_str(&r[0])), clustered, cell_str(&r[4])));
        }
        let fks = self.query_rows(&format!(
            "SELECT fk.name, \
               STUFF((SELECT ', ' + QUOTENAME(c.name) FROM {db}.sys.foreign_key_columns k JOIN {db}.sys.columns c ON c.object_id = k.parent_object_id AND c.column_id = k.parent_column_id \
                      WHERE k.constraint_object_id = fk.object_id ORDER BY k.constraint_column_id FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, ''), \
               QUOTENAME(rs.name) + '.' + QUOTENAME(rt.name), \
               STUFF((SELECT ', ' + QUOTENAME(c.name) FROM {db}.sys.foreign_key_columns k JOIN {db}.sys.columns c ON c.object_id = k.referenced_object_id AND c.column_id = k.referenced_column_id \
                      WHERE k.constraint_object_id = fk.object_id ORDER BY k.constraint_column_id FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, ''), \
               fk.delete_referential_action_desc, fk.update_referential_action_desc \
             FROM {db}.sys.foreign_keys fk JOIN {db}.sys.tables rt ON rt.object_id = fk.referenced_object_id \
             JOIN {db}.sys.schemas rs ON rs.schema_id = rt.schema_id WHERE fk.parent_object_id = {oid} ORDER BY fk.name"
        ))?;
        for r in &fks {
            let mut l = format!(
                "    CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
                qi(&cell_str(&r[0])),
                cell_str(&r[1]),
                cell_str(&r[2]),
                cell_str(&r[3])
            );
            for (i, verb) in [(4, "DELETE"), (5, "UPDATE")] {
                let a = cell_str(&r[i]);
                if a != "NO_ACTION" {
                    l.push_str(&format!(" ON {verb} {}", a.replace('_', " ")));
                }
            }
            lines.push(l);
        }
        let mut out = format!("CREATE TABLE {} (\n{}\n);\n", self.qualified_name(o), lines.join(",\n"));
        for r in idx.iter().filter(|r| cell_i64(&r[1]) == 0) {
            let unique = if cell_i64(&r[2]) == 1 { "UNIQUE " } else { "" };
            let kind = if cell_str(&r[3]).starts_with("CLUSTERED") { "CLUSTERED " } else { "NONCLUSTERED " };
            out.push_str(&format!(
                "\nCREATE {unique}{kind}INDEX {} ON {} ({});",
                qi(&cell_str(&r[0])),
                self.qualified_name(o),
                cell_str(&r[4])
            ));
        }
        Ok(out)
    }
}

async fn connect_client(cfg: &ConnConfig, database: Option<String>) -> Result<Cli> {
    let mut config = Config::new();
    let host = if cfg.host.trim().is_empty() { "localhost" } else { cfg.host.trim() };
    // Se admite la notación "servidor\instancia" en el campo del host.
    let (host, inst_from_host) = match host.split_once('\\') {
        Some((h, i)) => (h.to_string(), i.to_string()),
        None => (host.to_string(), String::new()),
    };
    config.host(&host);
    if let Some(p) = cfg.port {
        config.port(p);
    }
    let instance = if cfg.instance.trim().is_empty() { inst_from_host } else { cfg.instance.trim().to_string() };
    if !instance.is_empty() {
        config.instance_name(&instance);
    }
    let db = database.unwrap_or_else(|| cfg.database.clone());
    if !db.is_empty() {
        config.database(&db);
    }
    config.application_name("Celer");
    if cfg.integrated_auth {
        #[cfg(windows)]
        config.authentication(AuthMethod::Integrated);
        #[cfg(not(windows))]
        bail!("La autenticación integrada solo está disponible en Windows");
    } else {
        config.authentication(AuthMethod::sql_server(&cfg.user, cfg.password.clone().unwrap_or_default()));
    }
    config.encryption(match cfg.encryption.as_str() {
        "off" => EncryptionLevel::NotSupported,
        "login" => EncryptionLevel::Off,
        _ => EncryptionLevel::Required,
    });
    if cfg.trust_cert {
        config.trust_cert();
    }
    let fut = async {
        let mut config = config;
        for _ in 0..3 {
            let tcp = if !instance.is_empty() && cfg.port.is_none() {
                TcpStream::connect_named(&config).await?
            } else {
                TcpStream::connect(config.get_addr()).await?
            };
            tcp.set_nodelay(true)?;
            match Client::connect(config.clone(), tcp.compat_write()).await {
                Ok(c) => return Ok(c),
                // Azure SQL y grupos de disponibilidad pueden redirigir a otro servidor.
                Err(tiberius::error::Error::Routing { host, port }) => {
                    config.host(&host);
                    config.port(port);
                }
                Err(e) => return Err(anyhow!(friendly_error(&e))),
            }
        }
        bail!("Demasiadas redirecciones del servidor")
    };
    match tokio::time::timeout(Duration::from_secs(20), fut).await {
        Ok(r) => r,
        Err(_) => bail!("Tiempo de espera agotado al conectar con {host}"),
    }
}

fn friendly_error(e: &tiberius::error::Error) -> String {
    match e {
        tiberius::error::Error::Server(t) => format!("Msg {}, nivel {}, línea {}: {}", t.code(), t.class(), t.line(), t.message()),
        other => other.to_string(),
    }
}

/// Indica si el error deja la conexión inservible.
fn is_fatal(e: &tiberius::error::Error) -> bool {
    !matches!(e, tiberius::error::Error::Server(_))
}

enum Outcome {
    Ok,
    Broken,
}

async fn run_query(mut client: Cli, sql: String, dml: bool, tx: mpsc::Sender<Item>, token: CancellationToken) -> Option<Cli> {
    let outcome = {
        let work = stream_query(&mut client, sql, dml, &tx);
        tokio::select! {
            o = work => o,
            _ = token.cancelled() => {
                let _ = tx.try_send(Item::Error("Consulta cancelada por el usuario (la conexión se ha reiniciado)".into()));
                Outcome::Broken
            }
        }
    };
    match outcome {
        Outcome::Ok => Some(client),
        Outcome::Broken => None,
    }
}

async fn stream_query(client: &mut Cli, sql: String, dml: bool, tx: &mpsc::Sender<Item>) -> Outcome {
    if dml {
        return match client.execute(sql, &[]).await {
            Ok(r) => {
                let _ = tx.send(Item::Count(r.total() as i64)).await;
                Outcome::Ok
            }
            Err(e) => {
                let fatal = is_fatal(&e);
                let _ = tx.send(Item::Error(friendly_error(&e))).await;
                if fatal { Outcome::Broken } else { Outcome::Ok }
            }
        };
    }
    let mut stream = match client.simple_query(sql).await {
        Ok(s) => s,
        Err(e) => {
            let fatal = is_fatal(&e);
            let _ = tx.send(Item::Error(friendly_error(&e))).await;
            return if fatal { Outcome::Broken } else { Outcome::Ok };
        }
    };
    // Si la interfaz deja de leer (cierra el cursor), seguimos vaciando el flujo sin enviar.
    let mut sending = true;
    loop {
        match stream.try_next().await {
            Ok(Some(QueryItem::Metadata(m))) => {
                if sending {
                    let cols = m.columns().iter().map(column_info).collect();
                    sending = tx.send(Item::Meta(cols)).await.is_ok();
                }
            }
            Ok(Some(QueryItem::Row(r))) => {
                if sending {
                    sending = tx.send(Item::Row(row_to_cells(r))).await.is_ok();
                }
            }
            Ok(None) => return Outcome::Ok,
            Err(e) => {
                if sending {
                    sending = tx.send(Item::Error(friendly_error(&e))).await.is_ok();
                }
                if is_fatal(&e) {
                    return Outcome::Broken;
                }
            }
        }
    }
}

fn column_info(c: &tiberius::Column) -> ColumnInfo {
    let (t, k) = match c.column_type() {
        ColumnType::Null => ("null", ColKind::Other),
        ColumnType::Bit | ColumnType::Bitn => ("bit", ColKind::Bool),
        ColumnType::Int1 => ("tinyint", ColKind::Number),
        ColumnType::Int2 => ("smallint", ColKind::Number),
        ColumnType::Int4 => ("int", ColKind::Number),
        ColumnType::Int8 => ("bigint", ColKind::Number),
        ColumnType::Intn => ("int", ColKind::Number),
        ColumnType::Float4 => ("real", ColKind::Number),
        ColumnType::Float8 | ColumnType::Floatn => ("float", ColKind::Number),
        ColumnType::Money | ColumnType::Money4 => ("money", ColKind::Number),
        ColumnType::Decimaln => ("decimal", ColKind::Number),
        ColumnType::Numericn => ("numeric", ColKind::Number),
        ColumnType::Datetime | ColumnType::Datetimen => ("datetime", ColKind::Date),
        ColumnType::Datetime4 => ("smalldatetime", ColKind::Date),
        ColumnType::Daten => ("date", ColKind::Date),
        ColumnType::Timen => ("time", ColKind::Date),
        ColumnType::Datetime2 => ("datetime2", ColKind::Date),
        ColumnType::DatetimeOffsetn => ("datetimeoffset", ColKind::Date),
        ColumnType::Guid => ("uniqueidentifier", ColKind::Other),
        ColumnType::BigVarBin => ("varbinary", ColKind::Binary),
        ColumnType::BigBinary => ("binary", ColKind::Binary),
        ColumnType::Image => ("image", ColKind::Binary),
        ColumnType::BigVarChar => ("varchar", ColKind::Text),
        ColumnType::BigChar => ("char", ColKind::Text),
        ColumnType::NVarchar => ("nvarchar", ColKind::Text),
        ColumnType::NChar => ("nchar", ColKind::Text),
        ColumnType::Text => ("text", ColKind::Text),
        ColumnType::NText => ("ntext", ColKind::Text),
        ColumnType::Xml => ("xml", ColKind::Text),
        ColumnType::Udt => ("udt", ColKind::Other),
        ColumnType::SSVariant => ("sql_variant", ColKind::Other),
    };
    ColumnInfo { name: c.name().to_string(), type_name: t.to_string(), kind: k }
}

fn fmt_dt(v: Option<chrono::NaiveDateTime>) -> Cell {
    match v {
        Some(d) => Cell::Text(d.format("%Y-%m-%d %H:%M:%S%.f").to_string()),
        None => Cell::Null,
    }
}

fn convert(cd: ColumnData<'static>) -> Cell {
    match cd {
        ColumnData::U8(v) => v.map(|x| Cell::Int(x as i64)).unwrap_or(Cell::Null),
        ColumnData::I16(v) => v.map(|x| Cell::Int(x as i64)).unwrap_or(Cell::Null),
        ColumnData::I32(v) => v.map(|x| Cell::Int(x as i64)).unwrap_or(Cell::Null),
        ColumnData::I64(v) => v.map(Cell::int).unwrap_or(Cell::Null),
        ColumnData::F32(v) => v.map(|x| Cell::num(x as f64)).unwrap_or(Cell::Null),
        ColumnData::F64(v) => v.map(Cell::num).unwrap_or(Cell::Null),
        ColumnData::Bit(v) => v.map(Cell::Bool).unwrap_or(Cell::Null),
        ColumnData::String(v) => v.map(|s| Cell::Text(s.into_owned())).unwrap_or(Cell::Null),
        ColumnData::Guid(v) => v.map(|g| Cell::Text(g.to_string().to_uppercase())).unwrap_or(Cell::Null),
        ColumnData::Binary(v) => v.map(|b| Cell::hex(&b, BINARY_PREVIEW)).unwrap_or(Cell::Null),
        ColumnData::Numeric(v) => v.map(|n| Cell::Text(n.to_string())).unwrap_or(Cell::Null),
        ColumnData::Xml(v) => v.map(|x| Cell::Text(x.into_owned().into_string())).unwrap_or(Cell::Null),
        ColumnData::Date(_) => match chrono::NaiveDate::from_sql(&cd) {
            Ok(Some(d)) => Cell::Text(d.format("%Y-%m-%d").to_string()),
            _ => Cell::Null,
        },
        ColumnData::Time(_) => match chrono::NaiveTime::from_sql(&cd) {
            Ok(Some(t)) => Cell::Text(t.format("%H:%M:%S%.f").to_string()),
            _ => Cell::Null,
        },
        ColumnData::DateTimeOffset(_) => match chrono::DateTime::<chrono::FixedOffset>::from_sql(&cd) {
            Ok(Some(d)) => Cell::Text(d.format("%Y-%m-%d %H:%M:%S%.f %:z").to_string()),
            _ => Cell::Null,
        },
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            fmt_dt(chrono::NaiveDateTime::from_sql(&cd).ok().flatten())
        }
    }
}

fn row_to_cells(r: tiberius::Row) -> Vec<Cell> {
    r.into_iter().map(convert).collect()
}

pub fn cell_str(c: &Cell) -> String {
    match c {
        Cell::Null => String::new(),
        Cell::Bool(b) => (if *b { "1" } else { "0" }).into(),
        Cell::Int(i) => i.to_string(),
        Cell::Num(f) => f.to_string(),
        Cell::Text(s) => s.clone(),
    }
}

pub fn cell_i64(c: &Cell) -> i64 {
    match c {
        Cell::Int(i) => *i,
        Cell::Bool(b) => *b as i64,
        Cell::Num(f) => *f as i64,
        Cell::Text(s) => s.trim().parse().unwrap_or(0),
        Cell::Null => 0,
    }
}

/// Identificador entre corchetes.
pub fn qi(s: &str) -> String {
    format!("[{}]", s.replace(']', "]]"))
}

/// Literal de texto Unicode.
fn ql(s: &str) -> String {
    format!("N'{}'", s.replace('\'', "''"))
}

fn mssql_type(name: &str, max_len: i64, precision: i64, scale: i64) -> String {
    match name {
        "varchar" | "char" | "varbinary" | "binary" => {
            if max_len == -1 { format!("{name}(max)") } else { format!("{name}({max_len})") }
        }
        "nvarchar" | "nchar" => {
            if max_len == -1 { format!("{name}(max)") } else { format!("{name}({})", max_len / 2) }
        }
        "decimal" | "numeric" => format!("{name}({precision},{scale})"),
        "datetime2" | "time" | "datetimeoffset" => format!("{name}({scale})"),
        _ => name.to_string(),
    }
}

pub fn kind_from_type(t: &str) -> ColKind {
    let t = t.to_ascii_lowercase();
    let base = t.split('(').next().unwrap_or("").trim();
    match base {
        "bit" | "boolean" => ColKind::Bool,
        "tinyint" | "smallint" | "int" | "integer" | "bigint" | "int8" | "serial" | "serial8" | "bigserial" | "decimal"
        | "numeric" | "money" | "smallmoney" | "float" | "real" | "smallfloat" | "double" | "double precision" => {
            ColKind::Number
        }
        "date" | "datetime" | "datetime2" | "smalldatetime" | "time" | "datetimeoffset" | "timestamp" | "interval" => {
            ColKind::Date
        }
        "binary" | "varbinary" | "image" | "byte" | "blob" | "rowversion" | "timestamp_" => ColKind::Binary,
        "char" | "varchar" | "nchar" | "nvarchar" | "text" | "ntext" | "xml" | "lvarchar" | "clob" | "sysname" => {
            ColKind::Text
        }
        _ if base.starts_with("datetime") || base.starts_with("interval") => ColKind::Date,
        _ => ColKind::Other,
    }
}

fn fmt_count(n: i64) -> String {
    let s = n.abs().to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push('.');
        }
        out.push(ch);
    }
    if n < 0 {
        out.insert(0, '-');
    }
    out
}

pub fn fmt_rows(n: i64) -> String {
    format!("{} {}", fmt_count(n), if n == 1 { "fila" } else { "filas" })
}

impl Driver for MssqlDriver {
    fn execute(&mut self, sql: &str, fetch: usize) -> Result<ExecOutput> {
        let t0 = Instant::now();
        let kw = first_keyword(sql);
        let upper = sql.trim_end().trim_end_matches(';').to_ascii_uppercase();
        let dml = matches!(kw.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE")
            && !upper.contains("OUTPUT")
            && !upper.contains(';')
            && !upper.contains("\nGO");
        self.start(sql.to_string(), dml)?;
        let mut out = ExecOutput::default();
        out.results = self.pump(fetch.max(1), &mut out.messages);
        if out.results.is_empty() && !out.messages.is_empty() && self.cursor.is_none() {
            let msg = out.messages.join("\n");
            self.refresh_tx_state();
            bail!(msg);
        }
        if kw == "USE" && self.cursor.is_none() {
            if let Ok(db) = self.current_database() {
                self.database = db;
            }
        }
        self.refresh_tx_state();
        out.in_transaction = self.in_tx;
        out.elapsed_ms = t0.elapsed().as_millis() as u64;
        Ok(out)
    }

    fn fetch(&mut self, n: usize) -> Result<FetchOutput> {
        let mut out = FetchOutput::default();
        if self.cursor.is_none() {
            return Ok(out);
        }
        let n = n.max(1);
        loop {
            match self.next_item() {
                Some(Item::Row(r)) => {
                    if out.rows.len() >= n {
                        self.peek_back(Item::Row(r));
                        out.has_more = true;
                        return Ok(out);
                    }
                    out.rows.push(r);
                }
                Some(Item::Error(m)) => {
                    self.close_cursor()?;
                    bail!(m);
                }
                Some(other) => {
                    // Empieza otro resultado del mismo lote.
                    self.peek_back(other);
                    let mut msgs = Vec::new();
                    out.extra = self.pump(n, &mut msgs);
                    return Ok(out);
                }
                None => {
                    self.finish();
                    return Ok(out);
                }
            }
        }
    }

    fn close_cursor(&mut self) -> Result<()> {
        if let Some(cur) = self.cursor.take() {
            drop(cur.rx);
            // El hilo de lectura vacía el resto del flujo. Si tarda, se corta la conexión.
            let token = self.cancel.lock().clone();
            match self.rt.block_on(tokio::time::timeout(Duration::from_secs(3), cur.done)) {
                Ok(Ok(c)) => self.client = c,
                _ => {
                    if let Some(t) = token {
                        t.cancel();
                    }
                    self.client = None;
                }
            }
            *self.cancel.lock() = None;
        }
        Ok(())
    }

    fn set_autocommit(&mut self, on: bool) -> Result<bool> {
        if on == self.autocommit {
            return Ok(self.in_tx);
        }
        if on {
            self.query_rows("IF @@TRANCOUNT > 0 COMMIT; SET IMPLICIT_TRANSACTIONS OFF")?;
        } else {
            self.query_rows("SET IMPLICIT_TRANSACTIONS ON")?;
        }
        self.autocommit = on;
        self.refresh_tx_state();
        Ok(self.in_tx)
    }

    fn commit(&mut self) -> Result<bool> {
        self.query_rows("IF @@TRANCOUNT > 0 COMMIT")?;
        self.refresh_tx_state();
        Ok(self.in_tx)
    }

    fn rollback(&mut self) -> Result<bool> {
        self.query_rows("IF @@TRANCOUNT > 0 ROLLBACK")?;
        self.refresh_tx_state();
        Ok(self.in_tx)
    }

    fn children(&mut self, path: &[String]) -> Result<Vec<MetaNode>> {
        let p: Vec<&str> = path.iter().map(|s| s.as_str()).collect();
        match p.as_slice() {
            [] => {
                let rows = self.query_rows(
                    "SELECT name, CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, state_desc FROM sys.databases \
                     WHERE HAS_DBACCESS(name) = 1 ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name",
                )?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        let n = cell_str(&r[0]);
                        let detail = if cell_i64(&r[1]) == 1 { Some("sistema".to_string()) } else { None };
                        MetaNode::branch(n.clone(), "database", vec![n]).with_detail(detail)
                    })
                    .collect())
            }
            [db] => {
                let d = qi(db);
                let rows = self.query_rows(&format!(
                    "SELECT s.name, COUNT(o.object_id) FROM {d}.sys.schemas s \
                     LEFT JOIN {d}.sys.objects o ON o.schema_id = s.schema_id AND o.is_ms_shipped = 0 \
                       AND o.type IN ('U','V','P','FN','IF','TF','SN','SO','FS','FT','PC') \
                     GROUP BY s.name HAVING COUNT(o.object_id) > 0 OR s.name = 'dbo' \
                     ORDER BY CASE WHEN s.name = 'dbo' THEN 0 ELSE 1 END, s.name"
                ))?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        let n = cell_str(&r[0]);
                        MetaNode::branch(n.clone(), "schema", vec![db.to_string(), n])
                    })
                    .collect())
            }
            [db, schema] => Ok([
                ("Tablas", "tables"),
                ("Vistas", "views"),
                ("Procedimientos", "procedures"),
                ("Funciones", "functions"),
                ("Sinónimos", "synonyms"),
                ("Secuencias", "sequences"),
            ]
            .iter()
            .map(|(label, key)| MetaNode::branch(*label, "folder", vec![db.to_string(), schema.to_string(), key.to_string()]))
            .collect()),
            [db, schema, folder] => {
                let d = qi(db);
                let s = ql(schema);
                let (sql, kind, branch) = match *folder {
                    "tables" => (
                        format!(
                            "SELECT t.name, SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END) FROM {d}.sys.tables t \
                             JOIN {d}.sys.schemas s ON s.schema_id = t.schema_id LEFT JOIN {d}.sys.partitions p ON p.object_id = t.object_id \
                             WHERE s.name = {s} GROUP BY t.name ORDER BY t.name"
                        ),
                        "table",
                        true,
                    ),
                    "views" => (
                        format!("SELECT v.name, NULL FROM {d}.sys.views v JOIN {d}.sys.schemas s ON s.schema_id = v.schema_id WHERE s.name = {s} ORDER BY v.name"),
                        "view",
                        true,
                    ),
                    "procedures" => (
                        format!("SELECT o.name, NULL FROM {d}.sys.procedures o JOIN {d}.sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = {s} ORDER BY o.name"),
                        "procedure",
                        false,
                    ),
                    "functions" => (
                        format!(
                            "SELECT o.name, CASE WHEN o.type IN ('FN','FS') THEN 'escalar' ELSE 'tabla' END FROM {d}.sys.objects o \
                             JOIN {d}.sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = {s} AND o.type IN ('FN','IF','TF','FS','FT') ORDER BY o.name"
                        ),
                        "function",
                        false,
                    ),
                    "synonyms" => (
                        format!("SELECT o.name, o.base_object_name FROM {d}.sys.synonyms o JOIN {d}.sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = {s} ORDER BY o.name"),
                        "synonym",
                        false,
                    ),
                    "sequences" => (
                        format!("SELECT o.name, NULL FROM {d}.sys.sequences o JOIN {d}.sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = {s} ORDER BY o.name"),
                        "sequence",
                        false,
                    ),
                    _ => return Ok(vec![]),
                };
                let rows = self.query_rows(&sql)?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        let n = cell_str(&r[0]);
                        let detail = match (&r[1], kind) {
                            (Cell::Null, _) => None,
                            (c, "table") => Some(fmt_rows(cell_i64(c))),
                            (c, _) => Some(cell_str(c)),
                        };
                        let obj = ObjectRef::new(db, schema, &n, kind);
                        let node = if branch {
                            MetaNode::branch(n.clone(), kind, vec![db.to_string(), schema.to_string(), folder.to_string(), n])
                        } else {
                            MetaNode::leaf(n, kind, None)
                        };
                        node.with_obj(obj).with_detail(detail)
                    })
                    .collect())
            }
            [db, schema, folder, name] => {
                let kind = if *folder == "views" { "view" } else { "table" };
                let o = ObjectRef::new(db, schema, name, kind);
                let cols = self.query_rows(&self.columns_query(&o))?;
                let mut nodes: Vec<MetaNode> = cols
                    .iter()
                    .map(|r| {
                        let ty = mssql_type(&cell_str(&r[1]), cell_i64(&r[2]), cell_i64(&r[3]), cell_i64(&r[4]));
                        let mut detail = ty;
                        if cell_i64(&r[7]) == 1 {
                            detail.push_str(" · PK");
                        }
                        if cell_i64(&r[6]) == 1 {
                            detail.push_str(" · identity");
                        }
                        if cell_i64(&r[5]) == 0 {
                            detail.push_str(" · not null");
                        }
                        let k = if cell_i64(&r[7]) == 1 { "pkcolumn" } else { "column" };
                        MetaNode::leaf(cell_str(&r[0]), k, Some(detail))
                    })
                    .collect();
                if kind == "table" {
                    let base = vec![db.to_string(), schema.to_string(), folder.to_string(), name.to_string()];
                    for (label, key) in [("Índices", "indexes"), ("Claves foráneas", "fks"), ("Triggers", "triggers")] {
                        let mut p = base.clone();
                        p.push(key.to_string());
                        nodes.push(MetaNode::branch(label, "folder", p));
                    }
                }
                Ok(nodes)
            }
            [db, schema, _folder, name, sub] => {
                let o = ObjectRef::new(db, schema, name, "table");
                let d = qi(db);
                let oid = self.obj_id(&o);
                match *sub {
                    "indexes" => {
                        let rows = self.query_rows(&format!(
                            "SELECT i.name, i.type_desc, i.is_unique, i.is_primary_key, \
                               STUFF((SELECT ', ' + c.name FROM {d}.sys.index_columns ic JOIN {d}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                                      WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0 ORDER BY ic.key_ordinal \
                                      FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '') \
                             FROM {d}.sys.indexes i WHERE i.object_id = {oid} AND i.type > 0 ORDER BY i.is_primary_key DESC, i.name"
                        ))?;
                        Ok(rows
                            .iter()
                            .map(|r| {
                                let mut det = format!("({})", cell_str(&r[4]));
                                if cell_i64(&r[3]) == 1 {
                                    det.push_str(" · PK");
                                } else if cell_i64(&r[2]) == 1 {
                                    det.push_str(" · único");
                                }
                                det.push_str(&format!(" · {}", cell_str(&r[1]).to_lowercase()));
                                MetaNode::leaf(cell_str(&r[0]), "index", Some(det))
                            })
                            .collect())
                    }
                    "fks" => {
                        let rows = self.query_rows(&format!(
                            "SELECT fk.name, OBJECT_SCHEMA_NAME(fk.referenced_object_id, DB_ID({})) + '.' + OBJECT_NAME(fk.referenced_object_id, DB_ID({})) \
                             FROM {d}.sys.foreign_keys fk WHERE fk.parent_object_id = {oid} ORDER BY fk.name",
                            ql(db),
                            ql(db)
                        ))?;
                        Ok(rows
                            .iter()
                            .map(|r| MetaNode::leaf(cell_str(&r[0]), "key", Some(format!("→ {}", cell_str(&r[1])))))
                            .collect())
                    }
                    "triggers" => {
                        let rows = self.query_rows(&format!("SELECT name FROM {d}.sys.triggers WHERE parent_id = {oid} ORDER BY name"))?;
                        Ok(rows
                            .iter()
                            .map(|r| {
                                let n = cell_str(&r[0]);
                                MetaNode::leaf(n.clone(), "trigger", None).with_obj(ObjectRef::new(db, schema, &n, "trigger"))
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
        let rows = self.query_rows(&self.columns_query(obj))?;
        Ok(rows
            .iter()
            .map(|r| {
                let base = cell_str(&r[1]);
                TableColumn {
                    name: cell_str(&r[0]),
                    type_name: mssql_type(&base, cell_i64(&r[2]), cell_i64(&r[3]), cell_i64(&r[4])),
                    nullable: cell_i64(&r[5]) == 1,
                    primary_key: cell_i64(&r[7]) == 1,
                    identity: cell_i64(&r[6]) == 1 || cell_i64(&r[9]) == 1 || base == "timestamp",
                    default: match &r[8] {
                        Cell::Text(s) => Some(s.clone()),
                        _ => None,
                    },
                    kind: kind_from_type(&base),
                }
            })
            .collect())
    }

    fn ddl(&mut self, obj: &ObjectRef) -> Result<String> {
        match obj.kind.as_str() {
            "table" => self.table_ddl(obj),
            "synonym" => {
                let rows = self.query_rows(&format!(
                    "SELECT base_object_name FROM {}.sys.synonyms WHERE object_id = {}",
                    qi(&obj.database),
                    self.obj_id(obj)
                ))?;
                let base = rows.first().map(|r| cell_str(&r[0])).unwrap_or_default();
                Ok(format!("CREATE SYNONYM {} FOR {};", self.qualified_name(obj), base))
            }
            "sequence" => {
                let rows = self.query_rows(&format!(
                    "SELECT TYPE_NAME(system_type_id), CAST(start_value AS nvarchar(50)), CAST(increment AS nvarchar(50)), \
                     CAST(minimum_value AS nvarchar(50)), CAST(maximum_value AS nvarchar(50)), is_cycling, CAST(current_value AS nvarchar(50)) \
                     FROM {}.sys.sequences WHERE object_id = {}",
                    qi(&obj.database),
                    self.obj_id(obj)
                ))?;
                let r = rows.first().ok_or_else(|| anyhow!("Secuencia no encontrada"))?;
                Ok(format!(
                    "CREATE SEQUENCE {} AS {}\n    START WITH {}\n    INCREMENT BY {}\n    MINVALUE {}\n    MAXVALUE {}\n    {};\n-- valor actual: {}",
                    self.qualified_name(obj),
                    cell_str(&r[0]),
                    cell_str(&r[1]),
                    cell_str(&r[2]),
                    cell_str(&r[3]),
                    cell_str(&r[4]),
                    if cell_i64(&r[5]) == 1 { "CYCLE" } else { "NO CYCLE" },
                    cell_str(&r[6])
                ))
            }
            _ => {
                let rows = self.query_rows(&format!(
                    "SELECT m.definition FROM {}.sys.sql_modules m WHERE m.object_id = {}",
                    qi(&obj.database),
                    self.obj_id(obj)
                ))?;
                match rows.first().map(|r| &r[0]) {
                    Some(Cell::Text(s)) => Ok(s.trim().to_string()),
                    _ => bail!("No hay definición disponible (objeto cifrado o sin permisos)"),
                }
            }
        }
    }

    fn completion(&mut self, database: &str) -> Result<CompletionSchema> {
        let d = qi(database);
        let rows = self.query_rows(&format!(
            "SELECT TOP 200000 s.name, o.name, c.name FROM {d}.sys.objects o JOIN {d}.sys.schemas s ON s.schema_id = o.schema_id \
             JOIN {d}.sys.columns c ON c.object_id = o.object_id WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0 \
             ORDER BY s.name, o.name, c.column_id"
        ))?;
        let mut out = CompletionSchema::default();
        for r in rows {
            let (s, t, c) = (cell_str(&r[0]), cell_str(&r[1]), cell_str(&r[2]));
            match out.tables.last_mut() {
                Some(last) if last.schema == s && last.name == t => last.columns.push(c),
                _ => out.tables.push(CompletionTable { schema: s, name: t, columns: vec![c] }),
            }
        }
        Ok(out)
    }

    fn databases(&mut self) -> Result<Vec<String>> {
        let rows = self.query_rows("SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name")?;
        Ok(rows.iter().map(|r| cell_str(&r[0])).collect())
    }

    fn current_database(&mut self) -> Result<String> {
        let rows = self.query_rows("SELECT DB_NAME()")?;
        Ok(rows.first().map(|r| cell_str(&r[0])).unwrap_or_default())
    }

    fn use_database(&mut self, db: &str) -> Result<()> {
        self.query_rows(&format!("USE {}", qi(db)))?;
        self.database = db.to_string();
        Ok(())
    }

    fn qualified_name(&self, o: &ObjectRef) -> String {
        let mut parts = Vec::new();
        if !o.database.is_empty() {
            parts.push(qi(&o.database));
        }
        if !o.schema.is_empty() {
            parts.push(qi(&o.schema));
        } else if !o.database.is_empty() {
            parts.push(String::new());
        }
        parts.push(qi(&o.name));
        parts.join(".")
    }

    fn quote_ident(&self, s: &str) -> String {
        qi(s)
    }

    fn server_info(&mut self) -> Result<String> {
        let rows = self.query_rows(
            "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(50)), CAST(SERVERPROPERTY('Edition') AS nvarchar(100)), @@VERSION",
        )?;
        let r = rows.first().ok_or_else(|| anyhow!("sin datos"))?;
        let first = cell_str(&r[2]).lines().next().unwrap_or("").trim().to_string();
        Ok(format!("{} — {} ({})", first, cell_str(&r[1]), cell_str(&r[0])))
    }

    fn canceller(&self) -> Canceller {
        let slot = self.cancel.clone();
        Arc::new(move || {
            if let Some(t) = slot.lock().as_ref() {
                t.cancel();
            }
        })
    }
}
