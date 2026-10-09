//! Driver nativo de MySQL / MariaDB (crate `mysql`, protocolo de texto, TLS por SChannel).
//!
//! ## Paginación
//! `mysql::QueryResult` toma prestada la conexión (`&mut Conn`), así que no puede guardarse en el
//! driver entre llamadas sin trucos autorreferenciales. En su lugar, cada `execute` lanza un hilo
//! lector que se queda con la conexión mientras dura el lote: ejecuta las sentencias en orden y
//! envía columnas/filas/recuentos por un canal *acotado* (`sync_channel`). El hilo de la sesión
//! recoge `fetch` filas y deja de leer; el lector se bloquea en cuanto el canal se llena, con lo
//! que el servidor deja de enviar (control de flujo de TCP). La memoria queda acotada a
//! `CHANNEL_ROWS` filas más los búferes del socket, sin cargar el resultado entero.
//! Al terminar el lote, el lector devuelve la conexión por otro canal. Si se cierra el cursor a
//! mitad, se suelta el receptor: el lector aborta, el crate drena el resto del resultado y, si eso
//! tarda, se lanza `KILL QUERY` desde una conexión auxiliar. Si aun así no vuelve, la conexión se
//! abandona y se abre otra al usarla (se restauran base de datos y modo autocommit; una
//! transacción abierta en ese caso se pierde).
//!
//! ## Árbol de objetos
//! MySQL no tiene nivel de esquema: se muestra un único nodo `schema` con el mismo nombre que la
//! base de datos, de modo que las rutas son `[db, db, carpeta, objeto, ...]` y
//! `ObjectRef { database: db, schema: db }`, coherente con `reloadTable` (`state.ts`), que construye
//! `[database, schema, "tables"|"views", nombre]`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ::mysql::consts::{ColumnFlags, ColumnType};
use ::mysql::prelude::Queryable;
use ::mysql::{Conn, Opts, OptsBuilder, SslOpts, Value};
use anyhow::{anyhow, bail, Result};

use crate::model::*;
use crate::session::{first_keyword, Canceller, Driver};

const BINARY_PREVIEW: usize = 4096;
/// Filas leídas por adelantado como máximo (además de los búferes del socket).
const CHANNEL_ROWS: usize = 1024;
const SYSTEM_DBS: [&str; 4] = ["information_schema", "mysql", "performance_schema", "sys"];

// ------------------------------------------------------------------------------------------------
// Conversión de tipos
// ------------------------------------------------------------------------------------------------

/// Lo necesario de una columna para convertir sus valores.
#[derive(Debug, Clone, Copy)]
struct ColMeta {
    ty: ColumnType,
    unsigned: bool,
    /// Juego de caracteres `binary` (63): BLOB/BINARY/VARBINARY frente a TEXT/CHAR.
    binary: bool,
    is_enum: bool,
    is_set: bool,
    len: u32,
}

impl ColMeta {
    fn of(c: &::mysql::Column) -> ColMeta {
        let f = c.flags();
        ColMeta {
            ty: c.column_type(),
            unsigned: f.contains(ColumnFlags::UNSIGNED_FLAG),
            binary: c.character_set() == 63,
            is_enum: f.contains(ColumnFlags::ENUM_FLAG),
            is_set: f.contains(ColumnFlags::SET_FLAG),
            len: c.column_length(),
        }
    }

    fn text() -> ColMeta {
        ColMeta {
            ty: ColumnType::MYSQL_TYPE_VAR_STRING,
            unsigned: false,
            binary: false,
            is_enum: false,
            is_set: false,
            len: 0,
        }
    }

    fn is_int(&self) -> bool {
        use ColumnType::*;
        matches!(
            self.ty,
            MYSQL_TYPE_TINY
                | MYSQL_TYPE_SHORT
                | MYSQL_TYPE_INT24
                | MYSQL_TYPE_LONG
                | MYSQL_TYPE_LONGLONG
                | MYSQL_TYPE_YEAR
        )
    }

    fn is_stringish(&self) -> bool {
        use ColumnType::*;
        matches!(
            self.ty,
            MYSQL_TYPE_STRING
                | MYSQL_TYPE_VAR_STRING
                | MYSQL_TYPE_VARCHAR
                | MYSQL_TYPE_TINY_BLOB
                | MYSQL_TYPE_MEDIUM_BLOB
                | MYSQL_TYPE_LONG_BLOB
                | MYSQL_TYPE_BLOB
        )
    }

    fn is_bytes(&self) -> bool {
        (self.is_stringish() && self.binary && !self.is_enum && !self.is_set)
            || self.ty == ColumnType::MYSQL_TYPE_GEOMETRY
    }

    fn is_flag(&self) -> bool {
        self.len == 1
            && matches!(
                self.ty,
                ColumnType::MYSQL_TYPE_TINY | ColumnType::MYSQL_TYPE_BIT
            )
    }

    fn type_name(&self) -> String {
        use ColumnType::*;
        let base = match self.ty {
            MYSQL_TYPE_TINY if self.len == 1 => "tinyint(1)",
            MYSQL_TYPE_TINY => "tinyint",
            MYSQL_TYPE_SHORT => "smallint",
            MYSQL_TYPE_INT24 => "mediumint",
            MYSQL_TYPE_LONG => "int",
            MYSQL_TYPE_LONGLONG => "bigint",
            MYSQL_TYPE_FLOAT => "float",
            MYSQL_TYPE_DOUBLE => "double",
            MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "decimal",
            MYSQL_TYPE_BIT => "bit",
            MYSQL_TYPE_YEAR => "year",
            MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "date",
            MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "time",
            MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "datetime",
            MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "timestamp",
            MYSQL_TYPE_JSON => "json",
            MYSQL_TYPE_ENUM => "enum",
            MYSQL_TYPE_SET => "set",
            MYSQL_TYPE_GEOMETRY => "geometry",
            MYSQL_TYPE_NULL => "null",
            MYSQL_TYPE_STRING if self.is_enum => "enum",
            MYSQL_TYPE_STRING if self.is_set => "set",
            MYSQL_TYPE_STRING if self.binary => "binary",
            MYSQL_TYPE_STRING => "char",
            MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR if self.binary => "varbinary",
            MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR => "varchar",
            MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB
            | MYSQL_TYPE_BLOB
                if self.binary =>
            {
                "blob"
            }
            MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB
            | MYSQL_TYPE_BLOB => "text",
            _ => "unknown",
        };
        let numeric = self.is_int()
            || matches!(
                self.ty,
                MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE | MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL
            );
        if self.unsigned && numeric && self.ty != MYSQL_TYPE_YEAR {
            format!("{base} unsigned")
        } else {
            base.to_string()
        }
    }

    fn kind(&self) -> ColKind {
        use ColumnType::*;
        if self.is_flag() {
            return ColKind::Bool;
        }
        if self.is_bytes() {
            return ColKind::Binary;
        }
        match self.ty {
            MYSQL_TYPE_TINY | MYSQL_TYPE_SHORT | MYSQL_TYPE_INT24 | MYSQL_TYPE_LONG
            | MYSQL_TYPE_LONGLONG | MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE | MYSQL_TYPE_DECIMAL
            | MYSQL_TYPE_NEWDECIMAL | MYSQL_TYPE_BIT | MYSQL_TYPE_YEAR => ColKind::Number,
            MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE | MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2
            | MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 | MYSQL_TYPE_TIMESTAMP
            | MYSQL_TYPE_TIMESTAMP2 => ColKind::Date,
            MYSQL_TYPE_JSON | MYSQL_TYPE_ENUM | MYSQL_TYPE_SET => ColKind::Text,
            _ if self.is_stringish() => ColKind::Text,
            _ => ColKind::Other,
        }
    }
}

fn column_info(c: &::mysql::Column, m: &ColMeta) -> ColumnInfo {
    let name = c.name_str();
    ColumnInfo {
        name: if name.is_empty() {
            "?column?".into()
        } else {
            name.into_owned()
        },
        type_name: m.type_name(),
        kind: m.kind(),
    }
}

fn uint_cell(v: u64) -> Cell {
    if v <= JS_SAFE_INT as u64 {
        Cell::Int(v as i64)
    } else {
        Cell::Text(v.to_string())
    }
}

fn text_cell(b: &[u8]) -> Cell {
    Cell::Text(String::from_utf8_lossy(b).into_owned())
}

/// Convierte el texto que envía el servidor (protocolo de texto) según el tipo de la columna.
fn bytes_to_cell(b: &[u8], m: &ColMeta) -> Cell {
    use ColumnType::*;
    if m.is_bytes() {
        return Cell::hex(b, BINARY_PREVIEW);
    }
    let s = || std::str::from_utf8(b).ok().map(str::trim);
    match m.ty {
        _ if m.is_int() => match s() {
            Some(t) => match t.parse::<i64>() {
                Ok(v) => Cell::int(v),
                Err(_) => Cell::Text(t.to_string()),
            },
            None => text_cell(b),
        },
        MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE => match s().and_then(|t| t.parse::<f64>().ok()) {
            Some(v) => Cell::num(v),
            None => text_cell(b),
        },
        MYSQL_TYPE_BIT => {
            if b.len() <= 8 {
                uint_cell(b.iter().fold(0u64, |acc, x| (acc << 8) | u64::from(*x)))
            } else {
                Cell::hex(b, BINARY_PREVIEW)
            }
        }
        MYSQL_TYPE_NULL => Cell::Null,
        _ => text_cell(b),
    }
}

fn fmt_frac(us: u32) -> String {
    if us == 0 {
        String::new()
    } else {
        format!(".{us:06}")
    }
}

fn value_to_cell(v: Value, m: &ColMeta) -> Cell {
    match v {
        Value::NULL => Cell::Null,
        Value::Bytes(b) => bytes_to_cell(&b, m),
        Value::Int(i) => Cell::int(i),
        Value::UInt(u) => uint_cell(u),
        // f32 -> texto -> f64 conserva la representación corta (1.1 y no 1.100000023841858).
        Value::Float(f) => Cell::num(f.to_string().parse::<f64>().unwrap_or(f64::from(f))),
        Value::Double(d) => Cell::num(d),
        Value::Date(y, mo, d, h, mi, s, us) => {
            if matches!(
                m.ty,
                ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE
            ) {
                Cell::Text(format!("{y:04}-{mo:02}-{d:02}"))
            } else {
                Cell::Text(format!(
                    "{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}{}",
                    fmt_frac(us)
                ))
            }
        }
        Value::Time(neg, days, h, mi, s, us) => {
            let hours = u64::from(days) * 24 + u64::from(h);
            Cell::Text(format!(
                "{}{hours:02}:{mi:02}:{s:02}{}",
                if neg { "-" } else { "" },
                fmt_frac(us)
            ))
        }
    }
}

