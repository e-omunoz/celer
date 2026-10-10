//! «Historial de la fila»: what one row looked like at past moments, read from Informix's logical logs through the
//! CDC API (`syscdcv1`). Nothing is guessed: a value shown is a value the server logged, and whatever stops the
//! history from being complete is said.
//!
//! How (measured on Informix 15, see issue #123): a CDC session (`cdc_opensess`) captures one table
//! (`cdc_startcapture`) from a log position (`cdc_activatesess`) that may be in the past, as long as that log is
//! still on disk. Its records (begin, insert, update before/after, delete, commit…) are read as a smart large object
//! whose descriptor is the session id: only SQLI offers that, so only Informix over JDBC (the bridge's LO_READ).
//! `cdc_startcapture` needs full row logging on the table; changes logged before it was turned on still come with
//! their full before and after images (measured only for tables with a variable-length column: updates of a table with only
//! fixed-length columns are logged as partial records the CDC API does not send, so the end of the history is checked
//! against the row as it is now and a difference is said), so Celer may turn it on for the read and off again, when the
//! user agrees.
//!
//! Preconditions, each reported instead of guessed: a logged database, not a RAW table, `syscdcv1` created by a DBA,
//! a user who may run the CDC routines (an ordinary user gets -674), and the logs still on disk (the oldest one is
//! where the history starts). The values are decoded here from the CDC binary format (big-endian integers, Informix
//! packed decimals for DECIMAL/MONEY/DATETIME/INTERVAL, length-prefixed strings): the size of every column is
//! checked against the size the server announces, and a table whose layout Celer cannot read is refused.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};

use crate::jdbc::{JdbcConn, JdbcError};
use crate::model::{Cell, ConnConfig, DbKind};
use crate::odbc_driver::Link;

/// The row whose history is asked for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub database: String,
    /// The table's owner (Informix's schema).
    #[serde(default)]
    pub owner: String,
    pub table: String,
    /// The primary key: each column with its value as the grid shows it.
    pub key: Vec<KeyPart>,
    /// The user agreed to turn on full row logging on the table for the read (and off again after it).
    #[serde(default)]
    pub enable_full_row_logging: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KeyPart {
    pub column: String,
    pub value: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    /// "ok"; "unavailable" (`reason` says why); "needsFullRowLogging" (the user may allow it for the read).
    pub status: &'static str,
    pub reason: String,
    /// The captured columns, in the order of the values in `before` and `after`.
    pub columns: Vec<String>,
    /// Columns the CDC API does not send (TEXT, BYTE, BLOB, CLOB, user types…), left out.
    pub skipped: Vec<String>,
    /// Changes of the row in commit order.
    pub events: Vec<Event>,
    pub range: Option<LogRange>,
    /// Why the history is not complete; empty when it is.
    pub partial: Vec<String>,
    /// What else the user should know (not gaps).
    pub notes: Vec<String>,
    /// The server's CDC reader stopped answering (a test needs to tell it from a partial history).
    #[serde(skip)]
    pub stalled: bool,
}

impl History {
    pub fn unavailable(reason: impl Into<String>) -> History {
        History { status: "unavailable", reason: reason.into(), ..Default::default() }
    }
}

/// The logical logs the history was read from.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRange {
    /// The oldest log still on disk, where the read started.
    pub first_log: i64,
    /// When that log filled up (Unix seconds); none when it is the current log.
    pub first_log_filled: Option<i64>,
    pub current_log: i64,
    /// Log position (uniqid:0xoffset) the read started from and the last one it reached.
    pub from_lsn: String,
    pub read_until: String,
    /// When the read was done (Unix seconds).
    pub read_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// Log position of the change (uniqid:0xoffset).
    pub lsn: String,
    /// Commit time of its transaction (Unix seconds).
    pub time: i64,
    pub tx: i64,
    pub uid: Option<i64>,
    /// The user name for `uid`, when a session of that user is connected now (Informix keeps no other list).
    pub user: Option<String>,
    /// "insert", "update", "delete" or "truncate".
    pub op: &'static str,
    /// The row before and after the change, one value per column of `columns` (None: NULL).
    pub before: Option<Vec<Option<String>>>,
    pub after: Option<Vec<Option<String>>>,
}

/// Why a connection cannot read the history at all (engine or protocol), or None when it may try.
pub fn unavailable(kind: DbKind, informix_mode: &str) -> Option<String> {
    let engine = match kind {
        DbKind::Informix => match informix_mode {
            "jdbc" => return None,
            "sqli" => return Some("No disponible por el Client SDK (ODBC): la API CDC de Informix se lee desde Celer solo con la conexión por JDBC. Cambia el protocolo de la conexión a JDBC.".into()),
            _ => return Some("No disponible por DRDA: la API CDC de Informix entrega los cambios como un objeto grande de sesión que solo ofrece el protocolo SQLI. Cambia el protocolo de la conexión a JDBC.".into()),
        },
        DbKind::Postgres => "PostgreSQL",
        DbKind::Mysql => "MySQL / MariaDB",
        DbKind::Mssql => "SQL Server",
        DbKind::Sqlite => "SQLite",
        DbKind::Odbc => "ODBC",
    };
    Some(format!("No disponible en {engine}: por ahora el historial de una fila se lee solo de los logs de Informix."))
}

// ───────────────────────────────────────────────────────────────── CDC records

const PACKET_SCHEME: u32 = 66;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Lsn(pub u32, pub u32);

impl std::fmt::Display for Lsn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:0x{:x}", self.0, self.1)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Insert,
    Delete,
    Before,
    After,
}

#[derive(Debug, Clone)]
pub enum Rec {
    Begin { lsn: Lsn, tx: i64, uid: i64 },
    Commit { lsn: Lsn, tx: i64, time: i64 },
    Rollback { tx: i64 },
    Change { kind: Change, lsn: Lsn, tx: i64, varlens: Vec<usize>, data: Vec<u8> },
    Discard { lsn: Lsn, tx: i64 },
    Truncate { lsn: Lsn, tx: i64 },
    Schema { fixed: usize, nfixed: usize, nvar: usize, cols: String },
    Timeout { lsn: Lsn },
    Error { code: i64, text: String },
    Other,
}

fn be32(b: &[u8], at: usize) -> Result<u32> {
    b.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(|| anyhow!("Registro CDC incompleto"))
}

fn be64(b: &[u8], at: usize) -> Result<i64> {
    Ok(((be32(b, at)? as u64) << 32 | be32(b, at + 4)? as u64) as i64)
}

fn lsn_at(b: &[u8], at: usize) -> Result<Lsn> {
    Ok(Lsn(be32(b, at)?, be32(b, at + 4)?))
}

/// The complete records at the start of `buf`, and how many bytes they took (a record cut at the end waits).
pub fn parse_records(buf: &[u8]) -> Result<(Vec<Rec>, usize)> {
    let mut out = Vec::new();
    let mut at = 0;
    while buf.len() - at >= 16 {
        let header = be32(buf, at)? as usize;
        let payload = be32(buf, at + 4)? as usize;
        if header < 16 {
            bail!("Registro CDC no válido (cabecera de {header} bytes)");
        }
        if be32(buf, at + 8)? != PACKET_SCHEME {
            bail!("Formato de registro CDC desconocido ({})", be32(buf, at + 8)?);
        }
        let Some(end) = at.checked_add(header).and_then(|e| e.checked_add(payload)) else { bail!("Registro CDC no válido") };
        if end > buf.len() {
            break;
        }
        let kind = be32(buf, at + 12)?;
        let h = &buf[at + 16..at + header];
        let p = &buf[at + header..end];
        out.push(match kind {
            // The start time (8 bytes at 12) is not used: a change is dated by its commit.
            1 => Rec::Begin { lsn: lsn_at(h, 0)?, tx: be32(h, 8)? as i32 as i64, uid: be32(h, 20)? as i32 as i64 },
            2 => Rec::Commit { lsn: lsn_at(h, 0)?, tx: be32(h, 8)? as i32 as i64, time: be64(h, 12)? },
            3 => Rec::Rollback { tx: be32(h, 8)? as i32 as i64 },
            40..=43 => {
                let kind = match kind {
                    40 => Change::Insert,
                    41 => Change::Delete,
                    42 => Change::Before,
                    _ => Change::After,
                };
                let varlens = h.get(20..).unwrap_or_default().as_chunks::<4>().0.iter().map(|c| u32::from_be_bytes(*c) as usize).collect();
                Rec::Change { kind, lsn: lsn_at(h, 0)?, tx: be32(h, 8)? as i32 as i64, varlens, data: p.to_vec() }
            }
            62 => Rec::Discard { lsn: lsn_at(h, 0)?, tx: be32(h, 8)? as i32 as i64 },
            119 => Rec::Truncate { lsn: lsn_at(h, 0)?, tx: be32(h, 8)? as i32 as i64 },
            200 => Rec::Schema {
                fixed: be32(h, 8)? as usize,
                nfixed: be32(h, 12)? as usize,
                nvar: be32(h, 16)? as usize,
                cols: String::from_utf8_lossy(p).trim_end_matches('\0').trim().to_string(),
            },
            201 => Rec::Timeout { lsn: lsn_at(h, 0)? },
            202 => Rec::Error { code: be32(h, 4)? as i32 as i64, text: String::from_utf8_lossy(p).trim_end_matches('\0').trim().to_string() },
            _ => Rec::Other,
        });
        at = end;
    }
    Ok((out, at))
}

// ───────────────────────────────────────────────────────────────── column types

const YEAR: u8 = 0;
const SECOND: u8 = 5;
const FRACTION: u8 = 6;

/// A DATETIME or INTERVAL qualifier: first and last field, digits of the first one, fraction digits.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Qualifier {
    start: u8,
    end: u8,
    lead: u8,
    frac: u8,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Ty {
    SmallInt,
    Int,
    Int8,
    BigInt,
    Float,
    SmallFloat,
    /// Fixed point with its scale, or floating (scale None).
    Decimal { precision: u8, scale: Option<u8> },
    Date,
    DateTime(Qualifier),
    Interval(Qualifier),
    Bool,
    Char(usize),
    VarChar,
    LVarChar,
}

fn field(name: &str) -> Option<u8> {
    Some(match name {
        "year" => 0,
        "month" => 1,
        "day" => 2,
        "hour" => 3,
        "minute" => 4,
        "second" => 5,
        "fraction" => 6,
        _ => return None,
    })
}

/// "name(1,2)" → ("name", [1, 2]).
fn with_args(s: &str) -> (&str, Vec<u32>) {
    match s.split_once('(') {
        Some((name, rest)) => (name.trim(), rest.trim_end_matches(')').split(',').filter_map(|a| a.trim().parse().ok()).collect()),
        None => (s.trim(), vec![]),
    }
}

/// "year to fraction(3)", "day(3) to second" (`interval`: the leading field may carry its digits).
fn qualifier(s: &str, interval: bool) -> Option<Qualifier> {
    let (from, to) = s.split_once(" to ")?;
    let (start_name, lead) = with_args(from);
    let (end_name, frac) = with_args(to);
    let start = field(start_name)?;
    let end = field(end_name)?;
    if end < start || start == FRACTION {
        return None;
    }
    let lead = match lead.first() {
        Some(&d) if interval && (1..=9).contains(&d) => d as u8,
        Some(_) => return None,
        None if start == YEAR => 4,
        None => 2,
    };
    let frac = if end == FRACTION { frac.first().copied().unwrap_or(3).clamp(1, 5) as u8 } else { 0 };
    Some(Qualifier { start, end, lead, frac })
}

