//! Driver nativo de SQL Server (protocolo TDS con `tiberius`, sin drivers externos).
//!
//! Conexiones: todas viven en un runtime compartido (`rt`). Un resultado que se deja a medias (la interfaz pide 500
//! filas y después lanza otra consulta) no se espera:
//! - si la sesión no tiene nada propio, sigue al momento en su conexión de reserva, abierta en segundo plano mientras
//!   el cursor estaba abierto, y la vieja se corta (ATTENTION) y se cierra en segundo plano;
//! - con transacción, modo manual, tablas #temporales o SET del usuario, la conexión se conserva: se lee el resto,
//!   con progreso (`progress`) y Detener como única forma de cortarlo.
//!
//! tiberius 0.13 manda ATTENTION (`cancel_query`), pero en las pruebas con SQL Server 2022 la conexión no quedó
//! utilizable después: por eso no se usa para conservar la sesión, solo para que el servidor deje de trabajar en la
//! conexión que se deja. Cómo fue (y su error) sale en los tiempos de la sentencia siguiente.
//!
//! Las conexiones de las sesiones que se cierran sin estado propio quedan libres un rato (`pool`) para la siguiente
//! sesión de la misma configuración, que se ahorra el login (con su TLS). Con `CELER_MSSQL_TRACE` en el entorno, los
//! tiempos de cada lote salen también por la salida de error.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use futures_util::TryStreamExt;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use tiberius::{
    AuthMethod, Client, ColumnData, ColumnType, Config, EncryptionLevel, FromSql, QueryItem,
    SqlBrowser,
};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};
use tokio_util::sync::CancellationToken;

use crate::model::*;
use crate::session::{first_keyword, Canceller, Driver, Progress};

type Cli = Client<Compat<TcpStream>>;

const BINARY_PREVIEW: usize = 4096;

/// Tamaño de paquete TDS que se pide al conectar (el de mssql-jdbc; tiberius pide 4096): menos paquetes por resultado.
const PACKET_SIZE: u32 = 8000;
/// Lo que se espera el acuse del ATTENTION al cortar en segundo plano la conexión que se deja.
const ATTENTION_CAP: Duration = Duration::from_secs(10);
/// Conexiones libres: cuánto se guardan, a partir de cuándo se comprueban antes de usarlas y cuántas por configuración.
const IDLE_TTL: Duration = Duration::from_secs(300);
const IDLE_PING: Duration = Duration::from_secs(20);
const IDLE_MAX: usize = 3;

enum Item {
    Meta(Vec<ColumnInfo>),
    Row(Vec<Cell>),
    Count(i64),
    Error(String),
}

struct Cursor {
    rx: mpsc::Receiver<Item>,
    done: oneshot::Receiver<Finished>,
    peeked: Option<Item>,
    /// Pide al lector que deje el resultado: lo corta (ATTENTION) y la conexión se cierra. Si se cierra el cursor sin
    /// pedirlo, el lector lee el resto y la conexión se conserva.
    abandon: CancellationToken,
    /// Filas leídas al vaciar el resto, para el progreso.
    drained: Arc<AtomicU64>,
}

/// Cómo terminó el lector de un lote: con la conexión (None si se perdió) y, si el resultado se dejó a medias, cómo
/// se cortó.
struct Finished {
    client: Option<Cli>,
    cut: Option<Cut>,
}

/// Un resultado dejado a medias: las filas que aún se leyeron y, si se cortó con ATTENTION, su error.
#[derive(Debug, Default)]
struct Cut {
    rows: u64,
    error: Option<String>,
}

/// Lo que se muestra mientras se lee el resto de un resultado para conservar la sesión.
struct Drain {
    why: String,
    rows: Arc<AtomicU64>,
    since: Instant,
}

/// El runtime de todas las conexiones de SQL Server, con hilos propios: el lector de un resultado sigue trayendo
/// filas mientras la interfaz pinta las primeras, una conexión que se deja termina de cortarse en segundo plano y
/// las conexiones libres pasan de una sesión a otra (una conexión solo funciona en el runtime que la abrió).
fn rt() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("celer-mssql")
            .enable_all()
            .build()
            .expect("runtime de SQL Server")
    })
}

/// Lo que se sabe de una conexión al abrirla (en una sola ida y vuelta) y que viaja con ella por el pool.
#[derive(Clone)]
struct Facts {
    /// La base con la que se abrió ("" = la predeterminada del login).
    home: String,
    /// La base en la que está.
    database: String,
    engine: Engine,
    /// La descripción del servidor (`server_info`).
    info: String,
}

impl Facts {
    fn serves(&self, wanted: &str) -> bool {
        self.home == wanted || (!wanted.is_empty() && self.database.eq_ignore_ascii_case(wanted))
    }
}

/// Una conexión libre: abierta con la configuración de su clave, en autocommit y sin estado de sesión.
struct Idle {
    client: Cli,
    facts: Facts,
    since: Instant,
    /// La conexión guardada de la que viene (al desconectarla se cierran sus conexiones libres).
    owner: String,
}

/// Las conexiones libres, con la clave de su configuración (`pool_key`).
fn pool() -> &'static Mutex<Vec<(String, Idle)>> {
    static POOL: OnceLock<Mutex<Vec<(String, Idle)>>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(Vec::new()))
}

/// La clave de una configuración en el pool, sin guardar la contraseña en claro: todo lo que decide cómo es la
/// conexión (servidor, usuario, cifrado, script de inicio…) salvo la base, que va en cada conexión libre. También la
/// usa el pool de los demás motores (`guard.rs`).
pub(crate) fn pool_key(cfg: &ConnConfig) -> String {
    let mut c = cfg.clone();
    c.database.clear();
    c.id.clear();
    c.name.clear();
    c.color.clear();
    c.folder.clear();
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_string(&c).unwrap_or_default().as_bytes());
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Deja una conexión libre para otra sesión, si caben más; las caducadas se cierran.
fn put_idle(key: String, idle: Idle) {
    let mut pool = pool().lock();
    pool.retain(|(_, i)| i.since.elapsed() < IDLE_TTL);
    if pool.iter().filter(|(k, _)| *k == key).count() < IDLE_MAX {
        pool.push((key, idle));
    }
}

/// Cierra las conexiones libres de una conexión guardada (al desconectarla o borrarla). Devuelve cuántas.
pub fn pool_forget(owner: &str) -> usize {
    let gone: Vec<(String, Idle)> = {
        let mut pool = pool().lock();
        let (gone, keep): (Vec<(String, Idle)>, Vec<(String, Idle)>) = std::mem::take(&mut *pool).into_iter().partition(|(_, i)| i.owner == owner);
        *pool = keep;
        gone
    };
    let n = gone.len();
    // Cerrarlas es soltar el cliente; dentro del runtime en el que se abrieron.
    rt().spawn(async move { drop(gone) });
    n
}

/// Una conexión libre para la base `wanted`, la más reciente. Si lleva un rato parada se comprueba antes con un
/// SELECT 1: un cortafuegos puede haberla cerrado sin avisar.
fn take_idle(key: &str, wanted: &str) -> Option<Idle> {
    loop {
        let mut idle = {
            let mut pool = pool().lock();
            pool.retain(|(_, i)| i.since.elapsed() < IDLE_TTL);
            let at = pool.iter().rposition(|(k, i)| k == key && i.facts.serves(wanted))?;
            pool.remove(at).1
        };
        if alive(&mut idle) {
            return Some(idle);
        }
    }
}

/// Si una conexión parada sigue viva: si lleva un rato sin usarse se comprueba con un SELECT 1, porque un
/// cortafuegos puede haberla cerrado sin avisar.
fn alive(idle: &mut Idle) -> bool {
    if idle.since.elapsed() < IDLE_PING {
        return true;
    }
    rt().block_on(async {
        let ping = async { idle.client.simple_query("SELECT 1").await?.into_results().await };
        matches!(tokio::time::timeout(Duration::from_secs(5), ping).await, Ok(Ok(_)))
    })
}

/// Abre una conexión en la base `database` ("" = la predeterminada del login) con el script de inicio, y lee de una
/// vez la base, la familia del servidor y su descripción.
async fn open_connection(cfg: &ConnConfig, database: &str) -> Result<Idle> {
    let mut client = connect_client(cfg, Some(database.to_string())).await?;
    let facts = async {
        client
            .simple_query(
                "SELECT DB_NAME(), CAST(SERVERPROPERTY('EngineEdition') AS int), @@VERSION, \
                 CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(50)), CAST(SERVERPROPERTY('Edition') AS nvarchar(100))",
            )
            .await?
            .into_first_result()
            .await
    }
    .await;
    let row: Vec<Cell> = facts.ok().and_then(|rows| rows.into_iter().next()).map(row_to_cells).unwrap_or_default();
    let cell = |i: usize| row.get(i).map(cell_str).unwrap_or_default();
    let version = cell(2);
    let engine = Engine::detect(row.get(1).map(cell_i64).unwrap_or(0), &version);
    let mut info = String::new();
    if !row.is_empty() {
        let first = version.lines().next().unwrap_or("").trim().to_string();
        info = format!("{} — {} ({})", first, cell(4), cell(3));
        if let Some(label) = engine.label() {
            info.push_str(&format!(" · {label}"));
        }
    }
    let actual = cell(0);
    Ok(Idle {
        owner: cfg.id.clone(),
        client,
        facts: Facts {
            home: database.to_string(),
            database: if actual.is_empty() { database.to_string() } else { actual },
            engine,
            info,
        },
        since: Instant::now(),
    })
}

/// Familia del servidor según `SERVERPROPERTY('EngineEdition')`: decide qué SQL de catálogo y qué DDL se escriben.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Engine {
    /// SQL Server, Azure SQL Database y Managed Instance, Azure SQL Edge, SQL database de Fabric.
    SqlServer,
    /// Azure Synapse dedicated SQL pool y Analytics Platform System / PDW (EngineEdition 6): tablas distribuidas,
    /// claves solo NOT ENFORCED, sin claves foráneas, triggers, secuencias, FOR XML ni USE.
    Synapse,
    /// Synapse serverless SQL pool y Warehouse / SQL analytics endpoint de Fabric (EngineEdition 11).
    Warehouse,
}

impl Engine {
    /// `version` (@@VERSION) cubre un PDW que no diera la edición.
    fn detect(edition: i64, version: &str) -> Engine {
        match edition {
            6 => Engine::Synapse,
            11 => Engine::Warehouse,
            _ if version.contains("Parallel Data Warehouse") || version.contains("SQL Data Warehouse") => Engine::Synapse,
            _ => Engine::SqlServer,
        }
    }

    /// Lo que se añade a la descripción del servidor (la interfaz lo busca para el plan y la actividad).
    fn label(self) -> Option<&'static str> {
        match self {
            Engine::SqlServer => None,
            Engine::Synapse => Some("Azure Synapse dedicated / PDW"),
            Engine::Warehouse => Some("Synapse serverless / Fabric Warehouse"),
        }
    }
}

/// Lo que un lote deja en la sesión, visto por encima (fuera de cadenas y comentarios): decide si otra conexión
/// valdría igual que esta.
#[derive(Debug, Default, PartialEq)]
struct Effects {
    /// SET de una opción de sesión (no el de un UPDATE ni el de una variable), contexto de sesión, rol de aplicación,
    /// EXECUTE AS y SETUSER, claves abiertas, cursores globales.
    session: bool,
    /// Crea tablas #temporales.
    temp: bool,
    /// Abre una transacción (BEGIN TRAN).
    tran: bool,
    /// Cambia de base (USE).
    uses: bool,
    /// El lote es solo `USE base`: la base.
    use_only: Option<String>,
}