fn row_cells(row: ::mysql::Row, metas: &[ColMeta]) -> Vec<Cell> {
    row.unwrap_raw()
        .into_iter()
        .enumerate()
        .map(|(i, v)| {
            let m = metas.get(i).copied().unwrap_or_else(ColMeta::text);
            v.map(|v| value_to_cell(v, &m)).unwrap_or(Cell::Null)
        })
        .collect()
}

/// Tipo declarado en `information_schema.COLUMNS` -> familia para la interfaz.
fn kind_from_decl(data_type: &str, column_type: &str) -> ColKind {
    let t = data_type.to_ascii_lowercase();
    let full = column_type.to_ascii_lowercase();
    if (t == "tinyint" && full.starts_with("tinyint(1)"))
        || (t == "bit" && full.starts_with("bit(1)"))
        || t == "bool"
        || t == "boolean"
    {
        return ColKind::Bool;
    }
    match t.as_str() {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "decimal"
        | "numeric" | "float" | "double" | "real" | "bit" | "year" => ColKind::Number,
        "date" | "time" | "datetime" | "timestamp" => ColKind::Date,
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" | "geometry"
        | "point" | "linestring" | "polygon" | "multipoint" | "multilinestring"
        | "multipolygon" | "geometrycollection" => ColKind::Binary,
        "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext" | "enum" | "set"
        | "json" | "uuid" | "inet4" | "inet6" => ColKind::Text,
        _ => ColKind::Other,
    }
}

// ------------------------------------------------------------------------------------------------
// División de scripts
// ------------------------------------------------------------------------------------------------

fn starts_with_ci(hay: &[u8], needle: &[u8]) -> bool {
    hay.len() >= needle.len() && hay[..needle.len()].eq_ignore_ascii_case(needle)
}

/// Índice tras la comilla de cierre (o el final si no se cierra).
fn skip_quoted(b: &[u8], start: usize, q: u8) -> usize {
    let mut j = start + 1;
    while j < b.len() {
        let c = b[j];
        if c == b'\\' && q != b'`' {
            j += 2;
        } else if c == q {
            if b.get(j + 1) == Some(&q) {
                j += 2;
            } else {
                return j + 1;
            }
        } else {
            j += 1;
        }
    }
    b.len()
}

fn line_end(b: &[u8], from: usize) -> usize {
    b[from..]
        .iter()
        .position(|&c| c == b'\n')
        .map_or(b.len(), |p| from + p)
}

/// Divide un script en sentencias, como el cliente `mysql`: respeta comillas (`'`, `"`, `` ` ``),
/// comentarios (`-- `, `#`, `/* */`) y líneas `DELIMITER xx`. Omite sentencias vacías o que solo
/// contienen comentarios (el servidor las rechazaría con "Query was empty").
pub(crate) fn split_statements(sql: &str) -> Vec<String> {
    let b = sql.as_bytes();
    let mut out = Vec::new();
    let mut delim: Vec<u8> = b";".to_vec();
    let mut start = 0;
    let mut significant = false;
    let mut line_start = true;
    let mut i = 0;
    let push = |from: usize, to: usize, significant: bool, out: &mut Vec<String>| {
        if significant {
            let s = sql[from..to].trim();
            if !s.is_empty() {
                out.push(s.to_string());
            }
        }
    };
    while i < b.len() {
        if line_start && !significant {
            let mut j = i;
            while j < b.len() && (b[j] == b' ' || b[j] == b'\t') {
                j += 1;
            }
            if starts_with_ci(&b[j..], b"delimiter")
                && b.get(j + 9).is_some_and(|c| *c == b' ' || *c == b'\t')
            {
                let eol = line_end(b, j);
                if let Some(d) = sql[j + 9..eol].split_whitespace().next() {
                    delim = d.as_bytes().to_vec();
                }
                i = eol;
                start = eol;
                continue;
            }
        }
        let c = b[i];
        line_start = false;
        if b[i..].starts_with(&delim) {
            push(start, i, significant, &mut out);
            i += delim.len();
            start = i;
            significant = false;
            continue;
        }
        match c {
            b'\n' => {
                line_start = true;
                i += 1;
            }
            b'\'' | b'"' | b'`' => {
                significant = true;
                i = skip_quoted(b, i, c);
            }
            b'#' => i = line_end(b, i),
            b'-' if b.get(i + 1) == Some(&b'-')
                && b.get(i + 2).is_none_or(|c| c.is_ascii_whitespace()) =>
            {
                i = line_end(b, i)
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                // /*! ... */ y /*M! ... */ son comentarios ejecutables: cuentan como contenido.
                if b.get(i + 2) == Some(&b'!') || b[i + 2..].starts_with(b"M!") {
                    significant = true;
                }
                let mut j = i + 2;
                while j + 1 < b.len() && !(b[j] == b'*' && b[j + 1] == b'/') {
                    j += 1;
                }
                i = (j + 2).min(b.len());
            }
            _ => {
                if !c.is_ascii_whitespace() {
                    significant = true;
                }
                i += 1;
            }
        }
    }
    push(start, b.len(), significant, &mut out);
    out
}

// ------------------------------------------------------------------------------------------------
// Opciones de conexión
// ------------------------------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq)]
struct ExtraOpts {
    connect_timeout: Option<Duration>,
    read_timeout: Option<Duration>,
    write_timeout: Option<Duration>,
    compress: bool,
    socket: Option<String>,
    ssl_ca: Option<String>,
    max_allowed_packet: Option<usize>,
    cleartext: bool,
    /// Sentencias que se ejecutan al abrir cada conexión.
    init: Vec<String>,
}

fn parse_bool(k: &str, v: &str) -> Result<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "" | "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => bail!("Valor no válido para {k}: {v}"),
    }
}

fn parse_secs(k: &str, v: &str) -> Result<Duration> {
    v.trim()
        .parse::<f64>()
        .ok()
        .filter(|s| *s >= 0.0 && s.is_finite())
        .map(Duration::from_secs_f64)
        .ok_or_else(|| anyhow!("Valor no válido para {k}: {v} (segundos)"))
}

/// Parámetros extra `clave=valor;...`. Las claves conocidas son opciones del cliente; el resto se
/// aplican como variables de sesión (`SET SESSION clave = valor`), p. ej. `sql_mode=ANSI_QUOTES`.
fn parse_extra(extra: &str) -> Result<ExtraOpts> {
    let mut o = ExtraOpts::default();
    for part in extra.split([';', '\n']) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (k, v) = match part.split_once('=') {
            Some((k, v)) => (k.trim(), v.trim()),
            None => (part, ""),
        };
        let key = k.to_ascii_lowercase().replace('-', "_");
        match key.as_str() {
            "connect_timeout" | "tcp_connect_timeout" => o.connect_timeout = Some(parse_secs(k, v)?),
            "read_timeout" => o.read_timeout = Some(parse_secs(k, v)?),
            "write_timeout" => o.write_timeout = Some(parse_secs(k, v)?),
            "compress" | "compression" => o.compress = parse_bool(k, v)?,
            "socket" | "pipe" => o.socket = Some(v.to_string()),
            "ssl_ca" | "sslca" | "ssl_root_cert" => o.ssl_ca = Some(v.to_string()),
            "max_allowed_packet" => {
                o.max_allowed_packet = Some(
                    v.parse()
                        .map_err(|_| anyhow!("Valor no válido para {k}: {v}"))?,
                )
            }
            "enable_cleartext_plugin" => o.cleartext = parse_bool(k, v)?,
            "init" | "init_command" => o.init.push(v.to_string()),
            _ => {
                if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    bail!("Parámetro extra no válido: {part}");
                }
                let value = if v.parse::<f64>().is_ok() {
                    v.to_string()
                } else {
                    ql(v, false)
                };
                o.init.push(format!("SET SESSION {key} = {value}"));
            }
        }
    }
    Ok(o)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum TlsMode {
    Required,
    Preferred,
    Off,
}

fn tls_mode(encryption: &str) -> TlsMode {
    match encryption.trim().to_ascii_lowercase().as_str() {
        "off" | "disable" | "disabled" | "false" | "no" => TlsMode::Off,
        "login" | "preferred" | "prefer" => TlsMode::Preferred,
        _ => TlsMode::Required,
    }
}

fn mysql_err(e: ::mysql::Error) -> anyhow::Error {
    anyhow!(fmt_err(&e))
}

fn fmt_err(e: &::mysql::Error) -> String {
    match e {
        ::mysql::Error::MySqlError(me) if me.code == 1317 => "Consulta cancelada".into(),
        ::mysql::Error::MySqlError(me) => {
            format!("ERROR {} ({}): {}", me.code, me.state, me.message)
        }
        ::mysql::Error::DriverError(::mysql::DriverError::TlsNotSupported) => {
            "El servidor no admite conexiones cifradas (TLS). Cambia el cifrado a «login» u «off».".into()
        }
        other => other.to_string(),
    }
}

/// Un error del servidor deja la conexión utilizable; cualquier otro (E/S, TLS, protocolo) no.
fn is_server_error(e: &::mysql::Error) -> bool {
    matches!(e, ::mysql::Error::MySqlError(_))
}

/// Abre una conexión auxiliar y cancela la sentencia en curso de `id`.
fn kill_query(opts: &Opts, id: u32) -> Result<()> {
    let o = OptsBuilder::from_opts(opts.clone())
        .db_name(None::<String>)
        .init(Vec::<String>::new())
        .tcp_connect_timeout(Some(Duration::from_secs(5)))
        .read_timeout(Some(Duration::from_secs(5)))
        .write_timeout(Some(Duration::from_secs(5)));
    let mut c = Conn::new(o).map_err(mysql_err)?;
    c.query_drop(format!("KILL QUERY {id}")).map_err(mysql_err)?;
    Ok(())
}

// ------------------------------------------------------------------------------------------------
// Hilo lector
// ------------------------------------------------------------------------------------------------

enum Item {
    Columns(Vec<ColumnInfo>),
    Row(Vec<Cell>),
    /// Fin de un conjunto de filas.
    EndSet,
    /// Sentencia sin filas: filas afectadas.
    Count(i64),
    Message(String),
    /// La base de datos actual cambió (sentencia `USE`).
    Database(String),
    Error(String),
}

enum Outcome {
    Done,
    /// El receptor se cerró (cursor cerrado): no seguir.
    Aborted,
    /// Error del servidor: la conexión sigue sirviendo.
    Failed(String),
    /// Error de E/S o protocolo: la conexión ya no sirve.
    Broken(String),
}

fn classify(e: ::mysql::Error) -> Outcome {
    if is_server_error(&e) {
        Outcome::Failed(fmt_err(&e))
    } else {
        Outcome::Broken(fmt_err(&e))
    }
}