/// A column type as the CDC table schema writes it ("decimal(12,3)", "datetime year to second"…).
pub fn parse_type(t: &str) -> Option<Ty> {
    let t = t.trim().to_lowercase();
    if let Some(q) = t.strip_prefix("datetime ") {
        return qualifier(q, false).map(Ty::DateTime);
    }
    if let Some(q) = t.strip_prefix("interval ") {
        return qualifier(q, true).map(Ty::Interval);
    }
    let (name, args) = with_args(&t);
    Some(match name {
        "smallint" => Ty::SmallInt,
        "integer" | "int" | "serial" => Ty::Int,
        "int8" | "serial8" => Ty::Int8,
        "bigint" | "bigserial" => Ty::BigInt,
        "float" | "double precision" => Ty::Float,
        "smallfloat" | "real" => Ty::SmallFloat,
        "date" => Ty::Date,
        "boolean" => Ty::Bool,
        "decimal" | "dec" | "numeric" => match args[..] {
            [] => Ty::Decimal { precision: 16, scale: None },
            [p] => Ty::Decimal { precision: p.min(32) as u8, scale: None },
            [p, s] if s <= p => Ty::Decimal { precision: p.min(32) as u8, scale: Some(s as u8) },
            _ => return None,
        },
        "money" => match args[..] {
            [] => Ty::Decimal { precision: 16, scale: Some(2) },
            [p] => Ty::Decimal { precision: p.min(32) as u8, scale: Some(2) },
            [p, s] if s <= p => Ty::Decimal { precision: p.min(32) as u8, scale: Some(s as u8) },
            _ => return None,
        },
        "char" | "nchar" | "character" => Ty::Char(args.first().copied().unwrap_or(1) as usize),
        "varchar" | "nvarchar" | "character varying" => Ty::VarChar,
        "lvarchar" => Ty::LVarChar,
        _ => return None,
    })
}

impl Qualifier {
    /// Digits of the whole part as stored (up to SECOND or the last field) and, separately, of the fraction.
    fn stored_digits(&self) -> (usize, usize) {
        let last = self.end.min(SECOND);
        (self.lead as usize + 2 * (last - self.start) as usize, self.frac as usize)
    }
    /// Digits of the whole part as the decimal point sees it: a DATETIME/INTERVAL value is always aligned on SECOND.
    fn aligned_digits(&self) -> usize {
        self.lead as usize + 2 * (SECOND - self.start) as usize
    }
}

/// Bytes of a packed decimal with this many whole and fraction digits.
fn packed_size(whole: usize, frac: usize) -> usize {
    whole.div_ceil(2) + frac.div_ceil(2) + 1
}

impl Ty {
    /// Bytes of a fixed-length value in a CDC record; None for the variable-length ones.
    pub fn size(&self) -> Option<usize> {
        Some(match self {
            Ty::SmallInt => 2,
            Ty::Int | Ty::Date | Ty::SmallFloat => 4,
            Ty::BigInt | Ty::Float => 8,
            Ty::Int8 => 10,
            Ty::Bool => 2,
            Ty::Char(n) => *n,
            Ty::Decimal { precision, scale: Some(s) } => packed_size((precision - s) as usize, *s as usize),
            Ty::Decimal { precision, scale: None } => (*precision as usize + 4) / 2,
            Ty::DateTime(q) | Ty::Interval(q) => {
                let (whole, frac) = q.stored_digits();
                packed_size(whole, frac)
            }
            Ty::VarChar | Ty::LVarChar => return None,
        })
    }

    fn numeric(&self) -> bool {
        matches!(self, Ty::SmallInt | Ty::Int | Ty::Int8 | Ty::BigInt | Ty::Float | Ty::SmallFloat | Ty::Decimal { .. })
    }
}

/// Columns the CDC API sends, by their `syscolumns` type: built-in scalar types; TEXT, BYTE, BLOB, CLOB, collections
/// and user types are left out.
pub fn capturable(coltype: i64, extended_id: i64) -> bool {
    match coltype & 0xFF {
        0..=8 | 10 | 13..=18 | 52 | 53 => true,
        // LVARCHAR and BOOLEAN are built-in "user" types: extended ids 1 and 5.
        40 => extended_id == 1,
        41 => extended_id == 5,
        43 | 45 => true,
        _ => false,
    }
}

/// Splits the CDC schema text ("id integer, d decimal(12,3), …") into name and type.
pub fn parse_schema(cols: &str) -> Result<Vec<(String, Ty)>> {
    let mut out = Vec::new();
    let mut depth = 0;
    let mut item = String::new();
    let mut items = Vec::new();
    for ch in cols.chars() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                items.push(std::mem::take(&mut item));
                continue;
            }
            _ => {}
        }
        item.push(ch);
    }
    if !item.trim().is_empty() {
        items.push(item);
    }
    for it in items {
        let it = it.trim();
        let (name, ty) = it.split_once(char::is_whitespace).ok_or_else(|| anyhow!("Columna sin tipo en el esquema CDC: {it}"))?;
        let parsed = parse_type(ty).ok_or_else(|| anyhow!("Celer no sabe leer el tipo «{}» de la columna {name}", ty.trim()))?;
        out.push((name.trim().to_string(), parsed));
    }
    Ok(out)
}

// ───────────────────────────────────────────────────────────────── values

/// How the database stores text (its DB_LOCALE code set).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Codeset {
    Utf8,
    Latin1,
    Windows1252,
    /// Another code set: text that is not plain ASCII is shown as bytes, not guessed.
    Other,
}

impl Codeset {
    /// From `sysdbslocale.dbs_collate` ("en_US.819", "es_ES.57372", "en_US.utf8"…).
    pub fn from_locale(locale: &str) -> Codeset {
        match locale.trim().rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
            "57372" | "utf8" | "utf-8" => Codeset::Utf8,
            "819" | "8859-1" | "iso8859-1" => Codeset::Latin1,
            "1252" | "cp1252" => Codeset::Windows1252,
            _ => Codeset::Other,
        }
    }

    fn text(&self, b: &[u8]) -> String {
        if b.is_ascii() {
            return String::from_utf8_lossy(b).into_owned();
        }
        const CP1252: [char; 32] = [
            '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
        ];
        match self {
            Codeset::Utf8 => String::from_utf8_lossy(b).into_owned(),
            Codeset::Latin1 => b.iter().map(|&c| c as char).collect(),
            Codeset::Windows1252 => b.iter().map(|&c| if (0x80..0xA0).contains(&c) { CP1252[(c - 0x80) as usize] } else { c as char }).collect(),
            Codeset::Other => format!("0x{}", b.iter().map(|c| format!("{c:02X}")).collect::<String>()),
        }
    }
}

/// An Informix packed decimal: sign, whole digits (no leading zeros) and fraction digits. None: NULL.
struct Packed {
    negative: bool,
    whole: String,
    frac: String,
}

fn packed(b: &[u8]) -> Result<Option<Packed>> {
    let Some(&first) = b.first() else { bail!("Decimal vacío") };
    if first == 0 {
        return Ok(None);
    }
    let negative = first & 0x80 == 0;
    let exp = (if negative { !first } else { first } & 0x7F) as i32 - 64;
    let mut pairs: Vec<u8> = b[1..].to_vec();
    if negative {
        // 100's complement of the digits: the last non-zero pair from 100, the ones before it from 99.
        if let Some(last) = pairs.iter().rposition(|&d| d != 0) {
            for (i, d) in pairs.iter_mut().enumerate().take(last + 1) {
                *d = if i == last { 100 - *d } else { 99 - *d };
            }
        }
    }
    if pairs.iter().any(|&d| d > 99) {
        bail!("Decimal no válido en el registro CDC");
    }
    let digit = |i: i32| if i >= 0 && (i as usize) < pairs.len() { pairs[i as usize] } else { 0 };
    let mut whole = String::new();
    for i in 0..exp.max(0) {
        whole.push_str(&format!("{:02}", digit(i)));
    }
    let mut frac = String::new();
    for i in exp.min(0)..0 {
        let _ = i;
        frac.push_str("00");
    }
    for i in exp.max(0)..pairs.len() as i32 {
        frac.push_str(&format!("{:02}", digit(i)));
    }
    let whole = whole.trim_start_matches('0').to_string();
    Ok(Some(Packed { negative, whole, frac }))
}

fn decimal_text(p: Packed, scale: Option<u8>) -> String {
    let mut frac = p.frac;
    match scale {
        Some(s) => {
            frac.truncate(s as usize);
            while frac.len() < s as usize {
                frac.push('0');
            }
        }
        None => frac = frac.trim_end_matches('0').to_string(),
    }
    let zero = p.whole.is_empty() && frac.chars().all(|c| c == '0');
    let mut out = String::new();
    if p.negative && !zero {
        out.push('-');
    }
    out.push_str(if p.whole.is_empty() { "0" } else { &p.whole });
    if !frac.is_empty() {
        out.push('.');
        out.push_str(&frac);
    }
    out
}

/// DATETIME and INTERVAL: the packed value is aligned on SECOND; its digits are cut into the qualifier's fields.
fn temporal_text(p: Packed, q: &Qualifier, interval: bool) -> Result<String> {
    let width = q.aligned_digits();
    if p.whole.len() > width {
        bail!("Valor de fecha u hora fuera de su calificador");
    }
    let whole = format!("{:0>width$}", p.whole);
    let mut fields = Vec::new();
    let mut at = 0;
    for f in q.start..=SECOND {
        let n = if f == q.start { q.lead as usize } else { 2 };
        fields.push((f, &whole[at..at + n]));
        at += n;
    }
    let mut out = String::new();
    if interval && p.negative {
        out.push('-');
    }
    for (f, digits) in fields.into_iter().filter(|(f, _)| *f <= q.end) {
        if f != q.start {
            out.push(match f {
                1 | 2 => '-',
                3 => ' ',
                _ => ':',
            });
        }
        // An interval's leading field shows its number, not its padding.
        if interval && f == q.start {
            let trimmed = digits.trim_start_matches('0');
            out.push_str(if trimmed.is_empty() { "0" } else { trimmed });
        } else {
            out.push_str(digits);
        }
    }
    if q.end == FRACTION {
        let mut frac = p.frac;
        frac.truncate(q.frac as usize);
        while frac.len() < q.frac as usize {
            frac.push('0');
        }
        out.push('.');
        out.push_str(&frac);
    }
    Ok(out)
}

/// Days since 1899-12-31 as yyyy-mm-dd.
fn date_text(days: i32) -> String {
    let base = chrono::NaiveDate::from_ymd_opt(1899, 12, 31).expect("valid date");
    match base.checked_add_signed(chrono::Duration::days(days as i64)) {
        Some(d) => d.format("%Y-%m-%d").to_string(),
        None => format!("{days} días desde 1899-12-31"),
    }
}

/// One fixed-length value (None: NULL).
fn fixed_value(ty: &Ty, b: &[u8], cs: Codeset) -> Result<Option<String>> {
    Ok(match ty {
        Ty::SmallInt => Some(i16::from_be_bytes([b[0], b[1]])).filter(|v| *v != i16::MIN).map(|v| v.to_string()),
        Ty::Int => Some(i32::from_be_bytes([b[0], b[1], b[2], b[3]])).filter(|v| *v != i32::MIN).map(|v| v.to_string()),
        Ty::Date => Some(i32::from_be_bytes([b[0], b[1], b[2], b[3]])).filter(|v| *v != i32::MIN).map(date_text),
        Ty::BigInt => Some(be64(b, 0)?).filter(|v| *v != i64::MIN).map(|v| v.to_string()),
        Ty::Int8 => {
            let sign = i16::from_be_bytes([b[0], b[1]]);
            if sign == 0 {
                None
            } else {
                let magnitude = ((be32(b, 6)? as u64) << 32) | be32(b, 2)? as u64;
                Some(if sign < 0 { format!("-{magnitude}") } else { magnitude.to_string() })
            }
        }
        Ty::Float => {
            if b[..8].iter().all(|&x| x == 0xFF) {
                None
            } else {
                Some(f64::from_be_bytes(b[..8].try_into()?).to_string())
            }
        }
        Ty::SmallFloat => {
            if b[..4].iter().all(|&x| x == 0xFF) {
                None
            } else {
                Some(f32::from_be_bytes(b[..4].try_into()?).to_string())
            }
        }
        Ty::Bool => (b[0] == 0).then(|| if b[1] != 0 { "true" } else { "false" }.to_string()),
        Ty::Char(_) => (b.first() != Some(&0)).then(|| cs.text(b).trim_end_matches(' ').to_string()),
        Ty::Decimal { scale, .. } => packed(b)?.map(|p| decimal_text(p, *scale)),
        Ty::DateTime(q) => packed(b)?.map(|p| temporal_text(p, q, false)).transpose()?,
        Ty::Interval(q) => packed(b)?.map(|p| temporal_text(p, q, true)).transpose()?,
        Ty::VarChar | Ty::LVarChar => bail!("Columna de longitud variable leída como fija"),
    })
}

/// The table as the CDC session describes it: the columns and where each value is in a record.
#[derive(Debug, Clone)]
pub struct Layout {
    pub cols: Vec<(String, Ty)>,
    pub codeset: Codeset,
}