/// Palabras, identificadores entre corchetes o comillas dobles, cadenas (`'`) y signos de un lote de T-SQL, sin
/// comentarios.
fn sql_tokens(sql: &str) -> Vec<String> {
    let c: Vec<char> = sql.chars().collect();
    let is_word = |ch: char| ch.is_alphanumeric() || matches!(ch, '_' | '@' | '#' | '$');
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch.is_whitespace() {
            i += 1;
        } else if ch == '-' && c.get(i + 1) == Some(&'-') {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
        } else if ch == '/' && c.get(i + 1) == Some(&'*') {
            // Los comentarios de T-SQL se anidan.
            let mut depth = 0;
            while i < c.len() {
                if c[i] == '/' && c.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if c[i] == '*' && c.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
        } else if ch == '\'' || ch == '"' || ch == '[' {
            let close = if ch == '[' { ']' } else { ch };
            let start = i;
            i += 1;
            while i < c.len() {
                if c[i] == close {
                    if c.get(i + 1) == Some(&close) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            out.push(if ch == '\'' { "'".to_string() } else { c[start..i].iter().collect() });
        } else if is_word(ch) {
            let start = i;
            while i < c.len() && is_word(c[i]) {
                i += 1;
            }
            out.push(c[start..i].iter().collect());
        } else {
            out.push(ch.to_string());
            i += 1;
        }
    }
    out
}

/// Los lotes de un script separados por líneas `GO` (o `GO n`: el lote n veces), como hacen SSMS y sqlcmd: una
/// línea con solo GO fuera de cadenas, identificadores y comentarios. Sin GO, un solo lote con el texto entero.
fn split_go(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut batch = String::new();
    // Dentro de un comentario /* */ (se anidan) o de una cadena o identificador que cierra con este carácter.
    let (mut depth, mut quote) = (0usize, None::<char>);
    for line in sql.split_inclusive('\n') {
        if depth == 0 && quote.is_none() {
            if let Some(times) = go_line(line) {
                if !batch.trim().is_empty() {
                    out.extend(std::iter::repeat_n(batch.clone(), times));
                }
                batch.clear();
                continue;
            }
        }
        let c: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < c.len() {
            let next = c.get(i + 1).copied();
            if let Some(q) = quote {
                if c[i] == q {
                    if next == Some(q) {
                        i += 1;
                    } else {
                        quote = None;
                    }
                }
            } else if depth > 0 {
                if c[i] == '/' && next == Some('*') {
                    depth += 1;
                    i += 1;
                } else if c[i] == '*' && next == Some('/') {
                    depth -= 1;
                    i += 1;
                }
            } else {
                match c[i] {
                    '-' if next == Some('-') => break,
                    '/' if next == Some('*') => {
                        depth = 1;
                        i += 1;
                    }
                    '\'' | '"' => quote = Some(c[i]),
                    '[' => quote = Some(']'),
                    _ => {}
                }
            }
            i += 1;
        }
        batch.push_str(line);
    }
    if !batch.trim().is_empty() || out.is_empty() {
        out.push(batch);
    }
    out
}

/// "Quedan 3 lotes …": `n` lotes con el verbo en singular o plural y el resto de la frase; nada si `n` es 0.
fn batches_note(one: &str, many: &str, n: usize, rest: &str) -> Option<String> {
    match n {
        0 => None,
        1 => Some(format!("{one} 1 lote {rest}")),
        n => Some(format!("{many} {n} lotes {rest}")),
    }
}

/// Si la línea es un separador de lotes: `GO` o `GO n`, con un comentario `--` detrás si acaso. Las veces del lote.
fn go_line(line: &str) -> Option<usize> {
    let code = line.split("--").next().unwrap_or("");
    let mut words = code.split_whitespace();
    if !words.next()?.eq_ignore_ascii_case("GO") {
        return None;
    }
    match (words.next(), words.next()) {
        (None, _) => Some(1),
        (Some(n), None) => n.parse().ok().filter(|n| *n >= 1),
        _ => None,
    }
}

/// Un identificador sin corchetes ni comillas dobles.
fn unquote_ident(s: &str) -> String {
    if let Some(inner) = s.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
        inner.replace("]]", "]")
    } else if let Some(inner) = s.strip_prefix('"').and_then(|r| r.strip_suffix('"')) {
        inner.replace("\"\"", "\"")
    } else {
        s.to_string()
    }
}

fn session_effects(sql: &str) -> Effects {
    let raw = sql_tokens(sql);
    let t: Vec<String> = raw.iter().map(|s| s.to_uppercase()).collect();
    let at = |i: usize| t.get(i).map(String::as_str).unwrap_or("");
    let name = |s: &str| s.starts_with(|c: char| c.is_alphanumeric() || matches!(c, '_' | '[' | '"'));
    let mut e = Effects::default();
    for i in 0..t.len() {
        match at(i) {
            "SET" => {
                // `UPDATE … SET col = …`, `SET t.col = …`, `SET @v = …` y `SET col += …` asignan; lo demás es una opción.
                let next = at(i + 2);
                let assigns = next == "="
                    || next == "."
                    || (matches!(next, "+" | "-" | "*" | "/" | "%" | "&" | "^" | "|") && at(i + 3) == "=");
                if name(at(i + 1)) && !assigns {
                    e.session = true;
                }
            }
            "TABLE" | "INTO" if at(i + 1).starts_with('#') => e.temp = true,
            "BEGIN" if matches!(at(i + 1), "TRAN" | "TRANSACTION" | "DISTRIBUTED") => e.tran = true,
            // `OPTION (USE HINT …)` y `USE PLAN` no cambian de base.
            "USE" if i == 0 || !matches!(at(i - 1), "(" | ",") => e.uses = true,
            "SP_SET_SESSION_CONTEXT" | "SP_GETAPPLOCK" | "SP_SETAPPROLE" | "SETUSER" => e.session = true,
            // EXECUTE AS cambia el usuario de la sesión; no la cláusula de un CREATE PROC … WITH [opción,] EXECUTE AS.
            "EXEC" | "EXECUTE" if at(i + 1) == "AS" && (i == 0 || !matches!(at(i - 1), "WITH" | ",")) => e.session = true,
            "OPEN" if matches!(at(i + 1), "SYMMETRIC" | "MASTER") && at(i + 2) == "KEY" => e.session = true,
            // Un cursor con nombre es GLOBAL salvo que diga LOCAL: dura lo que la conexión (una variable @c, el lote).
            "DECLARE" if !at(i + 1).starts_with('@') => {
                let decl: Vec<&str> = (i + 2..i + 10).map(at).take_while(|w| !matches!(*w, "FOR" | "")).collect();
                if decl.contains(&"CURSOR") && !decl.contains(&"LOCAL") {
                    e.session = true;
                }
            }
            _ => {}
        }
    }
    let code: Vec<&str> = raw.iter().map(String::as_str).filter(|s| *s != ";").collect();
    if code.len() == 2 && code[0].eq_ignore_ascii_case("USE") && name(code[1]) {
        e.use_only = Some(unquote_ident(code[1]));
    }
    e
}

/// Si un lote es una sola sentencia: ninguna otra empieza fuera de paréntesis (T-SQL no pide `;` entre sentencias).
/// Valen las partes de la propia sentencia: los SELECT tras UNION y demás, el SELECT o EXEC de un INSERT, el SET de
/// un UPDATE, el UPDATE SET, INSERT y DELETE tras THEN de un MERGE, la consulta de un WITH o de un DECLARE CURSOR, y
/// el cuerpo de un CREATE/ALTER de procedimiento, función, trigger o vista.
fn single_statement(sql: &str) -> bool {
    let t: Vec<String> = sql_tokens(sql).iter().filter(|s| *s != ";").map(|s| s.to_uppercase()).collect();
    let Some(first) = t.first().map(String::as_str) else { return true };
    if matches!(first, "CREATE" | "ALTER") {
        let mut what = 1;
        if t.get(1).map(String::as_str) == Some("OR") {
            what = 3;
        }
        if matches!(t.get(what).map(String::as_str), Some("PROC" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "VIEW")) {
            return true;
        }
    }
    // The statement itself: after a WITH, the one its CTEs are for.
    let mut main = first;
    let (mut depth, mut sources, mut sets) = (0usize, 0, 0);
    for i in 1..t.len() {
        let prev = t[i - 1].as_str();
        let word = t[i].as_str();
        match word {
            "(" => depth += 1,
            ")" => depth = depth.saturating_sub(1),
            _ if depth > 0 => {}
            "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" if main == "WITH" => main = word,
            "SELECT" if matches!(prev, "UNION" | "ALL" | "EXCEPT" | "INTERSECT") => {}
            "SELECT" if main == "DECLARE" && prev == "FOR" => {}
            "UPDATE" if prev == "FOR" => {}
            "SELECT" | "EXEC" | "EXECUTE" if main == "INSERT" && sources == 0 => sources += 1,
            "INSERT" | "UPDATE" | "DELETE" if main == "MERGE" && prev == "THEN" => {}
            "SET" if (main == "UPDATE" && sets == 0) || (main == "MERGE" && prev == "UPDATE") => sets += 1,
            "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "SET" | "EXEC" | "EXECUTE" | "CREATE" | "ALTER" | "DROP"
            | "DECLARE" | "PRINT" | "IF" | "WHILE" | "BEGIN" | "TRUNCATE" | "USE" | "RAISERROR" | "GRANT" | "REVOKE"
            | "DENY" | "COMMIT" | "ROLLBACK" | "WAITFOR" | "DBCC" => return false,
            _ => {}
        }
    }
    true
}

pub struct MssqlDriver {
    cfg: ConnConfig,
    /// `pool_key(cfg)`: las conexiones libres que puede tomar y dejar esta sesión.
    key: String,
    client: Option<Cli>,
    /// La base con que se abrió la conexión actual ("" = la predeterminada del login) y en la que estaba al abrirse.
    home: String,
    home_db: String,
    cursor: Option<Cursor>,
    cancel: Arc<Mutex<Option<CancellationToken>>>,
    database: String,
    autocommit: bool,
    in_tx: bool,
    /// Un BEGIN TRAN en modo automático: se mira @@TRANCOUNT tras cada lote hasta que vuelva a 0.
    tx_maybe: bool,
    /// Estado que otra conexión no tendría: SET del usuario, tablas #temporales, contexto de sesión.
    session_state: bool,
    showplan: bool,
    engine: Engine,
    info: String,
    /// Lo que pasó en el lote además de la consulta (conectar, dejar el resultado anterior), para la salida.
    notes: Vec<String>,
    /// Lo que se supo después en segundo plano (cómo se cortó la conexión que se dejó): sale en la sentencia siguiente.
    late: Arc<Mutex<Vec<String>>>,
    /// La conexión de reserva de la sesión, abriéndose o abierta, para seguir al momento si se deja un resultado.
    reserve: Option<oneshot::Receiver<Option<Idle>>>,
    /// Mientras se lee el resto de un resultado para conservar la sesión, para `progress`.
    drain: Arc<Mutex<Option<Drain>>>,
    /// Los lotes de un script con GO que quedan por enviar, y cuántos tenía: se envían al acabar el resultado abierto.
    batches: VecDeque<String>,
    batch_total: usize,
    /// Lotes del script anterior que no se enviaron porque su resultado se cerró antes de acabar, para avisar.
    discarded: usize,
    /// El resultado abierto es de un lote con más sentencias detrás, y dejarlo cortaría el lote; `cut`: se cortó.
    open_multi: bool,
    cut: bool,
}

impl MssqlDriver {
    pub fn connect(cfg: ConnConfig) -> Result<MssqlDriver> {
        let mut d = MssqlDriver {
            key: pool_key(&cfg),
            cfg,
            client: None,
            home: String::new(),
            home_db: String::new(),
            cursor: None,
            cancel: Arc::new(Mutex::new(None)),
            database: String::new(),
            autocommit: true,
            in_tx: false,
            tx_maybe: false,
            session_state: false,
            showplan: false,
            engine: Engine::SqlServer,
            info: String::new(),
            notes: Vec::new(),
            late: Arc::new(Mutex::new(Vec::new())),
            reserve: None,
            drain: Arc::new(Mutex::new(None)),
            batches: VecDeque::new(),
            batch_total: 0,
            discarded: 0,
            open_multi: false,
            cut: false,
        };
        let home = d.cfg.database.clone();
        d.attach(&home)?;
        trace(&d.notes.join(" · "));
        d.notes.clear();
        Ok(d)
    }

    /// Pone una conexión en la base `wanted` ("" = la predeterminada del login): una libre del pool si la hay o una
    /// nueva (con el script de inicio), y el modo de transacción de la sesión. Lo que la sesión tuviera (transacción,
    /// tablas temporales, SET) no pasa a la conexión nueva: se avisa.
    fn attach(&mut self, wanted: &str) -> Result<()> {
        let t0 = Instant::now();
        let (mut idle, reused) = match take_idle(&self.key, wanted) {
            Some(i) => (i, true),
            None => (rt().block_on(open_connection(&self.cfg, wanted))?, false),
        };
        if !self.autocommit {
            rt().block_on(async {
                idle.client.simple_query("SET IMPLICIT_TRANSACTIONS ON").await?.into_results().await
            })?;
        }
        let lost = self.lost_state();
        if !lost.is_empty() {
            self.notes.push(format!("conexión nueva: se han perdido {lost}"));
        }
        self.in_tx = false;
        self.tx_maybe = false;
        self.session_state = false;
        self.showplan = false;
        self.adopt(idle);
        let how = if reused { "conexión libre reutilizada" } else { "conexión abierta" };
        self.notes.push(format!("{how} en {} ms", t0.elapsed().as_millis()));
        Ok(())
    }

    fn adopt(&mut self, idle: Idle) {
        self.client = Some(idle.client);
        self.home = idle.facts.home;
        self.home_db = idle.facts.database.clone();
        self.database = idle.facts.database;
        self.engine = idle.facts.engine;
        self.info = idle.facts.info;
    }

    /// Lo que se sabe de la conexión actual, para dejarla en el pool.
    fn facts(&self) -> Facts {
        Facts {
            home: if self.database.eq_ignore_ascii_case(&self.home_db) { self.home.clone() } else { self.database.clone() },
            database: self.database.clone(),
            engine: self.engine,
            info: self.info.clone(),
        }
    }

    /// Si la sesión tiene algo que otra conexión no tendría: transacción (o modo manual), SET, tablas temporales.
    fn keeps_session(&self) -> bool {
        !self.autocommit || self.in_tx || self.tx_maybe || self.session_state || self.showplan
    }

    /// Lo que la sesión perdería con otra conexión, para avisar ("" si nada).
    fn lost_state(&self) -> String {
        let mut lost = Vec::new();
        if self.in_tx || self.tx_maybe {
            lost.push("la transacción abierta");
        }
        if self.session_state {
            lost.push("las tablas temporales, los SET y el resto del estado de la sesión (EXECUTE AS, claves abiertas, cursores)");
        }
        if self.showplan {
            lost.push("SHOWPLAN_XML");
        }
        lost.join(", ")
    }

    /// Devuelve el cliente, reconectando (en la misma base) si la conexión se perdió o se canceló.
    fn take_client(&mut self) -> Result<Cli> {
        if self.client.is_none() {
            let db = self.database.clone();
            self.attach(&db)?;
        }
        self.client.take().ok_or_else(|| anyhow!("Sin conexión con el servidor"))
    }

    /// Abre en segundo plano la conexión de reserva de la sesión, si no la tiene: en la base actual, con el script de
    /// inicio (una libre del pool si la hay). Se pide mientras un resultado queda abierto sin estado de sesión.
    fn ensure_reserve(&mut self) {
        if self.reserve.is_some() {
            return;
        }
        let (tx, rx) = oneshot::channel();
        let (cfg, key, wanted) = (self.cfg.clone(), self.key.clone(), self.database.clone());
        let opened = std::thread::Builder::new().name("celer-mssql-reserve".into()).spawn(move || {
            let idle = take_idle(&key, &wanted).or_else(|| rt().block_on(open_connection(&cfg, &wanted)).ok());
            if let Err(Some(idle)) = tx.send(idle) {
                // La sesión ya no la quiere: queda libre para otra.
                put_idle(key, idle);
            }
        });
        if opened.is_ok() {
            self.reserve = Some(rx);
        }
    }

    /// Sin estado de sesión que conservar, se deja el resultado a medias y la sesión sigue en su conexión de reserva
    /// (esperando solo lo que le falte por abrirse); sin reserva, en una libre o nueva. Misma base y mismo script de
    /// inicio: la reserva se abrió con ellos.
    fn switch_to_reserve(&mut self, t0: Instant) -> Result<()> {
        let mut ready = self.reserve.take().and_then(|rx| rt().block_on(rx).ok().flatten());
        // Abierta en otra base (la sesión cambió de base después): queda libre para otra sesión.
        if let Some(idle) = ready.take_if(|i| !i.facts.serves(&self.database)) {
            put_idle(self.key.clone(), idle);
        }
        if let Some(mut idle) = ready {
            if alive(&mut idle) {
                self.adopt(idle);
                self.notes.push(format!("resultado anterior dejado: sigue en la conexión de reserva ({} ms)", t0.elapsed().as_millis()));
                return Ok(());
            }
        }
        self.notes.push("resultado anterior dejado: sin conexión de reserva lista".into());
        let db = self.database.clone();
        self.attach(&db)
    }

    /// Azure Synapse dedicated no admite USE ni consulta otras bases con nombres de tres partes: cambiar de base es
    /// abrir la conexión en ella. La vieja queda libre en el pool si no lleva estado de sesión.
    fn reconnect_to(&mut self, db: &str) -> Result<()> {
        if db.eq_ignore_ascii_case(&self.database) {
            return Ok(());
        }
        self.close_cursor()?;
        self.refresh_tx_state();
        if self.in_tx {
            bail!("Hay una transacción abierta: confírmala o deshazla antes de cambiar de base de datos (Azure Synapse no admite USE: cambiar de base es abrir otra conexión)");
        }
        let reusable = !self.keeps_session();
        let facts = self.facts();
        let old = self.client.take();
        if let Err(e) = self.attach(db) {
            self.client = old;
            return Err(e);
        }
        if let (true, Some(client)) = (reusable, old) {
            put_idle(self.key.clone(), Idle { client, facts, since: Instant::now(), owner: self.cfg.id.clone() });
        }
        Ok(())
    }

    /// Para leer el catálogo de otra base en Azure Synapse dedicated, la sesión se conecta a ella.
    fn synapse_enter(&mut self, db: &str) -> Result<()> {
        if self.engine == Engine::Synapse && !db.is_empty() {
            self.reconnect_to(db)
        } else {
            Ok(())
        }
    }

    fn start(&mut self, sql: String, dml: bool) -> Result<()> {
        self.close_cursor()?;
        let client = self.take_client()?;
        let token = CancellationToken::new();
        *self.cancel.lock() = Some(token.clone());
        let abandon = CancellationToken::new();
        let drained = Arc::new(AtomicU64::new(0));
        let (leave, count) = (abandon.clone(), drained.clone());
        let (tx, rx) = mpsc::channel(1024);
        let (dtx, drx) = oneshot::channel();
        rt().spawn(async move {
            let done = run_query(client, sql, dml, tx, token, leave, count).await;
            let _ = dtx.send(done);
        });
        self.cursor = Some(Cursor {
            rx,
            done: drx,
            peeked: None,
            abandon,
            drained,
        });
        Ok(())
    }

    fn next_item(&mut self) -> Option<Item> {
        let cur = self.cursor.as_mut()?;
        if let Some(it) = cur.peeked.take() {
            return Some(it);
        }
        rt().block_on(cur.rx.recv())
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
            self.client = rt().block_on(cur.done).ok().and_then(|f| f.client);
        }
        *self.cancel.lock() = None;
    }

    /// Recoge la conexión tras leer el resto de un resultado (o tras acabar el lector) y anota cómo fue.
    fn after_cut(&mut self, finished: Option<Finished>, t0: Instant) {
        let ms = t0.elapsed().as_millis();
        let (client, cut) = match finished {
            Some(f) => (f.client, f.cut),
            None => (None, None),
        };
        let how = match cut {
            Some(c) => format!("resto del resultado anterior leído en {ms} ms ({} filas) para conservar la sesión", c.rows),
            None => format!("resultado anterior cerrado en {ms} ms"),
        };
        if client.is_none() {
            self.notes.push(format!("{how}; la conexión no se pudo conservar"));
        } else {
            self.notes.push(how);
        }
        self.client = client;
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
                    current = Some(ResultSet {
                        columns: cols,
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
        let (res, client) = rt().block_on(async move {
            let r: std::result::Result<Vec<Vec<Cell>>, tiberius::error::Error> = async {
                let stream = client.simple_query(sql).await?;
                let rows = stream.into_first_result().await?;
                Ok(rows.into_iter().map(row_to_cells).collect())
            }
            .await;
            (r, client)
        });
        match res {
            Ok(rows) => {
                self.client = Some(client);
                Ok(rows)
            }
            Err(e) => {
                // Un error de red deja la conexión inservible: la siguiente sentencia abre otra.
                if !is_fatal(&e) {
                    self.client = Some(client);
                }
                // Con el mensaje del servidor, como en las consultas del usuario (sin "Token error … on server …").
                Err(anyhow!(friendly_error(&e)))
            }
        }
    }

    /// Mira @@TRANCOUNT en modo manual y tras un BEGIN TRAN en automático; si no, no hay transacción y no se pregunta.
    fn refresh_tx_state(&mut self) {
        if self.autocommit && !self.tx_maybe {
            self.in_tx = false;
            return;
        }
        if self.cursor.is_some() {
            self.in_tx = true;
            return;
        }
        // La conexión se cortó: preguntar abriría otra (y perdería en silencio lo que hubiera). Se deja como estaba
        // para que la sesión vigilada (guard.rs) diga lo que se pierde.
        if self.client.is_none() {
            return;
        }
        self.in_tx = self
            .query_rows("SELECT @@TRANCOUNT")
            .ok()
            .and_then(|r| r.first().and_then(|r| r.first()).map(cell_i64))
            .unwrap_or(0)
            > 0;
        if self.autocommit && !self.in_tx {
            self.tx_maybe = false;
        }
    }

    /// Los tiempos de lo que no es la consulta en sí (abrir o cambiar de conexión, cortar el resultado anterior) para
    /// la salida, si hubo algo de eso; con CELER_MSSQL_TRACE, siempre, y también por la salida de error.
    fn timing_line(&mut self, first_ms: u128) -> Option<String> {
        let always = std::env::var_os("CELER_MSSQL_TRACE").is_some();
        if self.notes.is_empty() && !always {
            return None;
        }
        let mut parts = std::mem::take(&mut self.notes);
        parts.push(format!("primera respuesta del servidor en {first_ms} ms"));
        let line = format!("Tiempos: {}", parts.join(" · "));
        trace(&line);
        Some(line)
    }

    /// Columnas de una tabla (`columns_query`). En Synapse, si sys.indexes no marca la clave primaria, se toma de
    /// sus restricciones (`synapse_keys`).
    fn column_rows(&mut self, o: &ObjectRef) -> Result<Vec<Vec<Cell>>> {
        let mut rows = self.query_rows(&self.columns_query(o))?;
        if self.engine == Engine::Synapse && !rows.is_empty() && !rows.iter().any(|r| cell_i64(&r[7]) == 1) {
            let pk: Vec<String> = self
                .synapse_keys(o, false)
                .unwrap_or_default()
                .into_iter()
                .filter(|k| k.primary)
                .flat_map(|k| k.columns.split(", ").map(str::to_string).collect::<Vec<_>>())
                .collect();
            for r in rows.iter_mut() {
                if pk.contains(&cell_str(&r[0])) {
                    r[7] = Cell::Int(1);
                }
            }
        }
        Ok(rows)
    }

    /// Azure Synapse dedicated: las claves primarias y únicas (siempre NOT ENFORCED) de `sys.key_constraints`, con sus
    /// columnas de `sys.index_columns` o, si su índice no figura allí, de `INFORMATION_SCHEMA.KEY_COLUMN_USAGE`. La
    /// documentación no dice si estas claves salen en `sys.indexes`: así se ven en los dos casos.
    fn synapse_keys(&mut self, o: &ObjectRef, quoted: bool) -> Result<Vec<IndexDef>> {
        let db = qi(&o.database);
        let keys = self.query_rows(&format!(
            "SELECT k.name, k.type, k.unique_index_id FROM {db}.sys.key_constraints k WHERE k.parent_object_id = {} ORDER BY k.type, k.name",
            self.obj_id(o)
        ))?;
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let mut by_index = self.index_columns(o, quoted).unwrap_or_default();
        let mut by_name: HashMap<String, String> = HashMap::new();
        if keys.iter().any(|k| !by_index.contains_key(&cell_i64(&k[2]))) {
            let rows = self
                .query_rows(&format!(
                    "SELECT CONSTRAINT_NAME, COLUMN_NAME FROM {db}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE \
                     WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
                    ql(&o.schema),
                    ql(&o.name)
                ))
                .unwrap_or_default();
            for r in rows {
                let col = if quoted { qi(&cell_str(&r[1])) } else { cell_str(&r[1]) };
                let list = by_name.entry(cell_str(&r[0])).or_default();
                if !list.is_empty() {
                    list.push_str(", ");
                }
                list.push_str(&col);
            }
        }
        Ok(keys
            .iter()
            .map(|k| {
                let name = cell_str(&k[0]);
                let primary = cell_str(&k[1]).trim() == "PK";
                let columns = by_index.remove(&cell_i64(&k[2])).or_else(|| by_name.remove(&name)).unwrap_or_default();
                IndexDef {
                    name,
                    type_code: 2,
                    type_desc: "NONCLUSTERED".into(),
                    primary,
                    unique: true,
                    unique_constraint: !primary,
                    columns,
                    ..Default::default()
                }
            })
            .collect())
    }

    /// Si una tabla tiene la carpeta `key` ("indexes", "fks", "triggers") en este servidor: Synapse dedicated no tiene
    /// claves foráneas ni triggers, y Fabric Warehouse no tiene triggers ni índices.
    fn has_table_folder(&self, key: &str) -> bool {
        match self.engine {
            Engine::SqlServer => true,
            Engine::Synapse => key == "indexes",
            Engine::Warehouse => key == "fks",
        }
    }

    fn obj_id(&self, o: &ObjectRef) -> String {
        format!("OBJECT_ID({})", ql(&self.qualified_name(o)))
    }

    /// Columnas de una tabla: nombre, tipo, max_length, precision, scale, nullable, identity, pk, default, calculada y
    /// su expresión; en SQL Server también semilla e incremento del IDENTITY y si la calculada es PERSISTED.
    fn columns_query(&self, o: &ObjectRef) -> String {
        let db = qi(&o.database);
        let (identity, identity_join) = if self.engine == Engine::SqlServer {
            (
                "CONVERT(varchar(40), idc.seed_value), CONVERT(varchar(40), idc.increment_value), cc.is_persisted",
                format!("LEFT JOIN {db}.sys.identity_columns idc ON idc.object_id = c.object_id AND idc.column_id = c.column_id"),
            )
        } else {
            ("NULL, NULL, 0", String::new())
        };
        format!(
            "SELECT c.name, ty.name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, \
             CASE WHEN EXISTS(SELECT 1 FROM {db}.sys.index_columns ic JOIN {db}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
               WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END, \
             dc.definition, c.is_computed, cc.definition, {identity} \
             FROM {db}.sys.columns c JOIN {db}.sys.types ty ON ty.user_type_id = c.user_type_id \
             LEFT JOIN {db}.sys.default_constraints dc ON dc.object_id = c.default_object_id \
             LEFT JOIN {db}.sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id \
             {identity_join} WHERE c.object_id = {} ORDER BY c.column_id",
            self.obj_id(o)
        )
    }

    /// Columnas clave de cada índice de la tabla, por `index_id`, en orden: entre corchetes y con DESC (`quoted`,
    /// para el DDL) o tal cual (para el explorador).
    fn index_columns(&mut self, o: &ObjectRef, quoted: bool) -> Result<HashMap<i64, String>> {
        let db = qi(&o.database);
        let rows = self.query_rows(&format!(
            "SELECT ic.index_id, c.name, ic.is_descending_key \
             FROM {db}.sys.index_columns ic JOIN {db}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE ic.object_id = {} AND ic.is_included_column = 0 ORDER BY ic.index_id, ic.key_ordinal, ic.column_id",
            self.obj_id(o)
        ))?;
        Ok(column_lists(rows.iter().map(|r| {
            let name = cell_str(&r[1]);
            let col = match (quoted, cell_i64(&r[2]) == 1) {
                (false, _) => name,
                (true, false) => qi(&name),
                (true, true) => format!("{} DESC", qi(&name)),
            };
            (cell_i64(&r[0]), col)
        })))
    }

    /// Columnas de cada clave foránea de la tabla, por `object_id` de la clave: las propias y las referenciadas.
    fn fk_columns(&mut self, o: &ObjectRef, quoted: bool) -> Result<(HashMap<i64, String>, HashMap<i64, String>)> {
        let db = qi(&o.database);
        let rows = self.query_rows(&format!(
            "SELECT k.constraint_object_id, pc.name, rc.name FROM {db}.sys.foreign_key_columns k \
             JOIN {db}.sys.columns pc ON pc.object_id = k.parent_object_id AND pc.column_id = k.parent_column_id \
             JOIN {db}.sys.columns rc ON rc.object_id = k.referenced_object_id AND rc.column_id = k.referenced_column_id \
             WHERE k.parent_object_id = {} ORDER BY k.constraint_object_id, k.constraint_column_id",
            self.obj_id(o)
        ))?;
        let name = |c: &Cell| if quoted { qi(&cell_str(c)) } else { cell_str(c) };
        Ok((
            column_lists(rows.iter().map(|r| (cell_i64(&r[0]), name(&r[1])))),
            column_lists(rows.iter().map(|r| (cell_i64(&r[0]), name(&r[2])))),
        ))
    }

    fn table_ddl(&mut self, o: &ObjectRef) -> Result<String> {
        self.synapse_enter(&o.database)?;
        let columns = self.query_rows(&self.columns_query(o))?;
        if columns.is_empty() {
            bail!("No se encontró el objeto {}", self.qualified_name(o));
        }
        let db = qi(&o.database);
        let oid = self.obj_id(o);
        let sql_server = self.engine == Engine::SqlServer;
        let filter = if sql_server { "i.filter_definition" } else { "NULL" };
        let idx = self.query_rows(&format!(
            "SELECT i.index_id, i.name, i.type, i.type_desc, i.is_primary_key, i.is_unique, i.is_unique_constraint, {filter} \
             FROM {db}.sys.indexes i WHERE i.object_id = {oid} ORDER BY i.is_primary_key DESC, i.name"
        ))?;
        let mut key_cols = self.index_columns(o, true)?;
        // SQL Server: columnas INCLUDE (y las de un columnar), y lo propio de los índices XML secundarios y espaciales.
        let mut included = HashMap::new();
        let mut suffixes: HashMap<i64, String> = HashMap::new();
        if sql_server {
            let rows = self.query_rows(&format!(
                "SELECT ic.index_id, c.name FROM {db}.sys.index_columns ic \
                 JOIN {db}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                 WHERE ic.object_id = {oid} AND ic.is_included_column = 1 ORDER BY ic.index_id, ic.index_column_id"
            ))?;
            included = column_lists(rows.iter().map(|r| (cell_i64(&r[0]), qi(&cell_str(&r[1])))));
            if idx.iter().any(|r| cell_i64(&r[2]) == 3) {
                let rows = self.query_rows(&format!(
                    "SELECT x.index_id, x.secondary_type_desc, p.name FROM {db}.sys.xml_indexes x \
                     JOIN {db}.sys.indexes p ON p.object_id = x.object_id AND p.index_id = x.using_xml_index_id \
                     WHERE x.object_id = {oid}"
                ))?;
                for r in rows {
                    suffixes.insert(cell_i64(&r[0]), format!(" USING XML INDEX {} FOR {}", qi(&cell_str(&r[2])), cell_str(&r[1])));
                }
            }
            if idx.iter().any(|r| cell_i64(&r[2]) == 4) {
                let rows = self.query_rows(&format!(
                    "SELECT t.index_id, t.tessellation_scheme, t.bounding_box_xmin, t.bounding_box_ymin, t.bounding_box_xmax, \
                     t.bounding_box_ymax FROM {db}.sys.spatial_index_tessellations t WHERE t.object_id = {oid}"
                ))?;
                for r in rows {
                    let scheme = cell_str(&r[1]);
                    let mut suffix = format!(" USING {scheme}");
                    // Un índice sobre geometry necesita su caja; uno sobre geography no la tiene.
                    if scheme.starts_with("GEOMETRY") {
                        let b: Vec<String> = r[2..6].iter().map(cell_str).collect();
                        suffix.push_str(&format!(" WITH (BOUNDING_BOX = ({}))", b.join(", ")));
                    }
                    suffixes.insert(cell_i64(&r[0]), suffix);
                }
            }
        }
        let mut indexes: Vec<IndexDef> = idx
            .iter()
            .map(|r| {
                let id = cell_i64(&r[0]);
                IndexDef {
                    name: cell_str(&r[1]),
                    type_code: cell_i64(&r[2]),
                    type_desc: cell_str(&r[3]),
                    primary: cell_i64(&r[4]) == 1,
                    unique: cell_i64(&r[5]) == 1,
                    unique_constraint: cell_i64(&r[6]) == 1,
                    columns: key_cols.remove(&id).unwrap_or_default(),
                    included: included.remove(&id).unwrap_or_default(),
                    filter: cell_str(&r[7]),
                    suffix: suffixes.remove(&id).unwrap_or_default(),
                }
            })
            .collect();
        // Synapse: las claves NOT ENFORCED que sys.indexes no tenga (sin columnas no se pueden escribir).
        if self.engine == Engine::Synapse {
            for key in self.synapse_keys(o, true).unwrap_or_default() {
                if !key.columns.is_empty() && !indexes.iter().any(|i| i.name == key.name) {
                    indexes.push(key);
                }
            }
        }
        // Synapse dedicated no tiene claves foráneas.
        let fks = if self.engine == Engine::Synapse {
            Vec::new()
        } else {
            self.query_rows(&format!(
                "SELECT fk.object_id, fk.name, QUOTENAME(rs.name) + '.' + QUOTENAME(rt.name), \
                   fk.delete_referential_action_desc, fk.update_referential_action_desc \
                 FROM {db}.sys.foreign_keys fk JOIN {db}.sys.tables rt ON rt.object_id = fk.referenced_object_id \
                 JOIN {db}.sys.schemas rs ON rs.schema_id = rt.schema_id WHERE fk.parent_object_id = {oid} ORDER BY fk.name"
            ))?
        };
        let (mut own, mut referenced) = if fks.is_empty() { Default::default() } else { self.fk_columns(o, true)? };
        let foreign_keys = fks
            .iter()
            .map(|r| {
                let id = cell_i64(&r[0]);
                ForeignKeyDef {
                    name: cell_str(&r[1]),
                    columns: own.remove(&id).unwrap_or_default(),
                    target: cell_str(&r[2]),
                    target_columns: referenced.remove(&id).unwrap_or_default(),
                    on_delete: cell_str(&r[3]),
                    on_update: cell_str(&r[4]),
                }
            })
            .collect();
        let checks = if sql_server {
            self.query_rows(&format!(
                "SELECT name, definition FROM {db}.sys.check_constraints WHERE parent_object_id = {oid} ORDER BY name"
            ))?
            .iter()
            .map(|r| (cell_str(&r[0]), cell_str(&r[1])))
            .collect()
        } else {
            Vec::new()
        };
        let mut parts = TableParts {
            columns,
            indexes,
            foreign_keys,
            checks,
            ..Default::default()
        };
        if self.engine == Engine::Synapse {
            let policy = self.query_rows(&format!(
                "SELECT distribution_policy_desc FROM {db}.sys.pdw_table_distribution_properties WHERE object_id = {oid}"
            ))?;
            parts.distribution = policy.first().map(|r| cell_str(&r[0])).unwrap_or_default();
            let hash = self.query_rows(&format!(
                "SELECT c.name FROM {db}.sys.pdw_column_distribution_properties d \
                 JOIN {db}.sys.columns c ON c.object_id = d.object_id AND c.column_id = d.column_id \
                 WHERE d.object_id = {oid} AND d.distribution_ordinal > 0 ORDER BY d.distribution_ordinal"
            ))?;
            parts.distribution_columns = quoted_list(&hash);
            // column_store_order_ordinal no existe en PDW: sin él, el índice columnar se escribe sin ORDER.
            let order = self
                .query_rows(&format!(
                    "SELECT c.name FROM {db}.sys.index_columns ic \
                     JOIN {db}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                     WHERE ic.object_id = {oid} AND ic.column_store_order_ordinal > 0 ORDER BY ic.column_store_order_ordinal"
                ))
                .unwrap_or_default();
            parts.order = quoted_list(&order);
        }
        Ok(build_table_ddl(self.engine, &self.qualified_name(o), &parts))
    }
}

/// Junta en listas "a, b, c" las columnas que llegan como filas (grupo, columna) ya ordenadas. Sustituye a
/// `FOR XML PATH` y `STRING_AGG`: el primero no existe en Azure Synapse, PDW ni Fabric, y el segundo tampoco
/// antes de SQL Server 2017.
fn column_lists(rows: impl IntoIterator<Item = (i64, String)>) -> HashMap<i64, String> {
    let mut out: HashMap<i64, String> = HashMap::new();
    for (key, col) in rows {
        let list = out.entry(key).or_default();
        if !list.is_empty() {
            list.push_str(", ");
        }
        list.push_str(&col);
    }
    out
}

/// Los nombres de la primera columna de cada fila, entre corchetes y separados por comas.
fn quoted_list(rows: &[Vec<Cell>]) -> String {
    rows.iter().map(|r| qi(&cell_str(&r[0]))).collect::<Vec<_>>().join(", ")
}

/// Un índice de la tabla (también el montón, `type_code` 0), con sus columnas clave ya escritas. `type_code`: 1
/// agrupado, 2 no agrupado, 3 XML, 4 espacial, 5 columnar agrupado, 6 columnar no agrupado.
#[derive(Default)]
struct IndexDef {
    name: String,
    type_code: i64,
    type_desc: String,
    primary: bool,
    unique: bool,
    unique_constraint: bool,
    columns: String,
    /// SQL Server: las columnas INCLUDE (las de un columnar no agrupado), el filtro (`([q]>(10))`) y lo que va tras
    /// las columnas de un índice XML secundario o espacial (`USING XML INDEX … FOR PATH`, `USING GEOMETRY_GRID …`).
    included: String,
    filter: String,
    suffix: String,
}

struct ForeignKeyDef {
    name: String,
    columns: String,
    /// `[esquema].[tabla]` referenciada.
    target: String,
    target_columns: String,
    on_delete: String,
    on_update: String,
}

/// Lo que se lee del catálogo para escribir el DDL de una tabla.
#[derive(Default)]
struct TableParts {
    /// Filas de `columns_query`.
    columns: Vec<Vec<Cell>>,
    indexes: Vec<IndexDef>,
    foreign_keys: Vec<ForeignKeyDef>,
    /// SQL Server: las restricciones CHECK, nombre y definición (`([q]>(0))`).
    checks: Vec<(String, String)>,
    /// Synapse dedicated: HASH, ROUND_ROBIN o REPLICATE, las columnas del HASH y las del ORDER del índice columnar.
    distribution: String,
    distribution_columns: String,
    order: String,
}

/// Definición de una columna para CREATE TABLE. Fabric Warehouse no admite semilla en IDENTITY ni DEFAULT.
fn column_ddl(r: &[Cell], engine: Engine) -> String {
    let name = cell_str(&r[0]);
    let extra = |i: usize| r.get(i).map(cell_str).filter(|s| !s.is_empty());
    if cell_i64(&r[9]) == 1 {
        let persisted = if r.get(13).map(cell_i64) == Some(1) { " PERSISTED" } else { "" };
        return format!("    {} AS {}{persisted}", qi(&name), cell_str(&r[10]));
    }
    let ty = mssql_type(
        &cell_str(&r[1]),
        cell_i64(&r[2]),
        cell_i64(&r[3]),
        cell_i64(&r[4]),
    );
    let mut l = format!("    {} {}", qi(&name), ty);
    if cell_i64(&r[6]) == 1 {
        if engine == Engine::Warehouse {
            l.push_str(" IDENTITY");
        } else {
            let (seed, step) = (extra(11).unwrap_or_else(|| "1".into()), extra(12).unwrap_or_else(|| "1".into()));
            l.push_str(&format!(" IDENTITY({seed},{step})"));
        }
    }
    l.push_str(if cell_i64(&r[5]) == 1 {
        " NULL"
    } else {
        " NOT NULL"
    });
    match &r[8] {
        Cell::Text(d) if engine != Engine::Warehouse => l.push_str(&format!(" DEFAULT {d}")),
        _ => {}
    }
    l
}

/// CREATE TABLE con su clave primaria y foráneas, y después los demás índices.
fn build_table_ddl(engine: Engine, table: &str, t: &TableParts) -> String {
    if engine != Engine::SqlServer {
        return warehouse_table_ddl(engine, table, t);
    }
    let mut lines: Vec<String> = t.columns.iter().map(|r| column_ddl(r, engine)).collect();
    let indexes: Vec<&IndexDef> = t.indexes.iter().filter(|i| i.type_code > 0).collect();
    for i in indexes.iter().filter(|i| i.primary) {
        let clustered = if i.type_desc.starts_with("CLUSTERED") {
            " CLUSTERED"
        } else {
            " NONCLUSTERED"
        };
        lines.push(format!(
            "    CONSTRAINT {} PRIMARY KEY{} ({})",
            qi(&i.name),
            clustered,
            i.columns
        ));
    }
    for fk in &t.foreign_keys {
        let mut l = format!(
            "    CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
            qi(&fk.name),
            fk.columns,
            fk.target,
            fk.target_columns
        );
        for (a, verb) in [(&fk.on_delete, "DELETE"), (&fk.on_update, "UPDATE")] {
            if a != "NO_ACTION" {
                l.push_str(&format!(" ON {verb} {}", a.replace('_', " ")));
            }
        }
        lines.push(l);
    }
    for (name, definition) in &t.checks {
        lines.push(format!("    CONSTRAINT {} CHECK {definition}", qi(name)));
    }
    let mut out = format!("CREATE TABLE {} (\n{}\n);\n", table, lines.join(",\n"));
    for i in indexes.iter().filter(|i| !i.primary) {
        let name = qi(&i.name);
        let statement = match i.type_code {
            3 if i.suffix.is_empty() => format!("CREATE PRIMARY XML INDEX {name} ON {table} ({})", i.columns),
            3 | 4 => format!("CREATE {}INDEX {name} ON {table} ({}){}", if i.type_code == 3 { "XML " } else { "SPATIAL " }, i.columns, i.suffix),
            5 => format!("CREATE CLUSTERED COLUMNSTORE INDEX {name} ON {table}"),
            6 => format!("CREATE NONCLUSTERED COLUMNSTORE INDEX {name} ON {table} ({})", i.included),
            _ => {
                let unique = if i.unique { "UNIQUE " } else { "" };
                let kind = if i.type_desc.starts_with("CLUSTERED") { "CLUSTERED " } else { "NONCLUSTERED " };
                let mut s = format!("CREATE {unique}{kind}INDEX {name} ON {table} ({})", i.columns);
                if !i.included.is_empty() {
                    s.push_str(&format!(" INCLUDE ({})", i.included));
                }
                s
            }
        };
        let filter = if i.filter.is_empty() { String::new() } else { format!(" WHERE {}", i.filter) };
        out.push_str(&format!("\n{statement}{filter};"));
    }
    out
}

/// CREATE TABLE para Synapse dedicated / PDW, con la distribución y el almacenamiento (que allí deciden el
/// rendimiento), o para Fabric Warehouse. Las claves primarias y únicas solo existen NOT ENFORCED y se añaden con
/// ALTER TABLE, que admite varias columnas; las foráneas no existen en Synapse, y en Fabric también son NOT ENFORCED.
fn warehouse_table_ddl(engine: Engine, table: &str, t: &TableParts) -> String {
    let synapse = engine == Engine::Synapse;
    let lines: Vec<String> = t.columns.iter().map(|r| column_ddl(r, engine)).collect();
    let mut out = format!("CREATE TABLE {} (\n{}\n)", table, lines.join(",\n"));
    if synapse {
        let mut options = Vec::new();
        match t.distribution.as_str() {
            "HASH" if !t.distribution_columns.is_empty() => {
                options.push(format!("DISTRIBUTION = HASH({})", t.distribution_columns))
            }
            "ROUND_ROBIN" | "REPLICATE" => options.push(format!("DISTRIBUTION = {}", t.distribution)),
            _ => {}
        }
        // El montón (0), el índice agrupado (1) o el columnar agrupado (5): la tabla tiene uno y solo uno.
        match t.indexes.iter().find(|i| matches!(i.type_code, 0 | 1 | 5)) {
            Some(i) if i.type_code == 0 => options.push("HEAP".into()),
            Some(i) if i.type_code == 1 => options.push(format!("CLUSTERED INDEX ({})", i.columns)),
            Some(_) if !t.order.is_empty() => {
                options.push(format!("CLUSTERED COLUMNSTORE INDEX ORDER ({})", t.order))
            }
            Some(_) => options.push("CLUSTERED COLUMNSTORE INDEX".into()),
            None => {}
        }
        if !options.is_empty() {
            out.push_str(&format!("\nWITH (\n    {}\n)", options.join(",\n    ")));
        }
    }
    out.push_str(";\n");
    let indexes: Vec<&IndexDef> = t.indexes.iter().filter(|i| i.type_code > 0).collect();
    for i in indexes.iter().filter(|i| i.primary) {
        out.push_str(&format!(
            "\nALTER TABLE {table} ADD CONSTRAINT {} PRIMARY KEY NONCLUSTERED ({}) NOT ENFORCED;",
            qi(&i.name),
            i.columns
        ));
    }
    for i in indexes.iter().filter(|i| i.unique_constraint && !i.primary) {
        out.push_str(&format!(
            "\nALTER TABLE {table} ADD CONSTRAINT {} UNIQUE ({}) NOT ENFORCED;",
            qi(&i.name),
            i.columns
        ));
    }
    if synapse {
        // Los demás índices no agrupados (Synapse no tiene índices únicos ni columnares no agrupados).
        for i in indexes.iter().filter(|i| i.type_code == 2 && !i.primary && !i.unique_constraint) {
            out.push_str(&format!("\nCREATE INDEX {} ON {table} ({});", qi(&i.name), i.columns));
        }
    } else {
        for fk in &t.foreign_keys {
            out.push_str(&format!(
                "\nALTER TABLE {table} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) NOT ENFORCED;",
                qi(&fk.name),
                fk.columns,
                fk.target,
                fk.target_columns
            ));
        }
    }
    out
}

async fn connect_client(cfg: &ConnConfig, database: Option<String>) -> Result<Cli> {
    let mut config = Config::new();
    let host = if cfg.host.trim().is_empty() {
        "localhost"
    } else {
        cfg.host.trim()
    };
    // Se admite la notación "servidor\instancia" en el campo del host.
    let (host, inst_from_host) = match host.split_once('\\') {
        Some((h, i)) => (h.to_string(), i.to_string()),
        None => (host.to_string(), String::new()),
    };
    config.host(&host);
    if let Some(p) = cfg.port {
        config.port(p);
    }
    let instance = if cfg.instance.trim().is_empty() {
        inst_from_host
    } else {
        cfg.instance.trim().to_string()
    };
    if !instance.is_empty() {
        config.instance_name(&instance);
    }
    let db = database.unwrap_or_else(|| cfg.database.clone());
    if !db.is_empty() {
        config.database(&db);
    }
    config.application_name("Celer");
    config.packet_size(PACKET_SIZE);
    // tiberius corta por defecto una respuesta que tarde más de 30 s (una consulta larga de Synapse, por ejemplo):
    // aquí la consulta dura lo que tenga que durar y se para con Cancelar.
    config.command_timeout(None);
    if cfg.integrated_auth {
        #[cfg(windows)]
        config.authentication(AuthMethod::Integrated);
        #[cfg(not(windows))]
        bail!("La autenticación integrada solo está disponible en Windows");
    } else {
        config.authentication(AuthMethod::sql_server(
            &cfg.user,
            cfg.password.clone().unwrap_or_default(),
        ));
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
            // Keepalive de TCP: el sistema comprueba la conexión parada y la mantiene viva en cortafuegos y NAT.
            let _ = socket2::SockRef::from(&tcp).set_tcp_keepalive(&crate::session::tcp_keepalive());
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
    let mut client = match tokio::time::timeout(Duration::from_secs(20), fut).await {
        Ok(r) => r?,
        Err(_) => bail!("Tiempo de espera agotado al conectar con {host}"),
    };
    for sql in crate::startup::statements(cfg) {
        let run = async { client.simple_query(sql.as_str()).await?.into_results().await };
        run.await.map_err(|e| crate::startup::failed(&sql, friendly_error(&e)))?;
    }
    Ok(client)
}

fn friendly_error(e: &tiberius::error::Error) -> String {
    match e {
        // El analizador de Synapse dedicated / PDW rechaza lo que no existe allí (FOR XML, SHOWPLAN_XML, OFFSET…).
        tiberius::error::Error::Server(t) if t.code() == 103010 => format!(
            "Azure Synapse no admite esta sintaxis (Msg 103010, línea {}): {}",
            t.line(),
            t.message()
        ),
        tiberius::error::Error::Server(t) => format!(
            "Msg {}, nivel {}, línea {}: {}",
            t.code(),
            t.class(),
            t.line(),
            t.message()
        ),
        other => other.to_string(),
    }
}

/// Indica si el error deja la conexión inservible.
fn is_fatal(e: &tiberius::error::Error) -> bool {
    !matches!(e, tiberius::error::Error::Server(_))
}

/// Cómo acabó el lote para la conexión: utilizable (con el corte del resultado, si se dejó a medias) o perdida.
enum Outcome {
    Ok(Option<Cut>),
    Broken(Option<Cut>),
}

async fn run_query(
    mut client: Cli,
    sql: String,
    dml: bool,
    tx: mpsc::Sender<Item>,
    token: CancellationToken,
    abandon: CancellationToken,
    drained: Arc<AtomicU64>,
) -> Finished {
    let outcome = {
        let work = stream_query(&mut client, sql, dml, &tx, &abandon, &drained);
        tokio::select! {
            o = work => o,
            _ = token.cancelled() => {
                let _ = tx.try_send(Item::Error("Consulta cancelada por el usuario (la conexión se ha reiniciado)".into()));
                Outcome::Broken(None)
            }
        }
    };
    match outcome {
        Outcome::Ok(cut) => Finished { client: Some(client), cut },
        Outcome::Broken(cut) => Finished { client: None, cut },
    }
}

async fn stream_query(
    client: &mut Cli,
    sql: String,
    dml: bool,
    tx: &mpsc::Sender<Item>,
    abandon: &CancellationToken,
    drained: &AtomicU64,
) -> Outcome {
    if dml {
        return match client.execute(sql, &[]).await {
            Ok(r) => {
                let _ = tx.send(Item::Count(r.total() as i64)).await;
                Outcome::Ok(None)
            }
            Err(e) => {
                let fatal = is_fatal(&e);
                let _ = tx.send(Item::Error(friendly_error(&e))).await;
                if fatal {
                    Outcome::Broken(None)
                } else {
                    Outcome::Ok(None)
                }
            }
        };
    }
    let mut stream = match client.simple_query(sql).await {
        Ok(s) => s,
        Err(e) => {
            let fatal = is_fatal(&e);
            let _ = tx.send(Item::Error(friendly_error(&e))).await;
            return if fatal { Outcome::Broken(None) } else { Outcome::Ok(None) };
        }
    };
    loop {
        // Si se pide dejar el resultado mientras se espera al servidor, la lectura en curso no se pierde: el flujo
        // la guarda y la siguiente llamada la continúa.
        let next = tokio::select! {
            biased;
            _ = abandon.cancelled() => break,
            r = stream.try_next() => r,
        };
        let sent = match next {
            Ok(Some(QueryItem::Metadata(m))) => {
                let cols = m.columns().iter().map(column_info).collect();
                tx.send(Item::Meta(cols)).await.is_ok()
            }
            Ok(Some(QueryItem::Row(r))) => tx.send(Item::Row(row_to_cells(r))).await.is_ok(),
            Ok(None) => return Outcome::Ok(None),
            Err(e) => {
                let fatal = is_fatal(&e);
                let sent = tx.send(Item::Error(friendly_error(&e))).await.is_ok();
                if fatal {
                    return Outcome::Broken(None);
                }
                sent
            }
        };
        // La interfaz ha cerrado el cursor.
        if !sent {
            break;
        }
    }
    if !abandon.is_cancelled() {
        // El cursor se cerró y la sesión tiene algo propio (transacción, #temporales, SET): se lee el resto para
        // conservar la conexión. Solo Detener (el token de la consulta, en `run_query`) lo corta.
        let mut cut = Cut::default();
        loop {
            match stream.try_next().await {
                Ok(Some(QueryItem::Row(_))) => {
                    cut.rows += 1;
                    drained.fetch_add(1, Ordering::Relaxed);
                }
                Ok(Some(_)) => {}
                Ok(None) => return Outcome::Ok(Some(cut)),
                Err(e) if !is_fatal(&e) => {}
                Err(_) => return Outcome::Broken(Some(cut)),
            }
        }
    }
    // Se deja la conexión: se corta con ATTENTION (el servidor deja de trabajar) y se anota cómo fue; la sesión ya
    // sigue en su reserva y esta se cierra.
    drop(stream);
    let cut = match tokio::time::timeout(ATTENTION_CAP, client.cancel_query()).await {
        Ok(Ok(())) => Cut { rows: 0, error: None },
        Ok(Err(e)) => Cut { rows: 0, error: Some(e.to_string()) },
        Err(_) => Cut { rows: 0, error: Some(format!("sin acuse en {} s", ATTENTION_CAP.as_secs())) },
    };
    Outcome::Broken(Some(cut))
}

/// Con CELER_MSSQL_TRACE en el entorno, los tiempos de conexión y de cada lote por la salida de error.
fn trace(msg: &str) {
    if !msg.is_empty() && std::env::var_os("CELER_MSSQL_TRACE").is_some() {
        eprintln!("celer mssql: {msg}");
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
    ColumnInfo {
        name: c.name().to_string(),
        type_name: t.to_string(),
        kind: k,
    }
}

fn fmt_dt(v: Option<chrono::NaiveDateTime>, digits: u32) -> Cell {
    match v {
        Some(d) => {
            let (d, frac) = round_fraction(d, digits);
            Cell::Text(format!("{}{frac}", d.format("%Y-%m-%d %H:%M:%S")))
        }
        None => Cell::Null,
    }
}

/// The value rounded to `digits` decimal places of a second (3 for datetime, 7 for datetime2 and time: what
/// SQL Server reads back from a string) and that fraction as text (".123", trailing zeros dropped, "" if none).
fn round_fraction<T>(value: T, digits: u32) -> (T, String)
where
    T: chrono::Timelike + std::ops::Add<chrono::Duration, Output = T> + Copy,
{
    let unit = 10u32.pow(9 - digits);
    let nanos = value.nanosecond() % 1_000_000_000;
    let rounded = (nanos + unit / 2) / unit * unit;
    let value = value + chrono::Duration::nanoseconds(rounded as i64 - nanos as i64);
    let n = value.nanosecond() % 1_000_000_000;
    if n == 0 {
        return (value, String::new());
    }
    let text = format!("{:09}", n);
    (value, format!(".{}", text[..digits as usize].trim_end_matches('0')))
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
        ColumnData::Guid(v) => v
            .map(|g| Cell::Text(g.to_string().to_uppercase()))
            .unwrap_or(Cell::Null),
        ColumnData::Binary(v) => v
            .map(|b| Cell::hex(&b, BINARY_PREVIEW))
            .unwrap_or(Cell::Null),
        ColumnData::Numeric(v) => v.map(|n| Cell::Text(n.to_string())).unwrap_or(Cell::Null),
        ColumnData::Xml(v) => v
            .map(|x| Cell::Text(x.into_owned().into_string()))
            .unwrap_or(Cell::Null),
        ColumnData::Date(_) => match chrono::NaiveDate::from_sql(&cd) {
            Ok(Some(d)) => Cell::Text(d.format("%Y-%m-%d").to_string()),
            _ => Cell::Null,
        },
        ColumnData::Time(_) => match chrono::NaiveTime::from_sql(&cd) {
            Ok(Some(t)) => {
                let (t, frac) = round_fraction(t, 7);
                Cell::Text(format!("{}{frac}", t.format("%H:%M:%S")))
            }
            _ => Cell::Null,
        },
        ColumnData::DateTimeOffset(_) => {
            match chrono::DateTime::<chrono::FixedOffset>::from_sql(&cd) {
                Ok(Some(d)) => {
                    let (d, frac) = round_fraction(d, 7);
                    Cell::Text(format!("{}{frac} {}", d.format("%Y-%m-%d %H:%M:%S"), d.format("%:z")))
                }
                _ => Cell::Null,
            }
        }
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) => fmt_dt(chrono::NaiveDateTime::from_sql(&cd).ok().flatten(), 3),
        ColumnData::DateTime2(_) => fmt_dt(chrono::NaiveDateTime::from_sql(&cd).ok().flatten(), 7),
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
            if max_len == -1 {
                format!("{name}(max)")
            } else {
                format!("{name}({max_len})")
            }
        }
        "nvarchar" | "nchar" => {
            if max_len == -1 {
                format!("{name}(max)")
            } else {
                format!("{name}({})", max_len / 2)
            }
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
        "tinyint" | "smallint" | "int" | "integer" | "bigint" | "int8" | "serial" | "serial8"
        | "bigserial" | "decimal" | "numeric" | "money" | "smallmoney" | "float" | "real"
        | "smallfloat" | "double" | "double precision" => ColKind::Number,
        "date" | "datetime" | "datetime2" | "smalldatetime" | "time" | "datetimeoffset"
        | "timestamp" | "interval" => ColKind::Date,
        "binary" | "varbinary" | "image" | "byte" | "blob" | "rowversion" | "timestamp_" => {
            ColKind::Binary
        }
        "char" | "varchar" | "nchar" | "nvarchar" | "text" | "ntext" | "xml" | "lvarchar"
        | "clob" | "sysname" => ColKind::Text,
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

impl MssqlDriver {
    /// Envía un lote (sin GO) y lee sus resultados hasta que uno queda abierto o acaba.
    fn execute_batch(&mut self, sql: &str, fetch: usize) -> Result<ExecOutput> {
        let t0 = Instant::now();
        self.notes = std::mem::take(&mut *self.late.lock());
        let kw = first_keyword(sql);
        let effects = session_effects(sql);
        if let (Engine::Synapse, Some(db)) = (self.engine, &effects.use_only) {
            self.reconnect_to(db)?;
            let mut out = ExecOutput::default();
            out.messages.push(format!(
                "Base de datos: {} (Azure Synapse no admite USE: Celer abre la conexión en esa base)",
                self.database
            ));
            out.messages.extend(self.timing_line(0));
            out.in_transaction = self.in_tx;
            out.elapsed_ms = t0.elapsed().as_millis() as u64;
            return Ok(out);
        }
        let upper = sql.trim_end().trim_end_matches(';').to_ascii_uppercase();
        // With SHOWPLAN_XML on, a DML statement answers with its plan as a result set, not a row count.
        let dml = matches!(kw.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE")
            && !self.showplan
            && !upper.contains("OUTPUT")
            && !upper.contains(';')
            && !upper.contains("\nGO")
            && single_statement(sql);
        self.start(sql.to_string(), dml)?;
        let sent = Instant::now();
        self.session_state |= effects.session || effects.temp;
        self.tx_maybe |= effects.tran;
        if kw == "SET" {
            let words: Vec<&str> = upper.split_whitespace().collect();
            if words.get(1) == Some(&"SHOWPLAN_XML") {
                self.showplan = words.get(2) == Some(&"ON");
            }
        }
        // Hasta la primera respuesta del servidor (filas, recuento o error), para los tiempos.
        if let Some(first) = self.next_item() {
            self.peek_back(first);
        }
        let first_ms = sent.elapsed().as_millis();
        let mut out = ExecOutput::default();
        out.results = self.pump(fetch.max(1), &mut out.messages);
        if out.results.is_empty() && !out.messages.is_empty() && self.cursor.is_none() {
            let msg = out.messages.join("\n");
            self.refresh_tx_state();
            bail!(msg);
        }
        if effects.uses && self.cursor.is_none() {
            if let Some(db) = self.query_rows("SELECT DB_NAME()").ok().and_then(|r| r.first().map(|r| cell_str(&r[0]))) {
                self.database = db;
            }
        }
        self.refresh_tx_state();
        out.in_transaction = self.in_tx;
        // Un resultado que queda abierto sin estado de sesión: su reserva se abre ya, por si se deja a medias.
        if self.cursor.is_some() && !self.keeps_session() {
            self.ensure_reserve();
        }
        // Sin estado de sesión, dejar el resultado corta el lote con ATTENTION: lo que viniera detrás no se ejecuta.
        self.open_multi = self.cursor.is_some() && !self.keeps_session() && !single_statement(sql);
        if self.open_multi {
            out.messages.push("Lo que quede del lote tras este resultado se ejecuta al leerlo hasta el final; si ejecutas otra cosa antes, se cancela.".into());
        }
        out.messages.extend(self.timing_line(first_ms));
        out.elapsed_ms = t0.elapsed().as_millis() as u64;
        Ok(out)
    }

    /// Envía los lotes pendientes del script (GO) en orden, añadiendo sus resultados, hasta que uno deja un
    /// resultado abierto o no quedan. Un error para el script: los lotes de después no se envían.
    fn run_batches(&mut self, fetch: usize, results: &mut Vec<ResultSet>, messages: &mut Vec<String>) -> Result<()> {
        while self.cursor.is_none() {
            let Some(batch) = self.batches.pop_front() else { break };
            let n = self.batch_total - self.batches.len();
            match self.execute_batch(&batch, fetch) {
                Ok(o) => {
                    results.extend(o.results);
                    messages.extend(o.messages);
                }
                Err(e) => {
                    self.batches.clear();
                    bail!("Lote {n} de {}: {e}", self.batch_total);
                }
            }
        }
        Ok(())
    }

    fn fetch_rows(&mut self, n: usize) -> Result<FetchOutput> {
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
}

impl Driver for MssqlDriver {
    /// Un script con líneas GO se envía lote a lote, como en SSMS; sin GO, el texto es un solo lote.
    fn execute(&mut self, sql: &str, fetch: usize) -> Result<ExecOutput> {
        let t0 = Instant::now();
        self.close_cursor()?;
        let mut notes = Vec::new();
        if std::mem::take(&mut self.cut) {
            notes.push("Lo que quedaba del lote anterior no se ejecutó: su resultado se cerró antes de leerlo hasta el final.".into());
        }
        notes.extend(batches_note("No se ejecutó", "No se ejecutaron", std::mem::take(&mut self.discarded), "del script anterior: su resultado se cerró antes de leerlo hasta el final."));
        self.batches = split_go(sql).into();
        self.batch_total = self.batches.len();
        let mut out = if self.batch_total == 1 {
            let batch = self.batches.pop_front().unwrap_or_default();
            self.execute_batch(&batch, fetch)?
        } else {
            let mut out = ExecOutput::default();
            self.run_batches(fetch, &mut out.results, &mut out.messages)?;
            out.messages.extend(batches_note("Queda", "Quedan", self.batches.len(), "del script sin ejecutar: se envían al leer este resultado hasta el final; si ejecutas otra cosa antes, se descartan."));
            out.in_transaction = self.in_tx;
            out.elapsed_ms = t0.elapsed().as_millis() as u64;
            out
        };
        notes.append(&mut out.messages);
        out.messages = notes;
        Ok(out)
    }

    fn fetch(&mut self, n: usize) -> Result<FetchOutput> {
        let mut out = self.fetch_rows(n)?;
        // El resultado acabó: siguen los lotes que quedaban del script.
        if self.cursor.is_none() && !self.batches.is_empty() {
            let mut msgs = Vec::new();
            self.run_batches(n.max(1), &mut out.extra, &mut msgs)?;
        }
        Ok(out)
    }

    /// Cierra el resultado abierto. Si el lector ya lo había leído entero, la conexión sigue. Si no:
    /// - con transacción, modo manual, tablas #temporales o SET del usuario, se lee el resto en la misma conexión
    ///   (con progreso; Detener lo corta y la sesión se pierde);
    /// - si no, la sesión sigue al momento en su reserva y la vieja se corta y se cierra en segundo plano.
    fn close_cursor(&mut self) -> Result<()> {
        let Some(mut cur) = self.cursor.take() else { return Ok(()) };
        let t0 = Instant::now();
        self.discarded += self.batches.len();
        self.batches.clear();
        let multi = std::mem::take(&mut self.open_multi);
        if let Ok(finished) = cur.done.try_recv() {
            *self.cancel.lock() = None;
            self.after_cut(Some(finished), t0);
            return Ok(());
        }
        drop(cur.rx);
        if self.keeps_session() {
            let why = match self.lost_state() {
                lost if lost.is_empty() => "el modo manual de transacciones".to_string(),
                lost => lost,
            };
            *self.drain.lock() = Some(Drain { why, rows: cur.drained.clone(), since: t0 });
            let finished = rt().block_on(&mut cur.done).ok();
            *self.drain.lock() = None;
            *self.cancel.lock() = None;
            self.after_cut(finished, t0);
            return Ok(());
        }
        cur.abandon.cancel();
        self.cut = multi;
        *self.cancel.lock() = None;
        let late = self.late.clone();
        let done = cur.done;
        rt().spawn(async move {
            let ms = t0.elapsed().as_millis();
            let note = match done.await {
                Ok(Finished { cut: Some(Cut { error: None, .. }), .. }) => {
                    format!("la conexión anterior se cortó con ATTENTION en {ms} ms y se ha cerrado")
                }
                Ok(Finished { cut: Some(Cut { error: Some(e), .. }), .. }) => {
                    format!("la conexión anterior no aceptó el ATTENTION ({e}, {ms} ms) y se ha cerrado")
                }
                _ => format!("la conexión anterior se ha cerrado ({ms} ms)"),
            };
            trace(&note);
            late.lock().push(note);
        });
        self.switch_to_reserve(t0)
    }

    fn set_autocommit(&mut self, on: bool) -> Result<bool> {
        if on == self.autocommit {
            return Ok(self.in_tx);
        }
        if on {
            self.query_rows("IF @@TRANCOUNT > 0 COMMIT; SET IMPLICIT_TRANSACTIONS OFF")?;
        } else if let Err(e) = self.query_rows("SET IMPLICIT_TRANSACTIONS ON") {
            if self.engine == Engine::Synapse {
                bail!("Azure Synapse no ha aceptado el modo manual de transacciones (SET IMPLICIT_TRANSACTIONS ON); la consola sigue en automático. {e}");
            }
            return Err(e);
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
        if let Some(db) = path.first() {
            self.synapse_enter(db)?;
        }
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
                        let detail = if cell_i64(&r[1]) == 1 {
                            Some("sistema".to_string())
                        } else {
                            None
                        };
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
            // Synapse y Fabric Warehouse no tienen sinónimos ni secuencias.
            .filter(|(_, key)| self.engine == Engine::SqlServer || !matches!(*key, "synonyms" | "sequences"))
            .map(|(label, key)| {
                MetaNode::branch(
                    *label,
                    "folder",
                    vec![db.to_string(), schema.to_string(), key.to_string()],
                )
            })
            .collect()),
            [db, schema, folder] => {
                let d = qi(db);
                let s = ql(schema);
                let (sql, kind, branch) = match *folder {
                    // Synapse dedicated: sys.partitions no tiene las filas, que están repartidas por las distribuciones de
                    // los nodos (la consulta de tamaños de tabla de la documentación de Microsoft, sin el espacio).
                    "tables" if self.engine == Engine::Synapse => (
                        format!(
                            "SELECT t.name, SUM(nps.row_count) FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id \
                             LEFT JOIN sys.pdw_table_mappings tm ON tm.object_id = t.object_id \
                             LEFT JOIN sys.pdw_nodes_tables nt ON nt.name = tm.physical_name \
                             LEFT JOIN sys.dm_pdw_nodes_db_partition_stats nps ON nps.object_id = nt.object_id \
                               AND nps.pdw_node_id = nt.pdw_node_id AND nps.distribution_id = nt.distribution_id AND nps.index_id <= 1 \
                             WHERE s.name = {s} GROUP BY t.name ORDER BY t.name"
                        ),
                        "table",
                        true,
                    ),
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
                let rows = match self.query_rows(&sql) {
                    // Sin permiso para las vistas de los nodos (VIEW DATABASE STATE), las tablas sin recuento.
                    Err(_) if self.engine == Engine::Synapse && *folder == "tables" => self.query_rows(&format!(
                        "SELECT t.name, NULL FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = {s} ORDER BY t.name"
                    ))?,
                    r => r?,
                };
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
                let o = ObjectRef::new(db, schema, name, kind);
                let cols = self.column_rows(&o)?;
                let mut nodes: Vec<MetaNode> = cols
                    .iter()
                    .map(|r| {
                        let ty = mssql_type(
                            &cell_str(&r[1]),
                            cell_i64(&r[2]),
                            cell_i64(&r[3]),
                            cell_i64(&r[4]),
                        );
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
                        let k = if cell_i64(&r[7]) == 1 {
                            "pkcolumn"
                        } else {
                            "column"
                        };
                        MetaNode::leaf(cell_str(&r[0]), k, Some(detail))
                    })
                    .collect();
                if kind == "table" {
                    let base = vec![
                        db.to_string(),
                        schema.to_string(),
                        folder.to_string(),
                        name.to_string(),
                    ];
                    for (label, key) in [
                        ("Índices", "indexes"),
                        ("Claves foráneas", "fks"),
                        ("Triggers", "triggers"),
                    ] {
                        if !self.has_table_folder(key) {
                            continue;
                        }
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
                if !self.has_table_folder(sub) {
                    return Ok(vec![]);
                }
                match *sub {
                    "indexes" => {
                        let rows = self.query_rows(&format!(
                            "SELECT i.name, i.type_desc, i.is_unique, i.is_primary_key, i.index_id \
                             FROM {d}.sys.indexes i WHERE i.object_id = {oid} AND i.type > 0 ORDER BY i.is_primary_key DESC, i.name"
                        ))?;
                        let mut cols = self.index_columns(&o, false)?;
                        let mut nodes: Vec<MetaNode> = rows
                            .iter()
                            .map(|r| {
                                let mut det = format!("({})", cols.remove(&cell_i64(&r[4])).unwrap_or_default());
                                if cell_i64(&r[3]) == 1 {
                                    det.push_str(" · PK");
                                } else if cell_i64(&r[2]) == 1 {
                                    det.push_str(" · único");
                                }
                                det.push_str(&format!(" · {}", cell_str(&r[1]).to_lowercase()));
                                MetaNode::leaf(cell_str(&r[0]), "index", Some(det))
                            })
                            .collect();
                        // Synapse: las claves NOT ENFORCED que sys.indexes no tenga.
                        if self.engine == Engine::Synapse {
                            for key in self.synapse_keys(&o, false).unwrap_or_default() {
                                if !nodes.iter().any(|n| n.name == key.name) {
                                    let what = if key.primary { "PK" } else { "único" };
                                    nodes.push(MetaNode::leaf(key.name, "index", Some(format!("({}) · {what} · not enforced", key.columns))));
                                }
                            }
                        }
                        Ok(nodes)
                    }
                    "fks" => {
                        let rows = self.query_rows(&format!(
                            "SELECT fk.name, \
                               OBJECT_SCHEMA_NAME(fk.referenced_object_id, DB_ID({q})), \
                               OBJECT_NAME(fk.referenced_object_id, DB_ID({q})), \
                               fk.object_id \
                             FROM {d}.sys.foreign_keys fk WHERE fk.parent_object_id = {oid} ORDER BY fk.name",
                            q = ql(db),
                        ))?;
                        let (mut own, mut referenced) = if rows.is_empty() { Default::default() } else { self.fk_columns(&o, false)? };
                        // Same "cols → schema.table(cols)" shape on every engine; `obj` is the referenced table.
                        Ok(rows
                            .iter()
                            .map(|r| {
                                let (ref_schema, ref_table) = (cell_str(&r[1]), cell_str(&r[2]));
                                let id = cell_i64(&r[3]);
                                let (cols, ref_cols) = (own.remove(&id).unwrap_or_default(), referenced.remove(&id).unwrap_or_default());
                                MetaNode::leaf(
                                    cell_str(&r[0]),
                                    "key",
                                    Some(format!("{cols} → {ref_schema}.{ref_table}({ref_cols})")),
                                )
                                .with_obj(ObjectRef::new(db, &ref_schema, &ref_table, "table"))
                            })
                            .collect())
                    }
                    "triggers" => {
                        let rows = self.query_rows(&format!("SELECT name FROM {d}.sys.triggers WHERE parent_id = {oid} ORDER BY name"))?;
                        Ok(rows
                            .iter()
                            .map(|r| {
                                let n = cell_str(&r[0]);
                                MetaNode::leaf(n.clone(), "trigger", None)
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
        self.synapse_enter(&obj.database)?;
        let rows = self.column_rows(obj)?;
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
        self.synapse_enter(&obj.database)?;
        match obj.kind.as_str() {
            "table" => self.table_ddl(obj),
            "synonym" => {
                let rows = self.query_rows(&format!(
                    "SELECT base_object_name FROM {}.sys.synonyms WHERE object_id = {}",
                    qi(&obj.database),
                    self.obj_id(obj)
                ))?;
                let base = rows.first().map(|r| cell_str(&r[0])).unwrap_or_default();
                Ok(format!(
                    "CREATE SYNONYM {} FOR {};",
                    self.qualified_name(obj),
                    base
                ))
            }
            "sequence" => {
                let rows = self.query_rows(&format!(
                    "SELECT TYPE_NAME(system_type_id), CAST(start_value AS nvarchar(50)), CAST(increment AS nvarchar(50)), \
                     CAST(minimum_value AS nvarchar(50)), CAST(maximum_value AS nvarchar(50)), is_cycling, CAST(current_value AS nvarchar(50)) \
                     FROM {}.sys.sequences WHERE object_id = {}",
                    qi(&obj.database),
                    self.obj_id(obj)
                ))?;
                let r = rows
                    .first()
                    .ok_or_else(|| anyhow!("Secuencia no encontrada"))?;
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
        self.synapse_enter(database)?;
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
        let rows = self.query_rows(
            "SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name",
        )?;
        Ok(rows.iter().map(|r| cell_str(&r[0])).collect())
    }

    /// La base se sigue al conectar, con USE y al cambiar de base: no hace falta preguntarla.
    fn current_database(&mut self) -> Result<String> {
        if !self.database.is_empty() {
            return Ok(self.database.clone());
        }
        let rows = self.query_rows("SELECT DB_NAME()")?;
        Ok(rows.first().map(|r| cell_str(&r[0])).unwrap_or_default())
    }

    fn use_database(&mut self, db: &str) -> Result<()> {
        if self.engine == Engine::Synapse {
            return self.reconnect_to(db);
        }
        // USE no devuelve filas: el primer resultado es el de DB_NAME(), en la misma ida y vuelta.
        let rows = self.query_rows(&format!("USE {}; SELECT DB_NAME()", qi(db)))?;
        self.database = rows.first().map(|r| cell_str(&r[0])).filter(|s| !s.is_empty()).unwrap_or_else(|| db.to_string());
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

    /// Leída al conectar (`open_connection`); si entonces no se pudo, se pregunta.
    fn server_info(&mut self) -> Result<String> {
        if !self.info.is_empty() {
            return Ok(self.info.clone());
        }
        let rows = self.query_rows(
            "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(50)), CAST(SERVERPROPERTY('Edition') AS nvarchar(100)), @@VERSION",
        )?;
        let r = rows.first().ok_or_else(|| anyhow!("sin datos"))?;
        let first = cell_str(&r[2])
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        let mut info = format!("{} — {} ({})", first, cell_str(&r[1]), cell_str(&r[0]));
        if let Some(label) = self.engine.label() {
            info.push_str(&format!(" · {label}"));
        }
        Ok(info)
    }

    /// Mientras se lee el resto de un resultado para conservar la sesión: cuántas filas van.
    fn progress(&self) -> Progress {
        let slot = self.drain.clone();
        Arc::new(move || {
            slot.lock().as_ref().map(|d| {
                format!(
                    "leyendo el resto del resultado anterior para conservar {}: {} en {:.1} s · Detener lo corta y pierde la sesión",
                    d.why,
                    fmt_rows(d.rows.load(Ordering::Relaxed) as i64),
                    d.since.elapsed().as_secs_f64()
                )
            })
        })
    }

    fn canceller(&self) -> Canceller {
        let slot = self.cancel.clone();
        Arc::new(move || {
            if let Some(t) = slot.lock().as_ref() {
                t.cancel();
            }
        })
    }

    /// Un SELECT 1 con 5 s de límite. Con un resultado abierto no se mira (la conexión la tiene su lector) y sin
    /// conexión no hay nada que mirar. Si no responde, la conexión se suelta.
    fn ping(&mut self) -> Result<()> {
        if self.cursor.is_some() {
            return Ok(());
        }
        let Some(mut client) = self.client.take() else { return Ok(()) };
        let ok = rt().block_on(async {
            let ping = async { client.simple_query("SELECT 1").await?.into_results().await };
            matches!(tokio::time::timeout(Duration::from_secs(5), ping).await, Ok(Ok(_)))
        });
        if !ok {
            bail!("SQL Server no responde en esta conexión");
        }
        self.client = Some(client);
        Ok(())
    }

    /// Sin conexión ni lector: se cortó (o se cortó a propósito al cancelar).
    fn broken(&self) -> bool {
        self.client.is_none() && self.cursor.is_none()
    }

    fn session_state(&self) -> String {
        self.lost_state()
    }
}

impl Drop for MssqlDriver {
    /// La sesión se cierra: un resultado a medias se corta y su conexión se cierra; si no, la conexión queda libre
    /// para otra sesión de la misma configuración, si no lleva estado propio. La reserva también queda libre.
    fn drop(&mut self) {
        if let Some(rx) = self.reserve.take() {
            let key = self.key.clone();
            rt().spawn(async move {
                if let Ok(Some(idle)) = rx.await {
                    put_idle(key, idle);
                }
            });
        }
        if let Some(cur) = self.cursor.take() {
            cur.abandon.cancel();
            return;
        }
        if self.keeps_session() {
            return;
        }
        if let Some(client) = self.client.take() {
            put_idle(self.key.clone(), Idle { client, facts: self.facts(), since: Instant::now(), owner: self.cfg.id.clone() });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{NaiveDate, NaiveTime};

    /// Una fila de `columns_query`: nombre, tipo, max_length, precision, scale, nullable, identity, pk, default.
    fn col(name: &str, ty: &str, len: i64, nullable: bool, identity: bool, default: Option<&str>) -> Vec<Cell> {
        vec![
            Cell::Text(name.into()),
            Cell::Text(ty.into()),
            Cell::Int(len),
            Cell::Int(0),
            Cell::Int(0),
            Cell::Bool(nullable),
            Cell::Bool(identity),
            Cell::Int(0),
            default.map(|d| Cell::Text(d.into())).unwrap_or(Cell::Null),
            Cell::Bool(false),
            Cell::Null,
        ]
    }

    fn index(name: &str, type_code: i64, type_desc: &str, primary: bool, unique: bool, columns: &str) -> IndexDef {
        IndexDef {
            name: name.into(),
            type_code,
            type_desc: type_desc.into(),
            primary,
            unique,
            unique_constraint: unique && !primary && type_code == 2,
            columns: columns.into(),
            ..Default::default()
        }
    }

    #[test]
    fn batch_effects_on_the_session() {
        let e = |sql: &str| session_effects(sql);
        // Assignments are not session options.
        assert_eq!(e("UPDATE t SET a = 1, [b] = 2 WHERE id = 3"), Effects::default());
        assert_eq!(e("UPDATE t SET t.a = 1; SET @x = 2; SET @y += 1; UPDATE t SET c += 1"), Effects::default());
        assert_eq!(e("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET t.a = s.a;"), Effects::default());
        assert!(e("SET NOCOUNT ON; SELECT 1").session);
        assert!(e("set lock_timeout -1").session);
        assert!(e("SET TRANSACTION ISOLATION LEVEL SNAPSHOT").session);
        assert!(e("EXEC sys.sp_set_session_context @key = N'k', @value = 1").session);
        // A user of its own, open keys and global cursors last as long as the connection.
        assert!(e("EXECUTE AS USER = 'reader'").session && e("exec as login = 'otro'; SELECT 1").session);
        assert!(e("SETUSER 'reader'").session);
        assert!(e("OPEN SYMMETRIC KEY k DECRYPTION BY CERTIFICATE c").session && e("OPEN MASTER KEY DECRYPTION BY PASSWORD = 'x'").session);
        assert!(e("DECLARE c CURSOR FOR SELECT 1").session && e("DECLARE c INSENSITIVE SCROLL CURSOR FOR SELECT 1").session);
        assert!(e("DECLARE c CURSOR GLOBAL FAST_FORWARD FOR SELECT 1").session);
        assert_eq!(e("DECLARE c CURSOR LOCAL FOR SELECT 1"), Effects::default());
        assert_eq!(e("DECLARE @c CURSOR; DECLARE @n int = 1"), Effects::default());
        assert_eq!(e("CREATE PROCEDURE p WITH EXECUTE AS OWNER AS SELECT 1"), Effects::default());
        assert_eq!(e("CREATE PROCEDURE p WITH RECOMPILE, EXECUTE AS CALLER AS SELECT 1"), Effects::default());
        assert_eq!(e("EXEC dbo.p @as = 1; OPEN c"), Effects::default());
        // Strings and comments do not count.
        assert_eq!(e("SELECT 'SET NOCOUNT ON', N'CREATE TABLE #x' -- SET ANSI_NULLS OFF\n/* BEGIN TRAN /* USE x */ */"), Effects::default());
        assert!(e("CREATE TABLE #tmp (id int)").temp);
        assert!(e("SELECT * INTO ##global FROM t").temp);
        assert!(!e("SELECT * INTO dbo.t2 FROM t").temp);
        assert!(e("begin tran; insert into t values (1)").tran);
        assert!(e("BEGIN TRANSACTION").tran && !e("BEGIN TRY SELECT 1 END TRY BEGIN CATCH END CATCH").tran);
        assert!(e("SELECT 1; USE master").uses);
        assert!(!e("SELECT * FROM t OPTION (USE HINT ('DISABLE_OPTIMIZED_NESTED_LOOP'))").uses);
        assert_eq!(e("USE [mi]]base];").use_only.as_deref(), Some("mi]base"));
        assert_eq!(e("  use Ventas  ").use_only.as_deref(), Some("Ventas"));
        assert_eq!(e("USE ventas; SELECT 1").use_only, None);
    }

    #[test]
    fn scripts_split_on_go_lines() {
        let b = |sql: &str| split_go(sql).iter().map(|s| s.trim().to_string()).collect::<Vec<_>>();
        assert_eq!(b("CREATE TABLE dbo.a (id int)\nGO\nCREATE VIEW dbo.v AS SELECT id FROM dbo.a\nGO\n"), vec!["CREATE TABLE dbo.a (id int)", "CREATE VIEW dbo.v AS SELECT id FROM dbo.a"]);
        // Case, blanks, a trailing comment, CRLF, and GO n (the batch n times).
        assert_eq!(b("SELECT 1\r\n  go  -- fin\r\nINSERT t DEFAULT VALUES\r\nGO 3\r\nSELECT 2"), vec!["SELECT 1", "INSERT t DEFAULT VALUES", "INSERT t DEFAULT VALUES", "INSERT t DEFAULT VALUES", "SELECT 2"]);
        // Not a separator: inside a string, an identifier or a comment, or with more on the line.
        assert_eq!(b("SELECT 'a\nGO\nb'").len(), 1);
        assert_eq!(b("SELECT 1 AS [x\nGO\n]").len(), 1);
        assert_eq!(b("/* uno\nGO\n/* anidado */\nGO\n*/ SELECT 1").len(), 1);
        assert_eq!(b("SELECT 1 -- it's\nGO\nSELECT 2").len(), 2, "a quote in a line comment does not open a string");
        assert_eq!(b("SELECT 1\nGO TO x\nGOTO fin").len(), 1);
        // Without GO, or only GO: the text as it is.
        assert_eq!(split_go("SELECT 1; SELECT 2"), vec!["SELECT 1; SELECT 2"]);
        assert_eq!(split_go("GO\nGO\n").len(), 1);
    }

    #[test]
    fn dml_batches_of_one_statement() {
        assert!(single_statement("UPDATE dbo.t SET x = 1, y = 2 WHERE id IN (SELECT id FROM u)"));
        assert!(single_statement("INSERT INTO t (a) SELECT a FROM s UNION ALL SELECT a FROM r"));
        assert!(single_statement("INSERT t EXEC dbo.p"));
        assert!(single_statement("DELETE t FROM t JOIN u ON u.id = t.id -- SELECT * FROM t"));
        assert!(single_statement("MERGE t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET t.a = s.a WHEN NOT MATCHED THEN INSERT (a) VALUES (s.a) WHEN NOT MATCHED BY SOURCE THEN DELETE"));
        assert!(single_statement("UPDATE t SET note = 'SELECT 1'"));
        assert!(single_statement("WITH c AS (SELECT id FROM s) INSERT INTO t SELECT id FROM c"));
        assert!(single_statement("WITH c AS (SELECT id FROM s) UPDATE c SET x = 1"));
        assert!(single_statement("CREATE OR ALTER PROCEDURE p AS BEGIN SELECT 1; SELECT 2 END"));
        assert!(single_statement("DECLARE c CURSOR FOR SELECT a FROM t FOR UPDATE OF a"));
        assert!(!single_statement("SELECT * FROM big; DELETE FROM t WHERE id = 1"));
        // A second statement without ';' (the grid of the SELECT must not be lost).
        assert!(!single_statement("UPDATE dbo.t SET x = 1 WHERE id = 1\nSELECT * FROM dbo.t"));
        assert!(!single_statement("INSERT INTO t VALUES (1)\nINSERT INTO t VALUES (2)"));
        assert!(!single_statement("INSERT INTO t SELECT 1 SELECT 2"));
        assert!(!single_statement("DELETE FROM t\nEXEC dbo.p"));
        assert!(!single_statement("UPDATE t SET a = 1 SET NOCOUNT ON"));
    }

    #[test]
    fn pool_key_and_databases() {
        let mut a = ConnConfig { host: "srv".into(), user: "u".into(), password: Some("secreto".into()), database: "dw".into(), ..Default::default() };
        let key = pool_key(&a);
        assert_eq!(key.len(), 64);
        assert!(!key.contains("secreto"));
        // The database travels with each idle connection, not in the key; the password and the startup script do.
        a.database = "otra".into();
        assert_eq!(pool_key(&a), key);
        a.password = Some("otro".into());
        assert_ne!(pool_key(&a), key);
        let f = Facts { home: String::new(), database: "Ventas".into(), engine: Engine::SqlServer, info: String::new() };
        assert!(f.serves("") && f.serves("ventas") && !f.serves("compras"));
        let f = Facts { home: "dw".into(), database: "dw".into(), engine: Engine::Synapse, info: String::new() };
        assert!(f.serves("dw") && !f.serves(""));
    }

    #[test]
    fn column_lists_keep_the_order_of_each_group() {
        let rows = vec![(1, "[a]".to_string()), (1, "[b] DESC".to_string()), (2, "[c]".to_string()), (1, "[d]".to_string())];
        let lists = column_lists(rows);
        assert_eq!(lists[&1], "[a], [b] DESC, [d]");
        assert_eq!(lists[&2], "[c]");
        assert!(column_lists(Vec::new()).is_empty());
    }

    #[test]
    fn table_ddl_on_sql_server() {
        let parts = TableParts {
            columns: vec![
                col("id", "int", 4, false, true, None),
                col("nombre", "nvarchar", 200, false, false, None),
                col("activo", "bit", 1, true, false, Some("((1))")),
                col("parent_id", "int", 4, true, false, None),
            ],
            indexes: vec![
                index("PK_t", 1, "CLUSTERED", true, true, "[id]"),
                index("", 0, "HEAP", false, false, ""),
                index("IX_t_nombre", 2, "NONCLUSTERED", false, true, "[nombre] DESC, [activo]"),
            ],
            foreign_keys: vec![ForeignKeyDef {
                name: "FK_t_p".into(),
                columns: "[parent_id]".into(),
                target: "[dbo].[p]".into(),
                target_columns: "[id]".into(),
                on_delete: "CASCADE".into(),
                on_update: "NO_ACTION".into(),
            }],
            ..Default::default()
        };
        assert_eq!(
            build_table_ddl(Engine::SqlServer, "[db].[dbo].[t]", &parts),
            "CREATE TABLE [db].[dbo].[t] (\n    [id] int IDENTITY(1,1) NOT NULL,\n    [nombre] nvarchar(100) NOT NULL,\n    [activo] bit NULL DEFAULT ((1)),\n    [parent_id] int NULL,\n    CONSTRAINT [PK_t] PRIMARY KEY CLUSTERED ([id]),\n    CONSTRAINT [FK_t_p] FOREIGN KEY ([parent_id]) REFERENCES [dbo].[p] ([id]) ON DELETE CASCADE\n);\n\nCREATE UNIQUE NONCLUSTERED INDEX [IX_t_nombre] ON [db].[dbo].[t] ([nombre] DESC, [activo]);"
        );
    }

    #[test]
    fn table_ddl_keeps_identity_checks_and_index_kinds() {
        let mut id = col("id", "int", 4, false, true, None);
        id.extend([Cell::Text("1000".into()), Cell::Text("5".into()), Cell::Bool(false)]);
        let mut total = col("total", "int", 4, true, false, None);
        total[9] = Cell::Bool(true);
        total[10] = Cell::Text("([q]*(2))".into());
        total.extend([Cell::Null, Cell::Null, Cell::Bool(true)]);
        let parts = TableParts {
            columns: vec![id, col("q", "int", 4, true, false, None), col("s", "nvarchar", 20, true, false, None), total],
            indexes: vec![
                index("PK_f", 1, "CLUSTERED", true, true, "[id]"),
                IndexDef { included: "[s]".into(), filter: "([q]>(10))".into(), ..index("ix", 2, "NONCLUSTERED", false, false, "[q]") },
                IndexDef { included: "[q], [s]".into(), ..index("ncci", 6, "NONCLUSTERED COLUMNSTORE", false, false, "") },
                index("px", 3, "XML", false, false, "[doc]"),
                IndexDef { suffix: " USING XML INDEX [px] FOR PATH".into(), ..index("sx", 3, "XML", false, false, "[doc]") },
                IndexDef { suffix: " USING GEOMETRY_GRID WITH (BOUNDING_BOX = (0, 0, 100, 100))".into(), ..index("gx", 4, "SPATIAL", false, false, "[g]") },
            ],
            checks: vec![("CK_f_q".into(), "([q]>(0))".into())],
            ..Default::default()
        };
        let ddl = build_table_ddl(Engine::SqlServer, "[dbo].[f]", &parts);
        assert!(ddl.contains("    [id] int IDENTITY(1000,5) NOT NULL,"), "{ddl}");
        assert!(ddl.contains("    [total] AS ([q]*(2)) PERSISTED,"), "{ddl}");
        assert!(ddl.contains("    CONSTRAINT [CK_f_q] CHECK ([q]>(0))\n);"), "{ddl}");
        assert!(ddl.contains("\nCREATE NONCLUSTERED INDEX [ix] ON [dbo].[f] ([q]) INCLUDE ([s]) WHERE ([q]>(10));"), "{ddl}");
        assert!(ddl.contains("\nCREATE NONCLUSTERED COLUMNSTORE INDEX [ncci] ON [dbo].[f] ([q], [s]);"), "{ddl}");
        assert!(ddl.contains("\nCREATE PRIMARY XML INDEX [px] ON [dbo].[f] ([doc]);"), "{ddl}");
        assert!(ddl.contains("\nCREATE XML INDEX [sx] ON [dbo].[f] ([doc]) USING XML INDEX [px] FOR PATH;"), "{ddl}");
        assert!(ddl.contains("\nCREATE SPATIAL INDEX [gx] ON [dbo].[f] ([g]) USING GEOMETRY_GRID WITH (BOUNDING_BOX = (0, 0, 100, 100));"), "{ddl}");
        let cci = TableParts { columns: vec![col("a", "int", 4, true, false, None)], indexes: vec![index("cci", 5, "CLUSTERED COLUMNSTORE", false, false, "")], ..Default::default() };
        assert!(build_table_ddl(Engine::SqlServer, "[dbo].[c]", &cci).ends_with("\nCREATE CLUSTERED COLUMNSTORE INDEX [cci] ON [dbo].[c];"));
    }

    #[test]
    fn engine_from_the_edition() {
        assert_eq!(Engine::detect(3, "Microsoft SQL Server 2022 (RTM) - 16.0.1000.6"), Engine::SqlServer);
        assert_eq!(Engine::detect(5, "Microsoft SQL Azure (RTM) - 12.0.2000.8"), Engine::SqlServer);
        assert_eq!(Engine::detect(6, "Microsoft Azure SQL Data Warehouse - 10.0.15225.0"), Engine::Synapse);
        assert_eq!(Engine::detect(0, "Microsoft SQL Server 2016 Parallel Data Warehouse (10.0.8730.0)"), Engine::Synapse);
        assert_eq!(Engine::detect(11, "Microsoft Azure SQL Data Warehouse 12.0.2000.8"), Engine::Warehouse);
        assert_eq!(Engine::detect(12, "Microsoft SQL Azure (RTM) - 12.0.2000.8"), Engine::SqlServer);
    }

    /// Una tabla de hechos de Synapse: la clave foránea que no puede existir allí no se escribe.
    fn synapse_table(distribution: &str, distribution_columns: &str, storage: IndexDef, order: &str) -> TableParts {
        TableParts {
            columns: vec![
                col("id", "bigint", 8, false, true, None),
                col("cliente", "int", 4, false, false, None),
                col("importe", "money", 8, true, false, Some("((0))")),
                col("alta", "date", 3, true, false, None),
            ],
            indexes: vec![
                index("PK_ventas", 2, "NONCLUSTERED", true, true, "[id]"),
                storage,
                index("IX_ventas_alta", 2, "NONCLUSTERED", false, false, "[alta]"),
                index("UQ_ventas", 2, "NONCLUSTERED", false, true, "[cliente], [alta]"),
            ],
            foreign_keys: vec![ForeignKeyDef {
                name: "FK_ventas_cliente".into(),
                columns: "[cliente]".into(),
                target: "[dbo].[clientes]".into(),
                target_columns: "[id]".into(),
                on_delete: "NO_ACTION".into(),
                on_update: "NO_ACTION".into(),
            }],
            distribution: distribution.into(),
            distribution_columns: distribution_columns.into(),
            order: order.into(),
            ..Default::default()
        }
    }

    const SYNAPSE_COLUMNS: &str = "CREATE TABLE [dw].[dbo].[ventas] (\n    [id] bigint IDENTITY(1,1) NOT NULL,\n    [cliente] int NOT NULL,\n    [importe] money NULL DEFAULT ((0)),\n    [alta] date NULL\n)";
    const SYNAPSE_KEYS: &str = "\nALTER TABLE [dw].[dbo].[ventas] ADD CONSTRAINT [PK_ventas] PRIMARY KEY NONCLUSTERED ([id]) NOT ENFORCED;\nALTER TABLE [dw].[dbo].[ventas] ADD CONSTRAINT [UQ_ventas] UNIQUE ([cliente], [alta]) NOT ENFORCED;\nCREATE INDEX [IX_ventas_alta] ON [dw].[dbo].[ventas] ([alta]);";

    #[test]
    fn table_ddl_on_synapse() {
        let cci = index("ClusteredIndex_ventas", 5, "CLUSTERED COLUMNSTORE", false, false, "");
        let ddl = build_table_ddl(Engine::Synapse, "[dw].[dbo].[ventas]", &synapse_table("HASH", "[cliente], [alta]", cci, "[alta]"));
        assert_eq!(ddl, format!("{SYNAPSE_COLUMNS}\nWITH (\n    DISTRIBUTION = HASH([cliente], [alta]),\n    CLUSTERED COLUMNSTORE INDEX ORDER ([alta])\n);\n{SYNAPSE_KEYS}"));

        let heap = index("", 0, "HEAP", false, false, "");
        let ddl = build_table_ddl(Engine::Synapse, "[dw].[dbo].[ventas]", &synapse_table("ROUND_ROBIN", "", heap, ""));
        assert_eq!(ddl, format!("{SYNAPSE_COLUMNS}\nWITH (\n    DISTRIBUTION = ROUND_ROBIN,\n    HEAP\n);\n{SYNAPSE_KEYS}"));

        let clustered = index("CI_ventas", 1, "CLUSTERED", false, false, "[alta] DESC, [id]");
        let ddl = build_table_ddl(Engine::Synapse, "[dw].[dbo].[ventas]", &synapse_table("REPLICATE", "", clustered, ""));
        assert_eq!(ddl, format!("{SYNAPSE_COLUMNS}\nWITH (\n    DISTRIBUTION = REPLICATE,\n    CLUSTERED INDEX ([alta] DESC, [id])\n);\n{SYNAPSE_KEYS}"));
        assert!(!ddl.contains("FOREIGN KEY") && !ddl.contains("FOR XML"));
    }

    #[test]
    fn table_ddl_on_fabric_warehouse() {
        let heap = index("", 0, "HEAP", false, false, "");
        let mut parts = synapse_table("", "", heap, "");
        parts.indexes.retain(|i| i.primary || i.type_code == 0);
        let ddl = build_table_ddl(Engine::Warehouse, "[wh].[dbo].[ventas]", &parts);
        assert_eq!(
            ddl,
            "CREATE TABLE [wh].[dbo].[ventas] (\n    [id] bigint IDENTITY NOT NULL,\n    [cliente] int NOT NULL,\n    [importe] money NULL,\n    [alta] date NULL\n);\n\
             \nALTER TABLE [wh].[dbo].[ventas] ADD CONSTRAINT [PK_ventas] PRIMARY KEY NONCLUSTERED ([id]) NOT ENFORCED;\
             \nALTER TABLE [wh].[dbo].[ventas] ADD CONSTRAINT [FK_ventas_cliente] FOREIGN KEY ([cliente]) REFERENCES [dbo].[clientes] ([id]) NOT ENFORCED;"
        );
    }

    #[test]
    fn fractions_round_to_what_sql_server_reads_back() {
        let at = |h, m, s, n| NaiveDate::from_ymd_opt(2024, 3, 15).unwrap().and_hms_nano_opt(h, m, s, n).unwrap();
        // datetime ticks are 1/300 s: .003333333 is written .003.
        assert_eq!(round_fraction(at(10, 0, 0, 3_333_333), 3).1, ".003");
        assert_eq!(round_fraction(at(10, 0, 0, 0), 3).1, "");
        assert_eq!(round_fraction(at(10, 0, 0, 123_456_700), 7).1, ".1234567");
        assert_eq!(round_fraction(at(10, 0, 0, 500_000_000), 7).1, ".5");
        // Rounding up carries into the seconds.
        let (carried, frac) = round_fraction(at(10, 0, 59, 999_800_000), 3);
        assert_eq!((carried.format("%H:%M:%S").to_string(), frac), ("10:01:00".to_string(), String::new()));
        assert_eq!(round_fraction(NaiveTime::from_hms_nano_opt(8, 30, 0, 250_000_000).unwrap(), 7).1, ".25");
    }
}
