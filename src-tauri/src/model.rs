//! Tipos compartidos entre drivers y la interfaz.

use serde::{Deserialize, Serialize};

/// Valor de una celda tal y como viaja a la interfaz.
/// Los enteros fuera del rango seguro de JavaScript y los decimales viajan como texto
/// para no perder precisión.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum Cell {
    Null,
    Bool(bool),
    Int(i64),
    Num(f64),
    Text(String),
}

pub const JS_SAFE_INT: i64 = 9_007_199_254_740_991;

thread_local! {
    static FULL_BINARY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whole binary values instead of the grid's preview, for the session thread that runs an export (a driver that
/// reads in a thread of its own copies it there, see mysql.rs).
pub fn set_full_binary(on: bool) {
    FULL_BINARY.with(|f| f.set(on));
}

pub fn full_binary() -> bool {
    FULL_BINARY.with(|f| f.get())
}

impl Cell {
    pub fn int(v: i64) -> Cell {
        if (-JS_SAFE_INT..=JS_SAFE_INT).contains(&v) {
            Cell::Int(v)
        } else {
            Cell::Text(v.to_string())
        }
    }
    pub fn num(v: f64) -> Cell {
        if v.is_finite() {
            Cell::Num(v)
        } else {
            Cell::Text(v.to_string())
        }
    }
    /// Binary as 0x… text, cut at `limit` bytes for the grid, except while the thread reads whole values (export).
    pub fn hex(bytes: &[u8], limit: usize) -> Cell {
        let limit = if full_binary() { usize::MAX } else { limit };
        let mut s = String::with_capacity(2 + bytes.len().min(limit) * 2 + 3);
        s.push_str("0x");
        for b in bytes.iter().take(limit) {
            s.push_str(&format!("{:02X}", b));
        }
        if bytes.len() > limit {
            s.push('…');
        }
        Cell::Text(s)
    }
}

/// Familia de tipo de una columna: decide alineación, formato y edición en la interfaz.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ColKind {
    Number,
    Text,
    Bool,
    Date,
    Binary,
    Other,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "typeName")]
    pub type_name: String,
    pub kind: ColKind,
}

/// Un resultado de una sentencia: un conjunto de filas o un recuento de filas afectadas.
#[derive(Debug, Clone, Serialize)]
pub struct ResultSet {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Cell>>,
    /// Hay más filas pendientes en el cursor abierto (se piden con `fetch`).
    #[serde(rename = "hasMore")]
    pub has_more: bool,
    #[serde(rename = "rowsAffected")]
    pub rows_affected: Option<i64>,
}

