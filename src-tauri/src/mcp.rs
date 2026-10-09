//! Servidor MCP (Model Context Protocol) de Celer.
//!
//! `celer --mcp` habla JSON-RPC 2.0 por stdio (una línea JSON por mensaje) para que asistentes de
//! IA (Claude Desktop, Claude Code, cualquier cliente MCP) lean metadatos y datos a través de
//! Celer, **solo hasta donde el usuario lo permita** en `mcp.json`:
//!
//! - Cada conexión tiene un nivel: `none` (invisible, el valor por defecto), `schema` (solo
//!   metadatos), `read` (también consultas de lectura) o `write` (también sentencias que modifican).
//! - Las conexiones marcadas como producción o solo lectura nunca pasan de `read`.
//! - Las consultas de lectura pasan por un filtro léxico (una sola sentencia, solo lectura) y,
//!   además, se ejecutan dentro de una transacción de solo lectura cuando el motor lo permite.
//! - Las columnas cuyo nombre coincide con `redactPattern` se ocultan.
//! - Cada llamada queda registrada en `mcp-audit.jsonl`.
//!
//! La configuración se relee en cada llamada: los cambios hechos en la interfaz se aplican al
//! instante. Por stdout solo sale JSON del protocolo; los avisos van a stderr.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::model::*;
use crate::session::{Driver, SessionHandle};
use crate::store::Store;

pub const PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
pub const HARD_MAX_ROWS: u32 = 5000;
pub const DEFAULT_REDACT: &str =
    "(?i)pass(word)?|secret|token|api_?key|hash|salt|credit_?card|iban|ssn";
const REDACTED: &str = "[oculto]";
const CONFIG_FILE: &str = "mcp.json";
const AUDIT_FILE: &str = "mcp-audit.jsonl";
const AUDIT_KEEP: usize = 2000;
/// Se compacta al superar este tamaño. Las 2.000 entradas que se conservan (el SQL sin comentarios y
/// recortado por el medio a unos 4.000 caracteres, el error a 500) suelen ocupar bastante menos, así que no se
/// compacta en cada escritura.
const AUDIT_COMPACT_BYTES: u64 = 16 * 1024 * 1024;
/// SQL kept in the audit: its start and its end, this many characters each.
const AUDIT_SQL_ENDS: usize = 2000;
const AUDIT_DETAIL_CHARS: usize = 2 * AUDIT_SQL_ENDS + 40;
const MAX_CELL_CHARS: usize = 2000;
const MAX_DDL_CHARS: usize = 20000;
const MAX_TABLES: usize = 2000;
const MAX_SEARCH: usize = 200;
const SENSITIVE_TTL: Duration = Duration::from_secs(120);
const DISABLED_MSG: &str = "El acceso de asistentes de IA (MCP) está desactivado en Celer. \
     El usuario puede activarlo en Celer › Ajustes › IA.";

pub const TOOL_NAMES: &[&str] = &[
    "list_connections",
    "list_databases",
    "list_tables",
    "describe_table",
    "search_objects",
    "sample_rows",
    "run_query",
    "execute_statement",
];

/// Tools that act in the running Celer (#100). They are listed only with "Controlar la aplicación" on, and each
/// sub-switch adds its own: see `tool_allowed`.
pub const APP_TOOL_NAMES: &[&str] = &[
    "get_app_state",
    "list_library",
    "get_library_script",
    "add_library_script",
    "open_console",
    "open_table",
    "open_er_diagram",
    "open_object",
];
const MAX_APP_SQL: usize = 500_000;
const MAX_STATE_SQL: usize = 4000;
const MAX_LIBRARY_LIST: usize = 500;

/// Directorio de datos de la aplicación: el mismo que usa la interfaz
/// (`app_data_dir` de Tauri para el identificador `es.celer.app`).
/// En depuración, `CELER_DATA_DIR` lo sustituye (como en la interfaz).
pub fn default_data_dir() -> PathBuf {
    crate::dev_data_dir().unwrap_or_else(|| {
        dirs::data_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("es.celer.app")
    })
}

// ───────────────────────────── Configuración ─────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Default)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    #[default]
    None,
    Schema,
    Read,
    Write,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::None => "none",
            Level::Schema => "schema",
            Level::Read => "read",
            Level::Write => "write",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnPermission {
    pub level: Level,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_rows: Option<u32>,
}

/// "Controlar la aplicación" (#100): what an assistant may do in the running Celer. Off by default; the sub-switches
/// only count with it on.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppControl {
    pub enabled: bool,
    /// Open consoles, tables, E-R diagrams and object definitions.
    pub open_tabs: bool,
    /// Add scripts to the library.
    pub write_library: bool,
    /// Run the SQL of a console it opens, within the connection's level.
    pub run_opened: bool,
}