impl Layout {
    /// Checks the server's sizes against Celer's reading of each type: a mismatch means Celer cannot read the table.
    pub fn new(cols: Vec<(String, Ty)>, fixed: usize, nfixed: usize, nvar: usize, codeset: Codeset) -> Result<Layout> {
        let sizes: Vec<Option<usize>> = cols.iter().map(|(_, t)| t.size()).collect();
        let ours: usize = sizes.iter().flatten().sum();
        let (f, v) = (sizes.iter().filter(|s| s.is_some()).count(), sizes.iter().filter(|s| s.is_none()).count());
        if ours != fixed || f != nfixed || v != nvar {
            bail!("el formato de las columnas no es el que Celer sabe leer ({ours} bytes fijos en {f} columnas y {v} variables; el servidor dice {fixed}, {nfixed} y {nvar})");
        }
        Ok(Layout { cols, codeset })
    }

    /// The values of a record: the fixed-length columns come first in the schema, then the variable ones.
    pub fn row(&self, varlens: &[usize], data: &[u8]) -> Result<Vec<Option<String>>> {
        let mut out = Vec::with_capacity(self.cols.len());
        let mut at = 0;
        let mut var = varlens.iter();
        for (name, ty) in &self.cols {
            let n = match ty.size() {
                Some(n) => n,
                None => *var.next().ok_or_else(|| anyhow!("Falta la longitud de la columna {name} en el registro CDC"))?,
            };
            let b = data.get(at..at + n).ok_or_else(|| anyhow!("Registro CDC más corto que la fila (columna {name})"))?;
            at += n;
            out.push(match ty {
                Ty::VarChar => {
                    // One length byte and the text; NULL is length 1 with a single zero byte.
                    if b == [1, 0] {
                        None
                    } else {
                        let len = *b.first().ok_or_else(|| anyhow!("VARCHAR vacío en el registro CDC"))? as usize;
                        if len + 1 != n {
                            bail!("Longitud de VARCHAR no válida en el registro CDC (columna {name})");
                        }
                        Some(self.codeset.text(&b[1..]))
                    }
                }
                Ty::LVarChar => {
                    // Two bytes with the length plus one, a null flag, then the text.
                    if n < 3 {
                        bail!("LVARCHAR no válido en el registro CDC (columna {name})");
                    }
                    if b[2] == 1 {
                        None
                    } else {
                        Some(self.codeset.text(&b[3..]))
                    }
                }
                _ => fixed_value(ty, b, self.codeset)?,
            });
        }
        if at != data.len() {
            bail!("El registro CDC tiene {} bytes y la fila {at}", data.len());
        }
        Ok(out)
    }
}

/// The grid's value and the logged one are the same key value (numbers compare by value, CHAR without its padding).
pub fn same_value(ty: &Ty, logged: &str, shown: &str) -> bool {
    let (a, b) = (logged.trim_end_matches(' '), shown.trim_end_matches(' '));
    if a == b {
        return true;
    }
    if matches!(ty, Ty::Float | Ty::SmallFloat) {
        return matches!((a.trim().parse::<f64>(), b.trim().parse::<f64>()), (Ok(x), Ok(y)) if x == y);
    }
    if ty.numeric() {
        return normal_number(a) == normal_number(b) && normal_number(a).is_some();
    }
    false
}

/// A logged value and the one the table holds now are the same (the grid's and the log's spellings of dates, booleans
/// and numbers differ in trailing zeros and separators, not in value).
fn same_now(ty: &Ty, logged: Option<&str>, now: &Cell) -> bool {
    let shown = match now {
        Cell::Null => return logged.is_none(),
        Cell::Bool(b) => b.to_string(),
        other => text(other),
    };
    let Some(logged) = logged else { return false };
    if same_value(ty, logged, &shown) {
        return true;
    }
    match ty {
        Ty::Bool => matches!((logged, shown.as_str()), ("true", "t" | "1") | ("false", "f" | "0")),
        Ty::DateTime(_) | Ty::Interval(_) | Ty::Date => {
            let digits = |v: &str| v.chars().filter(|c| c.is_ascii_digit()).collect::<String>().trim_end_matches('0').to_string();
            digits(logged) == digits(&shown)
        }
        _ => false,
    }
}

/// "+001.500" → "1.5", "-0" → "0": the same number written the same way, or None if it is not a plain number.
fn normal_number(s: &str) -> Option<String> {
    let s = s.trim();
    let (negative, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let (whole, frac) = digits.split_once('.').unwrap_or((digits, ""));
    if whole.is_empty() && frac.is_empty() || !whole.chars().chain(frac.chars()).all(|c| c.is_ascii_digit()) {
        return None;
    }
    let whole = whole.trim_start_matches('0');
    let frac = frac.trim_end_matches('0');
    let body = format!("{}{}{}", if whole.is_empty() { "0" } else { whole }, if frac.is_empty() { "" } else { "." }, frac);
    Some(if negative && body != "0" { format!("-{body}") } else { body })
}

// ───────────────────────────────────────────────────────────────── the history of one row

struct Item {
    lsn: Lsn,
    op: &'static str,
    before: Option<Vec<Option<String>>>,
    after: Option<Vec<Option<String>>>,
    /// An update that gave the row this key: its old key.
    moved_from: Option<String>,
}

#[derive(Default)]
struct Tx {
    uid: Option<i64>,
    /// The before image of an update, until its after image comes.
    before: Option<Vec<Option<String>>>,
    items: Vec<Item>,
}

/// Turns the CDC records of the table into the changes of one row.
pub struct Builder {
    layout: Option<Layout>,
    codeset: Codeset,
    key: Vec<(String, String)>,
    key_idx: Vec<usize>,
    /// When the table's partition was created: older records are of a dropped table that had the same partnum.
    created: i64,
    users: HashMap<i64, String>,
    txs: HashMap<i64, Tx>,
    pub events: Vec<Event>,
    errors: Vec<String>,
    older_than_table: usize,
    key_moved_in: Option<String>,
    missing_before: usize,
    /// The furthest log position seen (records and timeouts).
    pub last: Lsn,
    /// A timeout came: no record of the table for a while. Only "caught up" once `last` reaches the end of the log
    /// as it was when the read began: the server may still be scanning older logs.
    pub caught_up: bool,
    /// The server sent an error: the session cannot go on (its code).
    pub failed: Option<i64>,
    /// A transaction committed after the table was created has been read: the log is past the creation.
    pub after_creation: bool,
}

pub const MAX_EVENTS: usize = 10_000;

impl Builder {
    pub fn new(key: Vec<(String, String)>, created: i64, users: HashMap<i64, String>, codeset: Codeset) -> Builder {
        Builder {
            layout: None,
            codeset,
            key,
            key_idx: vec![],
            created,
            users,
            txs: HashMap::new(),
            events: vec![],
            errors: vec![],
            older_than_table: 0,
            key_moved_in: None,
            missing_before: 0,
            last: Lsn::default(),
            caught_up: false,
            failed: None,
            after_creation: false,
        }
    }

    /// The session failed: its error, taken back from the history's own list (the read goes on in a new session).
    pub fn take_error(&mut self) -> String {
        self.failed = None;
        self.errors.pop().unwrap_or_default()
    }

    pub fn columns(&self) -> Vec<String> {
        self.layout.as_ref().map(|l| l.cols.iter().map(|(n, _)| n.clone()).collect()).unwrap_or_default()
    }

    fn matches(&self, row: &[Option<String>]) -> bool {
        let Some(layout) = &self.layout else { return false };
        self.key_idx.iter().zip(&self.key).all(|(&i, (_, want))| row.get(i).cloned().flatten().is_some_and(|v| same_value(&layout.cols[i].1, &v, want)))
    }

    fn key_text(&self, row: &[Option<String>]) -> String {
        self.key_idx.iter().map(|&i| row.get(i).cloned().flatten().unwrap_or_else(|| "NULL".into())).collect::<Vec<_>>().join(", ")
    }

    pub fn feed(&mut self, rec: Rec) -> Result<()> {
        match rec {
            Rec::Schema { fixed, nfixed, nvar, cols } => {
                let layout = Layout::new(parse_schema(&cols)?, fixed, nfixed, nvar, self.codeset)?;
                let mut idx = Vec::new();
                for (name, _) in &self.key {
                    let i = layout.cols.iter().position(|(c, _)| c.eq_ignore_ascii_case(name)).ok_or_else(|| anyhow!("La columna de clave {name} no está en la captura"))?;
                    idx.push(i);
                }
                self.key_idx = idx;
                self.layout = Some(layout);
            }
            Rec::Begin { lsn, tx, uid, .. } => {
                self.last = lsn;
                self.txs.insert(tx, Tx { uid: Some(uid), ..Default::default() });
            }
            Rec::Change { kind, lsn, tx, varlens, data } => {
                self.last = lsn;
                let layout = self.layout.as_ref().ok_or_else(|| anyhow!("Cambio recibido antes del esquema de la tabla"))?;
                let row = layout.row(&varlens, &data)?;
                let hit = self.matches(&row);
                let item = match kind {
                    Change::Before => {
                        self.txs.entry(tx).or_default().before = Some(row);
                        None
                    }
                    Change::Insert => hit.then_some(Item { lsn, op: "insert", before: None, after: Some(row), moved_from: None }),
                    Change::Delete => hit.then_some(Item { lsn, op: "delete", before: Some(row), after: None, moved_from: None }),
                    Change::After => {
                        let before = self.txs.entry(tx).or_default().before.take();
                        let before_hit = before.as_ref().is_some_and(|b| self.matches(b));
                        if hit || before_hit {
                            if before.is_none() {
                                self.missing_before += 1;
                            }
                            // The key changed into this row's: what came before is under the old key.
                            let moved_from = before.as_ref().filter(|_| hit && !before_hit).map(|b| self.key_text(b));
                            Some(Item { lsn, op: "update", before, after: Some(row), moved_from })
                        } else {
                            None
                        }
                    }
                };
                if let Some(item) = item {
                    self.txs.entry(tx).or_default().items.push(item);
                }
            }
            Rec::Truncate { lsn, tx } => {
                self.last = lsn;
                self.txs.entry(tx).or_default().items.push(Item { lsn, op: "truncate", before: None, after: None, moved_from: None });
            }
            Rec::Discard { lsn, tx } => {
                if let Some(t) = self.txs.get_mut(&tx) {
                    t.items.retain(|i| i.lsn < lsn);
                }
            }
            Rec::Rollback { tx } => {
                self.txs.remove(&tx);
            }
            Rec::Commit { lsn, tx, time } => {
                self.last = lsn;
                if time > self.created {
                    self.after_creation = true;
                }
                if let Some(t) = self.txs.remove(&tx) {
                    for item in t.items {
                        if time < self.created {
                            self.older_than_table += 1;
                            continue;
                        }
                        if let Some(old) = item.moved_from {
                            self.key_moved_in = Some(old);
                        }
                        if self.events.len() < MAX_EVENTS {
                            self.events.push(Event {
                                lsn: item.lsn.to_string(),
                                time,
                                tx,
                                uid: t.uid,
                                user: t.uid.and_then(|u| self.users.get(&u).cloned()),
                                op: item.op,
                                before: item.before,
                                after: item.after,
                            });
                        }
                    }
                }
            }
            Rec::Timeout { lsn } => {
                if lsn > self.last {
                    self.last = lsn;
                }
                self.caught_up = true;
            }
            Rec::Error { code, text } => {
                self.errors.push(if text.is_empty() { format!("error {code}") } else { format!("{text} ({code})") });
                self.failed = Some(code);
            }
            Rec::Other => {}
        }
        Ok(())
    }

    /// The row as the table holds it now (None: no such row) against the end of the history. Some changes never reach
    /// the CDC session: with full row logging off when they were made, the server logs an update of a table with only
    /// fixed-length columns as a partial record, which it does not send. The last change read must leave the row as it
    /// is now; if not, the history misses changes. Returns what differs, in words.
    pub fn disagrees_with(&self, now: Option<&[Cell]>) -> Option<String> {
        let layout = self.layout.as_ref()?;
        let last = self.events.last();
        let expected = last.and_then(|e| e.after.as_ref());
        match (expected, now) {
            (None, None) => None,
            (None, Some(_)) if last.is_none() => None, // "no changes at all" has its own message
            (None, Some(_)) => Some("la fila existe hoy, pero el último cambio leído fue un borrado".into()),
            (Some(_), None) => Some("la fila ya no existe, pero el último cambio leído no la borra".into()),
            (Some(after), Some(now)) => {
                let diff: Vec<&str> = layout
                    .cols
                    .iter()
                    .zip(after.iter().zip(now))
                    .filter(|(c, (a, n))| !same_now(&c.1, a.as_deref(), n))
                    .map(|(c, _)| c.0.as_str())
                    .collect();
                (!diff.is_empty()).then(|| format!("el último valor leído de {} no es el que tiene la fila hoy", diff.join(", ")))
            }
        }
    }

    /// The history: the changes and every reason it may not be complete.
    pub fn finish(self, first_log: i64, stopped: Option<String>, gaps: Vec<String>) -> History {
        let mut h = History { status: "ok", columns: self.columns(), ..Default::default() };
        // A read that did not reach the end of the log says nothing about the row: no change seen is not "no change".
        let cut_short = stopped.is_some() || !gaps.is_empty();
        h.partial.extend(gaps);
        if let Some(why) = stopped {
            h.partial.push(why);
        }
        for e in &self.errors {
            h.partial.push(format!("El servidor avisó de un error durante la lectura: {e}"));
        }
        if self.events.len() >= MAX_EVENTS {
            h.partial.push(format!("Hay más de {MAX_EVENTS} cambios de la fila: se muestran los {MAX_EVENTS} primeros."));
        }
        match self.events.first().filter(|_| self.key_moved_in.is_none()) {
            None if self.key_moved_in.is_some() || cut_short => {}
            None => h.partial.push(format!(
                "No hay cambios de esta fila en los logs que quedan en disco (desde el log {first_log}): ya tenía sus valores actuales antes de ese log, y lo anterior no se puede saber."
            )),
            Some(e) if e.op != "insert" => h.partial.push(format!(
                "La fila ya existía antes del log {first_log}, el más antiguo que queda en disco: sus valores y cambios anteriores no se pueden saber."
            )),
            _ => {}
        }
        if let Some(old) = &self.key_moved_in {
            h.partial.push(format!("La clave primaria de la fila cambió (antes era {old}): los cambios anteriores a ese cambio están bajo la clave antigua y no se muestran."));
        }
        if self.missing_before > 0 {
            h.partial.push(format!("{} cambios llegaron sin la imagen anterior de la fila: su «antes» no se muestra.", self.missing_before));
        }
        let open: usize = self.txs.values().map(|t| t.items.len()).sum();
        if open > 0 {
            h.notes.push(format!("{open} cambios de transacciones que aún no han hecho commit no se muestran."));
        }
        if self.older_than_table > 0 {
            h.notes.push(format!(
                "Se descartaron {} cambios anteriores a la creación de esta tabla: eran de una tabla borrada que tenía el mismo número de partición.",
                self.older_than_table
            ));
        }
        h.events = self.events;
        h
    }
}

// ───────────────────────────────────────────────────────────────── the read

/// How long a read may take before it stops and says the history is partial.
const MAX_READ: Duration = Duration::from_secs(120);
/// How long a read of the CDC session may get no answer at all (it sends a timeout record every two seconds when it
/// has nothing): past it the server's reader is stuck, and the history says so instead of waiting for it.
const STALL: Duration = Duration::from_secs(30);
/// Bit of `sysptnhdr.flags` set while full row logging is on (measured: `cdc_set_fullrowlogging` sets it).
const FULL_ROW_LOGGING: i64 = 0x0400_0000;
/// Bit of `systables.flags` of a RAW (unlogged) table.
const RAW_TABLE: i64 = 0x10;

fn int(c: &Cell) -> Option<i64> {
    match c {
        Cell::Int(v) => Some(*v),
        Cell::Num(v) => Some(*v as i64),
        Cell::Text(s) => s.trim().parse().ok(),
        Cell::Bool(b) => Some(*b as i64),
        Cell::Null => None,
    }
}

fn text(c: &Cell) -> String {
    match c {
        Cell::Text(s) => s.trim().to_string(),
        Cell::Int(v) => v.to_string(),
        Cell::Num(v) => v.to_string(),
        Cell::Bool(b) => b.to_string(),
        Cell::Null => String::new(),
    }
}

fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Informix's name for a database, owner or table in a CDC call ("db:owner.table"): as the catalog has it.
fn ident(s: &str) -> Result<&str> {
    let s = s.trim();
    if s.is_empty() || !s.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$') {
        bail!("Nombre no admitido por la API CDC: «{s}»");
    }
    Ok(s)
}