fn collect_rows(
    conn: &mut Conn,
    sql: &str,
) -> std::result::Result<Vec<Vec<Cell>>, ::mysql::Error> {
    let mut qr = conn.query_iter(sql)?;
    let mut out = Vec::new();
    if let Some(mut set) = qr.iter() {
        let metas: Vec<ColMeta> = set.columns().as_ref().iter().map(ColMeta::of).collect();
        for row in set.by_ref() {
            out.push(row_cells(row?, &metas));
        }
    }
    Ok(out)
}

fn run_statement(conn: &mut Conn, sql: &str, tx: &SyncSender<Item>) -> Outcome {
    let mut qr = match conn.query_iter(sql) {
        Ok(q) => q,
        Err(e) => return classify(e),
    };
    let mut had_rows = false;
    while let Some(mut set) = qr.iter() {
        let (metas, infos) = {
            let cols = set.columns();
            let cols = cols.as_ref();
            let metas: Vec<ColMeta> = cols.iter().map(ColMeta::of).collect();
            let infos: Vec<ColumnInfo> = cols
                .iter()
                .zip(&metas)
                .map(|(c, m)| column_info(c, m))
                .collect();
            (metas, infos)
        };
        if infos.is_empty() {
            let n = set.affected_rows();
            // CALL termina con un OK vacío tras sus resultados: no aporta nada.
            if !(had_rows && n == 0)
                && tx
                    .send(Item::Count(i64::try_from(n).unwrap_or(i64::MAX)))
                    .is_err()
            {
                return Outcome::Aborted;
            }
            continue;
        }
        had_rows = true;
        if tx.send(Item::Columns(infos)).is_err() {
            return Outcome::Aborted;
        }
        for row in set.by_ref() {
            match row {
                Ok(r) => {
                    if tx.send(Item::Row(row_cells(r, &metas))).is_err() {
                        return Outcome::Aborted;
                    }
                }
                Err(e) => return classify(e),
            }
        }
        if tx.send(Item::EndSet).is_err() {
            return Outcome::Aborted;
        }
    }
    Outcome::Done
}

/// Ejecuta las sentencias en orden. Devuelve la conexión si sigue siendo utilizable.
fn worker(mut conn: Conn, stmts: Vec<String>, tx: &SyncSender<Item>, left: &AtomicUsize) -> Option<Conn> {
    let total = stmts.len();
    for (i, stmt) in stmts.into_iter().enumerate() {
        // Statements not started yet: those a closed cursor drops.
        left.store(total - i - 1, Ordering::Relaxed);
        match run_statement(&mut conn, &stmt, tx) {
            Outcome::Done => {}
            Outcome::Aborted => return Some(conn),
            Outcome::Failed(m) => {
                let _ = tx.send(Item::Error(m));
                return Some(conn);
            }
            Outcome::Broken(m) => {
                let _ = tx.send(Item::Error(m));
                return None;
            }
        }
        if conn.warnings() > 0 {
            if let Ok(rows) = collect_rows(&mut conn, "SHOW WARNINGS") {
                for r in rows {
                    let msg = format!(
                        "{} {}: {}",
                        r.first().map(cell_str).unwrap_or_default(),
                        r.get(1).map(cell_str).unwrap_or_default(),
                        r.get(2).map(cell_str).unwrap_or_default()
                    );
                    if tx.send(Item::Message(msg)).is_err() {
                        return Some(conn);
                    }
                }
            }
        }
        if first_keyword(&stmt) == "USE" {
            if let Ok(rows) = collect_rows(&mut conn, "SELECT DATABASE()") {
                let db = rows
                    .first()
                    .and_then(|r| r.first())
                    .map(cell_str)
                    .unwrap_or_default();
                if tx.send(Item::Database(db)).is_err() {
                    return Some(conn);
                }
            }
        }
    }
    Some(conn)
}

struct Cursor {
    rx: Receiver<Item>,
    peeked: Option<Item>,
    /// El lector devuelve aquí la conexión al terminar (se cierra sin enviar si se rompió).
    done: Receiver<Conn>,
    /// Statements of the batch the reader has not started.
    left: Arc<AtomicUsize>,
}

// ------------------------------------------------------------------------------------------------
// Driver
// ------------------------------------------------------------------------------------------------

pub struct MysqlDriver {
    cursor: Option<Cursor>,
    /// `None` mientras la tiene el hilo lector o si se perdió (se reabre al usarla).
    conn: Option<Conn>,
    opts: Opts,
    conn_id: Arc<AtomicU32>,
    busy: Arc<AtomicBool>,
    autocommit: bool,
    in_tx: bool,
    /// Solo MySQL (sin `@@in_transaction`): hubo sentencias desde el último COMMIT/ROLLBACK.
    dirty: bool,
    /// Statements of a script dropped with its open result, told in the next execute's messages.
    discarded: usize,
    database: String,
    mariadb: bool,
    version: String,
    endpoint: String,
}

impl MysqlDriver {
    pub fn connect(cfg: ConnConfig) -> Result<MysqlDriver> {
        let extra = parse_extra(&cfg.extra)?;
        let host = if cfg.host.trim().is_empty() {
            "localhost".to_string()
        } else {
            cfg.host.trim().to_string()
        };
        let port = cfg.port.unwrap_or(3306);
        let mut init = vec!["SET NAMES utf8mb4".to_string()];
        if cfg.read_only {
            init.push("SET SESSION TRANSACTION READ ONLY".into());
        }
        init.extend(extra.init.iter().cloned());
        // The connection's startup script: the driver runs `init` on every connection it opens (reconnects
        // included), before anything else.
        init.extend(crate::startup::statements(&cfg));
        let db = cfg.database.trim();
        let mut base = OptsBuilder::new()
            .ip_or_hostname(Some(host.clone()))
            .tcp_port(port)
            .user(Some(cfg.user.clone()))
            .pass(cfg.password.clone())
            .db_name(if db.is_empty() {
                None
            } else {
                Some(db.to_string())
            })
            .prefer_socket(false)
            .stmt_cache_size(0)
            .tcp_nodelay(true)
            // El sistema comprueba la conexión parada (y la mantiene viva en cortafuegos y NAT).
            .tcp_keepalive_time_ms(Some(60_000))
            .tcp_connect_timeout(Some(
                extra.connect_timeout.unwrap_or(Duration::from_secs(15)),
            ))
            .read_timeout(extra.read_timeout)
            .write_timeout(extra.write_timeout)
            .max_allowed_packet(extra.max_allowed_packet)
            .enable_cleartext_plugin(extra.cleartext)
            .init(init);
        if extra.compress {
            base = base.compress(Some(::mysql::Compression::default()));
        }
        if let Some(sock) = &extra.socket {
            base = base.socket(Some(sock.clone())).prefer_socket(true);
        }
        let ssl = |verify: bool| {
            SslOpts::default()
                .with_danger_accept_invalid_certs(!verify)
                .with_danger_skip_domain_validation(!verify)
                .with_root_cert_path(extra.ssl_ca.as_ref().map(PathBuf::from))
        };
        let (conn, opts) = match tls_mode(&cfg.encryption) {
            TlsMode::Off => {
                let o: Opts = base.into();
                (Conn::new(o.clone()).map_err(mysql_err)?, o)
            }
            TlsMode::Required => {
                let o: Opts = base.ssl_opts(ssl(!cfg.trust_cert)).into();
                (Conn::new(o.clone()).map_err(mysql_err)?, o)
            }
            // Como `--ssl-mode=PREFERRED`: cifra si el servidor puede, sin validar el certificado.
            TlsMode::Preferred => {
                let o: Opts = base.clone().ssl_opts(ssl(false)).into();
                match Conn::new(o.clone()) {
                    Ok(c) => (c, o),
                    Err(::mysql::Error::DriverError(::mysql::DriverError::TlsNotSupported)) => {
                        let o: Opts = base.into();
                        (Conn::new(o.clone()).map_err(mysql_err)?, o)
                    }
                    Err(e) => return Err(mysql_err(e)),
                }
            }
        };
        let mut d = MysqlDriver {
            cursor: None,
            conn_id: Arc::new(AtomicU32::new(conn.connection_id())),
            conn: Some(conn),
            opts,
            busy: Arc::new(AtomicBool::new(false)),
            autocommit: true,
            in_tx: false,
            dirty: false,
            discarded: 0,
            database: db.to_string(),
            mariadb: false,
            version: String::new(),
            endpoint: format!("{host}:{port}"),
        };
        let rows = d.query("SELECT VERSION(), DATABASE(), @@autocommit")?;
        if let Some(r) = rows.first() {
            d.version = r.first().map(cell_str).unwrap_or_default();
            d.database = r.get(1).map(cell_str).unwrap_or_default();
            d.autocommit = r.get(2).is_none_or(|c| cell_i64(c) != 0);
        }
        d.mariadb = d.version.to_ascii_lowercase().contains("mariadb");
        Ok(d)
    }

    /// Conexión lista para usar; la reabre si se perdió.
    fn ensure_conn(&mut self) -> Result<&mut Conn> {
        if self.conn.is_none() {
            let mut c = Conn::new(self.opts.clone()).map_err(mysql_err)?;
            self.conn_id.store(c.connection_id(), Ordering::Relaxed);
            if !self.database.is_empty() {
                let _ = c.query_drop(format!("USE {}", qi(&self.database)));
            }
            if !self.autocommit {
                c.query_drop("SET autocommit = 0").map_err(mysql_err)?;
            }
            self.in_tx = false;
            self.dirty = false;
            self.conn = Some(c);
        }
        self.conn
            .as_mut()
            .ok_or_else(|| anyhow!("Sin conexión con el servidor"))
    }

    /// Primer conjunto de filas de `sql`, en el hilo de la sesión.
    fn query(&mut self, sql: &str) -> Result<Vec<Vec<Cell>>> {
        self.release_cursor();
        let busy = self.busy.clone();
        let conn = self.ensure_conn()?;
        busy.store(true, Ordering::Relaxed);
        let r = collect_rows(conn, sql);
        busy.store(false, Ordering::Relaxed);
        match r {
            Ok(rows) => Ok(rows),
            Err(e) => {
                if !is_server_error(&e) {
                    self.conn = None;
                }
                Err(mysql_err(e))
            }
        }
    }

    /// Literal de texto SQL, según el modo de escape de barras invertidas de la sesión.
    fn lit(&self, s: &str) -> String {
        ql(
            s,
            self.conn.as_ref().is_some_and(|c| c.no_backslash_escape()),
        )
    }