impl Default for AppControl {
    fn default() -> Self {
        AppControl { enabled: false, open_tabs: true, write_library: true, run_opened: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct McpConfig {
    pub enabled: bool,
    pub max_rows: u32,
    pub timeout_secs: u32,
    pub redact_pattern: String,
    pub connections: BTreeMap<String, ConnPermission>,
    pub app_control: AppControl,
}

impl Default for McpConfig {
    fn default() -> Self {
        McpConfig {
            enabled: false,
            max_rows: 200,
            timeout_secs: 30,
            redact_pattern: DEFAULT_REDACT.into(),
            connections: BTreeMap::new(),
            app_control: AppControl::default(),
        }
    }
}

/// Whether a tool is offered (and may be called) with this configuration: the database tools always, the app
/// tools only with "Controlar la aplicación" on and their sub-switch.
pub fn tool_allowed(cfg: &McpConfig, name: &str) -> bool {
    if TOOL_NAMES.contains(&name) {
        return true;
    }
    let a = &cfg.app_control;
    a.enabled
        && match name {
            "get_app_state" | "list_library" | "get_library_script" => true,
            "add_library_script" => a.write_library,
            "open_console" | "open_table" | "open_er_diagram" | "open_object" => a.open_tabs,
            _ => false,
        }
}

fn app_tool_refused(cfg: &McpConfig, name: &str) -> String {
    let what = if !cfg.app_control.enabled {
        "que la IA controle la aplicación"
    } else if name == "add_library_script" {
        "que la IA escriba en la biblioteca de scripts"
    } else {
        "que la IA abra pestañas"
    };
    format!("El usuario no permite {what}. Puede cambiarlo en Celer › Ajustes › IA y MCP › Controlar la aplicación.")
}

impl McpConfig {
    /// Lleva los valores a rangos razonables.
    pub fn sanitized(mut self) -> McpConfig {
        self.max_rows = self.max_rows.clamp(1, HARD_MAX_ROWS);
        self.timeout_secs = self.timeout_secs.clamp(1, 3600);
        for p in self.connections.values_mut() {
            if let Some(m) = p.max_rows.as_mut() {
                *m = (*m).clamp(1, HARD_MAX_ROWS);
            }
        }
        self
    }
}

/// Lee `mcp.json`. Si falta o no es válido se usan los valores seguros por defecto (desactivado).
pub fn load_config(store: &Store) -> McpConfig {
    store
        .read(CONFIG_FILE)
        .and_then(|s| serde_json::from_str::<McpConfig>(s.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_default()
        .sanitized()
}

pub fn save_config(store: &Store, cfg: McpConfig) -> anyhow::Result<()> {
    let cfg = cfg.sanitized();
    store.write_atomic(CONFIG_FILE, &serde_json::to_string_pretty(&cfg)?)
}

/// Nivel efectivo de una conexión: producción y solo lectura nunca pasan de `read`.
pub fn effective_level(cfg: &McpConfig, conn: &ConnConfig) -> Level {
    let lvl = cfg
        .connections
        .get(&conn.id)
        .map(|p| p.level)
        .unwrap_or(Level::None);
    if (conn.production || conn.read_only) && lvl > Level::Read {
        Level::Read
    } else {
        lvl
    }
}

/// Filas máximas: min(pedidas, límite de la conexión, límite global, 5000).
pub fn row_cap(cfg: &McpConfig, conn_id: &str, requested: Option<u64>, default: u32) -> usize {
    let mut limit = cfg.max_rows.min(HARD_MAX_ROWS);
    if let Some(m) = cfg.connections.get(conn_id).and_then(|p| p.max_rows) {
        limit = limit.min(m);
    }
    let limit = limit.max(1) as u64;
    requested.unwrap_or(default as u64).clamp(1, limit) as usize
}

// ───────────────────────────── Ocultación ─────────────────────────────

pub struct Redactor(Option<regex::Regex>);

impl Redactor {
    /// Un patrón vacío desactiva la ocultación; uno inválido cae al patrón por defecto.
    pub fn new(pattern: &str) -> Redactor {
        if pattern.trim().is_empty() {
            return Redactor(None);
        }
        Redactor(
            regex::Regex::new(pattern)
                .or_else(|_| regex::Regex::new(DEFAULT_REDACT))
                .ok(),
        )
    }
    pub fn active(&self) -> bool {
        self.0.is_some()
    }
    pub fn matches(&self, name: &str) -> bool {
        self.0.as_ref().is_some_and(|r| r.is_match(name))
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max).collect();
        t.push_str("…[truncado]");
        t
    }
}

/// The SQL as the audit keeps it: what runs, without comments (a long leading comment must not push the statement
/// out); a long one keeps its start and its end.
fn audit_sql(sql: &str, kind: DbKind) -> String {
    let c: Vec<char> = sql.chars().collect();
    // Only what is a comment under every quoting variant of the dialect is left out: text that one of them reads
    // as code stays.
    let mut comment = vec![true; c.len()];
    for d in dialects(kind) {
        let mut marks = vec![false; c.len()];
        if lex_marking(sql, *d, Some(&mut marks)).is_err() {
            comment.fill(false);
            break;
        }
        comment.iter_mut().zip(marks).for_each(|(a, b)| *a &= b);
    }
    let mut out = String::new();
    for (ch, skip) in c.into_iter().zip(comment) {
        if skip {
            if !out.is_empty() && !out.ends_with(char::is_whitespace) {
                out.push(' ');
            }
        } else {
            out.push(ch);
        }
    }
    let out = out.trim();
    let n = out.chars().count();
    if n <= 2 * AUDIT_SQL_ENDS {
        return out.to_string();
    }
    let head: String = out.chars().take(AUDIT_SQL_ENDS).collect();
    let tail: String = out.chars().skip(n - AUDIT_SQL_ENDS).collect();
    format!("{head} …[{} caracteres omitidos]… {tail}", n - 2 * AUDIT_SQL_ENDS)
}

fn cell_json(c: &Cell) -> Value {
    match c {
        Cell::Text(s) => Value::String(truncate_chars(s, MAX_CELL_CHARS)),
        other => serde_json::to_value(other).unwrap_or(Value::Null),
    }
}

/// Convierte el primer resultado de una ejecución en JSON compacto, ocultando columnas sensibles.
fn render_exec(out: &ExecOutput, red: &Redactor, elapsed_ms: u64) -> (Value, u64) {
    let rs = out
        .results
        .iter()
        .find(|r| !r.columns.is_empty())
        .or(out.results.first());
    let Some(rs) = rs else {
        return (
            json!({"columns": [], "rows": [], "rowCount": 0, "truncated": false, "elapsedMs": elapsed_ms}),
            0,
        );
    };
    let mask: Vec<bool> = rs.columns.iter().map(|c| red.matches(&c.name)).collect();
    let rows: Vec<Value> = rs
        .rows
        .iter()
        .map(|r| {
            Value::Array(
                r.iter()
                    .enumerate()
                    .map(|(i, c)| match c {
                        Cell::Null => Value::Null,
                        _ if mask.get(i).copied().unwrap_or(false) => json!(REDACTED),
                        _ => cell_json(c),
                    })
                    .collect(),
            )
        })
        .collect();
    let n = rows.len() as u64;
    let mut v = json!({
        "columns": rs.columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
        "types": rs.columns.iter().map(|c| c.type_name.clone()).collect::<Vec<_>>(),
        "rows": rows,
        "rowCount": n,
        "truncated": rs.has_more,
        "elapsedMs": elapsed_ms,
    });
    let hidden: Vec<&str> = rs
        .columns
        .iter()
        .zip(&mask)
        .filter(|(_, m)| **m)
        .map(|(c, _)| c.name.as_str())
        .collect();
    if !hidden.is_empty() {
        v["redactedColumns"] = json!(hidden);
    }
    if let Some(n) = rs.rows_affected {
        v["rowsAffected"] = json!(n);
    }
    (v, n)
}

// ───────────────────────────── Filtro de sentencias ─────────────────────────────

/// Reglas léxicas de un dialecto. Para no depender de una sola interpretación, cada sentencia se
/// analiza con todas las variantes plausibles del motor y debe pasar el filtro en todas.
#[derive(Clone, Copy, Debug)]
struct Lex {
    /// `\` escapa dentro de cadenas.
    backslash: bool,
    /// Cadenas `$tag$ … $tag$` y `E'…'` (PostgreSQL).
    dollar: bool,
    /// Comentarios `/* */` anidados.
    nested: bool,
    /// `#` inicia comentario (MySQL).
    hash: bool,
    /// `--` solo es comentario si le sigue un espacio (MySQL).
    dash_space: bool,
    /// `"…"` es una cadena (MySQL sin ANSI_QUOTES) y no un identificador.
    dq_string: bool,
    backtick: bool,
    bracket: bool,
    /// Rechaza comentarios ejecutables `/*! … */` (MySQL).
    mysql_exec: bool,
}

const PG: Lex = Lex {
    backslash: false,
    dollar: true,
    nested: true,
    hash: false,
    dash_space: false,
    dq_string: false,
    backtick: false,
    bracket: false,
    mysql_exec: false,
};
const PG_BS: Lex = Lex {
    backslash: true,
    ..PG
};
const MY: Lex = Lex {
    backslash: true,
    dollar: false,
    nested: false,
    hash: true,
    dash_space: true,
    dq_string: true,
    backtick: true,
    bracket: false,
    mysql_exec: true,
};
const MY_ANSI: Lex = Lex {
    backslash: false,
    dq_string: false,
    ..MY
};
const STD: Lex = Lex {
    backslash: false,
    dollar: false,
    nested: false,
    hash: false,
    dash_space: false,
    dq_string: false,
    backtick: true,
    bracket: true,
    mysql_exec: false,
};
const STD_NESTED: Lex = Lex {
    nested: true,
    ..STD
};

fn dialects(kind: DbKind) -> &'static [Lex] {
    match kind {
        DbKind::Postgres => &[PG, PG_BS],
        DbKind::Mysql => &[MY, MY_ANSI],
        DbKind::Sqlite => &[STD],
        DbKind::Mssql => &[STD, STD_NESTED],
        DbKind::Informix | DbKind::Odbc => &[PG, PG_BS, MY, MY_ANSI, STD, STD_NESTED],
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// Palabra sin comillas, en mayúsculas.
    Word(String),
    /// Identificador entre comillas (contenido original).
    Ident(String),
    Str,
    Num,
    P(char),
}

fn is_word_start(c: char, o: Lex) -> bool {
    c.is_alphabetic() || c == '_' || (c == '$' && !o.dollar)
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

fn read_quoted(c: &[char], i: usize, q: char, backslash: bool) -> Result<usize, String> {
    let mut j = i + 1;
    loop {
        if j >= c.len() {
            return Err("Cadena sin cerrar en la consulta".into());
        }
        if backslash && c[j] == '\\' {
            j += 2;
            continue;
        }
        if c[j] == q {
            if c.get(j + 1) == Some(&q) {
                j += 2;
                continue;
            }
            return Ok(j + 1);
        }
        j += 1;
    }
}

fn read_ident(c: &[char], i: usize, close: char) -> Result<(String, usize), String> {
    let mut j = i + 1;
    let mut s = String::new();
    loop {
        if j >= c.len() {
            return Err("Identificador entre comillas sin cerrar".into());
        }
        if c[j] == close {
            if c.get(j + 1) == Some(&close) {
                s.push(close);
                j += 2;
                continue;
            }
            return Ok((s, j + 1));
        }
        s.push(c[j]);
        j += 1;
    }
}

/// Si en `i` empieza una etiqueta `$tag$` o `$$`, devuelve el índice del `$` final.
fn dollar_tag(c: &[char], i: usize) -> Option<usize> {
    let mut j = i + 1;
    match c.get(j) {
        Some('$') => return Some(j),
        Some(ch) if ch.is_alphabetic() || *ch == '_' => {}
        _ => return None,
    }
    while j < c.len() && (c[j].is_alphanumeric() || c[j] == '_') {
        j += 1;
    }
    (c.get(j) == Some(&'$')).then_some(j)
}

/// Divide en sentencias (sin las vacías) y tokeniza, respetando cadenas y comentarios.
fn lex(sql: &str, o: Lex) -> Result<Vec<Vec<Tok>>, String> {
    lex_marking(sql, o, None)
}

/// `lex`, also marking in `comments` (one flag per char) the chars that are comments.
fn lex_marking(sql: &str, o: Lex, mut comments: Option<&mut Vec<bool>>) -> Result<Vec<Vec<Tok>>, String> {
    let c: Vec<char> = sql.chars().collect();
    let n = c.len();
    let mut stmts = Vec::new();
    let mut cur: Vec<Tok> = Vec::new();
    let mut i = 0;
    while i < n {
        let ch = c[i];
        let next = c.get(i + 1).copied();
        let at = i;
        if ch.is_whitespace() {
            i += 1;
        } else if (ch == '-'
            && next == Some('-')
            && (!o.dash_space
                || c.get(i + 2)
                    .map_or(true, |x| x.is_whitespace() || x.is_control())))
            || (ch == '#' && o.hash)
        {
            while i < n && c[i] != '\n' {
                i += 1;
            }
            if let Some(m) = comments.as_deref_mut() {
                m[at..i].iter_mut().for_each(|f| *f = true);
            }
        } else if ch == '/' && next == Some('*') {
            if o.mysql_exec
                && (c.get(i + 2) == Some(&'!')
                    || (c.get(i + 2) == Some(&'M') && c.get(i + 3) == Some(&'!')))
            {
                return Err("No se permiten comentarios ejecutables /*! … */".into());
            }
            let mut depth = 1;
            i += 2;
            loop {
                if i >= n {
                    return Err("Comentario /* sin cerrar en la consulta".into());
                }
                if c[i] == '*' && c.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else if o.nested && c[i] == '/' && c.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if let Some(m) = comments.as_deref_mut() {
                m[at..i].iter_mut().for_each(|f| *f = true);
            }
        } else if ch == '\'' {
            i = read_quoted(&c, i, '\'', o.backslash)?;
            cur.push(Tok::Str);
        } else if ch == '"' {
            if o.dq_string {
                i = read_quoted(&c, i, '"', o.backslash)?;
                cur.push(Tok::Str);
            } else {
                let (s, j) = read_ident(&c, i, '"')?;
                cur.push(Tok::Ident(s));
                i = j;
            }
        } else if ch == '`' && o.backtick {
            let (s, j) = read_ident(&c, i, '`')?;
            cur.push(Tok::Ident(s));
            i = j;
        } else if ch == '[' && o.bracket {
            let (s, j) = read_ident(&c, i, ']')?;
            cur.push(Tok::Ident(s));
            i = j;
        } else if ch == '$' && o.dollar && dollar_tag(&c, i).is_some() {
            let end = dollar_tag(&c, i).unwrap_or(i);
            let tag: Vec<char> = c[i..=end].to_vec();
            let mut j = end + 1;
            loop {
                if j + tag.len() > n {
                    return Err("Cadena $$ sin cerrar en la consulta".into());
                }
                if c[j..j + tag.len()] == tag[..] {
                    break;
                }
                j += 1;
            }
            i = j + tag.len();
            cur.push(Tok::Str);
        } else if ch == ';' {
            if !cur.is_empty() {
                stmts.push(std::mem::take(&mut cur));
            }
            i += 1;
        } else if is_word_start(ch, o) {
            let st = i;
            while i < n && is_word_char(c[i]) {
                i += 1;
            }
            let w: String = c[st..i].iter().collect();
            if o.dollar
                && (w == "U" || w == "u")
                && c.get(i) == Some(&'&')
                && c.get(i + 1) == Some(&'"')
            {
                // U&"d\0061ta" names an object through escapes the filters cannot see.
                return Err("No se permiten identificadores U&\"…\"".into());
            }
            if o.dollar && (w == "E" || w == "e") && c.get(i) == Some(&'\'') {
                i = read_quoted(&c, i, '\'', true)?;
                cur.push(Tok::Str);
            } else {
                cur.push(Tok::Word(w.to_uppercase()));
            }
        } else if ch.is_ascii_digit() {
            while i < n && (c[i].is_alphanumeric() || c[i] == '.' || c[i] == '_') {
                i += 1;
            }
            cur.push(Tok::Num);
        } else {
            cur.push(Tok::P(ch));
            i += 1;
        }
    }
    if !cur.is_empty() {
        stmts.push(cur);
    }
    Ok(stmts)
}

/// Tokens de la única sentencia del texto, una lista por variante de dialecto.
fn single_statement(sql: &str, kind: DbKind) -> Result<Vec<Vec<Tok>>, String> {
    let mut all = Vec::new();
    for d in dialects(kind) {
        let mut st = lex(sql, *d)?;
        match st.len() {
            0 => return Err("La sentencia está vacía".into()),
            1 => all.push(st.remove(0)),
            _ => {
                return Err(
                    "Solo se permite una sentencia por llamada (sin ';' intermedios)".into(),
                )
            }
        }
    }
    Ok(all)
}

const READ_START: &[&str] = &[
    "SELECT", "WITH", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "VALUES", "TABLE", "PRAGMA",
];

/// Palabras que en una consulta de lectura delatan otra sentencia o una modificación
/// (salvo cuando van seguidas de `(`: entonces son funciones, p. ej. `INSERT()` o `TRUNCATE()` de MySQL).
const WRITE_WORDS: &[&str] = &[
    "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "TRUNCATE", "CREATE", "ALTER", "DROP",
    "RENAME", "GRANT", "REVOKE", "DENY", "ATTACH", "DETACH", "COPY", "KILL", "SHUTDOWN", "BACKUP",
    "RESTORE", "DBCC", "BULK", "LOCK", "UNLOCK", "COMMIT", "ROLLBACK", "SAVEPOINT", "PREPARE",
    "DEALLOCATE", "HANDLER", "CHECKPOINT", "RECONFIGURE", "VACUUM", "REINDEX",
];

/// Funciones con efectos (ficheros, procesos, administración) que nunca se permiten.
const DENY_FUNCS: &[&str] = &[
    "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_rotate_logfile",
    "pg_promote", "pg_switch_wal", "pg_create_restore_point", "pg_read_file",
    "pg_read_binary_file", "pg_ls_dir", "pg_stat_file", "pg_file_write", "lo_import", "lo_export",
    "dblink", "dblink_exec", "dblink_connect", "dblink_send_query", "load_file", "sys_exec",
    "sys_eval", "openrowset", "opendatasource", "openquery", "load_extension", "writefile",
    "readfile", "edit", "fts3_tokenizer",
];

/// Funciones que escriben o bloquean: prohibidas en lectura.
const DENY_FUNCS_READ: &[&str] = &[
    "nextval", "setval", "set_config", "pg_advisory_lock", "pg_advisory_xact_lock",
    "pg_try_advisory_lock", "pg_logical_emit_message", "lo_unlink", "lo_create", "lo_from_bytea",
    "lo_put", "get_lock",
];

const PRAGMA_FUNCS: &[&str] = &[
    "table_info", "table_xinfo", "table_list", "index_list", "index_info", "index_xinfo",
    "foreign_key_list", "foreign_key_check", "integrity_check", "quick_check",
];

const PRAGMA_SETTINGS: &[&str] = &[
    "database_list", "collation_list", "function_list", "module_list", "pragma_list",
    "compile_options", "user_version", "application_id", "schema_version", "data_version",
    "page_count", "page_size", "freelist_count", "encoding", "foreign_keys", "journal_mode",
    "auto_vacuum", "cache_size", "synchronous", "busy_timeout", "query_only", "temp_store",
];

fn first_word(t: &[Tok]) -> Option<&str> {
    t.iter()
        .find(|x| **x != Tok::P('('))
        .and_then(|x| match x {
            Tok::Word(w) => Some(w.as_str()),
            _ => None,
        })
}

fn check_pragma(t: &[Tok]) -> Result<(), String> {
    if t.contains(&Tok::P('=')) {
        return Err("Solo se permiten PRAGMA de lectura (sin '=')".into());
    }
    let name = match (t.get(1), t.get(2), t.get(3)) {
        (Some(_), Some(Tok::P('.')), Some(Tok::Word(w))) => w,
        (Some(Tok::Word(w)), _, _) => w,
        _ => return Err("PRAGMA no reconocido".into()),
    };
    let name = name.to_lowercase();
    let has_args = t.contains(&Tok::P('('));
    if PRAGMA_FUNCS.contains(&name.as_str())
        || (PRAGMA_SETTINGS.contains(&name.as_str()) && !has_args)
    {
        Ok(())
    } else {
        Err(format!("PRAGMA {name} no está permitido en modo lectura"))
    }
}

fn denied_function(w: &str, read: bool) -> bool {
    let l = w.to_lowercase();
    l.starts_with("xp_")
        || DENY_FUNCS.contains(&l.as_str())
        || (read && DENY_FUNCS_READ.contains(&l.as_str()))
}

fn check_read_tokens(t: &[Tok]) -> Result<(), String> {
    let Some(first) = first_word(t) else {
        return Err("La consulta debe empezar por SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, VALUES, TABLE o PRAGMA".into());
    };
    if !READ_START.contains(&first) {
        return Err(format!(
            "Solo se permiten consultas de lectura (SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, VALUES, TABLE o PRAGMA de lectura); «{first}» no está permitido aquí"
        ));
    }
    if first == "PRAGMA" {
        return check_pragma(t);
    }
    for (k, tok) in t.iter().enumerate() {
        let call = t.get(k + 1) == Some(&Tok::P('('));
        let w = match tok {
            Tok::Word(w) => w,
            // A quoted name calls the same function: "pg_read_file"(…), `get_lock`(…), [xp_cmdshell].
            Tok::Ident(w) => {
                if (call && denied_function(w, true)) || w.to_lowercase().starts_with("xp_") {
                    return Err(format!("{} no está permitido", w.to_lowercase()));
                }
                continue;
            }
            _ => continue,
        };
        let next = t.get(k + 1);
        match w.as_str() {
            "INTO" => {
                return Err("SELECT … INTO no está permitido: crea o modifica objetos".into())
            }
            "EXEC" | "EXECUTE" => {
                return Err("No se permite ejecutar procedimientos en una consulta de lectura".into())
            }
            "FOR" => {
                if let Some(Tok::Word(n)) = next {
                    if matches!(n.as_str(), "UPDATE" | "SHARE" | "KEY" | "NO") {
                        return Err("FOR UPDATE / FOR SHARE bloquea filas: no está permitido".into());
                    }
                }
            }
            _ => {}
        }
        if WRITE_WORDS.contains(&w.as_str()) && !call && !(first == "SHOW" && w == "CREATE") {
            return Err(format!(
                "La consulta contiene «{w}»: con run_query solo se permiten consultas de lectura"
            ));
        }
        if call && denied_function(w, true) {
            return Err(format!("La función {} no está permitida", w.to_lowercase()));
        }
        if w.starts_with("XP_") {
            return Err(format!("{} no está permitido", w.to_lowercase()));
        }
    }
    Ok(())
}

fn check_write_tokens(t: &[Tok]) -> Result<(), String> {
    let first = first_word(t).unwrap_or("");
    if matches!(
        first,
        "SHUTDOWN" | "KILL" | "GRANT" | "REVOKE" | "DENY" | "ATTACH" | "DETACH" | "RECONFIGURE"
    ) {
        return Err(format!(
            "«{first}» es una operación de administración: no está permitida para asistentes"
        ));
    }
    for (k, tok) in t.iter().enumerate() {
        let w = match tok {
            Tok::Word(w) => w,
            Tok::Ident(w) => {
                let call = t.get(k + 1) == Some(&Tok::P('('));
                if (call && denied_function(w, false)) || w.to_lowercase().starts_with("xp_") {
                    return Err(format!("{} no está permitido", w.to_lowercase()));
                }
                continue;
            }
            _ => continue,
        };
        let next = match t.get(k + 1) {
            Some(Tok::Word(n)) => n.as_str(),
            _ => "",
        };
        if matches!(w.as_str(), "CREATE" | "ALTER" | "DROP")
            && matches!(
                next,
                "USER" | "ROLE" | "LOGIN" | "DATABASE" | "SERVER" | "EXTENSION" | "TABLESPACE"
            )
        {
            return Err(format!(
                "{w} {next} es una operación de administración: no está permitida para asistentes"
            ));
        }
        if w == "PROGRAM" || (w == "INTO" && matches!(next, "OUTFILE" | "DUMPFILE")) {
            return Err("No se permite leer ni escribir ficheros o programas del servidor".into());
        }
        if denied_function(w, false) {
            return Err(format!("{} no está permitido", w.to_lowercase()));
        }
    }
    Ok(())
}

/// For read-only connections in the GUI: true when any statement of a batch (under any quoting variant of the
/// dialect) writes. Unlike `run_query` it accepts several statements, and harmless ones such as SET or USE.
pub fn batch_writes(sql: &str, kind: DbKind) -> bool {
    const WRITE_START: &[&str] = &[
        "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "REPLACE", "TRUNCATE", "CREATE", "ALTER",
        "DROP", "RENAME", "GRANT", "REVOKE", "DENY", "EXEC", "EXECUTE", "CALL", "COPY", "LOAD",
        "UNLOAD", "BULK", "ATTACH", "DETACH", "VACUUM", "REINDEX", "COMMENT", "LOCK", "IMPORT",
        // A PostgreSQL DO block runs any PL/pgSQL; MySQL's DO evaluates functions that may write.
        "DO", "REFRESH", "CLUSTER", "REASSIGN",
    ];
    // SQL Server runs a bare procedure name at the start of a batch (`sp_executesql N'DELETE …'`) and needs no ';'
    // between statements, and nothing at session level makes it read-only: only these words may start a batch or
    // statement, and a write keyword anywhere in it counts.
    const MSSQL_READ_START: &[&str] = &[
        "SELECT", "WITH", "SET", "USE", "DECLARE", "PRINT", "IF", "ELSE", "BEGIN", "END", "WHILE", "BREAK",
        "CONTINUE", "RETURN", "COMMIT", "ROLLBACK", "SAVE", "RAISERROR", "THROW", "WAITFOR", "OPEN", "FETCH",
        "CLOSE", "DEALLOCATE", "EXPLAIN", "GO",
    ];
    const MSSQL_WRITE_WORDS: &[&str] = &[
        "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "CREATE", "ALTER", "DROP", "INTO", "EXEC",
        "EXECUTE", "GRANT", "REVOKE", "DENY", "BULK",
    ];
    // Session settings that would turn the server's read-only mode off (PostgreSQL, MySQL).
    const READ_ONLY_VARS: &[&str] = &["DEFAULT_TRANSACTION_READ_ONLY", "TRANSACTION_READ_ONLY", "TX_READ_ONLY"];
    for d in dialects(kind) {
        let Ok(statements) = lex(sql, *d) else {
            // Unbalanced quotes: be conservative.
            return crate::session::is_mutating(sql);
        };
        for t in &statements {
            let first = first_word(t).unwrap_or("");
            if WRITE_START.contains(&first) {
                return true;
            }
            if kind == DbKind::Mssql {
                if !MSSQL_READ_START.contains(&first) {
                    return true;
                }
                for (k, tok) in t.iter().enumerate() {
                    let Tok::Word(w) = tok else { continue };
                    let next = t.get(k + 1);
                    // UPDATE(col) is a trigger function; pass-through queries run anything on the linked
                    // server; a word after GO starts a new batch.
                    let batch_start = match next {
                        Some(Tok::Word(n)) => !MSSQL_READ_START.contains(&n.as_str()),
                        Some(Tok::Ident(_)) => true,
                        _ => false,
                    };
                    if (MSSQL_WRITE_WORDS.contains(&w.as_str()) && next != Some(&Tok::P('(')))
                        || matches!(w.as_str(), "OPENQUERY" | "OPENROWSET" | "OPENDATASOURCE")
                        || (w == "GO" && batch_start)
                    {
                        return true;
                    }
                }
            }
            let words: Vec<&str> = t
                .iter()
                .filter_map(|tok| match tok {
                    Tok::Word(w) => Some(w.as_str()),
                    _ => None,
                })
                .collect();
            let has = |list: &[&str]| words.iter().any(|w| list.contains(w));
            // EXPLAIN ANALYZE (PostgreSQL) and ANALYZE <statement> (MariaDB) run the statement they explain.
            if matches!(first, "EXPLAIN" | "ANALYZE" | "ANALYSE")
                && has(&["ANALYZE", "ANALYSE"])
                && has(&["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "INTO", "CREATE", "EXECUTE"])
            {
                return true;
            }
            if (matches!(first, "SET" | "RESET") && has(READ_ONLY_VARS))
                || (matches!(first, "RESET" | "DISCARD") && has(&["ALL"]))
                || words.windows(2).any(|w| w == ["READ", "WRITE"])
                || t.windows(2).any(|w| matches!(w, [Tok::Word(f), Tok::P('(')] if f == "SET_CONFIG"))
            {
                return true;
            }
            if first == "SELECT" || first == "WITH" {
                for (k, tok) in t.iter().enumerate() {
                    let Tok::Word(w) = tok else { continue };
                    let call = t.get(k + 1) == Some(&Tok::P('('));
                    if !call && matches!(w.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "INTO") {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Filtro de `run_query`: una sola sentencia y de solo lectura en todas las variantes del dialecto.
pub fn check_read_query(sql: &str, kind: DbKind) -> Result<(), String> {
    for t in single_statement(sql, kind)? {
        check_read_tokens(&t)?;
    }
    Ok(())
}

/// Filtro de `execute_statement`: una sola sentencia, sin operaciones de administración.
pub fn check_write_statement(sql: &str, kind: DbKind) -> Result<(), String> {
    for t in single_statement(sql, kind)? {
        check_write_tokens(&t)?;
    }
    Ok(())
}

/// Columns whose values are hidden from assistants, and the tables that have them (lowercase).
#[derive(Debug, Clone, Default)]
struct Sensitive {
    columns: HashSet<String>,
    tables: HashSet<String>,
}

fn tok_name(t: Option<&Tok>) -> Option<String> {
    match t {
        Some(Tok::Word(w)) | Some(Tok::Ident(w)) => Some(w.to_lowercase()),
        _ => None,
    }
}

/// Words after which a name in a FROM clause is not a table alias.
const NOT_ALIAS: &[&str] = &[
    "WHERE", "JOIN", "ON", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "OUTER", "GROUP", "ORDER",
    "LIMIT", "OFFSET", "FETCH", "UNION", "INTERSECT", "EXCEPT", "USING", "WINDOW", "HAVING", "FOR", "TABLESAMPLE",
    "WITH", "LATERAL", "AS", "SET", "RETURNING", "QUALIFY", "STRAIGHT_JOIN", "PARTITION", "USE", "FORCE", "IGNORE",
    "PIVOT", "UNPIVOT", "APPLY", "INTO",
];

/// Names written before a '.' (database, schema or table qualifiers), lowercase, under every quoting variant.
fn qualifiers(sql: &str, kind: DbKind) -> HashSet<String> {
    let mut out = HashSet::new();
    for d in dialects(kind) {
        if let Ok(stmts) = lex(sql, *d) {
            for t in stmts {
                for w in t.windows(2) {
                    if w[1] == Tok::P('.') {
                        if let Some(n) = tok_name(Some(&w[0])) {
                            out.insert(n);
                        }
                    }
                }
            }
        }
    }
    out
}

/// Ways to read a protected column without naming it, refused in a query that reads a table that has one:
/// a whole row as a value (`SELECT t FROM users t`, `row_to_json(t.*)`), column alias lists that rename columns
/// (`WITH s(a, b) AS …`, `FROM users AS u(a, b)`) and set operations (`SELECT 1, 2 WHERE false UNION SELECT * FROM
/// users`), whose column names come from the first branch. Masking is still best-effort (views, for instance).
fn masking_bypass(t: &[Tok], sens: &Sensitive) -> Option<String> {
    if !t.iter().any(|x| tok_name(Some(x)).is_some_and(|n| sens.tables.contains(&n))) {
        return None;
    }
    let refuse = |what: &str| {
        Some(format!(
            "La consulta lee una tabla con columnas protegidas y usa {what}: así sus valores no se pueden ocultar. Nombra las columnas que necesitas (las protegidas aparecen como \"{REDACTED}\" con SELECT *)."
        ))
    };
    let word = |k: usize| match t.get(k) {
        Some(Tok::Word(w)) => w.as_str(),
        _ => "",
    };
    // Relations the query declares (tables, aliases, CTEs, derived tables) and the positions that declare them.
    let mut relations: HashSet<String> = HashSet::new();
    let mut declared: HashSet<usize> = HashSet::new();
    let mut in_from = vec![false];
    for k in 0..t.len() {
        match &t[k] {
            Tok::P('(') => in_from.push(false),
            Tok::P(')') => {
                in_from.pop();
                if in_from.is_empty() {
                    in_from.push(false);
                }
                // A derived table's alias: `(SELECT …) [AS] x`, maybe with a column list.
                if *in_from.last().unwrap_or(&false) {
                    let a = if word(k + 1) == "AS" { k + 2 } else { k + 1 };
                    if let Some(n) = tok_name(t.get(a)) {
                        if !NOT_ALIAS.contains(&word(a)) {
                            if t.get(a + 1) == Some(&Tok::P('(')) {
                                return refuse("una lista de alias de columnas");
                            }
                            relations.insert(n);
                            declared.insert(a);
                        }
                    }
                }
            }
            Tok::Word(w) if matches!(w.as_str(), "UNION" | "INTERSECT" | "EXCEPT" | "MINUS") => {
                return refuse(w.as_str());
            }
            Tok::Word(w) if matches!(w.as_str(), "FROM" | "JOIN") => {
                if let Some(top) = in_from.last_mut() {
                    *top = true;
                }
            }
            Tok::Word(w)
                if matches!(
                    w.as_str(),
                    "WHERE" | "GROUP" | "ORDER" | "HAVING" | "LIMIT" | "SELECT" | "ON" | "USING" | "WINDOW"
                        | "QUALIFY" | "OFFSET" | "FETCH" | "FOR" | "RETURNING"
                ) =>
            {
                if let Some(top) = in_from.last_mut() {
                    *top = false;
                }
            }
            _ => {}
        }
        let Some(name) = tok_name(t.get(k)) else { continue };
        // CTE: `name AS [NOT] [MATERIALIZED] (` or, with a column list, `name (…) AS (`.
        let mut a = k + 1;
        if word(a) == "AS" {
            a += 1;
            while matches!(word(a), "NOT" | "MATERIALIZED") {
                a += 1;
            }
            if t.get(a) == Some(&Tok::P('(')) && !matches!(&t[k], Tok::Word(w) if w == "AS") {
                relations.insert(name);
                declared.insert(k);
                continue;
            }
        }
        if t.get(k + 1) == Some(&Tok::P('(')) && matches!(word(k.wrapping_sub(1)), "WITH" | "RECURSIVE")
            || (t.get(k + 1) == Some(&Tok::P('(')) && t.get(k.wrapping_sub(1)) == Some(&Tok::P(',')) && {
                // `, name (a, b) AS (`: find the list's end.
                let mut depth = 0;
                let mut j = k + 1;
                while j < t.len() {
                    match t[j] {
                        Tok::P('(') => depth += 1,
                        Tok::P(')') => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                    j += 1;
                }
                word(j + 1) == "AS" && t.get(j + 2) == Some(&Tok::P('('))
            })
        {
            return refuse("una lista de alias de columnas en un WITH");
        }
        // A table in a FROM clause (after FROM, JOIN or a comma there, maybe qualified), and its alias.
        if t.get(k + 1) == Some(&Tok::P('.')) {
            continue;
        }
        let mut p = k.wrapping_sub(1);
        while t.get(p) == Some(&Tok::P('.')) {
            p = p.wrapping_sub(2);
        }
        let from_slot = matches!(word(p), "FROM" | "JOIN" | "TABLE" | "STRAIGHT_JOIN")
            || (t.get(p) == Some(&Tok::P(',')) && *in_from.last().unwrap_or(&false));
        if !from_slot || t.get(k + 1) == Some(&Tok::P('(')) {
            continue;
        }
        relations.insert(name);
        declared.insert(k);
        let a = if word(k + 1) == "AS" { k + 2 } else { k + 1 };
        if let Some(alias) = tok_name(t.get(a)) {
            if !NOT_ALIAS.contains(&word(a)) {
                if t.get(a + 1) == Some(&Tok::P('(')) {
                    return refuse("una lista de alias de columnas");
                }
                relations.insert(alias);
                declared.insert(a);
            }
        }
    }
    // A relation used as a value: `SELECT t …`, `to_json(t)`, `f(t.*)`.
    for k in 0..t.len() {
        let Some(name) = tok_name(t.get(k)) else { continue };
        if declared.contains(&k) || !relations.contains(&name) || k > 0 && t.get(k - 1) == Some(&Tok::P('.')) {
            continue;
        }
        match t.get(k + 1) {
            Some(Tok::P('.')) => {
                let star = t.get(k + 2) == Some(&Tok::P('*'));
                let wrapped = k > 0 && t.get(k - 1) == Some(&Tok::P('(')) || t.get(k + 3) == Some(&Tok::P(')'));
                if star && wrapped {
                    return refuse(&format!("la fila entera de «{name}» como valor"));
                }
            }
            // A function or type of that name, or a CTE being defined.
            Some(Tok::P('(')) => {}
            _ => return refuse(&format!("la fila entera de «{name}» como valor")),
        }
    }
    None
}

/// Identificadores (en minúsculas) que aparecen en la consulta fuera de cadenas y comentarios.
fn query_identifiers(sql: &str, kind: DbKind) -> HashSet<String> {
    let mut out = HashSet::new();
    for d in dialects(kind) {
        if let Ok(stmts) = lex(sql, *d) {
            for t in stmts.into_iter().flatten() {
                match t {
                    Tok::Word(w) | Tok::Ident(w) => {
                        out.insert(w.to_lowercase());
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

// ───────────────────────────── Auditoría ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub at: i64,
    pub tool: String,
    pub conn_id: String,
    pub conn_name: String,
    pub detail: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u64>,
    pub ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Where the assistant runs: "Windows", "WSL (Ubuntu)", "Linux"… (entries written before it was kept: none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    /// The MCP client program, as it introduced itself (`clientInfo.name` of initialize: "claude-code"…).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_app: Option<String>,
}

fn audit_path(store: &Store) -> PathBuf {
    store.dir.join(AUDIT_FILE)
}

fn audit_all(store: &Store) -> Vec<AuditEntry> {
    let Ok(f) = fs::File::open(audit_path(store)) else {
        return vec![];
    };
    std::io::BufReader::new(f)
        .lines()
        .map_while(|l| l.ok())
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect()
}

pub fn append_audit(store: &Store, e: &AuditEntry) -> anyhow::Result<()> {
    let path = audit_path(store);
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    writeln!(f, "{}", serde_json::to_string(e)?)?;
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    drop(f);
    if len > AUDIT_COMPACT_BYTES {
        let mut all = audit_all(store);
        let skip = all.len().saturating_sub(AUDIT_KEEP);
        all.drain(..skip);
        let body: String = all
            .iter()
            .filter_map(|e| serde_json::to_string(e).ok())
            .map(|s| s + "\n")
            .collect();
        store.write_atomic(AUDIT_FILE, &body)?;
    }
    Ok(())
}

/// Entradas del registro, las más recientes primero.
pub fn read_audit(store: &Store, limit: usize) -> Vec<AuditEntry> {
    let mut all = audit_all(store);
    all.reverse();
    all.truncate(limit);
    all
}

pub fn clear_audit(store: &Store) -> anyhow::Result<()> {
    match fs::remove_file(audit_path(store)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// The last entry, read from the end of the file (the status bar asks often; the file can be large).
pub fn last_audit(store: &Store) -> Option<AuditEntry> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(audit_path(store)).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(64 * 1024);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    String::from_utf8_lossy(&buf).lines().rev().find_map(|l| serde_json::from_str(l).ok())
}

pub(crate) fn now_ms_pub() -> i64 {
    now_ms()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ───────────────────────────── Ejecución ─────────────────────────────

fn ensure_db(d: &mut dyn Driver, want: &str) -> anyhow::Result<String> {
    let cur = d.current_database().unwrap_or_default();
    if !want.is_empty() && want != cur {
        d.use_database(want)?;
        return Ok(d.current_database().unwrap_or_else(|_| want.to_string()));
    }
    Ok(cur)
}

/// Ejecuta una consulta ya filtrada con la máxima protección que permite cada motor:
/// transacción de solo lectura (PostgreSQL, MySQL), `query_only` (SQLite) o transacción que se
/// deshace siempre (resto). Además limita las filas en el servidor cuando es posible.
fn read_exec(
    d: &mut dyn Driver,
    kind: DbKind,
    sql: &str,
    cap: usize,
    timeout_secs: u32,
) -> anyhow::Result<ExecOutput> {
    match kind {
        DbKind::Postgres => {
            d.execute("BEGIN READ ONLY", 1)?;
            let r = d
                .execute(
                    &format!("SET LOCAL statement_timeout = {}", timeout_secs as u64 * 1000),
                    1,
                )
                .and_then(|_| d.execute(sql, cap));
            let _ = d.close_cursor();
            let _ = d.rollback();
            r
        }
        DbKind::Mysql => {
            d.execute("START TRANSACTION READ ONLY", 1)?;
            let r = d
                .execute(&format!("SET SESSION sql_select_limit = {}", cap + 1), 1)
                .and_then(|_| d.execute(sql, cap));
            let _ = d.close_cursor();
            let _ = d.execute("SET SESSION sql_select_limit = DEFAULT", 1);
            let _ = d.rollback();
            r
        }
        DbKind::Sqlite => {
            d.execute("PRAGMA query_only = ON", 1)?;
            let r = d.execute(sql, cap);
            let _ = d.close_cursor();
            let _ = d.execute("PRAGMA query_only = OFF", 1);
            r
        }
        DbKind::Mssql => {
            let _ = d.set_autocommit(false);
            let r = d
                .execute(&format!("SET ROWCOUNT {}", cap + 1), 1)
                .and_then(|_| d.execute(sql, cap));
            let _ = d.close_cursor();
            let _ = d.execute("SET ROWCOUNT 0", 1);
            let _ = d.rollback();
            let _ = d.set_autocommit(true);
            r
        }
        DbKind::Informix | DbKind::Odbc => {
            let _ = d.set_autocommit(false);
            let r = d.execute(sql, cap);
            let _ = d.close_cursor();
            let _ = d.rollback();
            let _ = d.set_autocommit(true);
            r
        }
    }
}

/// Busca una tabla o vista visible en `db` y devuelve su referencia completa.
fn resolve_table(
    d: &mut dyn Driver,
    db: &str,
    schema: &str,
    name: &str,
) -> anyhow::Result<ObjectRef> {
    let comp = d.completion(db)?;
    let find = |schema: &str, name: &str, ci: bool| -> Vec<CompletionTable> {
        comp.tables
            .iter()
            .filter(|t| {
                let n_ok = if ci {
                    t.name.eq_ignore_ascii_case(name)
                } else {
                    t.name == name
                };
                let s_ok = schema.is_empty()
                    || if ci {
                        t.schema.eq_ignore_ascii_case(schema)
                    } else {
                        t.schema == schema
                    };
                n_ok && s_ok
            })
            .cloned()
            .collect()
    };
    let mut cands = find(schema, name, false);
    if cands.is_empty() {
        cands = find(schema, name, true);
    }
    if cands.is_empty() && schema.is_empty() {
        if let Some((s, n)) = name.rsplit_once('.') {
            cands = find(s, n, true);
        }
    }
    let t = match cands.len() {
        0 => anyhow::bail!(
            "No se encontró la tabla o vista «{name}»{}. Usa list_tables o search_objects.",
            if schema.is_empty() {
                String::new()
            } else {
                format!(" en el esquema «{schema}»")
            }
        ),
        1 => cands.remove(0),
        _ => {
            let pref = ["public", "dbo", "main", db];
            match cands.iter().position(|t| pref.contains(&t.schema.as_str())) {
                Some(p) => cands.remove(p),
                None => anyhow::bail!(
                    "«{name}» existe en varios esquemas ({}); indica «schema»",
                    cands
                        .iter()
                        .map(|t| t.schema.clone())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            }
        }
    };
    let views = view_names(d, db, &t.schema);
    let kind = if views.contains(&t.name) { "view" } else { "table" };
    Ok(ObjectRef::new(db, &t.schema, &t.name, kind))
}

/// Nombres de vistas (y vistas materializadas) de un esquema, según el árbol de objetos.
fn view_names(d: &mut dyn Driver, db: &str, schema: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for folder in ["views", "matviews"] {
        if let Ok(nodes) = d.children(&[db.to_string(), schema.to_string(), folder.to_string()]) {
            out.extend(nodes.into_iter().filter(|n| n.kind == "view").map(|n| n.name));
        }
    }
    out
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn arg_u64(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64))
            .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
    })
}

fn engine_name(k: DbKind) -> &'static str {
    match k {
        DbKind::Mssql => "sqlserver",
        DbKind::Informix => "informix",
        DbKind::Odbc => "odbc",
        DbKind::Sqlite => "sqlite",
        DbKind::Postgres => "postgresql",
        DbKind::Mysql => "mysql",
    }
}

#[derive(Clone)]
struct Cached {
    fp: String,
    h: Arc<SessionHandle>,
    default_db: String,
}

/// Resultado de una herramienta, tal y como lo verá el asistente.
#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub is_error: bool,
    pub text: String,
    pub data: Option<Value>,
}

impl ToolOutput {
    pub fn to_mcp(&self) -> Value {
        json!({"content": [{"type": "text", "text": self.text}], "isError": self.is_error})
    }
    /// Forma para la vista previa de la interfaz.
    pub fn to_preview(&self) -> Value {
        json!({"isError": self.is_error, "text": self.text, "json": self.data})
    }
}

type ToolResult = Result<(Value, Option<u64>), String>;

pub struct McpServer {
    store: Store,
    sessions: Mutex<HashMap<String, Cached>>,
    /// Columnas sensibles por (conexión, base de datos): (momento, patrón, nombres).
    sensitive: Mutex<HashMap<String, (Instant, String, Arc<Sensitive>)>>,
    /// Vista previa desde la interfaz: ignora `enabled` y no se audita.
    preview: bool,
    /// Where the assistant runs ("Windows", "WSL (Ubuntu)"…), for the audit log.
    origin: String,
    /// The client program, from `initialize`.
    client_app: Mutex<String>,
}

impl McpServer {
    pub fn new(dir: PathBuf, preview: bool) -> McpServer {
        McpServer::with_origin(dir, preview, default_origin())
    }

    pub fn with_origin(dir: PathBuf, preview: bool, origin: String) -> McpServer {
        McpServer {
            store: Store::new(dir),
            sessions: Mutex::new(HashMap::new()),
            sensitive: Mutex::new(HashMap::new()),
            preview,
            origin,
            client_app: Mutex::new(String::new()),
        }
    }

    /// "claude-code · WSL (Ubuntu)": who is calling, for the app's notices.
    fn client_label(&self) -> String {
        let app = self.client_app.lock().clone();
        if app.is_empty() {
            self.origin.clone()
        } else {
            format!("{app} · {}", self.origin)
        }
    }

    async fn session(&self, conn: &ConnConfig, timeout_secs: u32) -> Result<Cached, String> {
        let fp = serde_json::to_string(conn).unwrap_or_default();
        if let Some(c) = self
            .sessions
            .lock()
            .get(&conn.id)
            .filter(|c| c.fp == fp)
            .cloned()
        {
            return Ok(c);
        }
        let connector = crate::make_connector(&self.store, conn.clone())?;
        let open = SessionHandle::open(conn.id.clone(), connector);
        let h = match tokio::time::timeout(Duration::from_secs(timeout_secs as u64), open).await {
            Ok(Ok(h)) => Arc::new(h),
            Ok(Err(e)) => return Err(format!("No se pudo conectar a «{}»: {e}", conn.name)),
            Err(_) => {
                return Err(format!(
                    "No se pudo conectar a «{}» en {timeout_secs} s",
                    conn.name
                ))
            }
        };
        let default_db = h
            .run(|d| d.current_database())
            .await
            .unwrap_or_default();
        let c = Cached {
            fp,
            h,
            default_db,
        };
        self.sessions.lock().insert(conn.id.clone(), c.clone());
        Ok(c)
    }

    fn drop_session(&self, id: &str) {
        self.sessions.lock().remove(id);
    }

    /// Ejecuta `f` en la sesión de la conexión, ya situada en la base pedida (o la de por defecto),
    /// con tiempo máximo. Tras cualquier error la sesión se descarta para empezar limpia.
    async fn run<T, F>(
        &self,
        conn: &ConnConfig,
        timeout_secs: u32,
        want_db: String,
        f: F,
    ) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut dyn Driver, String) -> anyhow::Result<T> + Send + 'static,
    {
        let c = self.session(conn, timeout_secs).await?;
        let default_db = c.default_db.clone();
        let fut = c.h.run(move |d| {
            let want = if want_db.is_empty() { default_db } else { want_db };
            let db = ensure_db(d, &want)?;
            f(d, db)
        });
        match tokio::time::timeout(Duration::from_secs(timeout_secs as u64), fut).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => {
                self.drop_session(&conn.id);
                Err(e.to_string())
            }
            Err(_) => {
                c.h.cancel();
                self.drop_session(&conn.id);
                Err(format!(
                    "La operación superó el tiempo máximo ({timeout_secs} s) y se canceló"
                ))
            }
        }
    }

    /// The protected columns of the database the session is on (`want_db`), or of `other` (MySQL and SQL Server
    /// reach other databases with `otherdb.table`), read without leaving the session's database.
    async fn sensitive_columns(
        &self,
        conn: &ConnConfig,
        cfg: &McpConfig,
        want_db: &str,
        other: Option<String>,
    ) -> Result<Arc<Sensitive>, String> {
        let red = Redactor::new(&cfg.redact_pattern);
        if !red.active() {
            return Ok(Arc::new(Sensitive::default()));
        }
        let key = format!("{}\u{1}{}\u{1}{}", conn.id, want_db, other.as_deref().unwrap_or(""));
        if let Some((t, p, set)) = self.sensitive.lock().get(&key) {
            if t.elapsed() < SENSITIVE_TTL && *p == cfg.redact_pattern {
                return Ok(set.clone());
            }
        }
        let comp = self
            .run(conn, cfg.timeout_secs, want_db.to_string(), move |d, db| {
                d.completion(other.as_deref().unwrap_or(&db))
            })
            .await?;
        let mut set = Sensitive::default();
        for t in &comp.tables {
            for c in t.columns.iter().filter(|c| red.matches(c)) {
                set.columns.insert(c.to_lowercase());
                set.tables.insert(t.name.to_lowercase());
            }
        }
        let set = Arc::new(set);
        self.sensitive.lock().insert(
            key,
            (Instant::now(), cfg.redact_pattern.clone(), set.clone()),
        );
        Ok(set)
    }

    /// Ejecuta una herramienta aplicando permisos, y la registra en la auditoría.
    pub async fn call_tool(&self, name: &str, args: &Value) -> ToolOutput {
        let t0 = Instant::now();
        let cfg = load_config(&self.store);
        let conns = self.store.load_connections();
        let conn_id = arg_str(args, "connId");
        let conn = conns.iter().find(|c| c.id == conn_id).cloned();
        let res = if !TOOL_NAMES.contains(&name) && !APP_TOOL_NAMES.contains(&name) {
            Err(format!("Herramienta desconocida: {name}"))
        } else if !self.preview && !cfg.enabled {
            Err(DISABLED_MSG.to_string())
        } else if !tool_allowed(&cfg, name) {
            Err(app_tool_refused(&cfg, name))
        } else if APP_TOOL_NAMES.contains(&name) {
            self.dispatch_app(name, args, &cfg, &conns, conn.as_ref()).await
        } else {
            self.dispatch(name, args, &cfg, &conns, conn.as_ref()).await
        };
        if !self.preview {
            let visible = conn
                .as_ref()
                .filter(|c| effective_level(&cfg, c) != Level::None);
            let detail = match name {
                "run_query" | "execute_statement" => audit_sql(
                    &arg_str(args, "sql"),
                    conn.as_ref().map_or(DbKind::Odbc, |c| c.kind),
                ),
                "describe_table" | "sample_rows" => {
                    let s = arg_str(args, "schema");
                    let t = arg_str(args, "table");
                    if s.is_empty() {
                        t
                    } else {
                        format!("{s}.{t}")
                    }
                }
                "search_objects" | "list_library" => arg_str(args, "query"),
                "open_console" => {
                    let sql = audit_sql(args.get("sql").and_then(Value::as_str).unwrap_or(""), conn.as_ref().map_or(DbKind::Odbc, |c| c.kind));
                    if args.get("run").and_then(Value::as_bool) == Some(true) {
                        format!("[ejecutar] {sql}")
                    } else {
                        sql
                    }
                }
                "open_table" | "open_object" | "open_er_diagram" => {
                    let s = arg_str(args, "schema");
                    let t = arg_str(args, "table");
                    let mut d = [s, t].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(".");
                    let filter = arg_str(args, "filter");
                    if !filter.is_empty() {
                        d.push_str(&format!(" WHERE {filter}"));
                    }
                    let order = arg_str(args, "orderBy");
                    if !order.is_empty() {
                        d.push_str(&format!(" ORDER BY {order}"));
                    }
                    d
                }
                "add_library_script" => arg_str(args, "name"),
                "get_library_script" => {
                    let id = arg_str(args, "id");
                    if id.is_empty() {
                        arg_str(args, "name")
                    } else {
                        id
                    }
                }
                _ => arg_str(args, "database"),
            };
            let entry = AuditEntry {
                at: now_ms(),
                tool: name.to_string(),
                conn_id: conn_id.clone(),
                conn_name: visible.map(|c| c.name.clone()).unwrap_or_default(),
                detail: truncate_chars(&detail, AUDIT_DETAIL_CHARS),
                ok: res.is_ok(),
                rows: res.as_ref().ok().and_then(|r| r.1),
                ms: t0.elapsed().as_millis() as u64,
                error: res.as_ref().err().map(|e| truncate_chars(e, 500)),
                client: Some(self.origin.clone()),
                client_app: Some(self.client_app.lock().clone()).filter(|a| !a.is_empty()),
            };
            if let Err(e) = append_audit(&self.store, &entry) {
                eprintln!("celer mcp: no se pudo escribir la auditoría: {e}");
            }
        }
        match res {
            Ok((v, _)) => ToolOutput {
                is_error: false,
                text: serde_json::to_string(&v).unwrap_or_default(),
                data: Some(v),
            },
            Err(e) => ToolOutput {
                is_error: true,
                text: e,
                data: None,
            },
        }
    }

    async fn dispatch(
        &self,
        name: &str,
        args: &Value,
        cfg: &McpConfig,
        conns: &[ConnConfig],
        conn: Option<&ConnConfig>,
    ) -> ToolResult {
        if name == "list_connections" {
            let list: Vec<Value> = conns
                .iter()
                .filter_map(|c| {
                    let lvl = effective_level(cfg, c);
                    (lvl != Level::None).then(|| {
                        let database = if c.kind == DbKind::Sqlite {
                            Path::new(&c.file_path)
                                .file_name()
                                .map(|f| f.to_string_lossy().to_string())
                                .unwrap_or_else(|| c.file_path.clone())
                        } else {
                            c.database.clone()
                        };
                        json!({
                            "id": c.id,
                            "name": c.name,
                            "engine": engine_name(c.kind),
                            "level": lvl.as_str(),
                            "database": database,
                            "production": c.production,
                            "readOnly": c.read_only,
                        })
                    })
                })
                .collect();
            let n = list.len() as u64;
            return Ok((json!({ "connections": list }), Some(n)));
        }

        let need = match name {
            "sample_rows" | "run_query" => Level::Read,
            "execute_statement" => Level::Write,
            _ => Level::Schema,
        };
        let conn = accessible(cfg, conn, &arg_str(args, "connId"), name, need)?;
        let db = arg_str(args, "database");
        let timeout = cfg.timeout_secs;
        let kind = conn.kind;
        let red = Redactor::new(&cfg.redact_pattern);

        match name {
            "list_databases" => {
                let dbs = self
                    .run(&conn, timeout, String::new(), |d, cur| {
                        Ok((d.databases()?, cur))
                    })
                    .await?;
                let n = dbs.0.len() as u64;
                Ok((json!({"databases": dbs.0, "current": dbs.1}), Some(n)))
            }
            "list_tables" => {
                let schema = arg_str(args, "schema");
                let v = self
                    .run(&conn, timeout, db, move |d, db| {
                        let comp = d.completion(&db)?;
                        let mut tables: Vec<&CompletionTable> = comp
                            .tables
                            .iter()
                            .filter(|t| schema.is_empty() || t.schema.eq_ignore_ascii_case(&schema))
                            .collect();
                        let mut schemas: Vec<String> = Vec::new();
                        for t in &tables {
                            if !schemas.contains(&t.schema) {
                                schemas.push(t.schema.clone());
                            }
                        }
                        let mut views: HashSet<(String, String)> = HashSet::new();
                        for s in schemas.iter().take(50) {
                            for v in view_names(d, &db, s) {
                                views.insert((s.clone(), v));
                            }
                        }
                        let truncated = tables.len() > MAX_TABLES;
                        tables.truncate(MAX_TABLES);
                        let list: Vec<Value> = tables
                            .iter()
                            .map(|t| {
                                let is_view = views.contains(&(t.schema.clone(), t.name.clone()));
                                json!({
                                    "schema": t.schema,
                                    "name": t.name,
                                    "kind": if is_view { "view" } else { "table" },
                                    "columns": t.columns.len(),
                                })
                            })
                            .collect();
                        Ok(json!({"database": db, "tables": list, "truncated": truncated}))
                    })
                    .await?;
                let n = v["tables"].as_array().map(|a| a.len() as u64);
                Ok((v, n))
            }
            "describe_table" => {
                let table = arg_str(args, "table");
                if table.is_empty() {
                    return Err("Falta «table»".into());
                }
                let schema = arg_str(args, "schema");
                let v = self
                    .run(&conn, timeout, db, move |d, db| {
                        let obj = resolve_table(d, &db, &schema, &table)?;
                        let cols = d.table_columns(&obj)?;
                        let ddl = d.ddl(&obj);
                        let mut v = json!({
                            "database": db,
                            "schema": obj.schema,
                            "name": obj.name,
                            "kind": obj.kind,
                            "qualifiedName": d.qualified_name(&obj),
                            "columns": cols.iter().map(|c| json!({
                                "name": c.name,
                                "type": c.type_name,
                                "nullable": c.nullable,
                                "primaryKey": c.primary_key,
                                "identity": c.identity,
                                "default": c.default,
                            })).collect::<Vec<_>>(),
                        });
                        match ddl {
                            Ok(s) => v["ddl"] = json!(truncate_chars(&s, MAX_DDL_CHARS)),
                            Err(e) => v["ddlError"] = json!(e.to_string()),
                        }
                        Ok(v)
                    })
                    .await?;
                let n = v["columns"].as_array().map(|a| a.len() as u64);
                Ok((v, n))
            }
            "search_objects" => {
                let q = arg_str(args, "query").to_lowercase();
                if q.is_empty() {
                    return Err("Falta «query»".into());
                }
                let v = self
                    .run(&conn, timeout, db, move |d, db| {
                        let comp = d.completion(&db)?;
                        let mut matches = Vec::new();
                        let mut truncated = false;
                        'outer: for t in &comp.tables {
                            if t.name.to_lowercase().contains(&q) {
                                if matches.len() >= MAX_SEARCH {
                                    truncated = true;
                                    break;
                                }
                                matches.push(json!({"type": "table", "schema": t.schema, "table": t.name}));
                            }
                            for c in &t.columns {
                                if c.to_lowercase().contains(&q) {
                                    if matches.len() >= MAX_SEARCH {
                                        truncated = true;
                                        break 'outer;
                                    }
                                    matches.push(json!({"type": "column", "schema": t.schema, "table": t.name, "column": c}));
                                }
                            }
                        }
                        Ok(json!({"database": db, "matches": matches, "truncated": truncated}))
                    })
                    .await?;
                let n = v["matches"].as_array().map(|a| a.len() as u64);
                Ok((v, n))
            }
            "sample_rows" => {
                let table = arg_str(args, "table");
                if table.is_empty() {
                    return Err("Falta «table»".into());
                }
                let schema = arg_str(args, "schema");
                let cap = row_cap(cfg, &conn.id, arg_u64(args, "limit"), 20);
                let t0 = Instant::now();
                let out = self
                    .run(&conn, timeout, db, move |d, db| {
                        let obj = resolve_table(d, &db, &schema, &table)?;
                        let q = d.qualified_name(&obj);
                        let sql = match kind {
                            DbKind::Postgres | DbKind::Mysql | DbKind::Sqlite => {
                                format!("SELECT * FROM {q} LIMIT {}", cap + 1)
                            }
                            DbKind::Mssql => format!("SELECT TOP ({}) * FROM {q}", cap + 1),
                            _ => format!("SELECT * FROM {q}"),
                        };
                        let out = read_exec(d, kind, &sql, cap, timeout)?;
                        Ok((out, q))
                    })
                    .await?;
                let (mut v, n) = render_exec(&out.0, &red, t0.elapsed().as_millis() as u64);
                v["table"] = json!(out.1);
                Ok((v, Some(n)))
            }
            "run_query" => {
                let sql = arg_str(args, "sql");
                self.check_read_access(&conn, cfg, &db, &sql).await?;
                let cap = row_cap(cfg, &conn.id, arg_u64(args, "maxRows"), 100);
                let t0 = Instant::now();
                let out = self
                    .run(&conn, timeout, db, move |d, _db| {
                        read_exec(d, kind, &sql, cap, timeout)
                    })
                    .await?;
                let (v, n) = render_exec(&out, &red, t0.elapsed().as_millis() as u64);
                Ok((v, Some(n)))
            }
            "execute_statement" => {
                let sql = arg_str(args, "sql");
                check_write_statement(&sql, kind)?;
                let cap = row_cap(cfg, &conn.id, None, 100);
                let t0 = Instant::now();
                let out = self
                    .run(&conn, timeout, db, move |d, _db| {
                        let r = d.execute(&sql, cap);
                        let _ = d.close_cursor();
                        r
                    })
                    .await?;
                let (mut v, n) = render_exec(&out, &red, t0.elapsed().as_millis() as u64);
                let affected: i64 = out.results.iter().filter_map(|r| r.rows_affected).sum();
                v["rowsAffected"] = json!(affected);
                v["messages"] = json!(out.messages);
                Ok((v, Some(if n > 0 { n } else { affected.max(0) as u64 })))
            }
            _ => Err(format!("Herramienta desconocida: {name}")),
        }
    }

    /// What run_query checks before it runs a statement: one read-only statement, and no protected column named or
    /// reached another way (a whole row, a column alias list, a set operation; on MySQL and SQL Server also the
    /// protected columns of another database it names).
    async fn check_read_access(&self, conn: &ConnConfig, cfg: &McpConfig, db: &str, sql: &str) -> Result<(), String> {
        let kind = conn.kind;
        check_read_query(sql, kind)?;
        let red = Redactor::new(&cfg.redact_pattern);
        let mut sens = (*self.sensitive_columns(conn, cfg, db, None).await?).clone();
        // MySQL and SQL Server read other databases by name (`otherdb.users`): their protected columns count.
        if red.active() && matches!(kind, DbKind::Mysql | DbKind::Mssql) {
            let quals = qualifiers(sql, kind);
            if !quals.is_empty() {
                let dbs = self.run(conn, cfg.timeout_secs, db.to_string(), |d, _| d.databases()).await.unwrap_or_default();
                for other in dbs.into_iter().filter(|n| quals.contains(&n.to_lowercase())) {
                    let more = self.sensitive_columns(conn, cfg, db, Some(other)).await?;
                    sens.columns.extend(more.columns.iter().cloned());
                    sens.tables.extend(more.tables.iter().cloned());
                }
            }
        }
        if !sens.columns.is_empty() {
            for t in single_statement(sql, kind)? {
                if let Some(e) = masking_bypass(&t, &sens) {
                    return Err(e);
                }
            }
            let ids = query_identifiers(sql, kind);
            let mut hit: Vec<&String> = ids.iter().filter(|i| sens.columns.contains(*i)).collect();
            hit.sort();
            if let Some(h) = hit.first() {
                return Err(format!(
                    "La consulta menciona la columna protegida «{h}». Sus valores están ocultos para los asistentes: no la uses en expresiones, filtros ni alias. Con SELECT * o sample_rows aparecerá como \"{REDACTED}\"."
                ));
            }
        }
        Ok(())
    }

    // ───────────── Control de la aplicación (#100) ─────────────

    /// Asks the running Celer to do something (after every check here). Blocking socket work, off the runtime.
    async fn app(&self, action: &str, args: Value) -> Result<Value, String> {
        let dir = self.store.dir.clone();
        let client = self.client_label();
        let action = action.to_string();
        tokio::task::spawn_blocking(move || crate::mcp_app::request(&dir, &action, args, &client, crate::mcp_app::REQUEST_TIMEOUT))
            .await
            .map_err(|e| e.to_string())?
    }

    /// The library's scripts (library.json), as the file has them.
    fn library_scripts(&self) -> Vec<Value> {
        self.store
            .read("library.json")
            .and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok())
            .and_then(|v| v.get("scripts").and_then(Value::as_array).cloned())
            .unwrap_or_default()
    }

    async fn dispatch_app(&self, name: &str, args: &Value, cfg: &McpConfig, conns: &[ConnConfig], conn: Option<&ConnConfig>) -> ToolResult {
        let id = arg_str(args, "connId");
        match name {
            "get_app_state" => {
                let raw = self.app("state", json!({})).await?;
                let v = app_state_for_ai(&raw, cfg, conns);
                let n = v["windows"].as_array().map(|w| w.len() as u64);
                Ok((v, n))
            }
            "list_library" => {
                let q = arg_str(args, "query").to_lowercase();
                let folder = arg_str(args, "folder");
                let mut out = Vec::new();
                let mut total = 0usize;
                for s in self.library_scripts().iter().filter(|s| script_visible(cfg, conns, s)) {
                    let f = s["folder"].as_str().unwrap_or("");
                    if !folder.is_empty() && f != folder && !f.starts_with(&format!("{folder}/")) {
                        continue;
                    }
                    let tags: Vec<&str> = s["tags"].as_array().map(|t| t.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                    let hit = q.is_empty()
                        || s["name"].as_str().unwrap_or("").to_lowercase().contains(&q)
                        || f.to_lowercase().contains(&q)
                        || tags.iter().any(|t| t.to_lowercase().contains(&q));
                    if !hit {
                        continue;
                    }
                    total += 1;
                    if out.len() < MAX_LIBRARY_LIST {
                        out.push(script_json(s, conns, false));
                    }
                }
                let n = out.len() as u64;
                Ok((json!({"scripts": out, "total": total, "truncated": total > n as usize}), Some(n)))
            }
            "get_library_script" => {
                let want_id = arg_str(args, "id");
                let want_name = arg_str(args, "name");
                if want_id.is_empty() && want_name.is_empty() {
                    return Err("Indica «id» (de list_library) o «name»".into());
                }
                let scripts = self.library_scripts();
                let found = scripts.iter().filter(|s| script_visible(cfg, conns, s)).find(|s| {
                    if want_id.is_empty() {
                        s["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(&want_name))
                    } else {
                        s["id"].as_str() == Some(want_id.as_str())
                    }
                });
                match found {
                    Some(s) => Ok((script_json(s, conns, true), Some(1))),
                    None => Err("No hay ningún script accesible con ese id o nombre. Usa list_library.".into()),
                }
            }
            "add_library_script" => {
                let script_name = arg_str(args, "name");
                let sql = args.get("sql").and_then(Value::as_str).unwrap_or("").to_string();
                if script_name.is_empty() || sql.trim().is_empty() {
                    return Err("Faltan «name» y «sql»".into());
                }
                if sql.chars().count() > MAX_APP_SQL {
                    return Err("El SQL es demasiado largo para la biblioteca".into());
                }
                let target = if id.is_empty() { None } else { Some(accessible(cfg, conn, &id, name, Level::Schema)?) };
                let tags: Vec<String> = match args.get("tags") {
                    Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
                    Some(Value::String(s)) => vec![s.clone()],
                    _ => vec![],
                };
                let r = self
                    .app(
                        "add_library_script",
                        json!({
                            "name": truncate_chars(&script_name, 200),
                            "sql": sql,
                            "folder": arg_str(args, "folder"),
                            "tags": tags,
                            "notes": truncate_chars(&arg_str(args, "notes"), 4000),
                            "connId": target.map(|c| c.id),
                        }),
                    )
                    .await?;
                Ok((r, Some(1)))
            }
            "open_console" => {
                let run = args.get("run").and_then(Value::as_bool).unwrap_or(false);
                let sql = args.get("sql").and_then(Value::as_str).unwrap_or("").to_string();
                if sql.chars().count() > MAX_APP_SQL {
                    return Err("El SQL es demasiado largo para una consola".into());
                }
                let target = if id.is_empty() { None } else { Some(accessible(cfg, conn, &id, name, Level::Schema)?) };
                let db = arg_str(args, "database");
                if run {
                    if !cfg.app_control.run_opened {
                        return Err("El usuario no permite que la IA ejecute lo que abre (Ajustes › IA y MCP › Controlar la aplicación › Ejecutar lo que abre). Abre la consola sin «run» y que el usuario la ejecute.".into());
                    }
                    let Some(c) = target.as_ref() else {
                        return Err("Para ejecutar hace falta «connId»".into());
                    };
                    let level = effective_level(cfg, c);
                    if check_read_query(&sql, c.kind).is_ok() {
                        if level < Level::Read {
                            return Err(level_refused(c, level, Level::Read, "ejecutar una consulta"));
                        }
                        self.check_read_access(c, cfg, &db, &sql).await?;
                    } else {
                        check_write_statement(&sql, c.kind).map_err(|e| format!("No se ejecuta: {e}"))?;
                        if level < Level::Write {
                            return Err(level_refused(c, level, Level::Write, "ejecutar una sentencia que modifica"));
                        }
                    }
                }
                let r = self
                    .app(
                        "open_console",
                        json!({
                            "connId": target.as_ref().map(|c| c.id.clone()),
                            "database": db,
                            "sql": sql,
                            "title": truncate_chars(&arg_str(args, "title"), 80),
                            "run": run,
                        }),
                    )
                    .await?;
                Ok((r, None))
            }
            "open_table" | "open_object" | "open_er_diagram" => {
                let need = if name == "open_table" { Level::Read } else { Level::Schema };
                let target = accessible(cfg, conn, &id, name, need)?;
                let table = arg_str(args, "table");
                let schema = arg_str(args, "schema");
                if table.is_empty() && (name != "open_er_diagram" || schema.is_empty()) {
                    return Err(if name == "open_er_diagram" { "Indica «table» (su diagrama de relaciones) o «schema» (todo el esquema)" } else { "Falta «table»" }.into());
                }
                let section = match arg_str(args, "section").as_str() {
                    "" => if name == "open_object" { "ddl" } else { "data" }.to_string(),
                    s @ ("data" | "columns" | "indexes" | "keys" | "ddl") => s.to_string(),
                    other => return Err(format!("«section» no válida: {other} (data, columns, indexes, keys o ddl)")),
                };
                let filter = arg_str(args, "filter");
                let order = arg_str(args, "orderBy");
                let (obj, qualified, db) = if table.is_empty() {
                    let db = self.run(&target, cfg.timeout_secs, arg_str(args, "database"), |_, db| Ok(db)).await?;
                    (None, String::new(), db)
                } else {
                    let (o, q, db) = self
                        .run(&target, cfg.timeout_secs, arg_str(args, "database"), move |d, db| {
                            let obj = resolve_table(d, &db, &schema, &table)?;
                            let q = d.qualified_name(&obj);
                            Ok((obj, q, db))
                        })
                        .await?;
                    (Some(o), q, db)
                };
                if name == "open_table" && (!filter.is_empty() || !order.is_empty()) {
                    // The filter and the order run as the table's query: the read filter and the masking apply to it.
                    let mut sql = format!("SELECT * FROM {qualified}");
                    if !filter.is_empty() {
                        sql.push_str(&format!(" WHERE {filter}"));
                    }
                    if !order.is_empty() {
                        sql.push_str(&format!(" ORDER BY {order}"));
                    }
                    self.check_read_access(&target, cfg, &db, &sql).await.map_err(|e| format!("Filtro u orden no válido: {e}"))?;
                }
                let action = if name == "open_er_diagram" { "open_er_diagram" } else { "open_table" };
                let r = self
                    .app(
                        action,
                        json!({
                            "connId": target.id,
                            "database": db,
                            "schema": obj.as_ref().map(|o| o.schema.clone()).unwrap_or_else(|| arg_str(args, "schema")),
                            "obj": obj,
                            "section": section,
                            "where": if name == "open_table" { filter } else { String::new() },
                            "orderBy": if name == "open_table" { order } else { String::new() },
                        }),
                    )
                    .await?;
                Ok((r, None))
            }
            _ => Err(format!("Herramienta desconocida: {name}")),
        }
    }

    // ───────────── JSON-RPC ─────────────

    /// Procesa un mensaje JSON-RPC. Devuelve la respuesta, o `None` para notificaciones.
    pub async fn handle(&self, msg: Value) -> Option<Value> {
        if let Value::Array(items) = msg {
            let mut out = Vec::new();
            for m in items {
                if let Some(r) = Box::pin(self.handle(m)).await {
                    out.push(r);
                }
            }
            return (!out.is_empty()).then_some(Value::Array(out));
        }
        let id = msg.get("id").cloned();
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            if msg.get("result").is_some() || msg.get("error").is_some() {
                return None; // respuesta del cliente a algo que no pedimos
            }
            return Some(rpc_error(id.unwrap_or(Value::Null), -32600, "Invalid Request"));
        };
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
        let res: Result<Value, (i64, String)> = match method {
            "initialize" => {
                if let Some(name) = params.pointer("/clientInfo/name").and_then(Value::as_str) {
                    *self.client_app.lock() = truncate_chars(name.trim(), 60);
                }
                Ok(initialize_result(&params))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tool_defs(&load_config(&self.store)) })),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                if !TOOL_NAMES.contains(&name) && !APP_TOOL_NAMES.contains(&name) {
                    Err((-32602, format!("Herramienta desconocida: {name}")))
                } else {
                    let args = params
                        .get("arguments")
                        .cloned()
                        .filter(Value::is_object)
                        .unwrap_or_else(|| json!({}));
                    Ok(self.call_tool(name, &args).await.to_mcp())
                }
            }
            "resources/list" => Ok(json!({ "resources": [] })),
            "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
            "prompts/list" => Ok(json!({ "prompts": [] })),
            m if m.starts_with("notifications/") => return None,
            m => Err((-32601, format!("Method not found: {m}"))),
        };
        let id = id?; // sin id es una notificación: no se responde
        Some(match res {
            Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
            Err((code, m)) => rpc_error(id, code, &m),
        })
    }
}

/// The connection a tool works on, when the assistant may reach it at the level `need`.
fn accessible(cfg: &McpConfig, conn: Option<&ConnConfig>, id: &str, tool: &str, need: Level) -> Result<ConnConfig, String> {
    let conn = conn.filter(|c| effective_level(cfg, c) != Level::None).ok_or_else(|| {
        if id.is_empty() {
            "Falta «connId». Usa list_connections para ver las conexiones disponibles.".to_string()
        } else {
            format!("No hay ninguna conexión accesible con id «{id}». Usa list_connections.")
        }
    })?;
    let level = effective_level(cfg, conn);
    if level < need {
        return Err(level_refused(conn, level, need, tool));
    }
    Ok(conn.clone())
}

fn level_refused(conn: &ConnConfig, level: Level, need: Level, what: &str) -> String {
    if need == Level::Write && (conn.production || conn.read_only) {
        return format!(
            "«{}» está marcada como {} en Celer: los asistentes nunca pueden modificar datos en ella.",
            conn.name,
            if conn.production { "producción" } else { "solo lectura" }
        );
    }
    format!(
        "La conexión «{}» tiene nivel «{}» para asistentes y {what} requiere «{}». El usuario puede cambiarlo en Celer › Ajustes › IA.",
        conn.name,
        level.as_str(),
        need.as_str()
    )
}

/// A library script the assistant may see: one of no connection, or of a connection it can reach.
fn script_visible(cfg: &McpConfig, conns: &[ConnConfig], script: &Value) -> bool {
    match script.get("connId").and_then(Value::as_str).filter(|c| !c.is_empty()) {
        None => true,
        Some(id) => conns.iter().find(|c| c.id == id).is_none_or(|c| effective_level(cfg, c) != Level::None),
    }
}

fn script_json(s: &Value, conns: &[ConnConfig], with_sql: bool) -> Value {
    let conn_id = s.get("connId").and_then(Value::as_str).filter(|c| !c.is_empty());
    let sql = s.get("sql").and_then(Value::as_str).unwrap_or("");
    let mut v = json!({
        "id": s.get("id"),
        "name": s.get("name"),
        "folder": s.get("folder").and_then(Value::as_str).unwrap_or(""),
        "tags": s.get("tags").cloned().unwrap_or_else(|| json!([])),
        "connId": conn_id,
        "connection": conn_id.and_then(|id| conns.iter().find(|c| c.id == id)).map(|c| c.name.clone()),
        "updatedAt": s.get("updatedAt"),
    });
    if let Some(notes) = s.get("notes").and_then(Value::as_str).filter(|n| !n.is_empty()) {
        v["notes"] = json!(truncate_chars(notes, if with_sql { 4000 } else { 200 }));
    }
    if with_sql {
        v["sql"] = json!(truncate_chars(sql, MAX_APP_SQL));
    } else {
        v["lines"] = json!(sql.lines().count());
    }
    v
}

/// What is on screen (the windows' layout, from the app) as the assistant may see it: tabs of connections it cannot
/// reach show only their kind; SQL, filters and orders only for connections with level 'read' or more; a console
/// without a connection shows its title.
fn app_state_for_ai(raw: &Value, cfg: &McpConfig, conns: &[ConnConfig]) -> Value {
    let level_of = |id: &str| conns.iter().find(|c| c.id == id).map(|c| (effective_level(cfg, c), c.name.clone()));
    let windows: Vec<Value> = raw
        .get("windows")
        .and_then(Value::as_array)
        .map(|ws| {
            ws.iter()
                .map(|w| {
                    let active = w.get("activeTabId").and_then(Value::as_str).unwrap_or("");
                    let tabs: Vec<Value> = w
                        .get("tabs")
                        .and_then(Value::as_array)
                        .map(|ts| {
                            ts.iter()
                                .map(|t| {
                                    let tab_id = t.get("id").and_then(Value::as_str).unwrap_or("");
                                    let kind = t.get("kind").and_then(Value::as_str).unwrap_or("sql");
                                    let conn_id = t.get("connId").and_then(Value::as_str).filter(|c| !c.is_empty());
                                    let reach = conn_id.map(level_of);
                                    let level = match reach {
                                        None => None,
                                        Some(Some((l, _))) if l != Level::None => Some(l),
                                        _ => return json!({"id": tab_id, "kind": kind, "hidden": true, "active": tab_id == active}),
                                    };
                                    let mut v = json!({
                                        "id": tab_id,
                                        "kind": kind,
                                        "title": t.get("title"),
                                        "active": tab_id == active,
                                    });
                                    if let (Some(id), Some(Some((_, name)))) = (conn_id, reach) {
                                        v["connId"] = json!(id);
                                        v["connection"] = json!(name);
                                        v["database"] = t.get("database").cloned().unwrap_or(Value::Null);
                                    }
                                    let reads = level.is_some_and(|l| l >= Level::Read);
                                    if kind == "table" {
                                        if let Some(o) = t.get("obj") {
                                            v["table"] = json!({"schema": o.get("schema"), "name": o.get("name"), "kind": o.get("kind")});
                                        }
                                        v["section"] = t.get("section").cloned().unwrap_or(Value::Null);
                                        if reads {
                                            for key in ["where", "orderBy"] {
                                                if let Some(s) = t.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                                                    v[key] = json!(s);
                                                }
                                            }
                                        }
                                    } else if reads {
                                        v["sql"] = json!(truncate_chars(t.get("sql").and_then(Value::as_str).unwrap_or(""), MAX_STATE_SQL));
                                    }
                                    v
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    json!({
                        "window": w.get("label"),
                        "name": w.get("name"),
                        "focused": w.get("focused").and_then(Value::as_bool).unwrap_or(false),
                        "tabs": tabs,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({ "windows": windows })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn initialize_result(params: &Value) -> Value {
    let asked = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(PROTOCOL_VERSION);
    let version = if SUPPORTED_VERSIONS.contains(&asked) {
        asked
    } else {
        PROTOCOL_VERSION
    };
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "celer", "title": "Celer", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Celer gives read access to the user's databases, limited by the permissions the user set in Celer › Settings › IA. \
Start with list_connections to get a connId and its access level (schema = metadata only, read = metadata + read-only queries, write = may also modify data). \
Explore with list_tables / search_objects / describe_table before writing SQL. Row counts are capped; values of sensitive columns appear as \"[oculto]\". \
Every call is recorded in an audit log the user can review."
    })
}

fn conn_prop() -> Value {
    json!({"type": "string", "description": "Connection id from list_connections."})
}

fn db_prop() -> Value {
    json!({"type": "string", "description": "Database to use (see list_databases). Optional: defaults to the connection's database. For SQLite use 'main'."})
}

/// Definiciones de las herramientas que se anuncian en `tools/list`: las de bases de datos y, con «Controlar la
/// aplicación», las que actúan en Celer que permitan sus interruptores.
pub fn tool_defs(cfg: &McpConfig) -> Value {
    let mut all = db_tool_defs();
    if let (Some(list), Value::Array(app)) = (all.as_array_mut(), app_tool_defs()) {
        list.extend(app.into_iter().filter(|t| t["name"].as_str().is_some_and(|n| tool_allowed(cfg, n))));
    }
    all
}

fn app_tool_defs() -> Value {
    let ro = json!({"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false});
    let ui = json!({"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false});
    let table_props = json!({
        "connId": conn_prop(),
        "table": {"type": "string", "description": "Table or view name. 'schema.table' is also accepted."},
        "schema": {"type": "string", "description": "Schema of the table. Optional when the name is unambiguous."},
        "database": db_prop()
    });
    let mut open_table = table_props.clone();
    open_table["filter"] = json!({"type": "string", "description": "Optional WHERE condition (without the word WHERE), in the connection's dialect, e.g. \"status = 'open' AND total > 100\". Checked like run_query: read-only, no protected columns."});
    open_table["orderBy"] = json!({"type": "string", "description": "Optional ORDER BY list (without the words), e.g. \"created_at DESC\"."});
    let mut open_object = table_props.clone();
    open_object["section"] = json!({"type": "string", "enum": ["ddl", "columns", "indexes", "keys", "data"], "description": "What to show first (default 'ddl', the CREATE statement)."});
    let mut er = table_props;
    er["table"] = json!({"type": "string", "description": "Show this table and the tables its foreign keys link it with. Give this or 'schema'."});
    er["schema"] = json!({"type": "string", "description": "Without 'table': the whole schema's diagram."});
    json!([
        {
            "name": "get_app_state",
            "title": "What the user has open in Celer",
            "description": "Celer's windows and their tabs (consoles and tables): which window has the focus and which tab is active in each, with the connection and database of each tab. The SQL of a console and a table's filter are included only for connections the user shared at level 'read' or more; tabs of connections not shared show only their kind. Needs a running Celer.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
            "annotations": ro
        },
        {
            "name": "list_library",
            "title": "List library scripts",
            "description": "List the scripts of the user's script library in Celer (name, folder, tags, connection, number of lines), optionally only those whose name, folder or tags contain 'query', or those in 'folder' and its subfolders. Scripts of connections not shared with assistants are not listed. Use get_library_script for the SQL.",
            "inputSchema": {"type": "object", "properties": {
                "query": {"type": "string", "description": "Text to look for in names, folders and tags."},
                "folder": {"type": "string", "description": "Only this folder (e.g. 'Informes/Mensuales') and its subfolders."}
            }, "additionalProperties": false},
            "annotations": ro
        },
        {
            "name": "get_library_script",
            "title": "Get a library script",
            "description": "The SQL and details of one script of the user's library, by 'id' (from list_library) or by exact 'name'.",
            "inputSchema": {"type": "object", "properties": {
                "id": {"type": "string"},
                "name": {"type": "string"}
            }, "additionalProperties": false},
            "annotations": ro
        },
        {
            "name": "add_library_script",
            "title": "Add a script to the library",
            "description": "Save a SQL script in the user's script library in Celer, so the user can find and run it later. The user sees a notice that the AI added it. Optional folder ('Informes/Mensuales'), tags, notes and the connection it belongs to (a connId from list_connections). Needs a running Celer.",
            "inputSchema": {"type": "object", "properties": {
                "name": {"type": "string", "minLength": 1, "description": "Script name (made unique if taken)."},
                "sql": {"type": "string", "minLength": 1},
                "folder": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
                "notes": {"type": "string", "description": "What the script does, for the user."},
                "connId": conn_prop()
            }, "required": ["name", "sql"], "additionalProperties": false},
            "annotations": ui
        },
        {
            "name": "open_console",
            "title": "Open a SQL console in Celer",
            "description": "Open a new console tab in Celer with SQL written for the user to see, edit and run, on a connection (connId) and database. With run=true Celer also runs it, only if the user allows it and the connection's level permits that statement: a single read-only statement at level 'read' (checked like run_query), a single modifying statement only at level 'write'. The results are shown to the user in Celer, not returned here (use run_query to read data). If the user is typing, the tab opens in the background and the user is told. Needs a running Celer.",
            "inputSchema": {"type": "object", "properties": {
                "connId": conn_prop(),
                "database": db_prop(),
                "sql": {"type": "string", "description": "The SQL to put in the console."},
                "title": {"type": "string", "description": "Tab title (default: the connection's name)."},
                "run": {"type": "boolean", "description": "Also run it (needs connId; see above)."}
            }, "required": ["sql"], "additionalProperties": false},
            "annotations": ui
        },
        {
            "name": "open_table",
            "title": "Open a table in Celer",
            "description": "Open a table or view in Celer's table viewer for the user, optionally filtered and ordered. Requires level 'read'. The rows are shown to the user, not returned here. Needs a running Celer.",
            "inputSchema": {"type": "object", "properties": open_table, "required": ["connId", "table"], "additionalProperties": false},
            "annotations": ui
        },
        {
            "name": "open_er_diagram",
            "title": "Show an E-R diagram in Celer",
            "description": "Show the user the entity-relationship diagram of a table and the tables its foreign keys link it with, or of a whole schema. Requires level 'schema'. Needs a running Celer.",
            "inputSchema": {"type": "object", "properties": er, "required": ["connId"], "additionalProperties": false},
            "annotations": ui
        },
        {
            "name": "open_object",
            "title": "Show a table's definition in Celer",
            "description": "Open a table or view in Celer on its definition: DDL (default), columns, indexes or keys. Requires level 'schema'. Needs a running Celer.",
            "inputSchema": {"type": "object", "properties": open_object, "required": ["connId", "table"], "additionalProperties": false},
            "annotations": ui
        }
    ])
}

fn db_tool_defs() -> Value {
    let ro = json!({"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false});
    json!([
        {
            "name": "list_connections",
            "title": "List connections",
            "description": "List the database connections the user has shared with AI assistants in Celer, with the access level of each: 'schema' (metadata only), 'read' (metadata plus read-only queries) or 'write' (may also modify data). Connections the user has not shared are not listed. Call this first: every other tool needs a connId from here.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
            "annotations": ro
        },
        {
            "name": "list_databases",
            "title": "List databases",
            "description": "List the databases (catalogs) available on a connection, plus the current one. Requires level 'schema' or higher.",
            "inputSchema": {"type": "object", "properties": {"connId": conn_prop()}, "required": ["connId"], "additionalProperties": false},
            "annotations": ro
        },
        {
            "name": "list_tables",
            "title": "List tables",
            "description": "List the tables and views of a database with their schema, kind ('table' or 'view') and column count. Requires level 'schema' or higher.",
            "inputSchema": {"type": "object", "properties": {
                "connId": conn_prop(),
                "database": db_prop(),
                "schema": {"type": "string", "description": "Only list objects of this schema (e.g. 'public', 'dbo'). Optional."}
            }, "required": ["connId"], "additionalProperties": false},
            "annotations": ro
        },
        {
            "name": "describe_table",
            "title": "Describe table",
            "description": "Describe a table or view: columns with type, nullability, primary key, identity and default, plus its DDL (CREATE statement, indexes and constraints when the engine provides them). Requires level 'schema' or higher.",
            "inputSchema": {"type": "object", "properties": {
                "connId": conn_prop(),
                "table": {"type": "string", "description": "Table or view name. 'schema.table' is also accepted."},
                "schema": {"type": "string", "description": "Schema of the table. Optional when the name is unambiguous."},
                "database": db_prop()
            }, "required": ["connId", "table"], "additionalProperties": false},
            "annotations": ro
        },
        {
            "name": "search_objects",
            "title": "Search tables and columns",
            "description": "Case-insensitive substring search over table/view names and column names of a database. Useful to find where some data lives (e.g. query 'customer' or 'email'). Returns at most 200 matches. Requires level 'schema' or higher.",
            "inputSchema": {"type": "object", "properties": {
                "connId": conn_prop(),
                "query": {"type": "string", "minLength": 1, "description": "Text to look for in table and column names."},
                "database": db_prop()
            }, "required": ["connId", "query"], "additionalProperties": false},
            "annotations": ro
        },
        {
            "name": "sample_rows",
            "title": "Sample rows",
            "description": "Return the first rows of a table or view (SELECT * with a row limit) to see what the data looks like. Result: {columns, types, rows (arrays), rowCount, truncated, elapsedMs}. Sensitive columns show \"[oculto]\". Requires level 'read' or higher.",
            "inputSchema": {"type": "object", "properties": {
                "connId": conn_prop(),
                "table": {"type": "string", "description": "Table or view name. 'schema.table' is also accepted."},
                "schema": {"type": "string", "description": "Schema of the table. Optional when the name is unambiguous."},
                "database": db_prop(),
                "limit": {"type": "integer", "minimum": 1, "maximum": HARD_MAX_ROWS, "description": "Rows to return (default 20; capped by the user's limits)."}
            }, "required": ["connId", "table"], "additionalProperties": false},
            "annotations": ro
        },
        {
            "name": "run_query",
            "title": "Run read-only query",
            "description": "Run ONE read-only SQL statement (SELECT, WITH … SELECT, SHOW, EXPLAIN, DESCRIBE, VALUES, TABLE, or a read-only SQLite PRAGMA) in the connection's SQL dialect and return the rows. Multiple statements, SELECT … INTO, FOR UPDATE/SHARE, data-modifying CTEs and side-effect functions are rejected; where the engine allows it the query runs inside a read-only transaction. Rows are capped (default 100, also limited by the user's settings): add your own LIMIT/TOP and aggregate in SQL rather than fetching many rows. Result: {columns, types, rows (arrays), rowCount, truncated, elapsedMs}. Sensitive columns show \"[oculto]\" and must not be referenced in expressions. Requires level 'read' or higher.",
            "inputSchema": {"type": "object", "properties": {
                "connId": conn_prop(),
                "sql": {"type": "string", "minLength": 1, "description": "A single read-only SQL statement."},
                "database": db_prop(),
                "maxRows": {"type": "integer", "minimum": 1, "maximum": HARD_MAX_ROWS, "description": "Maximum rows to return (default 100; capped by the user's limits)."}
            }, "required": ["connId", "sql"], "additionalProperties": false},
            "annotations": ro
        },
        {
            "name": "execute_statement",
            "title": "Execute statement (modifies data)",
            "description": "Execute ONE statement that may modify data or structure (INSERT, UPDATE, DELETE, CREATE, ALTER, …) with autocommit: changes are permanent. Only available on connections the user set to level 'write'; never on production or read-only connections. Server administration (users, roles, databases, GRANT, KILL, files/programs) is rejected. Prefer run_query for anything that only reads, and confirm destructive changes with the user first. Result: {rowsAffected, messages, elapsedMs} plus rows if the statement returns any.",
            "inputSchema": {"type": "object", "properties": {
                "connId": conn_prop(),
                "sql": {"type": "string", "minLength": 1, "description": "A single SQL statement."},
                "database": db_prop()
            }, "required": ["connId", "sql"], "additionalProperties": false},
            "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": false}
        }
    ])
}

/// Where this process's client runs. `--client=wsl:<distro>` is what Settings › IA y MCP adds when it registers
/// Celer in a WSL distro (a Windows program started from WSL gets no WSL variables unless WSLENV passes them).
pub fn origin_from_args(args: &[String]) -> String {
    let value = args.iter().find_map(|a| a.strip_prefix("--client=")).map(str::trim).unwrap_or("");
    let clean = |s: &str| s.chars().filter(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ')).take(40).collect::<String>().trim().to_string();
    match value.split_once(':') {
        Some((kind, distro)) if kind.eq_ignore_ascii_case("wsl") && !clean(distro).is_empty() => format!("WSL ({})", clean(distro)),
        _ if value.eq_ignore_ascii_case("wsl") => "WSL".into(),
        _ if !clean(value).is_empty() => clean(value),
        _ => default_origin(),
    }
}

fn default_origin() -> String {
    // A Windows program started from WSL sees WSL_DISTRO_NAME only when WSLENV passes it.
    if let Some(distro) = std::env::var("WSL_DISTRO_NAME").ok().filter(|d| !d.trim().is_empty()) {
        if cfg!(windows) {
            return format!("WSL ({})", distro.trim());
        }
    }
    match std::env::consts::OS {
        "windows" => "Windows".into(),
        "macos" => "macOS".into(),
        "linux" => "Linux".into(),
        other => other.to_string(),
    }
}

/// Bucle principal de `celer --mcp`: JSON-RPC por stdio, un mensaje por línea.
pub fn serve_stdio() -> i32 {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("celer mcp: no se pudo iniciar el runtime: {e}");
            return 1;
        }
    };
    let dir = default_data_dir();
    eprintln!(
        "celer mcp {}: datos en {}",
        env!("CARGO_PKG_VERSION"),
        dir.display()
    );
    let args: Vec<String> = std::env::args().collect();
    let server = McpServer::with_origin(dir, false, origin_from_args(&args));
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<Value>(line) {
            Ok(v) => rt.block_on(server.handle(v)),
            Err(e) => Some(rpc_error(Value::Null, -32700, &format!("Parse error: {e}"))),
        };
        if let Some(r) = resp {
            if writeln!(stdout, "{r}").and_then(|_| stdout.flush()).is_err() {
                break;
            }
        }
    }
    0
}

// ───────────────────────────── Clientes ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub exe_path: String,
    pub args: Vec<String>,
    pub claude_desktop_config_path: String,
    pub claude_desktop_configured: bool,
    pub claude_code_command: String,
    /// Claude Code on this system (`~/.claude.json`): "yes", "stale" (another path), "no".
    pub claude_code_registered: String,
    /// This system is Windows: the WSL section applies.
    pub wsl_supported: bool,
}

/// Ficheros de configuración posibles de Claude Desktop. En Windows, la versión empaquetada
/// (MSIX) guarda los datos en `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`.
pub fn claude_desktop_config_paths() -> Vec<PathBuf> {
    let mut v = Vec::new();
    #[cfg(windows)]
    if let Some(local) = dirs::data_local_dir() {
        if let Ok(rd) = fs::read_dir(local.join("Packages")) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with("Claude_") {
                    let p = e.path().join("LocalCache").join("Roaming").join("Claude");
                    if p.is_dir() {
                        v.push(p.join("claude_desktop_config.json"));
                    }
                }
            }
        }
    }
    if let Some(c) = dirs::config_dir() {
        v.push(c.join("Claude").join("claude_desktop_config.json"));
    }
    v
}

fn exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "celer".into())
}

fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

fn configured_in(path: &Path, exe: &str) -> bool {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok())
        .and_then(|v| {
            v.pointer("/mcpServers/celer/command")
                .and_then(Value::as_str)
                .map(|c| same_path(c, exe))
        })
        .unwrap_or(false)
}

pub fn client_info() -> ClientInfo {
    let exe = exe_path();
    let paths = claude_desktop_config_paths();
    let primary = paths
        .iter()
        .find(|p| p.is_file())
        .or(paths.first())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    ClientInfo {
        claude_desktop_configured: paths.iter().any(|p| configured_in(p, &exe)),
        claude_code_command: format!("claude mcp add --scope user celer -- \"{exe}\" --mcp"),
        claude_code_registered: claude_code_registered(&exe),
        claude_desktop_config_path: primary,
        args: vec!["--mcp".into()],
        exe_path: exe,
        wsl_supported: cfg!(windows),
    }
}

/// Claude Code on this system: how its `~/.claude.json` has `celer` ("yes", "stale", "no").
fn claude_code_registered(exe: &str) -> String {
    let Some(path) = dirs::home_dir().map(|h| h.join(".claude.json")) else { return "no".into() };
    let Ok(text) = fs::read_to_string(&path) else { return "no".into() };
    match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
        Ok(v) => crate::mcp_wsl::registration(&v, exe, same_path).0,
        Err(_) => "no".into(),
    }
}

pub fn exe_path_pub() -> String {
    exe_path()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStatus {
    /// "Claude Desktop", "Claude Code".
    pub name: String,
    /// "Windows", "WSL (Ubuntu)"…
    pub place: String,
    /// "yes" or "stale" (registered with another path: register again).
    pub state: String,
}

/// What the status bar shows: whether MCP is on, the clients registered and the last call.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub enabled: bool,
    /// "Controlar la aplicación" is on (and MCP too).
    pub app_control: bool,
    pub clients: Vec<ClientStatus>,
    /// The WSL distros have been read (it takes a moment after start).
    pub wsl_checked: bool,
    pub last_call: Option<AuditEntry>,
}

pub fn status(store: &Store) -> McpStatus {
    let cfg = load_config(store);
    let exe = exe_path();
    let local = default_origin();
    let mut clients = Vec::new();
    if claude_desktop_config_paths().iter().any(|p| configured_in(p, &exe)) {
        clients.push(ClientStatus { name: "Claude Desktop".into(), place: local.clone(), state: "yes".into() });
    }
    let code = claude_code_registered(&exe);
    if code != "no" {
        clients.push(ClientStatus { name: "Claude Code".into(), place: local, state: code });
    }
    let wsl = if cfg.enabled { crate::mcp_wsl::cached(&exe, Duration::from_secs(120)) } else { None };
    for d in wsl.iter().flat_map(|w| w.distros.iter()) {
        if d.registered == "yes" || d.registered == "stale" {
            clients.push(ClientStatus { name: "Claude Code".into(), place: format!("WSL ({})", d.name), state: d.registered.clone() });
        }
    }
    McpStatus {
        enabled: cfg.enabled,
        app_control: cfg.enabled && cfg.app_control.enabled,
        clients,
        wsl_checked: wsl.is_some() || !cfg!(windows),
        last_call: last_audit(store),
    }
}

/// Añade (o actualiza) la entrada `celer` en un `claude_desktop_config.json`, conservando el
/// resto de claves y dejando antes una copia `.bak`.
pub fn merge_claude_config(path: &Path, exe: &str) -> Result<(), String> {
    let mut root: Value = if path.is_file() {
        let s = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let s = s.trim_start_matches('\u{feff}');
        if s.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(s).map_err(|e| {
                format!(
                    "{} no es un JSON válido ({e}); no se ha modificado",
                    path.display()
                )
            })?
        }
    } else {
        json!({})
    };
    let Some(obj) = root.as_object_mut() else {
        return Err(format!("{} no contiene un objeto JSON", path.display()));
    };
    if path.is_file() {
        let mut bak = path.as_os_str().to_owned();
        bak.push(".bak");
        fs::copy(path, PathBuf::from(bak)).map_err(|e| format!("No se pudo crear la copia: {e}"))?;
    }
    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| json!({}));
    if !servers.is_object() {
        *servers = json!({});
    }
    servers["celer"] = json!({"command": exe, "args": ["--mcp"]});
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Registra Celer en Claude Desktop (en todas sus ubicaciones existentes). Devuelve la ruta principal.
pub fn install_claude_desktop() -> Result<String, String> {
    let exe = exe_path();
    let paths = claude_desktop_config_paths();
    let primary = paths
        .iter()
        .find(|p| p.is_file())
        .or(paths.first())
        .cloned()
        .ok_or_else(|| "No se encontró la carpeta de configuración de Claude Desktop".to_string())?;
    let mut done = false;
    for p in &paths {
        if p.is_file() || *p == primary {
            merge_claude_config(p, &exe)?;
            done = true;
        }
    }
    if !done {
        merge_claude_config(&primary, &exe)?;
    }
    Ok(primary.to_string_lossy().to_string())
}

// ───────────────────────────── Tests ─────────────────────────────

#[cfg(test)]
mod batch_tests {
    use super::*;

    #[test]
    fn read_only_batches() {
        assert!(!batch_writes("SELECT 1; SELECT 'DELETE FROM t'", DbKind::Postgres));
        assert!(batch_writes("SELECT 1; DELETE FROM t", DbKind::Postgres));
        assert!(batch_writes("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", DbKind::Postgres));
        assert!(batch_writes("select 1;\n-- x\nupdate t set a = 1", DbKind::Mysql));
        assert!(!batch_writes("SET search_path TO public; SELECT * FROM t", DbKind::Postgres));
        assert!(batch_writes("SELECT * INTO copy FROM t", DbKind::Mssql));
        assert!(batch_writes("REFRESH MATERIALIZED VIEW v", DbKind::Postgres));
        assert!(batch_writes("CLUSTER t USING t_pkey", DbKind::Postgres));
        // SQL Server: a bare procedure call starts a batch, and statements need no ';'.
        assert!(batch_writes("sp_executesql N'DELETE FROM t'", DbKind::Mssql));
        assert!(batch_writes("[dbo].[purge_all] 1", DbKind::Mssql));
        assert!(batch_writes("SELECT 1\nGO\nsp_executesql N'DELETE FROM t'", DbKind::Mssql));
        assert!(batch_writes("DECLARE @n int = 1 IF @n = 1 DELETE FROM t", DbKind::Mssql));
        assert!(batch_writes("SELECT * FROM OPENQUERY(srv, 'SELECT 1')", DbKind::Mssql));
        assert!(!batch_writes("SET NOCOUNT ON; DECLARE @n int = 1; SELECT @n\nGO\nSELECT 2", DbKind::Mssql));
        assert!(!batch_writes("USE db; SELECT [update] FROM t WHERE x IN (SELECT 1)", DbKind::Mssql));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_read(sql: &str, kind: DbKind) {
        if let Err(e) = check_read_query(sql, kind) {
            panic!("debería aceptarse ({kind:?}): {sql}\n  → {e}");
        }
    }
    fn bad_read(sql: &str, kind: DbKind) {
        assert!(
            check_read_query(sql, kind).is_err(),
            "debería rechazarse ({kind:?}): {sql}"
        );
    }

    #[test]
    fn read_guard_accepts() {
        use DbKind::*;
        for k in [Postgres, Mysql, Sqlite, Mssql, Odbc] {
            ok_read("SELECT 1", k);
            ok_read("select * from t;", k);
            ok_read("  -- comentario; DELETE\n/* x; y DELETE */ SELECT 'a;b' AS x", k);
            ok_read("SELECT 'it''s; DROP TABLE t' FROM t", k);
            ok_read("WITH x AS (SELECT 1 AS a) SELECT * FROM x", k);
            ok_read("(SELECT 1)", k);
            ok_read("SELECT a FROM t ORDER BY a DESC", k);
            ok_read("SELECT count(*) FROM orders WHERE status = 'deleted'", k);
        }
        ok_read("SELECT \"into\", \"update\" FROM t", Postgres);
        ok_read("SELECT $$a;b$$, $tag$ DELETE; $tag$", Postgres);
        ok_read("SELECT E'it\\'s; ok'", Postgres);
        ok_read("SELECT arr[1] FROM t", Postgres);
        ok_read("EXPLAIN SELECT * FROM t", Postgres);
        ok_read("SHOW search_path", Postgres);
        ok_read("TABLE t", Postgres);
        ok_read("VALUES (1), (2)", Postgres);
        ok_read("SELECT 1 /* /* anidado; */ DELETE */", Postgres);
        ok_read("SHOW CREATE TABLE t", Mysql);
        ok_read("SHOW TABLES", Mysql);
        ok_read("DESCRIBE t", Mysql);
        ok_read("DESC t", Mysql);
        ok_read("SELECT insert('abc', 1, 1, 'x'), truncate(1.25, 1)", Mysql);
        ok_read("SELECT `select`, \"a;b\" FROM t # comentario; DELETE", Mysql);
        ok_read("SELECT 1 -- comentario; DELETE", Mysql);
        ok_read("SELECT [order] FROM [dbo].[t]", Mssql);
        ok_read("PRAGMA table_info(t)", Sqlite);
        ok_read("PRAGMA main.index_list('t')", Sqlite);
        ok_read("PRAGMA user_version", Sqlite);
    }

    #[test]
    fn read_guard_rejects() {
        use DbKind::*;
        for k in [Postgres, Mysql, Sqlite, Mssql, Odbc] {
            bad_read("", k);
            bad_read("  ;  -- nada", k);
            bad_read("SELECT 1; DELETE FROM t", k);
            bad_read("SELECT 1; SELECT 2", k);
            bad_read("DELETE FROM t", k);
            bad_read("UPDATE t SET a = 1", k);
            bad_read("insert into t values (1)", k);
            bad_read("DROP TABLE t", k);
            bad_read("SELECT * INTO copia FROM t", k);
            bad_read("SELECT * FROM t FOR UPDATE", k);
            bad_read("SELECT * FROM t FOR SHARE", k);
            bad_read("SELECT * FROM t FOR NO KEY UPDATE", k);
            bad_read("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", k);
            bad_read("WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT 1", k);
            bad_read("WITH x AS (UPDATE t SET a = 1 RETURNING a) SELECT * FROM x", k);
            bad_read("SELECT 'sin cerrar", k);
            bad_read("SELECT 1 /* sin cerrar", k);
            bad_read("EXEC sp_who", k);
            bad_read("SELECT 1 EXEC('DROP TABLE t')", k);
            bad_read("SELECT 1 DELETE FROM t", k); // lote T-SQL sin ';'
            bad_read("SELECT pg_terminate_backend(123)", k);
            bad_read("SELECT nextval('s')", k);
            bad_read("SELECT load_file('/etc/passwd')", k);
            bad_read("COPY t TO '/tmp/x'", k);
            bad_read("CALL p()", k);
            bad_read("ATTACH DATABASE 'x.db' AS x", k);
            bad_read("MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN DELETE", k);
            bad_read("SELECT * FROM t LOCK IN SHARE MODE", k);
            bad_read("EXPLAIN ANALYZE DELETE FROM t", k);
        }
        // PostgreSQL con standard_conforming_strings=off interpreta '\'' como escape.
        bad_read("SELECT 'a\\'; DELETE FROM t; --'", Postgres);
        // MySQL: escape con barra en una variante, comillas ANSI/NO_BACKSLASH_ESCAPES en otra.
        bad_read("SELECT 'a\\'; DELETE FROM t; -- '", Mysql);
        bad_read("SELECT 1 /*! ; DELETE FROM t */", Mysql);
        bad_read("SELECT 1 /*M! ; DELETE FROM t */", Mysql);
        bad_read("SELECT 1--1; DELETE FROM t", Mysql);
        bad_read("SELECT $$; DELETE FROM t; $$", Mysql);
        bad_read("SELECT * FROM t INTO OUTFILE '/tmp/x'", Mysql);
        bad_read("SELECT 1 # x\n; DELETE FROM t", Mysql);
        // Comentarios anidados: el motor podría no verlos como tales.
        bad_read("SELECT 1 /* /* */ ; DELETE FROM t; */", Odbc);
        bad_read("SELECT 1 /* /* */ ; DELETE FROM t; */", Sqlite);
        bad_read("PRAGMA journal_mode = WAL", Sqlite);
        bad_read("PRAGMA journal_mode(WAL)", Sqlite);
        bad_read("PRAGMA writable_schema", Sqlite);
        bad_read("SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')", Mssql);
        bad_read("SELECT 1 xp_cmdshell 'dir'", Mssql);
        // Quoted or schema-qualified names call the same function.
        bad_read("SELECT \"pg_read_file\"('postgresql.conf')", Postgres);
        bad_read("SELECT \"PG_TERMINATE_BACKEND\"(pid) FROM pg_stat_activity", Postgres);
        bad_read("SELECT pg_catalog.\"pg_cancel_backend\" (1)", Postgres);
        bad_read("SELECT \"set_config\"('a', 'b', false)", Postgres);
        bad_read("SELECT * FROM \"dblink_exec\"('x', 'y')", Postgres);
        bad_read("SELECT U&\"pg_r\\0065ad_file\"('x')", Postgres);
        bad_read("SELECT `get_lock`('x', 10)", Mysql);
        bad_read("SELECT `load_file`('/etc/passwd')", Mysql);
        bad_read("SELECT 1 FROM [xp_cmdshell]", Mssql);
        ok_read("SELECT \"pg_read_file\" FROM t", Postgres);
    }

    #[test]
    fn write_guard() {
        use DbKind::*;
        for k in [Postgres, Mysql, Sqlite, Mssql] {
            check_write_statement("INSERT INTO t VALUES (1)", k).unwrap();
            check_write_statement("UPDATE t SET a = 'x;y' WHERE id = 2;", k).unwrap();
            check_write_statement("CREATE TABLE x (id int)", k).unwrap();
            check_write_statement("DELETE FROM t WHERE id = 1", k).unwrap();
            assert!(check_write_statement("INSERT INTO t VALUES (1); DROP TABLE t", k).is_err());
            assert!(check_write_statement("GRANT ALL ON t TO bob", k).is_err());
            assert!(check_write_statement("DROP DATABASE celer", k).is_err());
            assert!(check_write_statement("CREATE USER x", k).is_err());
            assert!(check_write_statement("", k).is_err());
        }
        check_write_statement(
            "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql",
            Postgres,
        )
        .unwrap();
        assert!(check_write_statement("COPY t FROM PROGRAM 'rm -rf /'", Postgres).is_err());
        assert!(check_write_statement("SELECT * FROM t INTO OUTFILE '/tmp/x'", Mysql).is_err());
        assert!(check_write_statement("EXEC xp_cmdshell 'dir'", Mssql).is_err());
        assert!(check_write_statement("EXEC [master].[dbo].[xp_cmdshell] 'dir'", Mssql).is_err());
        assert!(check_write_statement("SELECT \"lo_export\"(1, '/tmp/x')", Postgres).is_err());
        assert!(check_write_statement("DO `sys_exec`('x')", Mysql).is_err());
        assert!(check_write_statement("ATTACH DATABASE 'x' AS y", Sqlite).is_err());
    }

    fn conn(id: &str, production: bool, read_only: bool) -> ConnConfig {
        ConnConfig {
            id: id.into(),
            name: id.into(),
            production,
            read_only,
            ..ConnConfig::default()
        }
    }

    #[test]
    fn levels_and_caps() {
        let mut cfg = McpConfig::default();
        for (id, l) in [
            ("w", Level::Write),
            ("r", Level::Read),
            ("s", Level::Schema),
        ] {
            cfg.connections.insert(
                id.into(),
                ConnPermission {
                    level: l,
                    max_rows: None,
                },
            );
        }
        assert_eq!(effective_level(&cfg, &conn("w", false, false)), Level::Write);
        assert_eq!(effective_level(&cfg, &conn("w", true, false)), Level::Read);
        assert_eq!(effective_level(&cfg, &conn("w", false, true)), Level::Read);
        assert_eq!(effective_level(&cfg, &conn("r", true, true)), Level::Read);
        assert_eq!(effective_level(&cfg, &conn("s", true, false)), Level::Schema);
        assert_eq!(effective_level(&cfg, &conn("x", false, false)), Level::None);

        cfg.max_rows = 200;
        assert_eq!(row_cap(&cfg, "r", None, 100), 100);
        assert_eq!(row_cap(&cfg, "r", Some(1000), 100), 200);
        assert_eq!(row_cap(&cfg, "r", Some(0), 100), 1);
        cfg.connections.get_mut("r").unwrap().max_rows = Some(10);
        assert_eq!(row_cap(&cfg, "r", Some(50), 100), 10);
        cfg.max_rows = 999_999;
        let cfg = cfg.sanitized();
        assert_eq!(cfg.max_rows, HARD_MAX_ROWS);
        assert_eq!(row_cap(&cfg, "s", Some(1_000_000), 100), HARD_MAX_ROWS as usize);
    }

    #[test]
    fn config_defaults() {
        let d = McpConfig::default();
        assert!(!d.enabled);
        assert_eq!(d.max_rows, 200);
        assert_eq!(d.timeout_secs, 30);
        assert_eq!(d.redact_pattern, DEFAULT_REDACT);
        assert!(d.connections.is_empty());
        let p: McpConfig =
            serde_json::from_str(r#"{"enabled":true,"connections":{"a":{"level":"read"}}}"#)
                .unwrap();
        assert!(p.enabled);
        assert_eq!(p.max_rows, 200);
        assert_eq!(p.connections["a"].level, Level::Read);
        assert_eq!(p.connections["a"].max_rows, None);
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("maxRows").is_some() && v.get("timeoutSecs").is_some());
        assert!(v.get("redactPattern").is_some());
        // Un fichero inválido no concede nada.
        let dir = temp_dir();
        let store = Store::new(dir.clone());
        store.write_atomic(CONFIG_FILE, "{\"enabled\": tru").unwrap();
        assert_eq!(load_config(&store), McpConfig::default());
        store
            .write_atomic(CONFIG_FILE, r#"{"enabled":true,"connections":{"a":{"level":"admin"}}}"#)
            .unwrap();
        assert!(!load_config(&store).enabled);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn redaction() {
        let r = Redactor::new(DEFAULT_REDACT);
        for n in [
            "password", "PASSWORD_HASH", "pass", "user_secret", "api_key", "apikey", "Token",
            "salt", "credit_card", "creditcard", "iban", "ssn",
        ] {
            assert!(r.matches(n), "{n}");
        }
        for n in ["id", "name", "email", "created_at"] {
            assert!(!r.matches(n), "{n}");
        }
        assert!(!Redactor::new("").active());
        assert!(Redactor::new("(").matches("password")); // patrón inválido → por defecto

        let out = ExecOutput {
            results: vec![ResultSet {
                columns: vec![
                    ColumnInfo { name: "id".into(), type_name: "int".into(), kind: ColKind::Number },
                    ColumnInfo { name: "password".into(), type_name: "text".into(), kind: ColKind::Text },
                ],
                rows: vec![
                    vec![Cell::Int(1), Cell::Text("s3cret".into())],
                    vec![Cell::Int(2), Cell::Null],
                ],
                has_more: true,
                rows_affected: None,
            }],
            ..ExecOutput::default()
        };
        let (v, n) = render_exec(&out, &r, 5);
        assert_eq!(n, 2);
        assert_eq!(v["rows"][0], json!([1, "[oculto]"]));
        assert_eq!(v["rows"][1], json!([2, null]));
        assert_eq!(v["truncated"], json!(true));
        assert_eq!(v["redactedColumns"], json!(["password"]));
        assert!(!v.to_string().contains("s3cret"));
    }

    #[test]
    fn claude_config_merge() {
        let dir = temp_dir();
        let path = dir.join("claude_desktop_config.json");
        merge_claude_config(&path, "C:\\x\\celer.exe").unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["celer"]["args"], json!(["--mcp"]));
        fs::write(
            &path,
            r#"{"theme":"dark","mcpServers":{"other":{"command":"x"}}}"#,
        )
        .unwrap();
        merge_claude_config(&path, "C:\\x\\celer.exe").unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["mcpServers"]["celer"]["command"], "C:\\x\\celer.exe");
        assert!(dir.join("claude_desktop_config.json.bak").is_file());
        assert!(configured_in(&path, "c:\\X\\celer.exe") == cfg!(windows));
        fs::write(&path, "{ roto").unwrap();
        assert!(merge_claude_config(&path, "x").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ roto");
        let _ = fs::remove_dir_all(dir);
    }

    // ───────────── Integración ─────────────

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("celer-mcp-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    struct Client {
        server: McpServer,
        rt: tokio::runtime::Runtime,
        next: i64,
    }

    impl Client {
        fn rpc(&mut self, method: &str, params: Value) -> Value {
            self.next += 1;
            let msg = json!({"jsonrpc": "2.0", "id": self.next, "method": method, "params": params});
            let r = self.rt.block_on(self.server.handle(msg)).expect("respuesta");
            assert_eq!(r["id"], json!(self.next));
            r
        }
        /// Llama a una herramienta y devuelve (isError, texto).
        fn call(&mut self, name: &str, args: Value) -> (bool, String) {
            let r = self.rpc("tools/call", json!({"name": name, "arguments": args}));
            let res = &r["result"];
            (
                res["isError"].as_bool().unwrap(),
                res["content"][0]["text"].as_str().unwrap().to_string(),
            )
        }
        fn ok(&mut self, name: &str, args: Value) -> Value {
            let (err, text) = self.call(name, args.clone());
            assert!(!err, "{name} {args} falló: {text}");
            serde_json::from_str(&text).unwrap()
        }
        fn err(&mut self, name: &str, args: Value) -> String {
            let (err, text) = self.call(name, args.clone());
            assert!(err, "{name} {args} debería fallar: {text}");
            text
        }
    }

    fn sqlite_conn(id: &str, path: &str, production: bool) -> Value {
        json!({"id": id, "name": format!("SQLite {id}"), "kind": "sqlite", "filePath": path,
               "production": production, "savePassword": false})
    }

    #[test]
    fn jsonrpc_end_to_end_sqlite() {
        let dir = temp_dir();
        let file = dir.join("datos.db");
        {
            let c = rusqlite::Connection::open(&file).unwrap();
            c.execute_batch(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, password TEXT);
                 INSERT INTO users(name, password) VALUES ('ana','h1'),('luis','h2'),('eva','h3');
                 CREATE VIEW v_users AS SELECT id, name FROM users;",
            )
            .unwrap();
        }
        let f = file.to_string_lossy().to_string();
        let conns = json!([
            sqlite_conn("read", &f, false),
            sqlite_conn("schema", &f, false),
            sqlite_conn("hidden", &f, false),
            sqlite_conn("prod", &f, true),
            sqlite_conn("mem", ":memory:", false),
        ]);
        fs::write(dir.join("connections.json"), conns.to_string()).unwrap();
        let mut cfg = McpConfig {
            enabled: true,
            ..McpConfig::default()
        };
        for (id, l) in [
            ("read", Level::Read),
            ("schema", Level::Schema),
            ("prod", Level::Write),
            ("mem", Level::Write),
        ] {
            cfg.connections.insert(id.into(), ConnPermission { level: l, max_rows: None });
        }
        cfg.connections.get_mut("read").unwrap().max_rows = Some(2);
        let store = Store::new(dir.clone());
        save_config(&store, cfg.clone()).unwrap();

        let mut c = Client {
            server: McpServer::new(dir.clone(), false),
            rt: rt(),
            next: 0,
        };

        // initialize / tools/list / ping / notificaciones
        let init = c.rpc("initialize", json!({"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}));
        assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(init["result"]["serverInfo"]["name"], "celer");
        assert!(init["result"]["capabilities"]["tools"].is_object());
        let init = c.rpc("initialize", json!({"protocolVersion": "1999-01-01"}));
        assert_eq!(init["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert!(c
            .rt
            .block_on(c.server.handle(json!({"jsonrpc": "2.0", "method": "notifications/initialized"})))
            .is_none());
        assert_eq!(c.rpc("ping", json!({}))["result"], json!({}));
        let tools = c.rpc("tools/list", json!({}));
        let names: Vec<&str> = tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, TOOL_NAMES);
        assert_eq!(c.rpc("nope", json!({}))["error"]["code"], -32601);
        assert_eq!(c.rpc("tools/call", json!({"name": "nope"}))["error"]["code"], -32602);

        // list_connections: las ocultas no aparecen; producción se limita a read.
        let l = c.ok("list_connections", json!({}));
        let list = l["connections"].as_array().unwrap();
        let ids: Vec<&str> = list.iter().map(|x| x["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["read", "schema", "prod", "mem"]);
        assert_eq!(list[2]["level"], "read");
        assert_eq!(list[0]["database"], "datos.db");

        // Metadatos
        let t = c.ok("list_tables", json!({"connId": "schema"}));
        let tables = t["tables"].as_array().unwrap();
        assert!(tables.iter().any(|x| x["name"] == "users" && x["kind"] == "table" && x["columns"] == 3));
        assert!(tables.iter().any(|x| x["name"] == "v_users" && x["kind"] == "view"));
        let d = c.ok("describe_table", json!({"connId": "schema", "table": "USERS"}));
        assert_eq!(d["columns"][0]["primaryKey"], true);
        assert_eq!(d["columns"][1]["nullable"], false);
        assert!(d["ddl"].as_str().unwrap().contains("CREATE TABLE"));
        let s = c.ok("search_objects", json!({"connId": "schema", "query": "NAM"}));
        assert!(s["matches"].as_array().unwrap().iter().any(|m| m["column"] == "name"));
        let dbs = c.ok("list_databases", json!({"connId": "schema"}));
        assert_eq!(dbs["databases"][0], "main");

        // Nivel schema: sin datos.
        assert!(c.err("sample_rows", json!({"connId": "schema", "table": "users"})).contains("read"));
        assert!(c.err("run_query", json!({"connId": "schema", "sql": "SELECT 1"})).contains("read"));
        // Conexiones ocultas o inexistentes: el mismo mensaje.
        let e1 = c.err("list_tables", json!({"connId": "hidden"}));
        assert!(e1.contains("hidden"));
        c.err("list_tables", json!({"connId": "nope"}));

        // Lectura con ocultación y límite por conexión (2 filas).
        let r = c.ok("sample_rows", json!({"connId": "read", "table": "users", "limit": 50}));
        assert_eq!(r["rowCount"], 2);
        assert_eq!(r["truncated"], true);
        assert_eq!(r["rows"][0][2], "[oculto]");
        assert!(!r.to_string().contains("h1"));
        let q = c.ok("run_query", json!({"connId": "read", "sql": "SELECT id, name FROM users ORDER BY id"}));
        assert_eq!(q["columns"], json!(["id", "name"]));
        assert_eq!(q["rows"], json!([[1, "ana"], [2, "luis"]]));
        assert_eq!(q["truncated"], true);
        let q = c.ok("run_query", json!({"connId": "read", "sql": "SELECT * FROM users WHERE id = 3"}));
        assert_eq!(q["rows"], json!([[3, "eva", "[oculto]"]]));
        // La columna protegida no puede usarse en expresiones.
        let e = c.err("run_query", json!({"connId": "read", "sql": "SELECT upper(password) AS p FROM users"}));
        assert!(e.contains("password"));
        c.err("run_query", json!({"connId": "read", "sql": "SELECT id FROM users WHERE \"PASSWORD\" = 'h1'"}));
        // Filtro de sentencias
        c.err("run_query", json!({"connId": "read", "sql": "DELETE FROM users"}));
        c.err("run_query", json!({"connId": "read", "sql": "SELECT 1; DELETE FROM users"}));
        c.err("execute_statement", json!({"connId": "read", "sql": "DELETE FROM users"}));
        let e = c.err("execute_statement", json!({"connId": "prod", "sql": "DELETE FROM users"}));
        assert!(e.contains("producción"));
        let q = c.ok("run_query", json!({"connId": "prod", "sql": "SELECT count(*) AS n FROM users"}));
        assert_eq!(q["rows"], json!([[3]]));

        // Escritura en una base en memoria (la sesión se mantiene entre llamadas).
        c.ok("execute_statement", json!({"connId": "mem", "sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, api_key TEXT, v TEXT)"}));
        let w = c.ok("execute_statement", json!({"connId": "mem", "sql": "INSERT INTO t(api_key, v) VALUES ('k1','a'),('k2','b')"}));
        assert_eq!(w["rowsAffected"], 2);
        let q = c.ok("run_query", json!({"connId": "mem", "sql": "SELECT * FROM t ORDER BY id"}));
        assert_eq!(q["rows"], json!([[1, "[oculto]", "a"], [2, "[oculto]", "b"]]));
        // query_only: aunque algo se colara por el filtro, SQLite rechaza escribir.
        let r = c.rt.block_on(async {
            let conns = c.server.store.load_connections();
            let mem = conns.iter().find(|x| x.id == "mem").unwrap().clone();
            c.server
                .run(&mem, 10, String::new(), |d, _| {
                    read_exec(d, DbKind::Sqlite, "INSERT INTO t(v) VALUES ('x')", 10, 10)
                })
                .await
        });
        assert!(r.is_err());

        // Auditoría
        let audit = read_audit(&store, 1000);
        assert!(audit.len() > 15);
        assert_eq!(audit[0].tool, "run_query");
        assert!(audit.iter().any(|a| !a.ok && a.error.is_some()));
        assert!(audit.iter().any(|a| a.tool == "sample_rows" && a.rows == Some(2)));
        assert!(audit.iter().filter(|a| a.conn_id == "hidden").all(|a| a.conn_name.is_empty()));
        assert_eq!(read_audit(&store, 3).len(), 3);

        // Desactivado: todo falla con el aviso, pero la vista previa funciona.
        cfg.enabled = false;
        save_config(&store, cfg).unwrap();
        assert!(c.err("list_connections", json!({})).contains("Ajustes › IA"));
        let preview = McpServer::new(dir.clone(), true);
        let before = read_audit(&store, 10_000).len();
        let out = c.rt.block_on(preview.call_tool("list_connections", &json!({})));
        assert!(!out.is_error);
        assert_eq!(read_audit(&store, 10_000).len(), before);
        clear_audit(&store).unwrap();
        assert!(read_audit(&store, 10).is_empty());

        drop(c);
        drop(preview);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_audit_records_the_client() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(origin_from_args(&args(&["celer.exe", "--mcp", "--client=wsl:Ubuntu-24.04"])), "WSL (Ubuntu-24.04)");
        assert_eq!(origin_from_args(&args(&["celer", "--mcp", "--client=wsl"])), "WSL");
        assert_eq!(origin_from_args(&args(&["celer", "--mcp", "--client=wsl:$(rm -rf);"])), "WSL (rm -rf)");
        assert_eq!(origin_from_args(&args(&["celer", "--mcp"])), default_origin());

        let dir = temp_dir();
        let file = dir.join("c.db");
        rusqlite::Connection::open(&file).unwrap().execute_batch("CREATE TABLE t (id INTEGER)").unwrap();
        fs::write(dir.join("connections.json"), json!([sqlite_conn("s", &file.to_string_lossy(), false)]).to_string()).unwrap();
        let store = Store::new(dir.clone());
        let mut cfg = McpConfig { enabled: true, ..McpConfig::default() };
        cfg.connections.insert("s".into(), ConnPermission { level: Level::Read, max_rows: None });
        save_config(&store, cfg).unwrap();
        let mut c = Client { server: McpServer::with_origin(dir.clone(), false, "WSL (Ubuntu)".into()), rt: rt(), next: 0 };
        c.rpc("initialize", json!({"protocolVersion": PROTOCOL_VERSION, "clientInfo": {"name": "claude-code", "version": "2.1"}}));
        c.ok("run_query", json!({"connId": "s", "sql": "SELECT count(*) FROM t"}));
        let last = last_audit(&store).unwrap();
        assert_eq!(last.client.as_deref(), Some("WSL (Ubuntu)"));
        assert_eq!(last.client_app.as_deref(), Some("claude-code"));
        assert_eq!(read_audit(&store, 1)[0], last);
        // Entries written before the client was kept still read.
        fs::write(dir.join(AUDIT_FILE), "{\"at\":1,\"tool\":\"run_query\",\"connId\":\"s\",\"connName\":\"S\",\"detail\":\"x\",\"ok\":true,\"ms\":1}\n").unwrap();
        assert_eq!(last_audit(&store).unwrap().client, None);
        drop(c);
        let _ = fs::remove_dir_all(dir);
    }

    fn tool_names(c: &mut Client) -> Vec<String> {
        let r = c.rpc("tools/list", json!({}));
        r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
    }

    fn set_app_control(store: &Store, f: impl FnOnce(&mut AppControl)) {
        let mut cfg = load_config(store);
        f(&mut cfg.app_control);
        save_config(store, cfg).unwrap();
    }

    /// What the stand-in app answers: the layout of `get_app_state`, and every other request echoed back.
    fn echo_app(dir: &Path, layout: Value) -> Arc<crate::mcp_app::tests::FakeApp> {
        crate::mcp_app::tests::fake_app(dir, move |action, args| match action {
            "state" => Ok(layout.clone()),
            "fail" => Err("no".into()),
            _ => Ok(json!({"done": action, "args": args})),
        })
    }

    #[test]
    fn app_tools_are_listed_only_when_allowed_and_respect_levels() {
        let dir = temp_dir();
        let file = dir.join("datos.db");
        rusqlite::Connection::open(&file)
            .unwrap()
            .execute_batch(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, password TEXT);
                 INSERT INTO users(name, password) VALUES ('ana','h1'),('luis','h2');",
            )
            .unwrap();
        let f = file.to_string_lossy().to_string();
        let mut prod = sqlite_conn("prod", &f, true);
        prod["name"] = json!("Producción");
        fs::write(
            dir.join("connections.json"),
            json!([sqlite_conn("read", &f, false), sqlite_conn("schema", &f, false), sqlite_conn("hidden", &f, false), sqlite_conn("write", &f, false), prod]).to_string(),
        )
        .unwrap();
        let store = Store::new(dir.clone());
        let mut cfg = McpConfig { enabled: true, ..McpConfig::default() };
        for (id, l) in [("read", Level::Read), ("schema", Level::Schema), ("write", Level::Write), ("prod", Level::Write)] {
            cfg.connections.insert(id.into(), ConnPermission { level: l, max_rows: None });
        }
        save_config(&store, cfg).unwrap();
        let mut c = Client { server: McpServer::with_origin(dir.clone(), false, "WSL (Ubuntu)".into()), rt: rt(), next: 0 };
        c.rpc("initialize", json!({"clientInfo": {"name": "claude-code"}}));

        // "Controlar la aplicación" off (the default): none of the new tools is listed, and calling one is refused.
        assert_eq!(tool_names(&mut c), TOOL_NAMES.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert!(c.err("open_console", json!({"connId": "read", "sql": "SELECT 1"})).contains("controle la aplicación"));
        assert!(c.err("get_app_state", json!({})).contains("Controlar la aplicación"));

        // On, with each sub-switch adding its tools.
        set_app_control(&store, |a| *a = AppControl { enabled: true, open_tabs: false, write_library: false, run_opened: false });
        let names = tool_names(&mut c);
        for t in ["get_app_state", "list_library", "get_library_script"] {
            assert!(names.iter().any(|n| n == t), "{t}");
        }
        for t in ["open_console", "open_table", "open_er_diagram", "open_object", "add_library_script"] {
            assert!(!names.iter().any(|n| n == t), "{t} listed with its switch off");
        }
        assert!(c.err("open_table", json!({"connId": "read", "table": "users"})).contains("abra pestañas"));
        set_app_control(&store, |a| a.open_tabs = true);
        let names = tool_names(&mut c);
        assert!(names.iter().any(|n| n == "open_console") && !names.iter().any(|n| n == "add_library_script"));
        assert!(c.err("add_library_script", json!({"name": "x", "sql": "SELECT 1"})).contains("biblioteca"));
        set_app_control(&store, |a| a.write_library = true);
        assert_eq!(tool_names(&mut c).len(), TOOL_NAMES.len() + APP_TOOL_NAMES.len());
        // MCP off: nothing at all.
        let mut off = load_config(&store);
        off.enabled = false;
        save_config(&store, off.clone()).unwrap();
        assert!(c.err("open_console", json!({"sql": ""})).contains("desactivado"));
        off.enabled = true;
        save_config(&store, off).unwrap();

        // Celer not running: a clear error (and the call is audited).
        assert_eq!(c.err("open_console", json!({"connId": "read", "sql": "SELECT 1"})), crate::mcp_app::NOT_RUNNING);
        let last = last_audit(&store).unwrap();
        assert_eq!((last.tool.as_str(), last.ok, last.client.as_deref()), ("open_console", false, Some("WSL (Ubuntu)")));

        let layout = json!({"windows": [{
            "label": "main", "name": "ventana principal", "focused": true, "activeTabId": "t1",
            "tabs": [
                {"id": "t1", "kind": "sql", "title": "ventas", "connId": "read", "database": "main", "sql": "SELECT * FROM users"},
                {"id": "t2", "kind": "sql", "title": "esquema", "connId": "schema", "database": "main", "sql": "SELECT 'secreto'"},
                {"id": "t3", "kind": "table", "title": "users", "connId": "hidden", "database": "main", "obj": {"schema": "main", "name": "users", "kind": "table"}, "where": "id = 1"},
                {"id": "t4", "kind": "sql", "title": "borrador", "connId": null, "sql": "SELECT 'sin conexión'"},
                {"id": "t5", "kind": "table", "title": "users", "connId": "read", "database": "main", "obj": {"schema": "main", "name": "users", "kind": "table"}, "section": "data", "where": "id > 1", "orderBy": "name"}
            ]
        }]});
        let app = echo_app(&dir, layout);

        // What is on screen, limited by each connection's level.
        let s = c.ok("get_app_state", json!({}));
        let tabs = s["windows"][0]["tabs"].as_array().unwrap();
        assert_eq!(s["windows"][0]["focused"], true);
        assert_eq!(tabs[0]["sql"], "SELECT * FROM users");
        assert_eq!(tabs[0]["active"], true);
        assert_eq!(tabs[0]["connection"], "SQLite read");
        assert!(tabs[1].get("sql").is_none(), "schema level: no SQL");
        assert_eq!(tabs[1]["title"], "esquema");
        assert_eq!(tabs[2], json!({"id": "t3", "kind": "table", "hidden": true, "active": false}));
        assert!(tabs[3].get("sql").is_none() && tabs[3]["title"] == "borrador");
        assert_eq!((tabs[4]["where"].as_str(), tabs[4]["table"]["name"].as_str()), (Some("id > 1"), Some("users")));
        assert!(!s.to_string().contains("secreto") && !s.to_string().contains("sin conexión"));

        // A console: opened at level schema, run only with its switch and within the level.
        let r = c.ok("open_console", json!({"connId": "schema", "sql": "SELECT name FROM users", "title": "Nombres"}));
        assert_eq!(r["done"], "open_console");
        assert_eq!(r["args"]["sql"], "SELECT name FROM users");
        assert_eq!(r["args"]["run"], false);
        c.ok("open_console", json!({"sql": "-- borrador"}));
        assert!(c.err("open_console", json!({"connId": "hidden", "sql": "SELECT 1"})).contains("hidden"));
        assert!(c.err("open_console", json!({"connId": "read", "sql": "SELECT 1", "run": true})).contains("Ejecutar lo que abre"));
        set_app_control(&store, |a| a.run_opened = true);
        assert!(c.err("open_console", json!({"connId": "schema", "sql": "SELECT 1", "run": true})).contains("«read»"));
        assert!(c.err("open_console", json!({"sql": "SELECT 1", "run": true})).contains("connId"));
        let r = c.ok("open_console", json!({"connId": "read", "sql": "SELECT id, name FROM users", "run": true}));
        assert_eq!(r["args"]["run"], true);
        // Masking and the read filter, as in run_query.
        assert!(c.err("open_console", json!({"connId": "read", "sql": "SELECT password FROM users", "run": true})).contains("password"));
        assert!(c.err("open_console", json!({"connId": "read", "sql": "SELECT t FROM users t", "run": true})).contains("protegidas"));
        assert!(c.err("open_console", json!({"connId": "read", "sql": "DELETE FROM users", "run": true})).contains("«write»"));
        assert!(c.err("open_console", json!({"connId": "read", "sql": "SELECT 1; DELETE FROM users", "run": true})).contains("una sentencia"));
        assert!(c.err("open_console", json!({"connId": "prod", "sql": "DELETE FROM users WHERE id = 1", "run": true})).contains("producción"));
        assert!(c.err("open_console", json!({"connId": "write", "sql": "ATTACH DATABASE 'x' AS y", "run": true})).contains("No se ejecuta"));
        let r = c.ok("open_console", json!({"connId": "write", "sql": "DELETE FROM users WHERE id = 1", "run": true}));
        assert_eq!(r["args"]["connId"], "write");
        // Opening without running is never a level problem, whatever the SQL.
        c.ok("open_console", json!({"connId": "read", "sql": "DELETE FROM users"}));

        // Tables, definitions, diagrams.
        assert!(c.err("open_table", json!({"connId": "schema", "table": "users"})).contains("«read»"));
        let r = c.ok("open_table", json!({"connId": "read", "table": "USERS", "filter": "id > 1", "orderBy": "name DESC"}));
        assert_eq!((r["args"]["obj"]["name"].as_str(), r["args"]["where"].as_str(), r["args"]["orderBy"].as_str()), (Some("users"), Some("id > 1"), Some("name DESC")));
        assert_eq!(r["args"]["section"], "data");
        assert!(c.err("open_table", json!({"connId": "read", "table": "users", "filter": "password = 'h1'"})).contains("password"));
        assert!(c.err("open_table", json!({"connId": "read", "table": "users", "filter": "1 = 1; DELETE FROM users"})).contains("Filtro"));
        assert!(c.err("open_table", json!({"connId": "read", "table": "nope"})).contains("nope"));
        let r = c.ok("open_object", json!({"connId": "schema", "table": "users"}));
        assert_eq!((r["done"].as_str(), r["args"]["section"].as_str()), (Some("open_table"), Some("ddl")));
        assert!(c.err("open_object", json!({"connId": "schema", "table": "users", "section": "x"})).contains("section"));
        let r = c.ok("open_er_diagram", json!({"connId": "schema", "table": "users"}));
        assert_eq!((r["done"].as_str(), r["args"]["obj"]["name"].as_str()), (Some("open_er_diagram"), Some("users")));
        let r = c.ok("open_er_diagram", json!({"connId": "schema", "schema": "main"}));
        assert!(r["args"]["obj"].is_null() && r["args"]["schema"] == "main" && r["args"]["database"] == "main");
        assert!(c.err("open_er_diagram", json!({"connId": "schema"})).contains("schema"));

        // The library: scripts of hidden connections stay hidden.
        fs::write(
            dir.join("library.json"),
            json!({"version": 2, "folders": ["Informes"], "scripts": [
                {"id": "s1", "name": "Ventas", "sql": "SELECT 1\nFROM users", "connId": null, "folder": "Informes/Mensuales", "tags": ["ventas"], "notes": "por mes"},
                {"id": "s2", "name": "Usuarios", "sql": "SELECT * FROM users", "connId": "read", "folder": "", "tags": []},
                {"id": "s3", "name": "Oculto", "sql": "SELECT 'oculto'", "connId": "hidden", "folder": "", "tags": []}
            ]})
            .to_string(),
        )
        .unwrap();
        let l = c.ok("list_library", json!({}));
        assert_eq!(l["total"], 2);
        assert!(!l.to_string().contains("Oculto"));
        assert_eq!(l["scripts"][0]["lines"], 2);
        assert!(l["scripts"][0].get("sql").is_none());
        assert_eq!(c.ok("list_library", json!({"folder": "Informes"}))["total"], 1);
        assert_eq!(c.ok("list_library", json!({"query": "VENTAS"}))["total"], 1);
        assert_eq!(c.ok("get_library_script", json!({"id": "s2"}))["sql"], "SELECT * FROM users");
        assert_eq!(c.ok("get_library_script", json!({"name": "ventas"}))["notes"], "por mes");
        c.err("get_library_script", json!({"id": "s3"}));
        let r = c.ok("add_library_script", json!({"name": "Nuevo", "sql": "SELECT 2", "folder": "IA", "tags": ["ia"], "connId": "read"}));
        assert_eq!((r["args"]["connId"].as_str(), r["args"]["folder"].as_str()), (Some("read"), Some("IA")));
        assert!(c.err("add_library_script", json!({"name": "x", "sql": "SELECT 1", "connId": "hidden"})).contains("hidden"));
        assert!(c.err("add_library_script", json!({"name": "x", "sql": "  "})).contains("sql"));

        // The app saw only what passed the checks, with who asked.
        let seen = app.seen.lock();
        assert!(seen.iter().all(|(_, args, client)| client == "claude-code · WSL (Ubuntu)" && !args.to_string().contains("password = ")));
        assert!(!seen.iter().any(|(_, args, _)| args["connId"] == "hidden" || args["connId"] == "prod"));
        drop(seen);
        // Each action is in the audit log, runs marked.
        let audit = read_audit(&store, 200);
        assert!(audit.iter().any(|a| a.tool == "open_console" && a.ok && a.detail.starts_with("[ejecutar] SELECT id, name FROM users")));
        assert!(audit.iter().any(|a| a.tool == "open_table" && a.detail == "USERS WHERE id > 1 ORDER BY name DESC"));
        assert!(audit.iter().any(|a| a.tool == "add_library_script" && a.detail == "Nuevo"));
        assert!(audit.iter().any(|a| a.tool == "open_console" && !a.ok && a.conn_id == "hidden" && a.conn_name.is_empty()));
        drop(c);
        crate::mcp_app::stop(&dir);
        let _ = fs::remove_dir_all(dir);
    }

    /// The app tools against a server engine: the table is found as the driver sees it, the filter and the run are
    /// checked on that engine (protected columns read from its catalog), and the levels hold.
    fn app_tools_on_engine(conn: Value, settings: Option<Value>) {
        let dir = temp_dir();
        let id = conn["id"].as_str().unwrap().to_string();
        fs::write(dir.join("connections.json"), json!([conn]).to_string()).unwrap();
        if let Some(s) = settings {
            fs::write(dir.join("settings.json"), s.to_string()).unwrap();
        }
        let store = Store::new(dir.clone());
        let mut cfg = McpConfig { enabled: true, ..McpConfig::default() };
        cfg.app_control = AppControl { enabled: true, open_tabs: true, write_library: true, run_opened: true };
        cfg.connections.insert(id.clone(), ConnPermission { level: Level::Write, max_rows: None });
        save_config(&store, cfg.clone()).unwrap();
        let mut c = Client { server: McpServer::new(dir.clone(), false), rt: rt(), next: 0 };
        let _app = echo_app(&dir, json!({"windows": []}));
        c.ok("execute_statement", json!({"connId": id, "sql": "DROP TABLE IF EXISTS mcp_app_probe"}));
        c.ok("execute_statement", json!({"connId": id, "sql": "CREATE TABLE mcp_app_probe (id INT, nombre VARCHAR(20), api_key VARCHAR(20))"}));
        let r = c.ok("open_table", json!({"connId": id, "table": "MCP_APP_PROBE", "filter": "id > 1", "orderBy": "nombre"}));
        assert!(r["args"]["obj"]["name"].as_str().unwrap().eq_ignore_ascii_case("mcp_app_probe"), "{r}");
        assert!(c.err("open_table", json!({"connId": id, "table": "mcp_app_probe", "filter": "api_key = 'x'"})).contains("api_key"));
        assert_eq!(c.ok("open_object", json!({"connId": id, "table": "mcp_app_probe"}))["args"]["section"], "ddl");
        c.ok("open_er_diagram", json!({"connId": id, "table": "mcp_app_probe"}));
        c.ok("open_console", json!({"connId": id, "sql": "SELECT id, nombre FROM mcp_app_probe", "run": true}));
        assert!(c.err("open_console", json!({"connId": id, "sql": "SELECT api_key FROM mcp_app_probe", "run": true})).contains("api_key"));
        c.ok("open_console", json!({"connId": id, "sql": "DELETE FROM mcp_app_probe WHERE id = 0", "run": true}));
        // At level read the same DELETE is refused, and a read still goes.
        cfg.connections.insert(id.clone(), ConnPermission { level: Level::Read, max_rows: None });
        save_config(&store, cfg.clone()).unwrap();
        assert!(c.err("open_console", json!({"connId": id, "sql": "DELETE FROM mcp_app_probe WHERE id = 0", "run": true})).contains("«write»"));
        c.ok("open_console", json!({"connId": id, "sql": "SELECT count(*) FROM mcp_app_probe", "run": true}));
        cfg.connections.insert(id.clone(), ConnPermission { level: Level::Write, max_rows: None });
        save_config(&store, cfg).unwrap();
        c.ok("execute_statement", json!({"connId": id, "sql": "DROP TABLE mcp_app_probe"}));
        drop(c);
        crate::mcp_app::stop(&dir);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn app_tools_postgres() {
        let Ok(spec) = std::env::var("CELER_PG_TEST") else { return };
        app_tools_on_engine(pg_conn(&spec), None);
    }

    #[test]
    fn app_tools_mysql() {
        let Ok(url) = std::env::var("CELER_MYSQL_TEST") else { return };
        app_tools_on_engine(mysql_conn(&url), None);
    }

    fn spec_of(var: &str) -> Option<HashMap<String, String>> {
        let s = std::env::var(var).ok()?;
        Some(s.split_whitespace().filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }

    #[test]
    fn app_tools_mssql() {
        let Some(m) = spec_of("CELER_MSSQL_TEST") else { return };
        let get = |k: &str| m.get(k).cloned().unwrap_or_default();
        app_tools_on_engine(
            json!({"id": "ms", "name": "SQL Server test", "kind": "mssql", "host": get("host"), "port": get("port").parse::<u16>().ok(),
                   "user": get("user"), "password": get("password"), "database": m.get("database").cloned().unwrap_or("master".into()),
                   "trustCert": true, "savePassword": false}),
            None,
        );
    }

    #[test]
    fn app_tools_informix_drda() {
        let (Some(m), Ok(lib)) = (spec_of("CELER_INFORMIX_TEST"), std::env::var("CELER_IBM_LIB")) else { return };
        let get = |k: &str| m.get(k).cloned().unwrap_or_default();
        app_tools_on_engine(
            json!({"id": "ifx", "name": "Informix DRDA test", "kind": "informix", "informixMode": "drda", "host": get("host"),
                   "port": get("port").parse::<u16>().ok(), "user": get("user"), "password": get("password"), "database": get("database"), "savePassword": false}),
            Some(json!({"ibmDriverPath": lib})),
        );
    }

    #[test]
    fn app_tools_informix_jdbc() {
        let (Some(m), Ok(java), Ok(jars)) = (spec_of("CELER_INFORMIX_JDBC_TEST"), std::env::var("CELER_JAVA"), std::env::var("CELER_JDBC_JARS")) else { return };
        if !crate::jdbc::bridge_included() {
            assert!(std::env::var_os("CELER_REQUIRE_BRIDGE").is_none(), "the JDBC bridge is not in this build");
            return;
        }
        let get = |k: &str| m.get(k).cloned().unwrap_or_default();
        let jar = std::env::split_paths(&jars).next().unwrap().to_string_lossy().to_string();
        app_tools_on_engine(
            json!({"id": "ifxj", "name": "Informix JDBC test", "kind": "informix", "informixMode": "jdbc", "host": get("host"),
                   "port": get("port").parse::<u16>().ok(), "user": get("user"), "password": get("password"), "database": get("database"),
                   "instance": get("server"), "savePassword": false}),
            Some(json!({"javaPath": java, "informixJdbcPath": jar})),
        );
    }

    #[test]
    fn masking_bypasses_are_refused() {
        let sens = Sensitive {
            columns: ["password_hash".to_string()].into(),
            tables: ["users".to_string()].into(),
        };
        let bad = |sql: &str, kind: DbKind| {
            let refused = single_statement(sql, kind).unwrap().iter().any(|t| masking_bypass(t, &sens).is_some());
            assert!(refused, "should be refused ({kind:?}): {sql}");
        };
        let ok = |sql: &str, kind: DbKind| {
            for t in single_statement(sql, kind).unwrap() {
                if let Some(e) = masking_bypass(&t, &sens) {
                    panic!("should pass ({kind:?}): {sql}\n  → {e}");
                }
            }
        };
        use DbKind::*;
        bad("SELECT t FROM users t", Postgres);
        bad("SELECT users FROM users", Postgres);
        bad("SELECT row_to_json(u) FROM public.users AS u", Postgres);
        bad("SELECT to_jsonb(x.*) FROM users x", Postgres);
        bad("SELECT json_agg(s) FROM (SELECT * FROM users) s", Postgres);
        bad("WITH s(a, b, c) AS (SELECT * FROM users) SELECT * FROM s", Postgres);
        bad("WITH x AS (SELECT 1), s (a, b) AS (SELECT * FROM users) SELECT * FROM s", Postgres);
        bad("WITH s AS (SELECT * FROM users) SELECT s FROM s", Postgres);
        bad("SELECT * FROM users AS u(a, b, c)", Postgres);
        bad("SELECT * FROM users u (a, b, c)", Postgres);
        bad("SELECT * FROM (SELECT * FROM users) AS d(a, b)", Postgres);
        bad("SELECT 1, 2, 3 WHERE false UNION ALL SELECT * FROM users", Postgres);
        bad("SELECT 1 AS a FROM dual UNION SELECT * FROM `users`", Mysql);
        ok("SELECT * FROM users", Postgres);
        ok("SELECT u.* FROM users u WHERE u.id = 1", Postgres);
        ok("SELECT u.id, o.total FROM users u JOIN orders o ON o.user_id = u.id ORDER BY u.id LIMIT 5", Postgres);
        ok("SELECT count(*) FROM users, orders WHERE users.id = orders.user_id", Postgres);
        ok("WITH s AS (SELECT id FROM users) SELECT s.id FROM s", Postgres);
        ok("SELECT * FROM (SELECT id FROM users) d WHERE d.id > 1", Postgres);
        ok("SELECT TOP (5) * FROM dbo.users WITH (NOLOCK)", Mssql);
        ok("SELECT * FROM users u USE INDEX (ix) WHERE u.id = 1", Mysql);
        // Queries that do not read a protected table are left alone.
        ok("SELECT o FROM orders o UNION SELECT 1", Postgres);
        // Another database's protected columns count on MySQL and SQL Server.
        assert!(qualifiers("SELECT password AS x FROM otherdb.users", Mysql).contains("otherdb"));
        assert!(qualifiers("SELECT 1 FROM [Other DB].dbo.users", Mssql).contains("other db"));
    }

    #[test]
    fn audit_keeps_the_executed_sql() {
        let pad = "x".repeat(6000);
        assert_eq!(audit_sql(&format!("/* {pad} */ SELECT password FROM users -- {pad}"), DbKind::Postgres), "SELECT password FROM users");
        assert_eq!(audit_sql(&format!("# {pad}\nSELECT 1"), DbKind::Mysql), "SELECT 1");
        // '#' is not a comment on PostgreSQL; a string keeps its "comment".
        assert_eq!(audit_sql("SELECT 1 # 2, '-- a' -- b", DbKind::Postgres), "SELECT 1 # 2, '-- a'");
        // Text that one quoting variant reads as code is kept: MySQL with and without backslash escapes.
        let tricky = "SELECT 'a\\' -- ', password FROM users";
        assert!(audit_sql(tricky, DbKind::Mysql).contains("password FROM users"));
        // A long statement keeps its start and its end.
        let long = format!("SELECT '{pad}' AS a, secret FROM t");
        let kept = audit_sql(&long, DbKind::Postgres);
        assert!(kept.starts_with("SELECT '") && kept.ends_with("AS a, secret FROM t") && kept.contains("omitidos"));
        assert!(kept.chars().count() <= AUDIT_DETAIL_CHARS);
    }

    #[test]
    fn audit_is_capped() {
        let dir = temp_dir();
        let store = Store::new(dir.clone());
        let e = AuditEntry {
            at: 1,
            tool: "run_query".into(),
            conn_id: "c".into(),
            conn_name: "C".into(),
            detail: "x".repeat(AUDIT_DETAIL_CHARS),
            ok: false,
            rows: Some(1),
            ms: 1,
            error: Some("e".repeat(500)),
            client: Some("WSL (Ubuntu-24.04)".into()),
            client_app: Some("claude-code".into()),
        };
        let line = serde_json::to_string(&e).unwrap().len() as u64 + 1;
        assert!(line * (AUDIT_KEEP as u64) < AUDIT_COMPACT_BYTES * 3 / 4);
        let total = (AUDIT_COMPACT_BYTES / line) as usize + 10;
        for _ in 0..total {
            append_audit(&store, &e).unwrap();
        }
        let n = read_audit(&store, 100_000).len();
        assert!(n >= AUDIT_KEEP && n < total, "{n} de {total}");
        let _ = fs::remove_dir_all(dir);
    }

    /// Convierte "mysql://user:pass@host:port/db" en una conexión.
    fn mysql_conn(url: &str) -> Value {
        let rest = url.trim_start_matches("mysql://");
        let (cred, rest) = rest.split_once('@').unwrap_or(("", rest));
        let (user, pass) = cred.split_once(':').unwrap_or((cred, ""));
        let (hostport, db) = rest.split_once('/').unwrap_or((rest, ""));
        let (host, port) = hostport.split_once(':').unwrap_or((hostport, "3306"));
        json!({
            "id": "my", "name": "MySQL test", "kind": "mysql", "host": host,
            "port": port.parse::<u16>().ok(), "user": user, "password": pass,
            "database": db, "encryption": "login", "savePassword": false,
        })
    }

    #[test]
    fn jsonrpc_mysql() {
        let Ok(url) = std::env::var("CELER_MYSQL_TEST") else {
            eprintln!("CELER_MYSQL_TEST no definido: se omite");
            return;
        };
        let dir = temp_dir();
        fs::write(dir.join("connections.json"), json!([mysql_conn(&url)]).to_string()).unwrap();
        let store = Store::new(dir.clone());
        let mut cfg = McpConfig {
            enabled: true,
            ..McpConfig::default()
        };
        cfg.connections.insert("my".into(), ConnPermission { level: Level::Write, max_rows: Some(3) });
        save_config(&store, cfg).unwrap();
        let mut c = Client {
            server: McpServer::new(dir.clone(), false),
            rt: rt(),
            next: 0,
        };
        c.ok("execute_statement", json!({"connId": "my", "sql": "DROP TABLE IF EXISTS mcp_ro_probe"}));
        c.ok("execute_statement", json!({"connId": "my", "sql": "CREATE TABLE mcp_ro_probe (x INT, pass_hash VARCHAR(20))"}));
        let w = c.ok("execute_statement", json!({"connId": "my", "sql": "INSERT INTO mcp_ro_probe VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e')"}));
        assert_eq!(w["rowsAffected"], 5);
        // Límite de filas en el servidor (sql_select_limit) y ocultación.
        let q = c.ok("run_query", json!({"connId": "my", "sql": "SELECT * FROM mcp_ro_probe ORDER BY x"}));
        assert_eq!(q["rowCount"], 3);
        assert_eq!(q["truncated"], true);
        assert_eq!(q["rows"][0], json!([1, "[oculto]"]));
        // El límite no queda activo para la sesión.
        let n = c.ok("execute_statement", json!({"connId": "my", "sql": "SELECT count(*) FROM (SELECT x FROM mcp_ro_probe) s"}));
        assert_eq!(n["rows"][0][0], 5);
        // Defensa en profundidad: START TRANSACTION READ ONLY impide escribir.
        let r = c.rt.block_on(async {
            let conn = c.server.store.load_connections()[0].clone();
            c.server
                .run(&conn, 10, String::new(), |d, _| {
                    read_exec(d, DbKind::Mysql, "INSERT INTO mcp_ro_probe VALUES (9, 'z')", 10, 10)
                })
                .await
        });
        assert!(r.is_err(), "la escritura debería fallar en una transacción de solo lectura");
        let n = c.ok("run_query", json!({"connId": "my", "sql": "SELECT count(*) FROM mcp_ro_probe WHERE x = 9"}));
        assert_eq!(n["rows"][0][0], 0);
        c.err("run_query", json!({"connId": "my", "sql": "SELECT `get_lock`('celer', 0)"}));
        c.err("run_query", json!({"connId": "my", "sql": "SELECT 1, 2 FROM dual WHERE false UNION SELECT * FROM mcp_ro_probe"}));
        // Another database's protected column, renamed: refused by name.
        let setup = |c: &mut Client, sql: &'static str| {
            c.rt.block_on(async {
                let conn = c.server.store.load_connections()[0].clone();
                c.server.run(&conn, 10, String::new(), move |d, _| d.execute(sql, 10)).await
            })
            .unwrap();
        };
        setup(&mut c, "CREATE DATABASE IF NOT EXISTS mcp_other");
        setup(&mut c, "CREATE TABLE IF NOT EXISTS mcp_other.users (id INT, password VARCHAR(20))");
        c.err("run_query", json!({"connId": "my", "sql": "SELECT password AS x FROM mcp_other.users"}));
        c.err("run_query", json!({"connId": "my", "sql": "SELECT `PASSWORD` AS x FROM `mcp_other`.users"}));
        setup(&mut c, "DROP DATABASE mcp_other");
        c.ok("execute_statement", json!({"connId": "my", "sql": "DROP TABLE mcp_ro_probe"}));
        drop(c);
        let _ = fs::remove_dir_all(dir);
    }

    /// Convierte "host=… port=… user=… password=… dbname=…" en una conexión.
    fn pg_conn(spec: &str) -> Value {
        let mut m = HashMap::new();
        for kv in spec.split_whitespace() {
            if let Some((k, v)) = kv.split_once('=') {
                m.insert(k.to_string(), v.to_string());
            }
        }
        json!({
            "id": "pg", "name": "PG test", "kind": "postgres",
            "host": m.get("host").cloned().unwrap_or("localhost".into()),
            "port": m.get("port").and_then(|p| p.parse::<u16>().ok()),
            "user": m.get("user").cloned().unwrap_or_default(),
            "password": m.get("password").cloned().unwrap_or_default(),
            "database": m.get("dbname").cloned().unwrap_or_default(),
            "encryption": "login", "savePassword": false,
        })
    }

    #[test]
    fn jsonrpc_postgres() {
        let Ok(spec) = std::env::var("CELER_PG_TEST") else {
            eprintln!("CELER_PG_TEST no definido: se omite");
            return;
        };
        let dir = temp_dir();
        fs::write(dir.join("connections.json"), json!([pg_conn(&spec)]).to_string()).unwrap();
        let store = Store::new(dir.clone());
        let mut cfg = McpConfig {
            enabled: true,
            ..McpConfig::default()
        };
        cfg.connections.insert("pg".into(), ConnPermission { level: Level::Read, max_rows: Some(3) });
        save_config(&store, cfg).unwrap();
        let mut c = Client {
            server: McpServer::new(dir.clone(), false),
            rt: rt(),
            next: 0,
        };
        let q = c.ok("run_query", json!({"connId": "pg", "sql": "SELECT g AS n, 'x' AS secret_token FROM generate_series(1, 10) g"}));
        assert_eq!(q["rowCount"], 3);
        assert_eq!(q["truncated"], true);
        assert_eq!(q["rows"][0], json!([1, "[oculto]"]));
        let q = c.ok("run_query", json!({"connId": "pg", "sql": "SHOW transaction_read_only"}));
        assert_eq!(q["rows"][0][0], "on");
        let dbs = c.ok("list_databases", json!({"connId": "pg"}));
        assert!(dbs["databases"].as_array().unwrap().iter().any(|d| d == "celer"));
        let t = c.ok("list_tables", json!({"connId": "pg"}));
        if let Some(first) = t["tables"].as_array().and_then(|a| a.first()).cloned() {
            let d = c.ok(
                "describe_table",
                json!({"connId": "pg", "table": first["name"], "schema": first["schema"]}),
            );
            assert!(!d["columns"].as_array().unwrap().is_empty());
            let s = c.ok("sample_rows", json!({"connId": "pg", "table": first["name"], "schema": first["schema"], "limit": 2}));
            assert!(s["rowCount"].as_u64().unwrap() <= 2);
        }
        c.err("execute_statement", json!({"connId": "pg", "sql": "CREATE TABLE mcp_probe (x int)"}));
        // Defensa en profundidad: la transacción de solo lectura impide escribir.
        let r = c.rt.block_on(async {
            let conn = c.server.store.load_connections()[0].clone();
            c.server
                .run(&conn, 10, String::new(), |d, _| {
                    read_exec(d, DbKind::Postgres, "CREATE TABLE mcp_ro_probe (x int)", 10, 10)
                })
                .await
        });
        let e = r.unwrap_err();
        assert!(e.contains("read-only") || e.contains("solo lectura"), "{e}");
        // Tras el error la sesión vuelve a funcionar.
        c.ok("run_query", json!({"connId": "pg", "sql": "SELECT 1"}));
        // Quoted names of forbidden functions, and ways around the masking.
        c.err("run_query", json!({"connId": "pg", "sql": "SELECT \"pg_read_file\"('postgresql.conf')"}));
        c.err("run_query", json!({"connId": "pg", "sql": "SELECT \"pg_terminate_backend\"(pid) FROM pg_stat_activity WHERE false"}));
        let setup = |c: &mut Client, sql: &'static str| {
            c.rt.block_on(async {
                let conn = c.server.store.load_connections()[0].clone();
                c.server.run(&conn, 10, String::new(), move |d, _| d.execute(sql, 10)).await
            })
            .unwrap();
        };
        setup(&mut c, "CREATE TABLE IF NOT EXISTS mcp_secret_probe (id int, password_hash text)");
        setup(&mut c, "INSERT INTO mcp_secret_probe VALUES (1, 'h1')");
        c.server.sensitive.lock().clear();
        let q = c.ok("run_query", json!({"connId": "pg", "sql": "SELECT * FROM mcp_secret_probe"}));
        assert_eq!(q["rows"][0], json!([1, "[oculto]"]));
        for sql in [
            "SELECT t FROM mcp_secret_probe t",
            "SELECT row_to_json(t) FROM mcp_secret_probe t",
            "WITH s(a, b) AS (SELECT * FROM mcp_secret_probe) SELECT * FROM s",
            "SELECT 1, 'x' WHERE false UNION ALL SELECT * FROM mcp_secret_probe",
        ] {
            c.err("run_query", json!({"connId": "pg", "sql": sql}));
        }
        setup(&mut c, "DROP TABLE mcp_secret_probe");
        drop(c);
        let _ = fs::remove_dir_all(dir);
    }
}