/// What a CDC routine's negative answer means.
fn cdc_error(code: i64) -> String {
    let what = match code {
        -83701 => "no existe la base de datos syscdcv1",
        -83703 => "no existe la base de datos",
        -83704 => "la base de datos no tiene log",
        -83705 => "no existe la tabla",
        -83706 => "la tabla no admite captura (temporal, vista, sin log o sin full row logging)",
        -83707 => "no existe una de las columnas",
        -83713 => "los datos de esa posición del log ya no están disponibles",
        -83715 => "ya hay una sesión CDC activa",
        _ => "error de la API CDC",
    };
    format!("{what} ({code})")
}

/// The single number an EXECUTE FUNCTION returns.
fn call(conn: &JdbcConn, sql: &str) -> Result<i64> {
    let rows = conn.query_within(sql, STALL)?;
    rows.first().and_then(|r| r.first()).and_then(int).ok_or_else(|| anyhow!("La función no devolvió un número: {sql}"))
}

fn privilege_error(e: &anyhow::Error) -> bool {
    e.downcast_ref::<JdbcError>().is_some_and(|j| matches!(j.code, -674 | -387 | -272))
}

/// Opens its own Informix connection over JDBC (in the row's database) and reads the history. `stop`: the user
/// closed the window; the read ends between two reads of the CDC session.
/// `dir`: where Celer keeps the note of the tables it turned full row logging on for (see `ledger_add`).
pub fn read(mut cfg: ConnConfig, rt: crate::jdbc::Runtime, req: Request, stop: &AtomicBool, dir: Option<&Path>) -> Result<History> {
    cfg.database = req.database.trim().to_string();
    let read_only = cfg.read_only;
    let user = cfg.user.clone();
    let connect = || JdbcConn::connect(&cfg, rt.clone(), crate::jdbc::informix_params).map_err(crate::jdbc::explain);
    let conn = connect()?;
    let ledger = dir.map(|d| d.join(LEDGER));
    run(&conn, &req, read_only, &user, stop, &Env { ledger: ledger.as_deref(), fresh: &connect })
}

/// What a read needs besides its connection.
pub struct Env<'a> {
    /// The file noting the tables Celer turned full row logging on for.
    pub ledger: Option<&'a Path>,
    /// Another connection like the first, for when that one is stuck behind a read the server never answered.
    pub fresh: &'a dyn Fn() -> Result<JdbcConn>,
}

impl Env<'_> {
    fn fresh(&self) -> Result<JdbcConn> {
        (self.fresh)()
    }
}

const LEDGER: &str = "informix-full-row-logging.txt";

/// Celer turns full row logging on for a read and off after it. If it dies in between, the server keeps the change:
/// each table it turns on is noted here first, and removed once it is off again. A later read of a table that is
/// still on and still noted turns it off after reading, and says so.
fn ledger_has(path: Option<&Path>, key: &str) -> bool {
    path.and_then(|p| std::fs::read_to_string(p).ok()).is_some_and(|t| t.lines().any(|l| l == key))
}

fn ledger_add(path: Option<&Path>, key: &str) {
    let Some(p) = path else { return };
    if !ledger_has(path, key) {
        use std::io::Write;
        let _ = std::fs::OpenOptions::new().create(true).append(true).open(p).and_then(|mut f| writeln!(f, "{key}"));
    }
}

fn ledger_forget(path: Option<&Path>, key: &str) {
    let Some(p) = path else { return };
    if let Ok(t) = std::fs::read_to_string(p) {
        let kept: Vec<&str> = t.lines().filter(|l| *l != key).collect();
        let _ = if kept.is_empty() { std::fs::remove_file(p) } else { std::fs::write(p, kept.join("\n") + "\n") };
    }
}