    /// Lanza el hilo lector con la conexión y deja el lote abierto como cursor.
    fn start(&mut self, stmts: Vec<String>) -> Result<()> {
        self.ensure_conn()?;
        let conn = self
            .conn
            .take()
            .ok_or_else(|| anyhow!("Sin conexión con el servidor"))?;
        let (tx, rx) = mpsc::sync_channel::<Item>(CHANNEL_ROWS);
        let (done_tx, done_rx) = mpsc::channel::<Conn>();
        let left = Arc::new(AtomicUsize::new(stmts.len()));
        let worker_left = left.clone();
        let full_binary = crate::model::full_binary();
        self.busy.store(true, Ordering::Relaxed);
        let spawned = std::thread::Builder::new()
            .name("celer-mysql-reader".into())
            .spawn(move || {
                crate::model::set_full_binary(full_binary);
                let conn = worker(conn, stmts, &tx, &worker_left);
                drop(tx);
                if let Some(c) = conn {
                    let _ = done_tx.send(c);
                }
            });
        if let Err(e) = spawned {
            self.busy.store(false, Ordering::Relaxed);
            bail!("No se pudo iniciar la lectura: {e}");
        }
        self.cursor = Some(Cursor {
            rx,
            peeked: None,
            done: done_rx,
            left,
        });
        Ok(())
    }

    fn next_item(&mut self) -> Option<Item> {
        let cur = self.cursor.as_mut()?;
        if let Some(it) = cur.peeked.take() {
            return Some(it);
        }
        cur.rx.recv().ok()
    }

    fn peek_back(&mut self, it: Item) {
        if let Some(cur) = self.cursor.as_mut() {
            cur.peeked = Some(it);
        }
    }

    /// El lote terminó: recupera la conexión del lector.
    fn finish(&mut self) {
        if let Some(cur) = self.cursor.take() {
            drop(cur.rx);
            self.conn = cur.done.recv().ok();
            self.busy.store(false, Ordering::Relaxed);
        }
    }

    /// Cierra el lote abierto a mitad: el lector aborta y drena; si tarda, `KILL QUERY`.
    fn release_cursor(&mut self) {
        let Some(cur) = self.cursor.take() else {
            return;
        };
        let Cursor { rx, done, left, .. } = cur;
        drop(rx);
        self.conn = match done.recv_timeout(Duration::from_millis(250)) {
            Ok(c) => Some(c),
            Err(RecvTimeoutError::Disconnected) => None,
            Err(RecvTimeoutError::Timeout) => {
                let _ = kill_query(&self.opts, self.conn_id.load(Ordering::Relaxed));
                done.recv_timeout(Duration::from_secs(10)).ok()
            }
        };
        self.discarded += left.load(Ordering::Relaxed);
        self.busy.store(false, Ordering::Relaxed);
    }

    /// Recoge resultados hasta llenar `fetch` filas de un conjunto o acabar el lote.
    fn pump(
        &mut self,
        fetch: usize,
        messages: &mut Vec<String>,
    ) -> (Vec<ResultSet>, Option<String>) {
        let mut results = Vec::new();
        let mut current: Option<ResultSet> = None;
        let mut error = None;
        loop {
            match self.next_item() {
                Some(Item::Columns(columns)) => {
                    results.extend(current.take());
                    current = Some(ResultSet {
                        columns,
                        rows: Vec::new(),
                        has_more: false,
                        rows_affected: None,
                    });
                }
                Some(Item::Row(r)) => {
                    let rs = current.get_or_insert_with(|| ResultSet {
                        columns: vec![],
                        rows: vec![],
                        has_more: false,
                        rows_affected: None,
                    });
                    if rs.rows.len() < fetch {
                        rs.rows.push(r);
                        continue;
                    }
                    rs.has_more = true;
                    results.extend(current.take());
                    self.peek_back(Item::Row(r));
                    return (results, error);
                }
                Some(Item::EndSet) => results.extend(current.take()),
                Some(Item::Count(n)) => {
                    results.extend(current.take());
                    results.push(ResultSet::count(n));
                    messages.push(if n == 1 {
                        "1 fila afectada".into()
                    } else {
                        format!("{n} filas afectadas")
                    });
                }
                Some(Item::Message(m)) => messages.push(m),
                Some(Item::Database(db)) => self.database = db,
                Some(Item::Error(e)) => {
                    // MariaDB envía las columnas antes de calcular las filas: si la sentencia
                    // falla (o se cancela) sin haber dado ninguna fila, el resultado vacío sobra.
                    if current.as_ref().is_some_and(|rs| rs.rows.is_empty()) {
                        current = None;
                    }
                    error = Some(e);
                }
                None => {
                    results.extend(current.take());
                    self.finish();
                    return (results, error);
                }
            }
        }
    }

    fn refresh_tx_state(&mut self) {
        if self.cursor.is_some() {
            if !self.autocommit {
                self.in_tx = true;
            }
            return;
        }
        // La conexión se perdió: preguntar abriría otra en silencio, sin la transacción ni lo demás. Se deja como
        // estaba para que la sesión vigilada (guard.rs) diga lo que se pierde.
        if self.conn.is_none() {
            return;
        }
        let sql = if self.mariadb {
            "SELECT @@autocommit, @@in_transaction"
        } else {
            "SELECT @@autocommit"
        };
        if let Ok(rows) = self.query(sql) {
            if let Some(r) = rows.first() {
                self.autocommit = r.first().is_none_or(|c| cell_i64(c) != 0);
                self.in_tx = if self.mariadb {
                    r.get(1).is_some_and(|c| cell_i64(c) != 0)
                } else {
                    self.dirty && !self.autocommit
                };
            }
        }
    }

    fn db_or_current(&mut self, db: &str) -> String {
        if !db.is_empty() {
            db.to_string()
        } else {
            self.current_database().unwrap_or_default()
        }
    }
}

impl Drop for MysqlDriver {
    fn drop(&mut self) {
        self.release_cursor();
    }
}

impl Driver for MysqlDriver {
    fn execute(&mut self, sql: &str, fetch: usize) -> Result<ExecOutput> {
        self.release_cursor();
        let t0 = Instant::now();
        let stmts = split_statements(sql);
        let mut out = ExecOutput::default();
        out.messages
            .extend(crate::session::discarded_note(std::mem::take(&mut self.discarded)));
        if stmts.is_empty() {
            out.in_transaction = self.in_tx;
            return Ok(out);
        }
        if !self.autocommit
            || stmts
                .iter()
                .any(|s| matches!(first_keyword(s).as_str(), "START" | "BEGIN"))
        {
            self.dirty = true;
        }
        self.start(stmts)?;
        let (results, error) = self.pump(fetch.max(1), &mut out.messages);
        out.results = results;
        self.refresh_tx_state();
        out.in_transaction = self.in_tx;
        out.elapsed_ms = t0.elapsed().as_millis() as u64;
        // A failed statement fails the whole batch, even after others gave results, as in postgres.rs:
        // saveTable rolls back on the error instead of committing the statements before it.
        if let Some(e) = error {
            bail!(e);
        }
        if let Some(cur) = &self.cursor {
            out.messages
                .extend(crate::session::pending_note(cur.left.load(Ordering::Relaxed)));
        }
        Ok(out)
    }