impl ResultSet {
    pub fn count(n: i64) -> ResultSet {
        ResultSet {
            columns: vec![],
            rows: vec![],
            has_more: false,
            rows_affected: Some(n),
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ExecOutput {
    pub results: Vec<ResultSet>,
    pub messages: Vec<String>,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
    /// Hay una transacción abierta (modo manual).
    #[serde(rename = "inTransaction")]
    pub in_transaction: bool,
}

/// Una sesión comprobada (y reconectada si se había cortado), para la interfaz.
#[derive(Debug, Clone, Serialize, Default)]
pub struct Health {
    pub ok: bool,
    /// La conexión se había cortado y otra ha ocupado su lugar.
    pub reconnected: bool,
    /// Lo que se perdió con la vieja ("" si nada), ya explicado.
    pub lost: String,
    pub ms: u64,
    pub error: String,
}

/// Respuesta a `fetch`: más filas del resultado abierto y, si éste termina,
/// los resultados posteriores del mismo lote.
#[derive(Debug, Clone, Serialize, Default)]
pub struct FetchOutput {
    pub rows: Vec<Vec<Cell>>,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
    pub extra: Vec<ResultSet>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Mssql,
    Informix,
    Odbc,
    Sqlite,
    Postgres,
    Mysql,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnConfig {
    pub id: String,
    pub name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: Option<u16>,
    /// SQL Server: instancia con nombre. Informix (SQLI): nombre del servidor INFORMIXSERVER.
    pub instance: String,
    pub database: String,
    pub user: String,
    /// Solo en memoria; en disco se guarda en el almacén de credenciales del sistema.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    pub save_password: bool,
    /// SQL Server: autenticación integrada de Windows.
    pub integrated_auth: bool,
    /// SQL Server: "required" | "login" | "off".
    pub encryption: String,
    pub trust_cert: bool,
    /// Informix: "drda" (driver IBM CLI) | "sqli" (Informix CSDK vía ODBC).
    pub informix_mode: String,
    /// ODBC genérico: cadena de conexión completa (DSN=...; o DRIVER={...};...).
    pub odbc_conn_str: String,
    /// Parámetros extra que se añaden a la cadena de conexión.
    pub extra: String,
    pub color: String,
    pub production: bool,
    pub read_only: bool,
    pub folder: String,
    /// SQLite: ruta del fichero, o `:memory:` para una base en memoria.
    #[serde(default)]
    pub file_path: String,
    /// Sentencias que se ejecutan en cada sesión nueva nada más conectar (SET search_path…, SET LOCK_TIMEOUT…).
    #[serde(default)]
    pub startup_sql: String,
}

impl Default for ConnConfig {
    fn default() -> Self {
        ConnConfig {
            id: String::new(),
            name: String::new(),
            kind: DbKind::Mssql,
            host: "localhost".into(),
            port: None,
            instance: String::new(),
            database: String::new(),
            user: String::new(),
            password: None,
            save_password: true,
            integrated_auth: false,
            encryption: "required".into(),
            trust_cert: true,
            informix_mode: "drda".into(),
            odbc_conn_str: String::new(),
            extra: String::new(),
            color: String::new(),
            production: false,
            read_only: false,
            folder: String::new(),
            file_path: String::new(),
            startup_sql: String::new(),
        }
    }
}

/// Nodo del árbol de objetos de la base de datos.
#[derive(Debug, Clone, Serialize)]
pub struct MetaNode {
    pub name: String,
    /// database | schema | folder | table | view | procedure | function | synonym | sequence
    /// | column | index | key | trigger
    pub kind: String,
    /// Texto secundario (tipo de una columna, nº de filas, ...)
    pub detail: Option<String>,
    /// Ruta para expandir el nodo; vacío si es una hoja.
    pub path: Vec<String>,
    pub leaf: bool,
    /// Objeto al que representa el nodo (tablas, vistas, procedimientos...), para abrirlo.
    pub obj: Option<ObjectRef>,
}

impl MetaNode {
    pub fn branch(name: impl Into<String>, kind: &str, path: Vec<String>) -> MetaNode {
        MetaNode {
            name: name.into(),
            kind: kind.into(),
            detail: None,
            path,
            leaf: false,
            obj: None,
        }
    }
    pub fn leaf(name: impl Into<String>, kind: &str, detail: Option<String>) -> MetaNode {
        MetaNode {
            name: name.into(),
            kind: kind.into(),
            detail,
            path: vec![],
            leaf: true,
            obj: None,
        }
    }
    pub fn with_obj(mut self, obj: ObjectRef) -> MetaNode {
        self.obj = Some(obj);
        self
    }
    pub fn with_detail(mut self, detail: Option<String>) -> MetaNode {
        self.detail = detail;
        self
    }
}

impl ObjectRef {
    pub fn new(database: &str, schema: &str, name: &str, kind: &str) -> ObjectRef {
        ObjectRef {
            database: database.into(),
            schema: schema.into(),
            name: name.into(),
            kind: kind.into(),
        }
    }
}

/// Columna de una tabla para el editor de datos y el autocompletado.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableColumn {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub identity: bool,
    pub default: Option<String>,
    pub kind: ColKind,
}

/// Nombre completo de un objeto.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    pub database: String,
    pub schema: String,
    pub name: String,
    /// table | view | procedure | function | ...
    pub kind: String,
}

/// Información para autocompletado: tablas y sus columnas.
#[derive(Debug, Clone, Serialize, Default)]
pub struct CompletionSchema {
    pub tables: Vec<CompletionTable>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CompletionTable {
    pub schema: String,
    pub name: String,
    pub columns: Vec<String>,
}