pub fn run(conn: &JdbcConn, req: &Request, read_only: bool, user: &str, stop: &AtomicBool, env: &Env) -> Result<History> {
    let db = ident(&req.database)?;
    let table = ident(&req.table)?;
    if req.key.is_empty() {
        return Ok(History::unavailable("la tabla no tiene clave primaria: sin ella no se puede seguir una fila en el log."));
    }
    let q = |sql: &str| conn.query_all(sql);

    // The database keeps a log of its changes.
    let dbs = q(&format!("SELECT is_logging FROM sysmaster:sysdatabases WHERE name = {}", lit(db)))?;
    let Some(row) = dbs.first() else { return Ok(History::unavailable(format!("no se encuentra la base de datos «{db}»."))) };
    if row.first().and_then(int) != Some(1) {
        return Ok(History::unavailable(format!(
            "la base de datos «{db}» no tiene log de transacciones (se creó sin WITH LOG): Informix no guarda sus cambios en el log lógico."
        )));
    }

    // The table, logged, and its owner.
    let owner_cond = if req.owner.trim().is_empty() { String::new() } else { format!(" AND owner = {}", lit(req.owner.trim())) };
    let tabs = q(&format!("SELECT tabid, partnum, flags, tabtype, owner FROM {db}:systables WHERE tabname = {}{owner_cond}", lit(table)))?;
    let Some(t) = tabs.first() else { return Ok(History::unavailable(format!("no se encuentra la tabla «{table}» en «{db}»."))) };
    let (tabid, partnum, flags) = (t.first().and_then(int).unwrap_or(0), t.get(1).and_then(int).unwrap_or(0), t.get(2).and_then(int).unwrap_or(0));
    if t.get(3).map(text).as_deref() != Some("T") {
        return Ok(History::unavailable(format!("«{table}» no es una tabla (es una vista, un sinónimo o una secuencia).")));
    }
    if flags & RAW_TABLE != 0 {
        return Ok(History::unavailable(format!("«{table}» es una tabla RAW: Informix no registra sus cambios en el log.")));
    }
    let owner = t.get(4).map(text).unwrap_or_default();
    let owner = ident(&owner)?.to_string();
    let full_name = format!("{db}:{owner}.{table}");

    // The columns the CDC API can send, the key among them.
    let cols = q(&format!("SELECT colname, coltype, extended_id FROM {db}:syscolumns WHERE tabid = {tabid} ORDER BY colno"))?;
    let (mut captured, mut skipped) = (Vec::new(), Vec::new());
    for c in &cols {
        let name = c.first().map(text).unwrap_or_default();
        if capturable(c.get(1).and_then(int).unwrap_or(-1), c.get(2).and_then(int).unwrap_or(0)) {
            captured.push(name);
        } else {
            skipped.push(name);
        }
    }
    for k in &req.key {
        if !captured.iter().any(|c| c.eq_ignore_ascii_case(&k.column)) {
            return Ok(History::unavailable(format!("la columna de clave «{}» es de un tipo que la API CDC no envía.", k.column)));
        }
    }
    for c in &captured {
        ident(c)?;
    }

    // The table's partitions: full row logging on all of them, when they were created, in-place alters.
    let mut parts = vec![partnum];
    if partnum == 0 {
        parts = q(&format!("SELECT partn FROM {db}:sysfragments WHERE tabid = {tabid} AND fragtype = 'T'"))?.iter().filter_map(|r| r.first().and_then(int)).collect();
    }
    if parts.is_empty() {
        return Ok(History::unavailable(format!("no se encuentran las particiones de «{table}».")));
    }
    let list = parts.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", ");
    let hdrs = q(&format!("SELECT flags, created, pta_newvers FROM sysmaster:sysptnhdr WHERE partnum IN ({list})"))?;
    let frl_on = !hdrs.is_empty() && hdrs.iter().all(|r| r.first().and_then(int).is_some_and(|f| f & FULL_ROW_LOGGING != 0));
    let created = hdrs.iter().filter_map(|r| r.get(1).and_then(int)).max().unwrap_or(0);
    let altered = hdrs.iter().any(|r| r.get(2).and_then(int).unwrap_or(0) > 0);

    // The CDC API.
    let cdc = q("SELECT COUNT(*) FROM sysmaster:sysdatabases WHERE name = 'syscdcv1'")?;
    if cdc.first().and_then(|r| r.first()).and_then(int).unwrap_or(0) == 0 {
        return Ok(History::unavailable(
            "el servidor no tiene la base de datos syscdcv1 de la API CDC. Un administrador la crea una vez con: dbaccess - $INFORMIXDIR/etc/syscdcv1.sql",
        ));
    }
    let server = q("SELECT DBSERVERNAME FROM systables WHERE tabid = 1")?.first().and_then(|r| r.first()).map(text).unwrap_or_default();
    let ledger_key = format!("{server}\t{full_name}");
    let left_over = frl_on && ledger_has(env.ledger, &ledger_key);
    if !frl_on && read_only {
        return Ok(History::unavailable("la conexión es de solo lectura y la tabla necesita full row logging, que es un cambio en el servidor."));
    }
    if !frl_on {
        // Before offering to change the server: can this user use the API at all? (opening a session changes nothing)
        match call(conn, &format!("EXECUTE FUNCTION syscdcv1:informix.cdc_opensess({}, 0, 2, 50, 1, 1)", lit(&server))) {
            Ok(id) if id > 0 => {
                let _ = call(conn, &format!("EXECUTE FUNCTION syscdcv1:informix.cdc_closesess({id})"));
            }
            Err(e) if privilege_error(&e) => {
                return Ok(History::unavailable(format!(
                    "el usuario «{user}» no tiene permiso para usar la API CDC de Informix (solo el usuario informix puede ejecutar sus funciones): {e}"
                )))
            }
            _ => {}
        }
    }
    if !frl_on && !req.enable_full_row_logging {
        return Ok(History {
            status: "needsFullRowLogging",
            reason: format!("la tabla «{table}» no tiene activado el registro de fila completa (full row logging), que la API CDC exige para leer sus cambios."),
            skipped,
            ..Default::default()
        });
    }

    // The logs on disk.
    let logs = q("SELECT uniqid, flags, filltime FROM sysmaster:syslogfil WHERE uniqid > 0 ORDER BY uniqid")?;
    let used: Vec<(i64, i64, i64)> = logs
        .iter()
        .filter_map(|r| Some((r.first().and_then(int)?, r.get(1).and_then(int)?, r.get(2).and_then(int).unwrap_or(0))))
        .filter(|(_, f, _)| f & 1 != 0)
        .collect();
    let Some(&(first_log, _, _)) = used.first() else { return Ok(History::unavailable("el servidor no tiene logs lógicos en uso.")) };
    let current_log = used.iter().find(|(_, f, _)| f & 2 != 0).map(|l| l.0).unwrap_or_else(|| used.last().map(|l| l.0).unwrap_or(first_log));
    let locale = q(&format!("SELECT dbs_collate FROM sysmaster:sysdbslocale WHERE dbs_dbsname = {}", lit(db)))?;
    let codeset = Codeset::from_locale(&locale.first().and_then(|r| r.first()).map(text).unwrap_or_default());
    let users: HashMap<i64, String> = q("SELECT DISTINCT uid, username FROM sysmaster:syssessions")?
        .iter()
        .filter_map(|r| Some((r.first().and_then(int)?, r.get(1).map(text)?)))
        .collect();

    // Where the log is now: the start of the page being written (`used` counts it whole). An LSN's offset is the page
    // number shifted 12 bits plus the byte in the page, whatever the page size (measured). The read is complete once
    // the session runs out of records (a timeout) at or past it; a timeout further back means the server is still
    // going through older logs.
    let now = q("SELECT uniqid, used, size FROM sysmaster:syslogfil WHERE uniqid > 0 ORDER BY uniqid DESC")?;
    let log_bytes: HashMap<u32, u32> = now.iter().filter_map(|r| Some((r.first().and_then(int)? as u32, (r.get(2).and_then(int)? << 12) as u32))).collect();
    let end = now
        .first()
        .and_then(|r| Some(Lsn(r.first().and_then(int)? as u32, (((r.get(1).and_then(int)? - 1).max(0)) << 12) as u32)))
        .ok_or_else(|| anyhow!("No se pudo leer la posición actual del log lógico"))?;
    // The table's partition was created in the first log that filled after `created` (or in the current one): the
    // older logs hold only other tables, and a dropped one may have had the same partnum, which the CDC API cannot
    // read (-83790).
    let older = used.iter().take_while(|(_, f, fill)| f & 2 == 0 && *fill > 0 && *fill < created).count();
    let start_logs: Vec<i64> = used[older..].iter().map(|l| l.0).collect();

    if !frl_on {
        ledger_add(env.ledger, &ledger_key);
    }
    let session = match open_capture(conn, &server, user, &full_name, &captured, !frl_on)? {
        Ok(s) => s,
        Err(h) => {
            ledger_forget(env.ledger, &ledger_key);
            return Ok(h);
        }
    };
    let turned_on = !frl_on || left_over;
    let mut session = session;
    // Set when a read of the CDC session got no answer: the connection is stuck behind it and is left alone.
    let wedged = std::cell::Cell::new(false);
    let result = (|| -> Result<History> {
        // From the start of the first log to read; one reused in the meantime moves the start to the next.
        let mut gone = Vec::new();
        let mut from = None;
        // Where an earlier read of this table found the first position the server reads cleanly (see `RESUME`).
        let remembered_key = (ledger_key.clone(), created, start_logs.first().copied().unwrap_or(0));
        let remembered = RESUME.lock().get(&remembered_key).cloned().filter(|r| !r.is_empty());
        let mut resumed = None;
        for &log in &start_logs {
            let at = match remembered.as_ref().and_then(|r| r.last()) {
                Some(&(_, resume, _)) if resume.0 as i64 == log => resume,
                _ => Lsn(log as u32, 0),
            };
            match activate(conn, session.id, at)? {
                0 => {
                    from = Some(log);
                    if at.1 != 0 {
                        resumed = Some(at);
                    }
                    break;
                }
                -83713 => gone.push(log),
                code => return Ok(History::unavailable(format!("la API CDC no empezó a leer el log: {}.", cdc_error(code)))),
            }
        }
        let Some(from) = from else { return Ok(History::unavailable("ningún log lógico en disco se pudo leer (se están reutilizando).")) };
        let started = Instant::now();
        let asked_at = chrono::Utc::now().timestamp();
        let key: Vec<(String, String)> = req.key.iter().map(|k| (k.column.clone(), k.value.clone())).collect();
        let mut b = Builder::new(key, created, users, codeset);
        let mut buf: Vec<u8> = Vec::new();
        let mut stopped = None;
        let mut read_from = resumed.unwrap_or(Lsn(from as u32, 0));
        b.last = read_from;
        let mut searches = 0;
        let mut skipped_from: Vec<(Lsn, Lsn, String)> = if resumed.is_some() { remembered.clone().unwrap_or_default() } else { Vec::new() };
        let mut stalled = false;
        let mut walls_hit: Vec<Lsn> = Vec::new();
        let mut waiting: Option<(Lsn, Instant)> = None;
        // Whether a read from `at` gets past the table's creation (a commit after it, or the end) without an error.
        let probe = |at: Lsn| -> Result<Option<bool>> {
            if wedged.get() || started.elapsed() > MAX_READ {
                return Ok(None);
            }
            let mut s = match open_capture(conn, &server, user, &full_name, &captured, false)? {
                Ok(s) => s,
                Err(_) => return Ok(None),
            };
            let verdict = (|| -> Result<Option<bool>> {
                if activate(conn, s.id, at)? != 0 {
                    return Ok(Some(false));
                }
                let mut t = Builder::new(vec![], created, HashMap::new(), codeset);
                let mut buf = Vec::new();
                let deadline = Instant::now() + Duration::from_secs(30).min(MAX_READ.saturating_sub(started.elapsed()));
                let mut stalled = None;
                while Instant::now() < deadline && !stop.load(Ordering::Relaxed) {
                    t.caught_up = false;
                    match conn.lo_read(s.id as i32, 256 << 10, STALL)? {
                        Some(chunk) => buf.extend_from_slice(&chunk),
                        None => {
                            wedged.set(true);
                            return Ok(None);
                        }
                    }
                    let (recs, n) = parse_records(&buf)?;
                    buf.drain(..n);
                    for rec in recs {
                        let error = matches!(rec, Rec::Error { .. });
                        if !matches!(rec, Rec::Change { .. }) {
                            t.feed(rec)?;
                        }
                        if error {
                            return Ok(Some(false));
                        }
                        if t.after_creation || (t.caught_up && t.last >= end) {
                            return Ok(Some(true));
                        }
                    }
                    // Two timeouts at the same place: everything the API has handed over reads cleanly.
                    if t.caught_up {
                        if stalled == Some(t.last) {
                            return Ok(Some(true));
                        }
                        stalled = Some(t.last);
                    }
                }
                Ok(None)
            })();
            if !wedged.get() && !s.close(conn) {
                wedged.set(true);
            }
            verdict
        };
        loop {
            if stop.load(Ordering::Relaxed) {
                stopped = Some("Lectura cancelada: solo se muestra lo leído hasta entonces.".to_string());
                break;
            }
            if started.elapsed() > MAX_READ {
                stopped = Some(format!("La lectura se detuvo a los {} s: solo se muestra lo leído hasta entonces.", MAX_READ.as_secs()));
                break;
            }
            // Caught up only by a timeout in this read (an earlier one may have come while older logs were scanned).
            b.caught_up = false;
            let Some(chunk) = conn.lo_read(session.id as i32, 256 << 10, STALL)? else {
                wedged.set(true);
                stalled = true;
                stopped = Some(format!(
                    "El lector CDC del servidor no respondió en {} s (posición {} del log): solo se muestra lo leído hasta entonces, y no se sabe nada más de la fila.",
                    STALL.as_secs(),
                    b.last.max(read_from)
                ));
                break;
            };
            buf.extend_from_slice(&chunk);
            let (recs, used_bytes) = parse_records(&buf)?;
            buf.drain(..used_bytes);
            let mut past_request = false;
            for rec in recs {
                // Changes committed after the user asked are not part of this history.
                if let Rec::Commit { time, .. } = rec {
                    if time > asked_at + 1 {
                        past_request = true;
                    }
                }
                b.feed(rec)?;
                if b.failed.is_some() {
                    break;
                }
            }
            if b.failed.is_some() {
                // The session cannot go on after a server error.
                if !session.close(conn) {
                    wedged.set(true);
                    stalled = true;
                    stopped = Some("El servidor no respondió al cerrar la sesión CDC tras un error: la lectura se detuvo.".to_string());
                    break;
                }
                let failed_at = b.last.max(read_from);
                let why = b.take_error();
                if b.after_creation || searches >= MAX_SEARCHES {
                    stopped = Some(format!("El servidor dio un error al leer el log después de {failed_at} ({why}): la lectura se detuvo ahí."));
                    break;
                }
                // Before the table existed, the log may hold records of dropped tables that had its partnum, which the
                // API cannot read (-83790): the read goes on from the first position from which it reads cleanly.
                searches += 1;
                let Some(resume) = first_readable(failed_at, end, &log_bytes, &probe)? else {
                    stopped = Some(format!("La lectura no pudo seguir tras el error en {failed_at} ({why})."));
                    break;
                };
                skipped_from.push((failed_at, resume, why));
                b.last = resume;
                read_from = resume;
                buf.clear();
                session = match open_capture(conn, &server, user, &full_name, &captured, false)? {
                    Ok(s) => s,
                    Err(h) => {
                        stopped = Some(format!("La lectura no pudo seguir tras el error: {}", h.reason));
                        break;
                    }
                };
                if resume >= end {
                    break;
                }
                match activate(conn, session.id, resume)? {
                    0 => continue,
                    code => {
                        stopped = Some(format!("La lectura no pudo seguir tras el error: {}.", cdc_error(code)));
                        break;
                    }
                }
            }
            if (b.caught_up && b.last >= end) || past_request || b.events.len() >= MAX_EVENTS {
                break;
            }
            // The API only hands over the part of the log the server has made available (measured: the last changes
            // can take tens of seconds): waiting there without progress ends the read, said as partial. In a log that
            // is already complete it is a wall (see `WALLS`): the read goes on from the next log.
            let mut wall = None;
            if b.caught_up && b.last.0 < end.0 {
                wall = WALLS.lock().get(&(server.clone(), b.last.0)).copied().filter(|w| b.last >= *w);
            }
            if wall.is_none() {
                if b.caught_up {
                    match waiting {
                        Some((at, since)) if at == b.last => {
                            if since.elapsed() > MAX_WAIT {
                                if at.0 < end.0 && at != Lsn::default() {
                                    WALLS.lock().insert((server.clone(), at.0), at);
                                    wall = Some(at);
                                } else {
                                    stopped = Some(if at == Lsn::default() {
                                        "El servidor no ha entregado ningún registro del log: su lector CDC no avanza. No se sabe nada de la fila; vuelve a leer en unos segundos.".to_string()
                                    } else if end.1.saturating_sub(at.1) >= 2 << 12 {
                                        format!(
                                            "El lector CDC del servidor se detuvo en la posición {at} del log {}, aunque el log ya tiene datos hasta {end}: tras una lectura que llegó al final de ese log mientras se escribía, el servidor no entrega nada más de él hasta que cambie de log lógico (onmode -l, o cuando el log actual se llene). Los cambios posteriores a esa posición no se pueden ver ahora.",
                                            at.0
                                        )
                                    } else {
                                        format!(
                                            "Los cambios más recientes, desde la posición {at} del log, todavía no están disponibles para la API CDC (el servidor aún no ha escrito esa parte del log): vuelve a leer en unos segundos."
                                        )
                                    });
                                    break;
                                }
                            }
                        }
                        _ => waiting = Some((b.last, Instant::now())),
                    }
                } else {
                    waiting = None;
                }
            }
            if let Some(w) = wall {
                walls_hit.push(w);
                let next = Lsn(w.0 + 1, 0);
                if !session.close(conn) {
                    wedged.set(true);
                    stalled = true;
                    stopped = Some("El servidor no respondió al cerrar la sesión CDC: la lectura se detuvo.".to_string());
                    break;
                }
                session = match open_capture(conn, &server, user, &full_name, &captured, false)? {
                    Ok(s) => s,
                    Err(h) => {
                        stopped = Some(format!("La lectura no pudo seguir tras el log {}: {}", w.0, h.reason));
                        break;
                    }
                };
                match activate(conn, session.id, next)? {
                    0 => {}
                    code => {
                        stopped = Some(format!("La lectura no pudo seguir en el log {}: {}.", next.0, cdc_error(code)));
                        break;
                    }
                }
                b.last = next;
                read_from = next;
                buf.clear();
                waiting = None;
            }
        }
        let last = b.last;
        let stalled = stalled || wedged.get();
        if !stalled && stopped.is_none() && !skipped_from.is_empty() {
            RESUME.lock().insert(remembered_key, skipped_from.clone());
        }
        // The history against the row as it is now: a change the server never sent shows up as a difference.
        let disagreement = if stopped.is_none() && !b.columns().is_empty() {
            let names = b.columns();
            let cond = req.key.iter().map(|k| format!("{} = {}", k.column, lit(&k.value))).collect::<Vec<_>>().join(" AND ");
            match conn.query_all(&format!("SELECT {} FROM {full_name} WHERE {cond}", names.join(", "))) {
                Ok(rows) if rows.len() <= 1 => b.disagrees_with(rows.first().map(|r| r.as_slice())),
                Ok(_) => None,
                Err(e) => Some(format!("no se pudo leer la fila actual para compararla con el log ({e})")),
            }
        } else {
            None
        };
        let mut h = b.finish(from, stopped, walls_hit.iter().map(|w| wall_text(*w)).collect());
        if let Some(d) = disagreement {
            h.partial.push(format!(
                "Faltan cambios en el historial: {d}. Con full row logging desactivado, el servidor registra las modificaciones de una tabla sin columnas de longitud variable como registros parciales y no los entrega por la API CDC. Puede ser también un cambio posterior a la lectura."
            ));
        }
        h.stalled = stalled;
        h.skipped = skipped.clone();
        h.range = Some(LogRange {
            first_log: from,
            first_log_filled: used.iter().find(|l| l.0 == from).filter(|l| l.1 & 2 == 0 && l.2 > 0).map(|l| l.2),
            current_log,
            from_lsn: Lsn(from as u32, 0).to_string(),
            read_until: last.to_string(),
            read_at: asked_at,
        });
        for (at, resume, why) in &skipped_from {
            h.notes.push(format!(
                "Antes de crearse la tabla, el log tiene registros de tablas borradas que usaban su número de partición, y el servidor no los lee ({why}, en {at}): la lectura siguió en {resume}, la primera posición legible, que queda antes de cualquier cambio de esta tabla."
            ));
        }
        if older > 0 && from != first_log {
            h.notes.push(format!(
                "La tabla se creó después de llenarse el log {}: la lectura empieza en el log {from}, porque los anteriores no tienen cambios suyos.",
                used[older - 1].0
            ));
        }
        if !gone.is_empty() {
            h.notes.push(format!("Los logs {} se reutilizaron mientras empezaba la lectura.", gone.iter().map(|g| g.to_string()).collect::<Vec<_>>().join(", ")));
        }
        if altered {
            h.notes.push("La tabla se ha modificado con ALTER TABLE: en los cambios anteriores a ese ALTER, el servidor da como NULL las columnas añadidas después.".into());
        }
        if left_over {
            h.notes.push("Una lectura anterior de Celer se interrumpió con full row logging activado en la tabla: se ha vuelto a desactivar.".into());
        } else if turned_on {
            h.notes.push("Se activó full row logging en la tabla solo durante la lectura, y se ha vuelto a desactivar.".into());
        }
        Ok(h)
    })();
    // A request the server never answered: the history says so, and the clean-up below uses another connection.
    let result = match result {
        Err(e) if crate::jdbc::is_wait_timeout(&e) => {
            wedged.set(true);
            Ok(History {
                status: "ok",
                partial: vec![format!("El servidor no respondió a la API CDC en {} s: no se pudo leer nada del log, y no se sabe nada de la fila.", STALL.as_secs())],
                stalled: true,
                ..Default::default()
            })
        }
        other => other,
    };
    // Always: the session closes, and full row logging goes back off if Celer turned it on. A connection stuck behind a
    // request the server never answered is left alone: the clean-up goes through another one.
    let mut spare: Option<JdbcConn> = None;
    let mut use_spare = wedged.get();
    if !use_spare && !session.close(conn) {
        use_spare = true;
    }
    if use_spare {
        spare = env.fresh().ok();
        if let Some(c) = &spare {
            let _ = call(c, &format!("EXECUTE FUNCTION syscdcv1:informix.cdc_closesess({})", session.id));
        }
    }
    if turned_on {
        // The server refuses while the capture session is still winding down: a few tries.
        let mut off = Err(anyhow!("sin conexión"));
        for attempt in 0..4 {
            if use_spare && spare.is_none() {
                spare = env.fresh().ok();
            }
            let c = if use_spare { spare.as_ref() } else { Some(conn) };
            let Some(c) = c else { break };
            off = call(c, &format!("EXECUTE FUNCTION syscdcv1:informix.cdc_set_fullrowlogging({}, 0)", lit(&full_name)));
            if matches!(off, Ok(0)) || attempt == 3 {
                break;
            }
            if matches!(&off, Err(e) if crate::jdbc::is_wait_timeout(e)) {
                use_spare = true;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        if matches!(off, Ok(0)) {
            ledger_forget(env.ledger, &ledger_key);
        } else {
            let mut h = result?;
            h.notes.retain(|n| !n.contains("se ha vuelto a desactivar"));
            h.notes.push(format!(
                "No se pudo volver a desactivar full row logging en «{full_name}»: hazlo con EXECUTE FUNCTION syscdcv1:informix.cdc_set_fullrowlogging('{full_name}', 0)."
            ));
            return Ok(h);
        }
    }
    result
}

/// Per table (server, name, creation time, first log read): the errors the server gave before the table existed and
/// the position each read went on from. Finding it takes a bisection of sessions (tens of seconds), and the next
/// history of the same table starts from there at once. The table's own changes never come before it.
static RESUME: std::sync::LazyLock<parking_lot::Mutex<HashMap<(String, i64, i64), Vec<(Lsn, Lsn, String)>>>> = std::sync::LazyLock::new(Default::default);

/// Per (server, log): the position where the server's CDC reader stops for good in that log. Measured on Informix 15: a
/// session that reaches the end of a log while its last page is still being written leaves that log unreadable past
/// that position for every later session, until the server restarts or the log is reused; the reader does not go on
/// to the next log either. A read that meets such a wall (no progress for `MAX_WAIT` in a log that is already
/// complete) goes on from the start of the next log, and says what it could not see.
static WALLS: std::sync::LazyLock<parking_lot::Mutex<HashMap<(String, u32), Lsn>>> = std::sync::LazyLock::new(Default::default);

fn wall_text(at: Lsn) -> String {
    format!(
        "El lector CDC del servidor no entrega el log {} más allá de la posición {at} (una lectura anterior llegó al final de ese log mientras se escribía, y el servidor ya no lo lee más allá): los cambios de ese log posteriores a esa posición no se pueden ver.",
        at.0
    )
}

/// Searches for a readable position after errors before the read gives up.
const MAX_SEARCHES: usize = 5;
/// How long the read waits at the end of what the API hands over for the rest of the log.
const MAX_WAIT: Duration = Duration::from_secs(10);

/// The first log position from which the CDC API reads without the error that stopped it at `bad`, or None when it
/// cannot tell. `probe` says whether a read from a position gets past the table's creation cleanly. Bisects down to 32
/// bytes: no change of the table can start that close after a dropped table's record, since the DROP and the CREATE
/// TABLE (catalog rows, partition records) are logged in between.
fn first_readable(bad: Lsn, end: Lsn, log_bytes: &HashMap<u32, u32>, probe: &dyn Fn(Lsn) -> Result<Option<bool>>) -> Result<Option<Lsn>> {
    let mut lo = bad;
    // The log that has the first readable position: each later log start is tried until one reads cleanly.
    let mut hi = end;
    while lo.0 < end.0 {
        let next = Lsn(lo.0 + 1, 0);
        match probe(next)? {
            Some(true) => {
                hi = next;
                break;
            }
            Some(false) => lo = next,
            None => return Ok(None),
        }
    }
    let size = |log: u32| log_bytes.get(&log).copied().unwrap_or(u32::MAX);
    let (mut a, mut b) = (lo.1, if hi.0 > lo.0 { size(lo.0) } else { hi.1 });
    while b.saturating_sub(a) > 32 {
        let mid = a + (b - a) / 2;
        match probe(Lsn(lo.0, mid))? {
            Some(true) => b = mid,
            Some(false) => a = mid,
            None => return Ok(None),
        }
    }
    Ok(Some(if b >= size(lo.0) && hi.0 > lo.0 { hi } else { Lsn(lo.0, b) }))
}

/// An open CDC session (closed once: `close` may be called again).
struct Session {
    id: i64,
    open: bool,
}

impl Session {
    /// false when the server did not answer (the connection is then stuck behind the request).
    fn close(&mut self, conn: &JdbcConn) -> bool {
        if std::mem::replace(&mut self.open, false) {
            for f in ["cdc_deactivatesess", "cdc_closesess"] {
                if matches!(call(conn, &format!("EXECUTE FUNCTION syscdcv1:informix.{f}({})", self.id)), Err(e) if crate::jdbc::is_wait_timeout(&e)) {
                    return false;
                }
            }
        }
        true
    }
}

/// A CDC session capturing the table: two seconds without records gives a timeout record, and up to 50 records come
/// in a read (1000 is refused: -83724). `full_row_logging`: turn it on first (the user agreed). What stops it is an
/// unavailable history (privileges, the API's own errors).
fn open_capture(conn: &JdbcConn, server: &str, user: &str, full_name: &str, columns: &[String], full_row_logging: bool) -> Result<std::result::Result<Session, History>> {
    let id = match call(conn, &format!("EXECUTE FUNCTION syscdcv1:informix.cdc_opensess({}, 0, 2, 50, 1, 1)", lit(server))) {
        Ok(s) if s > 0 => s,
        Ok(code) => return Ok(Err(History::unavailable(format!("la API CDC no abrió la sesión: {}.", cdc_error(code))))),
        Err(e) if privilege_error(&e) => {
            return Ok(Err(History::unavailable(format!(
                "el usuario «{user}» no tiene permiso para usar la API CDC de Informix (solo el usuario informix puede ejecutar sus funciones): {e}"
            ))))
        }
        Err(e) => return Err(e),
    };
    let mut session = Session { id, open: true };
    let unavailable = |session: &mut Session, why: String| {
        session.close(conn);
        Ok(Err(History::unavailable(why)))
    };
    if full_row_logging {
        match call(conn, &format!("EXECUTE FUNCTION syscdcv1:informix.cdc_set_fullrowlogging({}, 1)", lit(full_name))) {
            Ok(0) => {}
            Ok(r) => return unavailable(&mut session, format!("no se pudo activar full row logging: {}.", cdc_error(r))),
            Err(e) => {
                session.close(conn);
                return Err(e);
            }
        }
    }
    let captured = call(conn, &format!("EXECUTE FUNCTION syscdcv1:informix.cdc_startcapture({id}, 0, {}, {}, 1)", lit(full_name), lit(&columns.join(","))));
    if !matches!(captured, Ok(0)) && full_row_logging {
        // Not reading after all: full row logging goes back off.
        let _ = call(conn, &format!("EXECUTE FUNCTION syscdcv1:informix.cdc_set_fullrowlogging({}, 0)", lit(full_name)));
    }
    match captured {
        Ok(0) => Ok(Ok(session)),
        Ok(r) => unavailable(&mut session, format!("la API CDC no empezó la captura de la tabla: {}.", cdc_error(r))),
        Err(e) => {
            session.close(conn);
            Err(e)
        }
    }
}

/// Starts the session's read at a log position: 0, or the API's error code.
fn activate(conn: &JdbcConn, session: i64, lsn: Lsn) -> Result<i64> {
    let at = ((lsn.0 as u64) << 32) | lsn.1 as u64;
    call(conn, &format!("EXECUTE FUNCTION syscdcv1:informix.cdc_activatesess({session}, {at})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// A CDC record as the server sends it: common header, record header, payload.
    fn record(kind: u32, header: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&((16 + header.len()) as u32).to_be_bytes());
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(&PACKET_SCHEME.to_be_bytes());
        out.extend_from_slice(&kind.to_be_bytes());
        out.extend_from_slice(header);
        out.extend_from_slice(payload);
        out
    }

    // Records captured from Informix 15 in the spike (#123): `spike_types` and `spike_t2`.
    const TYPES_SCHEMA: &str = "id serial, si smallint, i8 int8, bi bigint, fl float, sf smallfloat, d decimal(12,3), m money(10,2), fdec decimal(10), dt date, ts datetime year to second, tf datetime year to fraction(3), hm datetime hour to minute, iv interval day(3) to second, ym interval year to month, b boolean, c char(5), nc nchar(4), bs bigserial, vc varchar(20,0), nv nvarchar(20,0), lv lvarchar(200)";
    const TYPES_ROW: &str = "00000001000c000171fb04cb0000011ffffffffdb34fe916400a000000000000bfc00000c301172d43500000c1635f000000bf0117000000000000b135c71418030f0a141ec71418030f0a141e0c32c30705c40c03040500c603070000016162202020c3b1c3bc000000000000000107686f6c6120c3b1026e76000a006c6f6e672074657874";
    const TYPES_UPDATED: &str = "00000001fffdffff000000050000000000000000000000000000000000000000bfc000003f320000000000008000000000003c62500000000000000000c713630c1f173b3bc71418030f0a141e0c32c30705c40c03040500c603070000000020202020c3b1c3bc000000000000000100026e76000a006c6f6e672074657874";
    const TYPES_NULLS: &str = "000000028000000000000000000000008000000000000000ffffffffffffffffffffffff00000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000000000100002020202000202020000000000000000201000100000101";

    fn types_layout(cs: Codeset) -> Layout {
        Layout::new(parse_schema(TYPES_SCHEMA).unwrap(), 111, 19, 3, cs).unwrap()
    }

    fn some(v: &[&str]) -> Vec<Option<String>> {
        v.iter().map(|s| if *s == "NULL" { None } else { Some(s.to_string()) }).collect()
    }

    #[test]
    fn every_type_decodes_as_logged() {
        let l = types_layout(Codeset::Latin1);
        let row = l.row(&[8, 3, 12], &hex(TYPES_ROW)).unwrap();
        assert_eq!(
            row,
            some(&[
                "1", "12", "1234567890123", "-9876543210", "3.25", "-1.5", "12345.678", "99.95", "0.000123", "2024-03-15", "2024-03-15 10:20:30", "2024-03-15 10:20:30.125", "07:05", "12 03:04:05", "3-07", "true", "ab", "Ã±Ã¼", "1",
                "hola Ã±", "nv", "long text",
            ])
        );
        let upd = l.row(&[1, 3, 12], &hex(TYPES_UPDATED)).unwrap();
        assert_eq!(
            upd,
            some(&[
                "1", "-3", "-5", "0", "0", "-1.5", "-0.500", "0.00", "-12000", "1899-12-31", "1999-12-31 23:59:59", "2024-03-15 10:20:30.125", "07:05", "12 03:04:05", "3-07", "false", "NULL", "Ã±Ã¼", "1", "", "nv", "long text",
            ])
        );
        let nulls = l.row(&[2, 2, 3], &hex(TYPES_NULLS)).unwrap();
        let mut expect = vec![None; 22];
        expect[0] = Some("2".to_string());
        expect[18] = Some("2".to_string());
        assert_eq!(nulls, expect);
        // UTF-8 databases read the same bytes as UTF-8.
        let utf8 = types_layout(Codeset::Utf8).row(&[8, 3, 12], &hex(TYPES_ROW)).unwrap();
        assert_eq!(utf8[17].as_deref(), Some("ñü"));
        assert_eq!(utf8[19].as_deref(), Some("hola ñ"));
        // An unknown code set shows bytes, never a guess.
        assert_eq!(types_layout(Codeset::Other).row(&[8, 3, 12], &hex(TYPES_ROW)).unwrap()[17].as_deref(), Some("0xC3B1C3BC"));
    }

    #[test]
    fn decimals_and_intervals_with_odd_digits() {
        let cols = parse_schema("id integer, d113 decimal(11,3), d51 decimal(5,1), f11 decimal(11), ivf interval day(3) to fraction(3), ivs interval minute(5) to fraction(1), yd datetime year to day, lv lvarchar(50)").unwrap();
        let l = Layout::new(cols, 41, 7, 1, Codeset::Latin1).unwrap();
        let one = l.row(&[3], &hex("000000013b57412b1508503d574132c601172d435901c501170405064e5ac401172d0646c71418030f000100")).unwrap();
        assert_eq!(one, some(&["1", "-12345678.912", "-1234.5", "12345678901", "123 04:05:06.789", "12345:06.7", "2024-03-15", ""]));
        let two = l.row(&[4], &hex("00000002bf0a0000000000c00a00003f320000000000405a0000000000003d6300000000c60101010000020078")).unwrap();
        assert_eq!(two, some(&["2", "0.001", "0.1", "-0.5", "-0 00:00:00.001", "-1:00.0", "0001-01-01", "x"]));
    }

    #[test]
    fn a_layout_celer_cannot_read_is_refused() {
        let cols = parse_schema("id integer, d decimal(12,3)").unwrap();
        let err = Layout::new(cols, 11, 2, 0, Codeset::Latin1).unwrap_err().to_string();
        assert!(err.contains("12 bytes") && err.contains("11"), "{err}");
        assert!(parse_schema("id integer, x mytype").is_err());
        // A record that does not fill the row exactly is an error too.
        let l = Layout::new(parse_schema("id integer").unwrap(), 4, 1, 0, Codeset::Latin1).unwrap();
        assert!(l.row(&[], &hex("0000000100")).is_err());
        assert!(l.row(&[], &hex("000001")).is_err());
    }

    #[test]
    fn types_and_sizes() {
        assert_eq!(parse_type("decimal(12,3)"), Some(Ty::Decimal { precision: 12, scale: Some(3) }));
        assert_eq!(parse_type("money"), Some(Ty::Decimal { precision: 16, scale: Some(2) }));
        assert_eq!(parse_type("datetime year to fraction").and_then(|t| t.size()), Some(10));
        assert_eq!(parse_type("interval year to month").and_then(|t| t.size()), Some(4));
        assert_eq!(parse_type("interval hour(4) to minute").and_then(|t| t.size()), Some(4));
        assert_eq!(parse_type("decimal(10)").and_then(|t| t.size()), Some(7));
        assert_eq!(parse_type("varchar(20,0)").and_then(|t| t.size()), None);
        assert_eq!(parse_type("datetime second to year"), None);
        assert_eq!(parse_type("blob"), None);
        assert!(capturable(262, 0) && capturable(13, 0) && capturable(41, 5) && capturable(40, 1) && capturable(309, 0));
        assert!(!capturable(12, 0) && !capturable(11, 0) && !capturable(41, 10) && !capturable(40, 7) && !capturable(19, 0));
        assert_eq!(Codeset::from_locale("en_US.819"), Codeset::Latin1);
        assert_eq!(Codeset::from_locale("es_ES.57372"), Codeset::Utf8);
        assert_eq!(Codeset::from_locale("ja_JP.sjis-s"), Codeset::Other);
    }

    #[test]
    fn key_values_compare_as_the_grid_shows_them() {
        let dec = Ty::Decimal { precision: 10, scale: Some(2) };
        assert!(same_value(&dec, "1.50", "1.5"));
        assert!(same_value(&dec, "-0.00", "0"));
        assert!(!same_value(&dec, "1.50", "1.05"));
        assert!(same_value(&Ty::Int, "7", "7"));
        assert!(!same_value(&Ty::Int, "7", "70"));
        assert!(same_value(&Ty::Char(5), "ab", "ab   "));
        assert!(!same_value(&Ty::VarChar, "ab", "AB"));
        assert!(same_value(&Ty::Float, "3.25", "3.250"));
        assert!(!same_value(&Ty::Int, "x", "x1"));
    }

    fn begin(tx: u32, uid: u32, time: u64) -> Vec<u8> {
        let mut h = vec![0, 0, 0, 69, 0, 0, 0x10, 0];
        h.extend_from_slice(&tx.to_be_bytes());
        h.extend_from_slice(&time.to_be_bytes());
        h.extend_from_slice(&uid.to_be_bytes());
        record(1, &h, &[])
    }

    fn commit(tx: u32, time: u64, pos: u32) -> Vec<u8> {
        let mut h = vec![0, 0, 0, 69];
        h.extend_from_slice(&pos.to_be_bytes());
        h.extend_from_slice(&tx.to_be_bytes());
        h.extend_from_slice(&time.to_be_bytes());
        record(2, &h, &[])
    }

    fn change(kind: u32, tx: u32, pos: u32, payload: &str, varlens: &[u32]) -> Vec<u8> {
        let mut h = vec![0, 0, 0, 69];
        h.extend_from_slice(&pos.to_be_bytes());
        h.extend_from_slice(&tx.to_be_bytes());
        h.extend_from_slice(&1u32.to_be_bytes());
        h.extend_from_slice(&0u32.to_be_bytes());
        for v in varlens {
            h.extend_from_slice(&v.to_be_bytes());
        }
        record(kind, &h, &hex(payload))
    }

    fn schema() -> Vec<u8> {
        let mut h = Vec::new();
        for v in [1u32, 0, 14, 3, 1] {
            h.extend_from_slice(&v.to_be_bytes());
        }
        record(200, &h, b"id integer, qty integer, price decimal(10,2), name varchar(40,0)\0")
    }

    /// The spike's `spike_hist`: rows 1 and 2 inserted, row 1 updated three times, row 2 deleted.
    fn spike_stream() -> Vec<u8> {
        // id, qty, price DECIMAL(10,2) (6 bytes), then the VARCHAR with its length byte.
        let alpha10 = &["00000001", "0000000a", "c10132000000", "05616c706861"].concat();
        let alpha11 = &["00000001", "0000000b", "c10132000000", "05616c706861"].concat();
        let alpha2_11 = &["00000001", "0000000b", "c1014b000000", "07616c7068612d32"].concat();
        let alpha2_12 = &["00000001", "0000000c", "c1014b000000", "07616c7068612d32"].concat();
        let beta = ["00000002", "00000014", "c10232000000", "0462657461"].concat();
        let mut s = schema();
        s.extend(begin(30, 200, 1000));
        s.extend(change(40, 30, 0x100, alpha10, &[6]));
        s.extend(commit(30, 1001, 0x110));
        s.extend(begin(31, 200, 1002));
        s.extend(change(40, 31, 0x200, &beta, &[5]));
        s.extend(commit(31, 1002, 0x210));
        s.extend(begin(32, 1001, 1003));
        s.extend(change(42, 32, 0x300, alpha10, &[6]));
        s.extend(change(43, 32, 0x301, alpha11, &[6]));
        s.extend(commit(32, 1004, 0x310));
        s.extend(begin(33, 200, 1005));
        s.extend(change(42, 33, 0x400, alpha11, &[6]));
        s.extend(change(43, 33, 0x401, alpha2_11, &[8]));
        s.extend(commit(33, 1005, 0x410));
        // A rolled back change is not history.
        s.extend(begin(34, 200, 1006));
        s.extend(change(42, 34, 0x500, alpha2_11, &[8]));
        s.extend(change(43, 34, 0x501, alpha2_12, &[8]));
        s.extend(record(3, &[0, 0, 0, 69, 0, 0, 5, 2, 0, 0, 0, 34], &[]));
        s.extend(begin(35, 200, 1007));
        s.extend(change(42, 35, 0x600, alpha2_11, &[8]));
        s.extend(change(43, 35, 0x601, alpha2_12, &[8]));
        s.extend(commit(35, 1008, 0x610));
        s.extend(begin(36, 200, 1009));
        s.extend(change(41, 36, 0x700, &beta, &[5]));
        s.extend(commit(36, 1009, 0x710));
        s.extend(record(201, &[0, 0, 0, 70, 0, 0, 0, 0], &[]));
        s
    }

    fn history(stream: &[u8], key: &str, created: i64) -> History {
        let users = HashMap::from([(200, "informix".to_string())]);
        let mut b = Builder::new(vec![("id".into(), key.into())], created, users, Codeset::Latin1);
        // Records arrive in pieces of any size.
        let mut buf = Vec::new();
        for piece in stream.chunks(7) {
            buf.extend_from_slice(piece);
            let (recs, used) = parse_records(&buf).unwrap();
            buf.drain(..used);
            for r in recs {
                b.feed(r).unwrap();
            }
        }
        assert!(buf.is_empty() && b.caught_up);
        b.finish(61, None, vec![])
    }

    #[test]
    fn the_history_of_one_row() {
        let h = history(&spike_stream(), "1", 0);
        assert_eq!(h.status, "ok");
        assert_eq!(h.columns, vec!["id", "qty", "price", "name"]);
        let ops: Vec<_> = h.events.iter().map(|e| (e.op, e.tx, e.time)).collect();
        assert_eq!(ops, vec![("insert", 30, 1001), ("update", 32, 1004), ("update", 33, 1005), ("update", 35, 1008)]);
        assert_eq!(h.events[0].after, Some(some(&["1", "10", "1.50", "alpha"])));
        assert_eq!(h.events[2].before, Some(some(&["1", "11", "1.50", "alpha"])));
        assert_eq!(h.events[2].after, Some(some(&["1", "11", "1.75", "alpha-2"])));
        assert_eq!(h.events[3].after, Some(some(&["1", "12", "1.75", "alpha-2"])));
        assert_eq!((h.events[0].user.as_deref(), h.events[1].user.as_deref(), h.events[1].uid), (Some("informix"), None, Some(1001)));
        assert_eq!(h.events[1].lsn, "69:0x301");
        assert!(h.partial.is_empty(), "inserted inside the range: complete ({:?})", h.partial);

        let gone = history(&spike_stream(), "2", 0);
        assert_eq!(gone.events.iter().map(|e| e.op).collect::<Vec<_>>(), vec!["insert", "delete"]);
        assert_eq!(gone.events[1].before, Some(some(&["2", "20", "2.50", "beta"])));

        // A row inserted before the oldest log: partial, never completed by guessing.
        let none = history(&spike_stream(), "9", 0);
        assert!(none.events.is_empty());
        assert!(none.partial[0].contains("log 61"), "{:?}", none.partial);

        // Records older than the table itself (a dropped table had its partnum) are left out and counted.
        let recreated = history(&spike_stream(), "1", 1005);
        assert_eq!(recreated.events.len(), 2);
        assert!(recreated.notes.iter().any(|n| n.contains("Se descartaron 2")), "{:?}", recreated.notes);
        assert!(recreated.partial.iter().any(|p| p.contains("ya existía")), "{:?}", recreated.partial);
    }

    #[test]
    fn the_end_of_the_history_is_checked_against_the_row_now() {
        let mut b = Builder::new(vec![("id".into(), "1".into())], 0, HashMap::new(), Codeset::Latin1);
        let (recs, _) = parse_records(&spike_stream()).unwrap();
        for r in recs {
            b.feed(r).unwrap();
        }
        let c = |v: &[&str]| v.iter().map(|x| Cell::Text(x.to_string())).collect::<Vec<_>>();
        assert_eq!(b.disagrees_with(Some(&c(&["1", "12", "1.75", "alpha-2"]))), None);
        let late = b.disagrees_with(Some(&c(&["1", "30", "3.00", "alpha-2"]))).unwrap();
        assert!(late.contains("qty, price"), "{late}");
        assert!(b.disagrees_with(None).is_some());
    }

    #[test]
    fn a_key_that_changed_and_server_errors_are_partial() {
        let mut s = schema();
        s.extend(begin(40, 200, 2000));
        let five = ["00000005", "00000001", "c10132000000", "02616c"].concat();
        let six = ["00000006", "00000001", "c10132000000", "02616c"].concat();
        s.extend(change(40, 40, 0x100, &five, &[3]));
        s.extend(commit(40, 2000, 0x110));
        s.extend(begin(41, 200, 2001));
        s.extend(change(42, 41, 0x200, &five, &[3]));
        s.extend(change(43, 41, 0x201, &six, &[3]));
        s.extend(commit(41, 2001, 0x210));
        let mut err = Vec::new();
        err.extend_from_slice(&0u32.to_be_bytes());
        err.extend_from_slice(&(-83713i32).to_be_bytes());
        s.extend(record(202, &err, b"log gone\0"));
        s.extend(record(201, &[0, 0, 0, 70, 0, 0, 0, 0], &[]));
        let h = history(&s, "6", 0);
        assert_eq!(h.events.len(), 1);
        assert_eq!(h.events[0].before, Some(some(&["5", "1", "1.50", "al"])));
        assert!(h.partial.iter().any(|p| p.contains("clave primaria") && p.contains("5")), "{:?}", h.partial);
        assert!(h.partial.iter().any(|p| p.contains("log gone") && p.contains("-83713")), "{:?}", h.partial);
        // Following the old key shows the row until it moved.
        let old = history(&s, "5", 0);
        assert_eq!(old.events.iter().map(|e| e.op).collect::<Vec<_>>(), vec!["insert", "update"]);
    }

    /// A read cut short (a stuck reader, the time limit) never claims the row had no changes: nothing was seen is not
    /// the same as nothing happened.
    #[test]
    fn a_read_cut_short_infers_nothing() {
        let b = || Builder::new(vec![("id".into(), "1".into())], 0, HashMap::new(), Codeset::Latin1);
        let whole = b().finish(61, None, vec![]);
        assert!(whole.partial.iter().any(|p| p.contains("ya tenía sus valores actuales")), "{:?}", whole.partial);
        let cut = b().finish(61, Some("El lector CDC del servidor no respondió".into()), vec![]);
        assert_eq!(cut.partial.len(), 1, "{:?}", cut.partial);
        assert!(!cut.partial.iter().any(|p| p.contains("ya tenía")), "{:?}", cut.partial);
    }

    /// The note of tables Celer turned full row logging on for survives a crash and is cleared once it is off.
    #[test]
    fn the_ledger_of_tables_turned_on() {
        let dir = std::env::temp_dir().join(format!("celer-ledger-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LEDGER);
        let p = Some(path.as_path());
        assert!(!ledger_has(p, "a\tdb:u.t1"));
        ledger_add(p, "a\tdb:u.t1");
        ledger_add(p, "a\tdb:u.t1");
        ledger_add(p, "a\tdb:u.t2");
        assert!(ledger_has(p, "a\tdb:u.t1") && ledger_has(p, "a\tdb:u.t2"));
        ledger_forget(p, "a\tdb:u.t1");
        assert!(!ledger_has(p, "a\tdb:u.t1") && ledger_has(p, "a\tdb:u.t2"));
        ledger_forget(p, "a\tdb:u.t2");
        assert!(!path.exists());
        assert!(!ledger_has(None, "x"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// After a server error before the table existed, the read goes on from the first position it reads cleanly from:
    /// found by trying later logs, then bisecting inside one, to within 32 bytes and never before it.
    #[test]
    fn the_first_readable_position_after_an_error() {
        let sizes = HashMap::from([(70, 0x20_0000), (71, 0x20_0000), (72, 0x20_0000), (73, 0x20_0000)]);
        let tried = std::cell::RefCell::new(Vec::new());
        let from = |good: Lsn| {
            move |at: Lsn| -> Result<Option<bool>> { Ok(Some(at >= good)) }
        };
        let probe = from(Lsn(73, 0x9f200));
        let logged = |at: Lsn| {
            tried.borrow_mut().push(at);
            probe(at)
        };
        let found = first_readable(Lsn(73, 0), Lsn(73, 0x10_0000), &sizes, &logged).unwrap().unwrap();
        assert!(found >= Lsn(73, 0x9f200) && found <= Lsn(73, 0x9f220), "{found}");
        assert!(tried.borrow().len() < 24, "bisected: {} tries", tried.borrow().len());
        // In an older log: later log starts first, then inside the log that has it.
        let found = first_readable(Lsn(70, 0x100), Lsn(73, 0x5000), &sizes, &from(Lsn(72, 0x1234))).unwrap().unwrap();
        assert!(found >= Lsn(72, 0x1234) && found <= Lsn(72, 0x1254), "{found}");
        // Readable from the start of the next log on.
        assert_eq!(first_readable(Lsn(71, 0x100), Lsn(73, 0x5000), &sizes, &from(Lsn(72, 0))).unwrap(), Some(Lsn(72, 0)));
        // Nothing readable before the end: the end, where there is nothing left to read.
        assert_eq!(first_readable(Lsn(73, 0x100), Lsn(73, 0x5000), &sizes, &from(Lsn(99, 0))).unwrap(), Some(Lsn(73, 0x5000)));
        // A probe that cannot tell stops the search.
        assert_eq!(first_readable(Lsn(73, 0), Lsn(73, 0x5000), &sizes, &|_| Ok(None)).unwrap(), None);
        // An error in the stream is taken back for the history to report it once.
        let mut b = Builder::new(vec![], 0, HashMap::new(), Codeset::Latin1);
        let mut err = Vec::new();
        err.extend_from_slice(&1u32.to_be_bytes());
        err.extend_from_slice(&(-83790i32).to_be_bytes());
        for r in parse_records(&record(202, &err, b"")).unwrap().0 {
            b.feed(r).unwrap();
        }
        assert_eq!(b.failed, Some(-83790));
        assert_eq!(b.take_error(), "error -83790");
        assert_eq!(b.failed, None);
        assert!(b.finish(1, None, vec![]).partial.iter().all(|p| !p.contains("-83790")));
    }

    #[test]
    fn engines_and_protocols_without_history() {
        assert!(unavailable(DbKind::Informix, "jdbc").is_none());
        assert!(unavailable(DbKind::Informix, "drda").unwrap().starts_with("No disponible por DRDA"));
        assert!(unavailable(DbKind::Informix, "sqli").unwrap().contains("JDBC"));
        assert_eq!(unavailable(DbKind::Postgres, "").unwrap(), "No disponible en PostgreSQL: por ahora el historial de una fila se lee solo de los logs de Informix.");
        for kind in [DbKind::Mysql, DbKind::Mssql, DbKind::Sqlite, DbKind::Odbc] {
            assert!(unavailable(kind, "").unwrap().starts_with("No disponible en "));
        }
        assert!(ident("celer").is_ok() && ident("x; DROP").is_err() && ident("").is_err());
        assert_eq!(lit("o'brien"), "'o''brien'");
    }
}