    fn fetch(&mut self, n: usize) -> Result<FetchOutput> {
        let mut out = FetchOutput::default();
        if self.cursor.is_none() {
            bail!(crate::session::CURSOR_CLOSED);
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
                Some(Item::Message(_)) => {}
                Some(Item::Database(db)) => self.database = db,
                Some(Item::Error(e)) => {
                    self.release_cursor();
                    self.refresh_tx_state();
                    bail!(e);
                }
                Some(other) => {
                    // Termina este resultado; siguen otros del mismo lote.
                    if !matches!(other, Item::EndSet) {
                        self.peek_back(other);
                    }
                    let mut msgs = Vec::new();
                    let (extra, error) = self.pump(n, &mut msgs);
                    out.extra = extra;
                    self.refresh_tx_state();
                    if let Some(e) = error {
                        bail!(e);
                    }
                    return Ok(out);
                }
                None => {
                    self.finish();
                    self.refresh_tx_state();
                    return Ok(out);
                }
            }
        }
    }

    fn close_cursor(&mut self) -> Result<()> {
        self.release_cursor();
        Ok(())
    }

    fn set_autocommit(&mut self, on: bool) -> Result<bool> {
        // Activar autocommit confirma la transacción abierta, como en el cliente `mysql`.
        self.query(if on {
            "SET autocommit = 1"
        } else {
            "SET autocommit = 0"
        })?;
        self.autocommit = on;
        if on {
            self.dirty = false;
        }
        self.refresh_tx_state();
        Ok(self.in_tx)
    }

    fn commit(&mut self) -> Result<bool> {
        self.query("COMMIT")?;
        self.dirty = false;
        self.refresh_tx_state();
        Ok(self.in_tx)
    }

    fn rollback(&mut self) -> Result<bool> {
        self.query("ROLLBACK")?;
        self.dirty = false;
        self.refresh_tx_state();
        Ok(self.in_tx)
    }

    fn children(&mut self, path: &[String]) -> Result<Vec<MetaNode>> {
        self.release_cursor();
        let p: Vec<&str> = path.iter().map(|s| s.as_str()).collect();
        match p.as_slice() {
            [] => {
                let sys = SYSTEM_DBS
                    .iter()
                    .map(|s| format!("'{s}'"))
                    .collect::<Vec<_>>()
                    .join(",");
                let rows = self.query(&format!(
                    "SELECT SCHEMA_NAME, CASE WHEN LOWER(SCHEMA_NAME) IN ({sys}) THEN 1 ELSE 0 END AS is_sys \
                     FROM information_schema.SCHEMATA ORDER BY is_sys, SCHEMA_NAME"
                ))?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        let n = cell_str(&r[0]);
                        let detail = (cell_i64(&r[1]) == 1).then(|| "sistema".to_string());
                        MetaNode::branch(n.clone(), "database", vec![n]).with_detail(detail)
                    })
                    .collect())
            }
            // MySQL no tiene esquemas: un único nodo con el nombre de la base de datos.
            [db] => Ok(vec![MetaNode::branch(
                *db,
                "schema",
                vec![db.to_string(), db.to_string()],
            )]),
            [db, schema] => Ok([
                ("Tablas", "tables"),
                ("Vistas", "views"),
                ("Procedimientos", "procedures"),
                ("Funciones", "functions"),
                ("Triggers", "triggers"),
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
                let d = self.lit(db);
                let (sql, kind, branch) = match *folder {
                    "tables" => (
                        format!(
                            "SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES \
                             WHERE TABLE_SCHEMA = {d} AND TABLE_TYPE IN ('BASE TABLE','SYSTEM VERSIONED') ORDER BY TABLE_NAME"
                        ),
                        "table",
                        true,
                    ),
                    "views" => (
                        format!(
                            "SELECT TABLE_NAME, NULL FROM information_schema.TABLES \
                             WHERE TABLE_SCHEMA = {d} AND TABLE_TYPE IN ('VIEW','SYSTEM VIEW') ORDER BY TABLE_NAME"
                        ),
                        "view",
                        true,
                    ),
                    "procedures" => (
                        format!(
                            "SELECT ROUTINE_NAME, NULL FROM information_schema.ROUTINES \
                             WHERE ROUTINE_SCHEMA = {d} AND ROUTINE_TYPE = 'PROCEDURE' ORDER BY ROUTINE_NAME"
                        ),
                        "procedure",
                        false,
                    ),
                    "functions" => (
                        format!(
                            "SELECT ROUTINE_NAME, DTD_IDENTIFIER FROM information_schema.ROUTINES \
                             WHERE ROUTINE_SCHEMA = {d} AND ROUTINE_TYPE = 'FUNCTION' ORDER BY ROUTINE_NAME"
                        ),
                        "function",
                        false,
                    ),
                    "triggers" => (
                        format!(
                            "SELECT TRIGGER_NAME, CONCAT(ACTION_TIMING, ' ', EVENT_MANIPULATION, ' · ', EVENT_OBJECT_TABLE) \
                             FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = {d} ORDER BY TRIGGER_NAME"
                        ),
                        "trigger",
                        false,
                    ),
                    _ => return Ok(vec![]),
                };
                let rows = self.query(&sql)?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        let n = cell_str(&r[0]);
                        let detail = match (&r[1], kind) {
                            (Cell::Null, _) => None,
                            (c, "table") => Some(format!("~{}", fmt_rows(cell_i64(c)))),
                            (c, _) => Some(cell_str(c)),
                        };
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
                        node.with_obj(obj).with_detail(detail)
                    })
                    .collect())
            }
            [db, schema, folder, name] => {
                let kind = if *folder == "views" { "view" } else { "table" };
                let rows = self.query(&format!(
                    "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA FROM information_schema.COLUMNS \
                     WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} ORDER BY ORDINAL_POSITION",
                    self.lit(db),
                    self.lit(name)
                ))?;
                let mut nodes: Vec<MetaNode> = rows
                    .iter()
                    .map(|r| {
                        let pk = cell_str(&r[3]) == "PRI";
                        let mut detail = cell_str(&r[1]);
                        if pk {
                            detail.push_str(" · PK");
                        }
                        if cell_str(&r[4])
                            .to_ascii_lowercase()
                            .contains("auto_increment")
                        {
                            detail.push_str(" · auto_increment");
                        }
                        if cell_str(&r[2]) == "NO" {
                            detail.push_str(" · not null");
                        }
                        MetaNode::leaf(
                            cell_str(&r[0]),
                            if pk { "pkcolumn" } else { "column" },
                            Some(detail),
                        )
                    })
                    .collect();
                if kind == "table" {
                    let base = vec![
                        db.to_string(),
                        schema.to_string(),
                        folder.to_string(),
                        name.to_string(),
                    ];
                    for (label, key) in [("Índices", "indexes"), ("Claves foráneas", "fks")] {
                        let mut p = base.clone();
                        p.push(key.to_string());
                        nodes.push(MetaNode::branch(label, "folder", p));
                    }
                }
                Ok(nodes)
            }
            [db, _schema, _folder, name, sub] => {
                let (d, t) = (self.lit(db), self.lit(name));
                match *sub {
                    "indexes" => {
                        let rows = self.query(&format!(
                            "SELECT INDEX_NAME, MIN(NON_UNIQUE), MIN(INDEX_TYPE), \
                               GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ') \
                             FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = {d} AND TABLE_NAME = {t} \
                             GROUP BY INDEX_NAME ORDER BY INDEX_NAME <> 'PRIMARY', INDEX_NAME"
                        ))?;
                        Ok(rows
                            .iter()
                            .map(|r| {
                                let n = cell_str(&r[0]);
                                let mut det = format!("({})", cell_str(&r[3]));
                                if n == "PRIMARY" {
                                    det.push_str(" · PK");
                                } else if cell_i64(&r[1]) == 0 {
                                    det.push_str(" · único");
                                }
                                det.push_str(&format!(" · {}", cell_str(&r[2]).to_lowercase()));
                                MetaNode::leaf(n, "index", Some(det))
                            })
                            .collect())
                    }
                    "fks" => {
                        let rows = self.query(&format!(
                            "SELECT CONSTRAINT_NAME, \
                               GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR ', '), \
                               MIN(REFERENCED_TABLE_SCHEMA), MIN(REFERENCED_TABLE_NAME), \
                               GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR ', ') \
                             FROM information_schema.KEY_COLUMN_USAGE \
                             WHERE TABLE_SCHEMA = {d} AND TABLE_NAME = {t} AND REFERENCED_TABLE_NAME IS NOT NULL \
                             GROUP BY CONSTRAINT_NAME ORDER BY CONSTRAINT_NAME"
                        ))?;
                        Ok(rows
                            .iter()
                            .map(|r| {
                                let ref_db = cell_str(&r[2]);
                                let ref_db = if ref_db.is_empty() { db.to_string() } else { ref_db };
                                let ref_table = cell_str(&r[3]);
                                let target = if ref_db == **db { ref_table.clone() } else { format!("{ref_db}.{ref_table}") };
                                // Same "cols → table(cols)" shape on every engine; `obj` is the referenced table.
                                MetaNode::leaf(
                                    cell_str(&r[0]),
                                    "key",
                                    Some(format!("{} → {}({})", cell_str(&r[1]), target, cell_str(&r[4]))),
                                )
                                .with_obj(ObjectRef::new(&ref_db, &ref_db, &ref_table, "table"))
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
        self.release_cursor();
        let db = self.db_or_current(if obj.database.is_empty() {
            &obj.schema
        } else {
            &obj.database
        });
        let rows = self.query(&format!(
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA, COLUMN_DEFAULT, DATA_TYPE \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} ORDER BY ORDINAL_POSITION",
            self.lit(&db),
            self.lit(&obj.name)
        ))?;
        Ok(rows
            .iter()
            .map(|r| {
                let column_type = cell_str(&r[1]);
                let extra = cell_str(&r[4]).to_ascii_lowercase();
                TableColumn {
                    name: cell_str(&r[0]),
                    kind: kind_from_decl(&cell_str(&r[6]), &column_type),
                    type_name: column_type,
                    nullable: cell_str(&r[2]) == "YES",
                    primary_key: cell_str(&r[3]) == "PRI",
                    identity: extra.contains("auto_increment") || extra.contains("generated"),
                    default: match &r[5] {
                        Cell::Null => None,
                        // MariaDB devuelve 'NULL' (texto) cuando no hay valor por defecto.
                        Cell::Text(s) if s == "NULL" => None,
                        c => Some(cell_str(c)),
                    },
                }
            })
            .collect())
    }

    fn ddl(&mut self, obj: &ObjectRef) -> Result<String> {
        let (what, col) = match obj.kind.as_str() {
            "view" => ("VIEW", 1),
            "procedure" => ("PROCEDURE", 2),
            "function" => ("FUNCTION", 2),
            "trigger" => ("TRIGGER", 2),
            _ => ("TABLE", 1),
        };
        let rows = self.query(&format!(
            "SHOW CREATE {what} {}",
            self.qualified_name(obj)
        ))?;
        let text = rows
            .first()
            .and_then(|r| r.get(col))
            .map(cell_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                anyhow!(
                    "No hay definición disponible para {} (¿faltan permisos?)",
                    obj.name
                )
            })?;
        Ok(match what {
            "TABLE" | "VIEW" => format!("{};", text.trim().trim_end_matches(';')),
            _ => format!("DELIMITER //\n{}\n//\nDELIMITER ;", text.trim()),
        })
    }

    fn completion(&mut self, database: &str) -> Result<CompletionSchema> {
        self.release_cursor();
        let db = self.db_or_current(database);
        let mut out = CompletionSchema::default();
        if db.is_empty() {
            return Ok(out);
        }
        let rows = self.query(&format!(
            "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = {} ORDER BY TABLE_NAME, ORDINAL_POSITION",
            self.lit(&db)
        ))?;
        for r in rows {
            let (t, c) = (cell_str(&r[0]), cell_str(&r[1]));
            match out.tables.last_mut() {
                Some(last) if last.name == t => last.columns.push(c),
                _ => out.tables.push(CompletionTable {
                    schema: db.clone(),
                    name: t,
                    columns: vec![c],
                }),
            }
        }
        Ok(out)
    }

    fn databases(&mut self) -> Result<Vec<String>> {
        let rows =
            self.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME")?;
        Ok(rows.iter().map(|r| cell_str(&r[0])).collect())
    }

    /// Se sabe al conectar y se sigue con USE (el lector lo avisa) y al cambiar de base: solo se pregunta si no hay.
    fn current_database(&mut self) -> Result<String> {
        if self.cursor.is_some() || !self.database.is_empty() {
            return Ok(self.database.clone());
        }
        let rows = self.query("SELECT DATABASE()")?;
        self.database = rows
            .first()
            .and_then(|r| r.first())
            .map(cell_str)
            .unwrap_or_default();
        Ok(self.database.clone())
    }

    fn use_database(&mut self, db: &str) -> Result<()> {
        self.query(&format!("USE {}", qi(db)))?;
        self.database = db.to_string();
        Ok(())
    }

    fn qualified_name(&self, o: &ObjectRef) -> String {
        let db = if o.database.is_empty() {
            o.schema.as_str()
        } else {
            o.database.as_str()
        };
        if db.is_empty() {
            qi(&o.name)
        } else {
            format!("{}.{}", qi(db), qi(&o.name))
        }
    }

    fn quote_ident(&self, s: &str) -> String {
        qi(s)
    }

    fn server_info(&mut self) -> Result<String> {
        Ok(format!(
            "{} — {}",
            product_version(&self.version),
            self.endpoint
        ))
    }

    /// COM_PING. Sin conexión (se perdió) también es un fallo: la sesión vigilada decide si se puede abrir otra.
    fn ping(&mut self) -> Result<()> {
        if self.cursor.is_some() {
            return Ok(());
        }
        let Some(conn) = self.conn.as_mut() else { bail!("Sin conexión con el servidor") };
        if let Err(e) = conn.ping() {
            self.conn = None;
            return Err(mysql_err(e));
        }
        Ok(())
    }

    /// La conexión se perdió (error de E/S o de protocolo) y no hay lector con ella.
    fn broken(&self) -> bool {
        self.conn.is_none() && self.cursor.is_none()
    }

    fn canceller(&self) -> Canceller {
        let opts = self.opts.clone();
        let id = self.conn_id.clone();
        let busy = self.busy.clone();
        Arc::new(move || {
            if !busy.load(Ordering::Relaxed) {
                return;
            }
            let opts = opts.clone();
            let id = id.load(Ordering::Relaxed);
            // Abrir la conexión auxiliar puede tardar: que no bloquee a quien cancela.
            let _ = std::thread::Builder::new()
                .name("celer-mysql-cancel".into())
                .spawn(move || {
                    let _ = kill_query(&opts, id);
                });
        })
    }
}

/// "11.4.8-MariaDB-log" -> "MariaDB 11.4.8"; "8.0.36-0ubuntu0" -> "MySQL 8.0.36".
fn product_version(v: &str) -> String {
    let v = v.trim();
    if v.to_ascii_lowercase().contains("mariadb") {
        let v = v.strip_prefix("5.5.5-").unwrap_or(v);
        format!("MariaDB {}", v.split('-').next().unwrap_or(v))
    } else if v.is_empty() {
        "MySQL".into()
    } else {
        format!("MySQL {}", v.split('-').next().unwrap_or(v))
    }
}

fn qi(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

/// Literal de texto. Con `no_backslash` (sql_mode NO_BACKSLASH_ESCAPES) la barra es literal.
fn ql(s: &str, no_backslash: bool) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        match ch {
            '\'' => out.push_str("''"),
            '\\' if !no_backslash => out.push_str("\\\\"),
            '\0' if !no_backslash => out.push_str("\\0"),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

fn cell_str(c: &Cell) -> String {
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
        Cell::Text(v) => v.trim().parse().unwrap_or(0),
        Cell::Null => 0,
    }
}

fn fmt_rows(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut s = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            s.push('.');
        }
        s.push(ch);
    }
    if n < 0 {
        s.insert(0, '-');
    }
    format!("{s} {}", if n == 1 { "fila" } else { "filas" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(ty: ColumnType) -> ColMeta {
        ColMeta {
            ty,
            unsigned: false,
            binary: false,
            is_enum: false,
            is_set: false,
            len: 11,
        }
    }

    #[test]
    fn splits_scripts() {
        let s = split_statements("select 1; select 'a;b' ; select \"x;\" ;select `c;d` from t");
        assert_eq!(
            s,
            vec![
                "select 1",
                "select 'a;b'",
                "select \"x;\"",
                "select `c;d` from t"
            ]
        );
        // Escapes con barra y comillas dobladas.
        let s = split_statements(r"select 'it\'s;'; select 'a''b;c'");
        assert_eq!(s, vec![r"select 'it\'s;'", "select 'a''b;c'"]);
        // Comentarios: --, #, /* */ y solo-comentarios descartados.
        let s = split_statements(
            "-- uno; dos\nselect 1; # tres; cuatro\n/* cinco; */ select 2;\n-- fin;\n  ",
        );
        assert_eq!(s, vec!["-- uno; dos\nselect 1", "# tres; cuatro\n/* cinco; */ select 2"]);
        // `5--1` no es un comentario.
        assert_eq!(split_statements("select 5--1;"), vec!["select 5--1"]);
        // Comentario ejecutable: cuenta como sentencia.
        assert_eq!(
            split_statements("/*!40101 SET NAMES utf8 */;"),
            vec!["/*!40101 SET NAMES utf8 */"]
        );
        assert!(split_statements(" ; ;\n -- nada\n").is_empty());
    }

    #[test]
    fn splits_delimiter_blocks() {
        let script = "DROP PROCEDURE IF EXISTS p;\n\
            DELIMITER //\n\
            CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 'x//';\nEND //\n\
            delimiter ;\n\
            CALL p();\n\
            DELIMITER $$\nCREATE FUNCTION f() RETURNS INT DETERMINISTIC BEGIN RETURN 1; END$$\nDELIMITER ;";
        let s = split_statements(script);
        assert_eq!(s.len(), 4, "{s:#?}");
        assert_eq!(s[0], "DROP PROCEDURE IF EXISTS p");
        assert!(s[1].starts_with("CREATE PROCEDURE p()"));
        assert!(s[1].ends_with("END"));
        assert!(s[1].contains("SELECT 1;"));
        assert!(s[1].contains("'x//'"));
        assert_eq!(s[2], "CALL p()");
        assert_eq!(
            s[3],
            "CREATE FUNCTION f() RETURNS INT DETERMINISTIC BEGIN RETURN 1; END"
        );
    }

    #[test]
    fn maps_types() {
        use ColumnType::*;
        let int = meta(MYSQL_TYPE_LONGLONG);
        assert!(matches!(bytes_to_cell(b"42", &int), Cell::Int(42)));
        assert!(matches!(bytes_to_cell(b"-9223372036854775808", &int), Cell::Text(_)));
        assert!(matches!(bytes_to_cell(b"9007199254740991", &int), Cell::Int(_)));
        match bytes_to_cell(b"18446744073709551615", &ColMeta { unsigned: true, ..int }) {
            Cell::Text(s) => assert_eq!(s, "18446744073709551615"),
            other => panic!("{other:?}"),
        }
        assert!(matches!(value_to_cell(Value::UInt(u64::MAX), &int), Cell::Text(_)));
        assert!(matches!(value_to_cell(Value::UInt(7), &int), Cell::Int(7)));
        assert!(matches!(bytes_to_cell(b"1.5", &meta(MYSQL_TYPE_DOUBLE)), Cell::Num(v) if v == 1.5));
        assert!(matches!(value_to_cell(Value::Float(1.1), &meta(MYSQL_TYPE_FLOAT)), Cell::Num(v) if v == 1.1));
        match bytes_to_cell(b"12345678901234567890.0123456789", &meta(MYSQL_TYPE_NEWDECIMAL)) {
            Cell::Text(s) => assert_eq!(s, "12345678901234567890.0123456789"),
            other => panic!("{other:?}"),
        }
        // tinyint(1): número con familia Bool.
        let flag = ColMeta { len: 1, ..meta(MYSQL_TYPE_TINY) };
        assert_eq!(flag.kind(), ColKind::Bool);
        assert_eq!(flag.type_name(), "tinyint(1)");
        assert!(matches!(bytes_to_cell(b"1", &flag), Cell::Int(1)));
        let bit1 = ColMeta { len: 1, ..meta(MYSQL_TYPE_BIT) };
        assert!(matches!(bytes_to_cell(&[1], &bit1), Cell::Int(1)));
        assert!(matches!(bytes_to_cell(&[0xA5], &meta(MYSQL_TYPE_BIT)), Cell::Int(165)));
        // Binarios -> hex; texto -> texto.
        let blob = ColMeta { binary: true, ..meta(MYSQL_TYPE_BLOB) };
        assert_eq!(blob.kind(), ColKind::Binary);
        assert_eq!(blob.type_name(), "blob");
        match bytes_to_cell(&[0xDE, 0xAD], &blob) {
            Cell::Text(s) => assert_eq!(s, "0xDEAD"),
            other => panic!("{other:?}"),
        }
        let text = meta(MYSQL_TYPE_BLOB);
        assert_eq!(text.kind(), ColKind::Text);
        assert!(matches!(bytes_to_cell("ñ".as_bytes(), &text), Cell::Text(s) if s == "ñ"));
        // ENUM con charset binario sigue siendo texto.
        let en = ColMeta { binary: true, is_enum: true, ..meta(MYSQL_TYPE_STRING) };
        assert!(matches!(bytes_to_cell(b"red", &en), Cell::Text(s) if s == "red"));
        assert_eq!(en.type_name(), "enum");
        // Fechas.
        let dt = meta(MYSQL_TYPE_DATETIME);
        assert_eq!(dt.kind(), ColKind::Date);
        assert!(matches!(bytes_to_cell(b"2024-01-02 03:04:05", &dt), Cell::Text(s) if s == "2024-01-02 03:04:05"));
        assert!(matches!(value_to_cell(Value::Date(2024, 2, 29, 0, 0, 0, 0), &meta(MYSQL_TYPE_DATE)), Cell::Text(s) if s == "2024-02-29"));
        assert!(matches!(value_to_cell(Value::Date(2024, 2, 29, 13, 5, 9, 120), &dt), Cell::Text(s) if s == "2024-02-29 13:05:09.000120"));
        assert!(matches!(value_to_cell(Value::Time(true, 34, 22, 59, 59, 0), &meta(MYSQL_TYPE_TIME)), Cell::Text(s) if s == "-838:59:59"));
        assert!(matches!(value_to_cell(Value::NULL, &dt), Cell::Null));
        // Basura en una columna numérica: texto, nunca pánico.
        assert!(matches!(bytes_to_cell(&[0xFF, 0xFE], &int), Cell::Text(_)));
        assert!(matches!(bytes_to_cell(b"abc", &meta(MYSQL_TYPE_DOUBLE)), Cell::Text(_)));
        assert_eq!(ColMeta { unsigned: true, ..int }.type_name(), "bigint unsigned");
        // Tipos declarados.
        assert_eq!(kind_from_decl("tinyint", "tinyint(1)"), ColKind::Bool);
        assert_eq!(kind_from_decl("tinyint", "tinyint(4)"), ColKind::Number);
        assert_eq!(kind_from_decl("longblob", "longblob"), ColKind::Binary);
        assert_eq!(kind_from_decl("json", "json"), ColKind::Text);
        assert_eq!(kind_from_decl("datetime", "datetime(6)"), ColKind::Date);
    }

    #[test]
    fn helpers() {
        assert_eq!(qi("a`b"), "`a``b`");
        assert_eq!(ql(r"o'k\", false), r"'o''k\\'");
        assert_eq!(ql(r"o'k\", true), r"'o''k\'");
        assert_eq!(product_version("11.4.8-MariaDB"), "MariaDB 11.4.8");
        assert_eq!(product_version("5.5.5-10.6.12-MariaDB-log"), "MariaDB 10.6.12");
        assert_eq!(product_version("8.0.36-0ubuntu0.22.04.1"), "MySQL 8.0.36");
        assert_eq!(fmt_rows(200000), "200.000 filas");
        assert_eq!(tls_mode("login"), TlsMode::Preferred);
        assert_eq!(tls_mode("off"), TlsMode::Off);
        assert_eq!(tls_mode("required"), TlsMode::Required);
        let e = parse_extra("connect_timeout=5; compress=true;sql_mode=ANSI_QUOTES;wait_timeout=600").unwrap();
        assert_eq!(e.connect_timeout, Some(Duration::from_secs(5)));
        assert!(e.compress);
        assert_eq!(
            e.init,
            vec![
                "SET SESSION sql_mode = 'ANSI_QUOTES'".to_string(),
                "SET SESSION wait_timeout = 600".to_string()
            ]
        );
        assert!(parse_extra("bad key=1").is_err());
        assert_eq!(parse_extra("").unwrap(), ExtraOpts::default());
    }

    // ---------------------------------------------------------------- integración
    // Solo con CELER_MYSQL_TEST=mysql://user:pass@host:port/db (ver dev/testdb-mysql.ps1).

    fn test_cfg() -> Option<ConnConfig> {
        let url = std::env::var("CELER_MYSQL_TEST").ok()?;
        let rest = url.trim().strip_prefix("mysql://")?;
        let (auth, hostdb) = rest.rsplit_once('@')?;
        let (user, pass) = auth.split_once(':').unwrap_or((auth, ""));
        let (hostport, db) = hostdb.split_once('/').unwrap_or((hostdb, ""));
        let (host, port) = hostport.split_once(':').unwrap_or((hostport, "3306"));
        let mut cfg = ConnConfig::default();
        cfg.kind = DbKind::Mysql;
        cfg.host = host.into();
        cfg.port = port.parse().ok();
        cfg.user = user.into();
        cfg.password = Some(pass.into());
        cfg.database = db.into();
        cfg.encryption = "login".into();
        Some(cfg)
    }

    fn connect() -> Option<MysqlDriver> {
        let cfg = test_cfg()?;
        Some(MysqlDriver::connect(cfg).expect("conexión de prueba"))
    }

    /// Ajustes › Ejecución › tiempo máximo (MySQL and MariaDB): the core's deadline cancels through the driver. An
    /// interrupted SLEEP ends with 1 instead of an error: the output stays, with the note that the deadline was hit.
    #[test]
    fn it_times_out() {
        let Some(mut d) = connect() else { return };
        let t0 = Instant::now();
        let cancel = d.canceller();
        let r = crate::session::with_deadline(cancel, 1, || d.execute("SELECT SLEEP(20) AS s", 10));
        assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
        match r {
            Ok(out) => assert!(out.messages.contains(&crate::session::timeout_note(1)), "{:?}", out.messages),
            Err(e) => assert_eq!(e, crate::session::timeout_error(1)),
        }
        let cancel = d.canceller();
        let r = crate::session::with_deadline(cancel, 1, || d.execute("SELECT COUNT(*) FROM events a JOIN events b ON a.kind = b.kind JOIN events c ON b.kind = c.kind", 10));
        assert_eq!(r.err(), Some(crate::session::timeout_error(1)));
        let out = d.execute("SELECT 5", 10).unwrap();
        assert_eq!(cell_i64(&out.results[0].rows[0][0]), 5);
    }

    /// Ayuda › Registro de errores (MySQL and MariaDB): the syntax error quotes the statement; its entry does not.
    #[test]
    fn it_scrubs_error_log_entries() {
        let Some(mut d) = connect() else { return };
        let e = d.execute("SELECT nombre FROMM clientes WHERE pwd = 'celer-secret-42'", 10).expect_err("error de sintaxis").to_string();
        crate::errlog::assert_scrubbed("MySQL/MariaDB", &e, "celer-secret-42");
    }

    #[test]
    fn it_pages_large_results() {
        let Some(mut d) = connect() else { return };
        let out = d
            .execute("SELECT * FROM events ORDER BY id; SELECT 'z' AS k", 100)
            .unwrap();
        assert_eq!(out.results.len(), 1);
        let rs = &out.results[0];
        assert_eq!(rs.rows.len(), 100);
        assert!(rs.has_more);
        assert_eq!(rs.columns[0].name, "id");
        assert_eq!(rs.columns[0].kind, ColKind::Number);
        assert_eq!(rs.columns[6].type_name, "text"); // JSON en MariaDB = LONGTEXT
        let mut total = rs.rows.len();
        let mut last_id = cell_i64(&rs.rows[99][0]);
        let extra;
        loop {
            let more = d.fetch(5000).unwrap();
            total += more.rows.len();
            if let Some(r) = more.rows.last() {
                assert!(cell_i64(&r[0]) > last_id);
                last_id = cell_i64(&r[0]);
            }
            if !more.has_more {
                extra = more.extra;
                break;
            }
            assert_eq!(more.rows.len(), 5000);
        }
        assert_eq!(total, 200_000);
        assert_eq!(extra.len(), 1);
        assert_eq!(cell_str(&extra[0].rows[0][0]), "z");
        // Without an open result, fetch says so (the grid must not take it for the last page).
        assert!(d.fetch(10).is_err());
        // Reading the catalog on the session (autocompletion after DDL) closes the open result: fetch fails.
        assert!(d.execute("SELECT * FROM events", 10).unwrap().results[0].has_more);
        d.completion("celer").unwrap();
        assert!(d.fetch(10).unwrap_err().to_string().contains("ya no está abierto"));

        // Cerrar a mitad deja la conexión utilizable y no lee el resto.
        let t0 = Instant::now();
        let out = d.execute("SELECT * FROM events a CROSS JOIN events b", 50).unwrap();
        assert!(out.results[0].has_more);
        d.close_cursor().unwrap();
        let out = d.execute("SELECT COUNT(*) FROM customers", 10).unwrap();
        assert_eq!(cell_i64(&out.results[0].rows[0][0]), 8);
        assert!(t0.elapsed() < Duration::from_secs(20), "{:?}", t0.elapsed());
        // Otra sentencia sin cerrar el cursor anterior también vale.
        d.execute("SELECT * FROM events", 10).unwrap();
        let out = d.execute("SELECT 1", 10).unwrap();
        assert_eq!(cell_i64(&out.results[0].rows[0][0]), 1);

        // Statements behind a paged result: told when it opens, and when they are dropped.
        let out = d.execute("SELECT * FROM events; SELECT 1; SELECT 2", 10).unwrap();
        assert!(out.messages.iter().any(|m| m.starts_with("Quedan 2 sentencias")), "{:?}", out.messages);
        let out = d.execute("SELECT 3", 10).unwrap();
        assert!(out.messages.iter().any(|m| m.starts_with("No se ejecutaron 2 sentencias")), "{:?}", out.messages);
        let out = d.execute("SELECT 4", 10).unwrap();
        assert!(out.messages.is_empty(), "{:?}", out.messages);
    }

    #[test]
    fn it_maps_values() {
        let Some(mut d) = connect() else { return };
        let out = d.execute("SELECT * FROM type_zoo ORDER BY id", 10).unwrap();
        let rs = &out.results[0];
        let col = |n: &str| rs.columns.iter().position(|c| c.name == n).unwrap();
        let r0 = &rs.rows[0];
        assert!(matches!(&r0[col("c_ubigint")], Cell::Text(s) if s == "18446744073709551615"));
        assert!(matches!(&r0[col("c_bigint")], Cell::Text(s) if s == "-9223372036854775808"));
        assert!(matches!(&rs.rows[1][col("c_bigint")], Cell::Text(s) if s == "9007199254740993"));
        assert!(matches!(&r0[col("c_int")], Cell::Int(-2147483648)));
        assert_eq!(rs.columns[col("c_bool")].kind, ColKind::Bool);
        assert!(matches!(&r0[col("c_bool")], Cell::Int(1)));
        assert!(matches!(&r0[col("c_double")], Cell::Num(v) if (*v - std::f64::consts::PI).abs() < 1e-12));
        assert!(matches!(&r0[col("c_float")], Cell::Num(v) if *v == 1.5));
        assert!(matches!(&r0[col("c_decimal")], Cell::Text(s) if s == "12345678901234567890.0123456789"));
        assert!(matches!(&r0[col("c_bit")], Cell::Int(165)));
        assert!(matches!(&r0[col("c_text")], Cell::Text(s) if s == "texto largo…"));
        assert!(matches!(&r0[col("c_binary")], Cell::Text(s) if s == "0x00FF10AB"));
        assert_eq!(rs.columns[col("c_blob")].kind, ColKind::Binary);
        assert!(matches!(&r0[col("c_blob")], Cell::Text(s) if s == "0x0102030405"));
        assert!(matches!(&r0[col("c_date")], Cell::Text(s) if s == "2024-02-29"));
        assert_eq!(rs.columns[col("c_datetime")].kind, ColKind::Date);
        assert!(matches!(&r0[col("c_datetime")], Cell::Text(s) if s == "2024-12-31 23:59:59.999999"));
        assert!(matches!(&r0[col("c_time")], Cell::Text(s) if s == "-838:59:59.000"));
        assert!(matches!(&r0[col("c_json")], Cell::Text(s) if s.contains("\"a\"")));
        assert!(matches!(&r0[col("c_enum")], Cell::Text(s) if s == "green"));
        assert!(matches!(&r0[col("c_set")], Cell::Text(s) if s == "a,c"));
        assert!(matches!(&r0[col("c_year")], Cell::Int(2024)));
        assert!(rs.rows[2][1..].iter().all(|c| matches!(c, Cell::Null)));
        let out = d.execute("SELECT full_name FROM customers WHERE id = 8", 10).unwrap();
        assert!(matches!(&out.results[0].rows[0][0], Cell::Text(s) if s == "Hiro Tanaka 田中"));
    }

    #[test]
    fn it_runs_scripts_and_warnings() {
        let Some(mut d) = connect() else { return };
        let script = "CREATE DATABASE IF NOT EXISTS celer_scratch;\n\
            USE celer_scratch;\n\
            DROP PROCEDURE IF EXISTS sp_two;\n\
            DELIMITER //\n\
            CREATE PROCEDURE sp_two(IN n INT)\nBEGIN\n  SELECT n AS a;\n  SELECT n * 2 AS b, 'x;y' AS c;\nEND //\n\
            DELIMITER ;\n\
            CALL sp_two(21);\n\
            CREATE TEMPORARY TABLE tmp_w (v TINYINT);\n\
            INSERT INTO tmp_w VALUES (1), (2), (3);\n\
            SELECT CAST('12abc' AS SIGNED) AS w;";
        let out = d.execute(script, 100).unwrap();
        assert_eq!(d.current_database().unwrap(), "celer_scratch");
        let rowsets: Vec<&ResultSet> = out.results.iter().filter(|r| !r.columns.is_empty()).collect();
        assert_eq!(rowsets.len(), 3, "{:#?}", out.results);
        assert_eq!(cell_i64(&rowsets[0].rows[0][0]), 21);
        assert_eq!(cell_i64(&rowsets[1].rows[0][0]), 42);
        assert_eq!(cell_str(&rowsets[1].rows[0][1]), "x;y");
        assert_eq!(cell_i64(&rowsets[2].rows[0][0]), 12);
        assert!(out.results.iter().any(|r| r.rows_affected == Some(3)));
        assert!(out.messages.iter().any(|m| m.contains("1292")), "{:?}", out.messages);
        assert!(out.messages.iter().any(|m| m == "3 filas afectadas"));
        // Error: el lote falla aunque sentencias anteriores dieran resultados (saveTable deshace con él).
        let err = d.execute("SELECT * FROM no_such_table", 10).unwrap_err();
        assert!(err.to_string().contains("1146"), "{err}");
        let err = d.execute("SELECT 1; SELECT * FROM no_such_table; SELECT 2", 10).unwrap_err();
        assert!(err.to_string().contains("1146"), "{err}");
        // También tras un resultado paginado: el error llega con fetch.
        let out = d.execute("SELECT * FROM celer.events LIMIT 20; SELECT 1; SELECT * FROM no_such_table", 10).unwrap();
        assert!(out.results[0].has_more);
        let err = d.fetch(100).unwrap_err();
        assert!(err.to_string().contains("1146"), "{err}");
        // Sigue funcionando después.
        let out = d.execute("SELECT 3", 10).unwrap();
        assert_eq!(cell_i64(&out.results[0].rows[0][0]), 3);
        // Solo comentarios: nada que hacer.
        assert!(d.execute("-- nada\n", 10).unwrap().results.is_empty());
        d.execute("DROP PROCEDURE IF EXISTS celer_scratch.sp_two", 10).unwrap();
    }

    #[test]
    fn it_reads_metadata() {
        let Some(mut d) = connect() else { return };
        let dbs = d.children(&[]).unwrap();
        let names: Vec<&str> = dbs.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"celer") && names.contains(&"shop"));
        let first_sys = names.iter().position(|n| SYSTEM_DBS.contains(n)).unwrap();
        assert!(names[first_sys..].iter().all(|n| SYSTEM_DBS.contains(n)), "{names:?}");
        assert_eq!(dbs[first_sys].detail.as_deref(), Some("sistema"));

        let p = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let schema = d.children(&p(&["celer"])).unwrap();
        assert_eq!(schema.len(), 1);
        assert_eq!(schema[0].kind, "schema");
        assert_eq!(schema[0].path, p(&["celer", "celer"]));
        let folders = d.children(&schema[0].path).unwrap();
        assert_eq!(folders.len(), 5);
        let tables = d.children(&p(&["celer", "celer", "tables"])).unwrap();
        let events = tables.iter().find(|n| n.name == "events").unwrap();
        assert!(events.detail.as_deref().unwrap().contains("filas"));
        assert_eq!(events.obj.as_ref().unwrap().schema, "celer");
        let views = d.children(&p(&["celer", "celer", "views"])).unwrap();
        assert!(views.iter().any(|n| n.name == "v_customer_orders"));
        let procs = d.children(&p(&["celer", "celer", "procedures"])).unwrap();
        assert!(procs.iter().any(|n| n.name == "sp_orders_by_customer" && n.leaf));
        let funcs = d.children(&p(&["celer", "celer", "functions"])).unwrap();
        let f = funcs.iter().find(|n| n.name == "fn_order_total").unwrap();
        assert!(f.detail.as_deref().unwrap().contains("decimal"));
        let trg = d.children(&p(&["celer", "celer", "triggers"])).unwrap();
        assert_eq!(trg[0].detail.as_deref(), Some("AFTER INSERT · order_items"));

        let cols = d.children(&p(&["celer", "celer", "tables", "customers"])).unwrap();
        assert_eq!(cols[0].kind, "pkcolumn");
        assert!(cols[0].detail.as_deref().unwrap().contains("auto_increment"));
        assert!(cols.iter().any(|n| n.name == "indexes" || n.path.last().map(|s| s.as_str()) == Some("indexes")));
        // Rutas como las construye reloadTable.
        let idx = d.children(&p(&["celer", "celer", "tables", "orders", "indexes"])).unwrap();
        assert_eq!(idx[0].name, "PRIMARY");
        assert!(idx.iter().any(|n| n.name == "ix_orders_customer_date"
            && n.detail.as_deref().unwrap().starts_with("(customer_id, ordered_at)")));
        let uq = d.children(&p(&["celer", "celer", "tables", "customers", "indexes"])).unwrap();
        assert!(uq.iter().any(|n| n.name == "uq_customers_email" && n.detail.as_deref().unwrap().contains("único")));
        let fks = d.children(&p(&["celer", "celer", "tables", "order_items", "fks"])).unwrap();
        assert_eq!(fks.len(), 2);
        assert!(fks.iter().any(|n| n.detail.as_deref() == Some("order_id → orders(id)")));
        assert!(fks.iter().any(|n| n.obj.as_ref().is_some_and(|o| o.name == "orders" && o.kind == "table")));

        let obj = ObjectRef::new("celer", "celer", "customers", "table");
        assert_eq!(d.qualified_name(&obj), "`celer`.`customers`");
        let tc = d.table_columns(&obj).unwrap();
        assert!(tc[0].primary_key && tc[0].identity && !tc[0].nullable);
        let active = tc.iter().find(|c| c.name == "is_active").unwrap();
        assert_eq!(active.kind, ColKind::Bool);
        let avatar = tc.iter().find(|c| c.name == "avatar").unwrap();
        assert_eq!(avatar.kind, ColKind::Binary);
        assert!(avatar.nullable && avatar.default.is_none());
        let country = tc.iter().find(|c| c.name == "country").unwrap();
        assert!(country.default.as_deref().unwrap().contains("ES"));

        assert!(d.ddl(&obj).unwrap().starts_with("CREATE TABLE `customers`"));
        let v = d.ddl(&ObjectRef::new("celer", "celer", "v_customer_orders", "view")).unwrap();
        assert!(v.contains("VIEW"));
        for (n, k) in [
            ("sp_orders_by_customer", "procedure"),
            ("fn_order_total", "function"),
            ("trg_order_items_ai", "trigger"),
        ] {
            let s = d.ddl(&ObjectRef::new("celer", "celer", n, k)).unwrap();
            assert!(s.starts_with("DELIMITER //") && s.contains(n), "{s}");
            assert_eq!(split_statements(&s).len(), 1);
        }

        let comp = d.completion("celer").unwrap();
        let cust = comp.tables.iter().find(|t| t.name == "customers").unwrap();
        assert_eq!(cust.columns[0], "id");
        assert_eq!(cust.schema, "celer");
        assert!(d.databases().unwrap().contains(&"shop".to_string()));
        d.use_database("shop").unwrap();
        assert_eq!(d.current_database().unwrap(), "shop");
        let out = d.execute("SELECT COUNT(*) FROM items", 10).unwrap();
        assert_eq!(cell_i64(&out.results[0].rows[0][0]), 5);
        let info = d.server_info().unwrap();
        assert!(info.starts_with("MariaDB ") || info.starts_with("MySQL "), "{info}");
        assert!(info.contains(":"));
    }

    #[test]
    fn it_handles_transactions() {
        let Some(mut d) = connect() else { return };
        d.execute("CREATE TEMPORARY TABLE tx_t (id INT PRIMARY KEY) ENGINE=InnoDB", 10)
            .unwrap();
        assert!(!d.set_autocommit(false).unwrap());
        let out = d.execute("INSERT INTO tx_t VALUES (1), (2)", 10).unwrap();
        assert!(out.in_transaction);
        assert_eq!(out.results[0].rows_affected, Some(2));
        assert!(!d.rollback().unwrap());
        let out = d.execute("SELECT COUNT(*) FROM tx_t", 10).unwrap();
        assert_eq!(cell_i64(&out.results[0].rows[0][0]), 0);
        d.execute("INSERT INTO tx_t VALUES (3)", 10).unwrap();
        assert!(!d.commit().unwrap());
        assert!(!d.set_autocommit(true).unwrap());
        let out = d.execute("SELECT COUNT(*) FROM tx_t", 10).unwrap();
        assert_eq!(cell_i64(&out.results[0].rows[0][0]), 1);
        assert!(!out.in_transaction);
        // Transacción explícita con autocommit activo.
        let out = d.execute("START TRANSACTION; INSERT INTO tx_t VALUES (4)", 10).unwrap();
        assert!(out.in_transaction);
        assert!(!d.rollback().unwrap());
        // Como saveTable: un lote cuya segunda sentencia falla es un error y el ROLLBACK lo deshace todo.
        d.execute("CREATE TEMPORARY TABLE tx_nn (id INT PRIMARY KEY, v INT NOT NULL) ENGINE=InnoDB; \
                   INSERT INTO tx_nn VALUES (1, 1), (2, 2)", 10)
            .unwrap();
        d.set_autocommit(false).unwrap();
        let err = d
            .execute("UPDATE tx_nn SET v = 10 WHERE id = 1; UPDATE tx_nn SET v = NULL WHERE id = 2", 1)
            .unwrap_err();
        assert!(err.to_string().contains("1048"), "{err}");
        d.rollback().unwrap();
        d.set_autocommit(true).unwrap();
        assert_eq!(scalar_i64(&mut d, "SELECT v FROM tx_nn WHERE id = 1"), 1);
    }

    fn scalar_i64(d: &mut MysqlDriver, sql: &str) -> i64 {
        cell_i64(&d.execute(sql, 10).unwrap().results[0].rows[0][0])
    }

    #[test]
    fn it_cancels() {
        let Some(mut d) = connect() else { return };
        let cancel = d.canceller();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            cancel();
        });
        let t0 = Instant::now();
        // SLEEP interrumpido devuelve 1 (MariaDB/MySQL) en lugar de un error.
        let r = d.execute("SELECT SLEEP(20) AS s", 10);
        t.join().unwrap();
        assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
        // Según el servidor, SLEEP interrumpido devuelve 1 o falla con el error 1317.
        match r {
            Ok(out) => assert_eq!(cell_i64(&out.results[0].rows[0][0]), 1),
            Err(e) => assert!(e.to_string().contains("cancelada"), "{e}"),
        }
        // Una consulta pesada cancelada da error de cancelación y la sesión sigue viva.
        let cancel = d.canceller();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            cancel();
        });
        let r = d.execute(
            "SELECT COUNT(*) FROM events a JOIN events b ON a.kind = b.kind",
            10,
        );
        t.join().unwrap();
        assert!(matches!(&r, Err(e) if e.to_string().contains("cancelada")), "{r:?}");
        let out = d.execute("SELECT 5", 10).unwrap();
        assert_eq!(cell_i64(&out.results[0].rows[0][0]), 5);
    }

    #[test]
    fn it_connects_with_tls_modes() {
        let Some(mut cfg) = test_cfg() else { return };
        cfg.encryption = "off".into();
        let mut d = MysqlDriver::connect(cfg.clone()).unwrap();
        assert!(d.server_info().is_ok());
        // Con cifrado obligatorio funciona si el servidor tiene TLS (MariaDB >= 11.4 lo trae
        // activado con un certificado autofirmado); si no, el error debe ser claro.
        cfg.encryption = "required".into();
        cfg.trust_cert = true;
        match MysqlDriver::connect(cfg.clone()) {
            Ok(mut d) => {
                let rows = d.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'").unwrap();
                assert!(!cell_str(&rows[0][1]).is_empty());
            }
            Err(e) => assert!(e.to_string().contains("TLS"), "{e}"),
        }
        cfg.password = Some("wrong".into());
        cfg.encryption = "login".into();
        let err = MysqlDriver::connect(cfg).err().expect("credenciales malas");
        assert!(err.to_string().contains("1045"), "{err}");
    }
}

