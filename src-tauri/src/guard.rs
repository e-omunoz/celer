//! Sesiones vigiladas: la conexión de cada pestaña y del explorador, para todos los motores.
//!
//! - **Comprobación antes de usar**: una sesión que lleva un rato parada (suspensión del equipo, VPN, cortafuegos que
//!   cierra conexiones ociosas) hace una ida y vuelta barata (`Driver::ping`) antes de la operación; si no hace falta,
//!   ninguna.
//! - **Reconexión**: si la conexión se cortó (al comprobarla o en mitad de una operación), se abre otra con la misma
//!   configuración, en la misma base y con el mismo modo de transacción.
//!   - Sin estado de sesión, la operación sigue sola: las lecturas se repiten y la salida lo dice («Conexión
//!     recuperada…»); una sentencia que modifica datos no se repite, porque no se sabe si llegó a ejecutarse.
//!   - **Nunca en silencio con estado**: si había una transacción abierta, tablas temporales o SET de la sesión, se
//!     reconecta pero la operación no se hace y el error lo dice (`SESSION_LOST:`). Si la pérdida se descubre en una
//!     operación del explorador o del autocompletado, se guarda y la siguiente sentencia la cuenta antes de nada.
//! - **Reintentos con espera** cuando el fallo al conectar parece pasajero (red que vuelve, servidor arrancando,
//!   errores transitorios de Azure).
//! - **Pool genérico**: la conexión de una sesión que se cierra sin estado propio queda libre unos minutos para la
//!   siguiente sesión de la misma configuración (como hace SQL Server en `mssql.rs`, que lleva el suyo).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;

use crate::model::*;
use crate::session::{is_mutating, Canceller, Driver, Progress};

/// Abre una conexión nueva (con la contraseña y el driver ya resueltos). Se puede llamar varias veces: reconectar.
pub type Connector = Arc<dyn Fn() -> Result<Box<dyn Driver>> + Send + Sync>;

/// Tras cuánto tiempo parada se comprueba una sesión antes de usarla.
pub const CHECK_AFTER: Duration = Duration::from_secs(60);
/// Esperas entre intentos cuando conectar falla por algo pasajero.
const BACKOFF: [Duration; 3] = [Duration::from_millis(400), Duration::from_millis(1200), Duration::from_millis(2500)];
/// Pool genérico: cuánto se guarda una conexión libre, a partir de cuándo se comprueba antes de darla y cuántas por
/// configuración.
const IDLE_TTL: Duration = Duration::from_secs(300);
const IDLE_PING: Duration = Duration::from_secs(20);
const IDLE_MAX: usize = 3;

/// Principio del mensaje cuando una sesión se recupera sola (la interfaz lo reconoce en la salida).
pub const RECOVERED: &str = "Conexión recuperada";

// ───────────────────────────────────────────────────────────────── qué hace un lote con la sesión

/// Lo que un lote deja en la sesión, visto por encima (fuera de cadenas y comentarios). SQL Server lo sabe mejor por
/// su cuenta (`MssqlDriver::session_state`).
#[derive(Debug, Default, PartialEq)]
pub struct Effects {
    /// Abre (`Some(true)`) o cierra (`Some(false)`) una transacción explícita, según su última sentencia que lo haga.
    pub tx: Option<bool>,
    /// Crea tablas temporales (CREATE TEMP TABLE, SELECT … INTO TEMP, DECLARE GLOBAL TEMPORARY TABLE, #tabla).
    pub temp: bool,
    /// Cambia opciones o deja algo en la sesión: SET, PREPARE, LOCK TABLES, LISTEN, ALTER SESSION, set_config()…
    pub settings: bool,
    /// Cambia de base (USE, DATABASE): hay que preguntar la base después.
    pub database: bool,
}

/// Palabras en mayúsculas, signos y marcas de cadena (`'`) o identificador entre comillas (`"`), sin comentarios.
fn tokens(sql: &str, kind: DbKind) -> Vec<String> {
    let c: Vec<char> = sql.chars().collect();
    let word = |ch: char| ch.is_alphanumeric() || matches!(ch, '_' | '@' | '$') || (ch == '#' && kind != DbKind::Mysql);
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch.is_whitespace() {
            i += 1;
        } else if (ch == '-' && c.get(i + 1) == Some(&'-')) || (ch == '#' && kind == DbKind::Mysql) {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
        } else if ch == '/' && c.get(i + 1) == Some(&'*') {
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
        } else if ch == '{' && kind == DbKind::Informix {
            while i < c.len() && c[i] != '}' {
                i += 1;
            }
            i += 1;
        } else if ch == '$' && kind == DbKind::Postgres && dollar_tag(&c, i).is_some() {
            // $$ … $$ o $etiqueta$ … $etiqueta$: el cuerpo de una función es una cadena.
            let tag = dollar_tag(&c, i).unwrap_or_default();
            i += tag.len();
            while i < c.len() && !c[i..].starts_with(&tag) {
                i += 1;
            }
            i = (i + tag.len()).min(c.len());
            out.push("'".to_string());
        } else if matches!(ch, '\'' | '"' | '`' | '[') {
            let close = if ch == '[' { ']' } else { ch };
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
            out.push(if ch == '\'' { "'".to_string() } else { "\"".to_string() });
        } else if word(ch) {
            let start = i;
            while i < c.len() && word(c[i]) {
                i += 1;
            }
            out.push(c[start..i].iter().collect::<String>().to_uppercase());
        } else {
            out.push(ch.to_string());
            i += 1;
        }
    }
    out
}

/// `$$` o `$etiqueta$` que empieza en `at`, si lo hay.
fn dollar_tag(c: &[char], at: usize) -> Option<Vec<char>> {
    let mut j = at + 1;
    while j < c.len() && (c[j].is_alphanumeric() || c[j] == '_') {
        j += 1;
    }
    (j < c.len() && c[j] == '$' && !c.get(at + 1).is_some_and(|d| d.is_ascii_digit())).then(|| c[at..=j].to_vec())
}

pub fn effects(sql: &str, kind: DbKind) -> Effects {
    let t = tokens(sql, kind);
    let mut e = Effects::default();
    for stmt in t.split(|s| s == ";") {
        let at = |i: usize| stmt.get(i).map(String::as_str).unwrap_or("");
        let has = |w: &str| stmt.iter().any(|s| s == w);
        match at(0) {
            // BEGIN de T-SQL abre un bloque, no una transacción: SQL Server se sigue en su driver.
            "BEGIN" if kind != DbKind::Mssql && matches!(at(1), "" | "WORK" | "TRANSACTION" | "TRAN" | "ISOLATION" | "READ" | "DEFERRABLE" | "NOT") => e.tx = Some(true),
            "START" if at(1) == "TRANSACTION" => e.tx = Some(true),
            "COMMIT" | "END" if kind != DbKind::Mssql || at(0) == "COMMIT" => e.tx = Some(false),
            "ROLLBACK" if at(1) != "TO" && at(2) != "TO" => e.tx = Some(false),
            "SET" if !matches!(at(1), "TRANSACTION" | "CONSTRAINTS" | "CONSTRAINT") && !(kind == DbKind::Mssql && at(1).starts_with('@')) => e.settings = true,
            "PREPARE" | "LISTEN" | "LOCK" if !(at(0) == "LOCK" && kind == DbKind::Postgres) => e.settings = true,
            "ALTER" if at(1) == "SESSION" => e.settings = true,
            "DECLARE" if at(1) == "GLOBAL" && at(2) == "TEMPORARY" => e.temp = true,
            "CREATE" if stmt.iter().take(5).any(|s| s == "TEMP" || s == "TEMPORARY") => e.temp = true,
            "USE" => e.database = true,
            "DATABASE" | "CLOSE" if kind == DbKind::Informix && (at(0) == "DATABASE" || at(1) == "DATABASE") => e.database = true,
            _ => {}
        }
        // SELECT … INTO TEMP t (Informix), SELECT … INTO #t y CREATE TABLE #t (SQL Server).
        if stmt.windows(2).any(|w| w[0] == "INTO" && (w[1] == "TEMP" || w[1].starts_with('#'))) || (at(0) == "CREATE" && at(1) == "TABLE" && at(2).starts_with('#')) {
            e.temp = true;
        }
        if has("SET_CONFIG") || has("PG_ADVISORY_LOCK") || has("GET_LOCK") || has("SP_SET_SESSION_CONTEXT") || has("SP_GETAPPLOCK") {
            e.settings = true;
        }
    }
    e
}

// ───────────────────────────────────────────────────────────────── qué clase de error es

/// El error dice que la conexión se cortó (no que la sentencia esté mal).
pub fn looks_lost(msg: &str) -> bool {
    let m = msg.to_lowercase();
    const LOST: &[&str] = &[
        "[08s01]", "[08003]", "[08006]", "[08007]", "communication link failure", "connection reset", "reset by peer",
        "broken pipe", "connection aborted", "forcibly closed", "os error 10054", "os error 10053", "os error 104)",
        "os error 32)", "unexpected eof", "unexpected end of file", "connection closed", "connection is closed",
        "closed connection", "connection was closed", "server closed the connection", "terminating connection",
        "lost connection", "server has gone away", "(2006)", "(2013)", "connection was killed", "-25582", "-25580",
        "-27001", "-27002", "-79716", "-79730", "sql30081n", "puente jdbc terminó", "sesión está cerrada",
        "sin conexión con el servidor",
    ];
    LOST.iter().any(|p| m.contains(p))
}

/// El corte lo hizo un administrador a propósito (KILL en MySQL/MariaDB, pg_terminate_backend en PostgreSQL): la
/// sentencia no se repite aunque solo lea, porque era justo lo que se quería parar. Tras un KILL el driver de
/// MySQL/MariaDB solo dice «server disconnected» (el servidor cerró la conexión limpiamente), aunque la sentencia
/// acabe de empezar; como una conexión parada un rato se comprueba antes de usarla (`check`), ese cierre limpio a
/// mitad de sentencia es un KILL o un reinicio del servidor, y tampoco se repite.
fn killed_on_purpose(msg: &str) -> bool {
    let m = msg.to_lowercase();
    ["connection was killed", "(1927)", "1927 (", "terminating connection due to administrator command", "57p01", "server disconnected"]
        .iter()
        .any(|p| m.contains(p))
}

/// Errores que solo pueden ser un corte (no hace falta comprobar la conexión para creerlos).
fn surely_lost(msg: &str) -> bool {
    let m = msg.to_lowercase();
    ["[08s01]", "[08003]", "[08006]", "[08007]", "communication link failure", "-25582", "sql30081n", "puente jdbc terminó"].iter().any(|p| m.contains(p))
}

/// Un fallo al conectar que puede pasarse solo en unos segundos. `patient`: al reconectar una sesión también se espera
/// a un servidor que rechaza la conexión (un reinicio, una conmutación por error); al abrir una nueva, no (suele ser
/// el puerto equivocado). Los tiempos de espera agotados no se reintentan: el driver ya esperó lo suyo.
pub fn transient(msg: &str, patient: bool) -> bool {
    let m = msg.to_lowercase();
    const PASSING: &[&str] = &[
        "connection reset", "reset by peer", "broken pipe", "connection aborted", "network is unreachable",
        "no route to host", "host is unreachable", "temporary failure", "try again", "os error 10054",
        "os error 10051", "os error 10065", "os error 101)", "os error 113)", "os error 104)", "starting up",
        "57p03", "shutting down", "too many connections", "(1040)", "40613", "40197", "40501", "49918", "49919",
        "49920", "is not currently available", "[08s01]", "-25582", "-27001",
    ];
    const REFUSED: &[&str] = &["refused", "os error 10061", "os error 111)"];
    PASSING.iter().any(|p| m.contains(p)) || (patient && REFUSED.iter().any(|p| m.contains(p)))
}

/// La primera línea del error, corta (sin el código de la interfaz delante).
pub fn short(msg: &str) -> String {
    let line = msg.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let line = match line.split_once(": ") {
        Some((code, rest)) if !code.is_empty() && code.chars().all(|c| c.is_ascii_uppercase() || matches!(c, '_' | ':' | ',')) => rest,
        _ => line,
    };
    if line.chars().count() > 160 {
        format!("{}…", line.chars().take(160).collect::<String>())
    } else {
        line.to_string()
    }
}

/// «45 s», «3 min», «2 h 5 min».
pub fn human(d: Duration) -> String {
    let s = d.as_secs();
    match s {
        0..=59 => format!("{s} s"),
        60..=3599 => format!("{} min", s / 60),
        _ if s % 3600 < 60 => format!("{} h", s / 3600),
        _ => format!("{} h {} min", s / 3600, (s % 3600) / 60),
    }
}

/// Conecta, reintentando con espera si el fallo parece pasajero.
pub fn connect_retrying(connect: &Connector, patient: bool) -> Result<Box<dyn Driver>> {
    let t0 = Instant::now();
    let mut attempt = 0;
    loop {
        match connect() {
            Ok(d) => return Ok(d),
            Err(e) if attempt < BACKOFF.len() && transient(&e.to_string(), patient) => {
                std::thread::sleep(BACKOFF[attempt]);
                attempt += 1;
            }
            Err(e) if attempt > 0 => {
                return Err(anyhow!("{e}\n\n({} intentos en {:.1} s)", attempt + 1, t0.elapsed().as_secs_f64()));
            }
            Err(e) => return Err(e),
        }
    }
}

// ───────────────────────────────────────────────────────────────── pool genérico

/// Una conexión libre: sin cursor, en autocommit, sin transacción ni estado de sesión.
struct Idle {
    driver: Box<dyn Driver>,
    /// La conexión guardada de la que viene, para cerrar las suyas al desconectar o borrarla.
    owner: String,
    /// La base con la que se abrió y en la que está.
    home: String,
    database: String,
    since: Instant,
}

impl Idle {
    fn serves(&self, wanted: &str) -> bool {
        self.home.eq_ignore_ascii_case(wanted) || (!wanted.is_empty() && self.database.eq_ignore_ascii_case(wanted))
    }
}

fn pool() -> &'static Mutex<Vec<(String, Idle)>> {
    static POOL: OnceLock<Mutex<Vec<(String, Idle)>>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(Vec::new()))
}

/// Deja una conexión libre para la siguiente sesión de su configuración, si caben más. Las que caducan se cierran
/// (fuera del candado: cerrar puede tardar).
fn pool_put(key: &str, idle: Idle) {
    let expired = {
        let mut pool = pool().lock();
        let mut out = take_expired(&mut pool);
        if pool.iter().filter(|(k, _)| k == key).count() < IDLE_MAX {
            pool.push((key.to_string(), idle));
        } else {
            out.push(idle);
        }
        out
    };
    janitor();
    drop(expired);
}

fn take_expired(pool: &mut Vec<(String, Idle)>) -> Vec<Idle> {
    let (keep, old): (Vec<(String, Idle)>, Vec<(String, Idle)>) = std::mem::take(pool).into_iter().partition(|(_, i)| i.since.elapsed() < IDLE_TTL);
    *pool = keep;
    old.into_iter().map(|(_, i)| i).collect()
}

/// Una conexión libre para la base `wanted`, la más reciente. Si lleva un rato parada se comprueba antes: puede
/// haberse cortado mientras esperaba.
fn pool_take(key: &str, wanted: &str) -> Option<Box<dyn Driver>> {
    loop {
        let mut idle = {
            let mut pool = pool().lock();
            let at = pool.iter().rposition(|(k, i)| k == key && i.serves(wanted) && i.since.elapsed() < IDLE_TTL)?;
            pool.remove(at).1
        };
        if idle.since.elapsed() < IDLE_PING || idle.driver.ping().is_ok() {
            return Some(idle.driver);
        }
    }
}

/// Cierra las conexiones libres de una conexión guardada (al desconectar o al borrarla). Devuelve cuántas.
pub fn pool_forget(owner: &str) -> usize {
    let gone: Vec<(String, Idle)> = {
        let mut pool = pool().lock();
        let (gone, keep): (Vec<(String, Idle)>, Vec<(String, Idle)>) = std::mem::take(&mut *pool).into_iter().partition(|(_, i)| i.owner == owner);
        *pool = keep;
        gone
    };
    gone.len()
}

/// Un hilo que cierra cada minuto las conexiones libres caducadas, para que no se queden abiertas en el servidor.
fn janitor() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let _ = std::thread::Builder::new().name("celer-pool".into()).spawn(|| loop {
            std::thread::sleep(Duration::from_secs(60));
            let expired = take_expired(&mut pool().lock());
            drop(expired);
        });
    });
}

// ───────────────────────────────────────────────────────────────── la sesión vigilada

/// Cómo se abre una sesión vigilada.
pub struct Opts {
    pub kind: DbKind,
    /// La conexión guardada (para el pool).
    pub owner: String,
    /// La clave de la configuración en el pool genérico (`mssql::pool_key`); vacía si el motor no lo usa (SQL Server
    /// lleva el suyo, SQLite abre al instante).
    pub key: String,
    /// La base en la que tiene que estar la sesión ("" = la predeterminada).
    pub database: String,
    pub autocommit: bool,
}

/// Cómo terminó una operación que falló.
enum Recovery {
    /// No fue un corte: el error tal cual.
    Not(anyhow::Error),
    /// Fue un corte y no se pudo volver a conectar.
    Down(anyhow::Error),
    /// Fue un corte y ya hay otra conexión: en `ms`, lo que se perdió con la vieja (`lost`) y por qué se cortó.
    Back { ms: u64, lost: String, reason: String, cancelled: bool, error: anyhow::Error },
}

pub struct Guarded {
    inner: Option<Box<dyn Driver>>,
    connect: Connector,
    kind: DbKind,
    owner: String,
    key: String,
    home: String,
    database: String,
    autocommit: bool,
    in_tx: bool,
    /// BEGIN sin COMMIT en un motor cuyo driver no sigue la transacción en modo automático (Informix, ODBC).
    tx_maybe: bool,
    temp: bool,
    settings: bool,
    /// Queda un resultado abierto (filas por leer).
    cursor: bool,
    last_used: Instant,
    /// Una pérdida de estado descubierta fuera de una sentencia (explorador, autocompletado): la cuenta la siguiente.
    pending_loss: Option<String>,
    cancel_slot: Arc<Mutex<Canceller>>,
    progress_slot: Arc<Mutex<Progress>>,
    cancelled: Arc<AtomicBool>,
    pub connect_ms: u64,
    pub reused: bool,
}

/// El error de una sesión que pierde su estado al reconectar.
fn lost_msg(reason: &str, lost: &str, ms: u64) -> String {
    format!(
        "SESSION_LOST: La conexión con el servidor se cortó ({reason}) y con ella se han perdido {lost}. Celer ha vuelto a conectar en {ms} ms; la sentencia no se ha ejecutado: revisa y vuelve a lanzarla."
    )
}

/// El error cuando no se pudo volver a conectar.
fn down_msg(reason: &str, again: &anyhow::Error, lost: &str) -> anyhow::Error {
    let lost = if lost.is_empty() { String::new() } else { format!(" Se han perdido {lost}.") };
    anyhow!("CONN_DOWN: La conexión con el servidor se cortó ({reason}) y no se ha podido volver a conectar: {}.{lost} Celer lo intentará otra vez en la próxima operación.", short(&again.to_string()))
}

fn is_code(e: &anyhow::Error, code: &str) -> bool {
    e.to_string().starts_with(&format!("{code}:"))
}

impl Guarded {
    /// Abre la sesión: una conexión libre de la misma configuración si la hay, o una nueva (con reintentos si el fallo
    /// es pasajero); ya en la base pedida y con el modo de transacción pedido.
    pub fn open(connect: Connector, o: Opts) -> Result<Guarded> {
        let t0 = Instant::now();
        let pooled = if o.key.is_empty() { None } else { pool_take(&o.key, &o.database) };
        let reused = pooled.is_some();
        let mut inner = match pooled {
            Some(d) => d,
            None => connect_retrying(&connect, false)?,
        };
        let mut database = inner.current_database().unwrap_or_default();
        if !o.database.is_empty() && !database.eq_ignore_ascii_case(&o.database) {
            inner.use_database(&o.database)?;
            database = inner.current_database().unwrap_or_else(|_| o.database.clone());
        }
        if !o.autocommit {
            inner.set_autocommit(false)?;
        }
        Ok(Guarded {
            cancel_slot: Arc::new(Mutex::new(inner.canceller())),
            progress_slot: Arc::new(Mutex::new(inner.progress())),
            inner: Some(inner),
            connect,
            kind: o.kind,
            owner: o.owner,
            key: o.key,
            home: o.database,
            database,
            autocommit: o.autocommit,
            in_tx: false,
            tx_maybe: false,
            temp: false,
            settings: false,
            cursor: false,
            last_used: Instant::now(),
            pending_loss: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            connect_ms: t0.elapsed().as_millis() as u64,
            reused,
        })
    }

    /// El driver; si la última reconexión falló, se intenta otra vez.
    fn d(&mut self) -> Result<&mut dyn Driver> {
        if self.inner.is_none() {
            self.recover().map_err(|e| anyhow!("CONN_DOWN: No hay conexión con el servidor: {}", short(&e.to_string())))?;
        }
        let d: &mut dyn Driver = self.inner.as_deref_mut().ok_or_else(|| anyhow!("Sin conexión con el servidor"))?;
        Ok(d)
    }

    fn touch(&mut self) {
        self.last_used = Instant::now();
    }

    /// Lo que la sesión perdería con otra conexión ("" si nada).
    fn lost_state(&self) -> String {
        let own = self.inner.as_deref().map(|d| d.session_state()).unwrap_or_default();
        if self.kind == DbKind::Mssql {
            return own;
        }
        let mut lost: Vec<String> = Vec::new();
        if self.in_tx || self.tx_maybe {
            lost.push("la transacción abierta (el servidor la deshace al cortarse)".into());
        }
        if self.temp {
            lost.push("las tablas temporales".into());
        }
        if self.settings {
            lost.push("los SET y demás estado de la sesión".into());
        }
        if !own.is_empty() {
            lost.push(own);
        }
        lost.join(", ")
    }

    /// Si un error es un corte: el driver lo sabe, o el mensaje lo dice y la conexión no responde. Informix (ODBC/CLI
    /// y JDBC) no sabe por sí solo si su conexión sigue y sus errores de red cambian con el driver: ante cualquier
    /// error se comprueba (una consulta barata, solo cuando algo falla).
    fn is_lost(&mut self, e: &anyhow::Error) -> bool {
        let kind = self.kind;
        let Some(d) = self.inner.as_deref_mut() else { return true };
        if d.broken() {
            return true;
        }
        let text = e.to_string();
        if surely_lost(&text) {
            return true;
        }
        (looks_lost(&text) || kind == DbKind::Informix) && d.ping().is_err()
    }

    /// Para las pruebas: como si la sesión llevara `idle` sin usarse.
    #[cfg(test)]
    pub(crate) fn pretend_idle(&mut self, idle: Duration) {
        self.last_used = Instant::now() - idle;
    }

    /// Otra conexión en lugar de la que se cortó, en la base y con el modo de transacción de la sesión. El estado que
    /// tuviera la vieja ya no existe: se olvida (quien llama ya lo ha contado). If no other connection can be opened,
    /// that loss is kept for the next statement or COMMIT, which must not then run in silence on a later connection.
    fn recover(&mut self) -> Result<u64> {
        let t0 = Instant::now();
        let lost = if self.inner.is_some() { self.lost_state() } else { String::new() };
        drop(self.inner.take());
        self.in_tx = false;
        self.tx_maybe = false;
        self.temp = false;
        self.settings = false;
        self.cursor = false;
        let opened = (|| -> Result<Box<dyn Driver>> {
            let mut d = connect_retrying(&self.connect, true)?;
            let here = d.current_database().unwrap_or_default();
            if !self.database.is_empty() && !here.eq_ignore_ascii_case(&self.database) {
                d.use_database(&self.database)?;
            }
            if !self.autocommit {
                d.set_autocommit(false)?;
            }
            Ok(d)
        })();
        let d = match opened {
            Ok(d) => d,
            Err(e) => {
                if !lost.is_empty() {
                    self.pending_loss = Some(format!(
                        "SESSION_LOST: La conexión con el servidor se cortó y con ella se han perdido {lost}. La sentencia no se ha ejecutado: revisa y vuelve a lanzarla."
                    ));
                }
                return Err(e);
            }
        };
        *self.cancel_slot.lock() = d.canceller();
        *self.progress_slot.lock() = d.progress();
        self.inner = Some(d);
        self.touch();
        Ok(t0.elapsed().as_millis() as u64)
    }

    fn recover_from(&mut self, e: anyhow::Error) -> Recovery {
        let cancelled = self.cancelled.swap(false, Ordering::SeqCst);
        if !self.is_lost(&e) {
            return Recovery::Not(e);
        }
        let lost = self.lost_state();
        let reason = short(&e.to_string());
        match self.recover() {
            Ok(ms) => Recovery::Back { ms, lost, reason, cancelled, error: e },
            Err(again) => Recovery::Down(down_msg(&reason, &again, &lost)),
        }
    }

    /// Antes de usar una sesión que lleva un rato parada (o siempre, con `force`), una ida y vuelta barata; si la
    /// conexión se cortó mientras tanto, otra en su lugar. Con estado de sesión, el error lo dice y la operación no
    /// se hace; sin él, devuelve la nota para la salida.
    fn check(&mut self, force: bool) -> Result<Option<String>> {
        if self.inner.is_none() {
            let ms = self.recover().map_err(|e| anyhow!("CONN_DOWN: No hay conexión con el servidor: {}", short(&e.to_string())))?;
            return Ok(Some(format!("{RECOVERED}: Celer ha vuelto a conectar ({ms} ms).")));
        }
        let idle = self.last_used.elapsed();
        if self.cursor || (!force && idle < CHECK_AFTER) {
            return Ok(None);
        }
        let ping = self.d().and_then(|d| d.ping());
        let Err(e) = ping else {
            self.touch();
            return Ok(None);
        };
        let lost = self.lost_state();
        let reason = short(&e.to_string());
        let ms = self.recover().map_err(|again| down_msg(&reason, &again, &lost))?;
        let why = format!("la conexión llevaba {} sin usarse y se había cortado ({reason})", human(idle));
        if !lost.is_empty() {
            bail!("SESSION_LOST: Al volver a usar la sesión, {why}. Celer ha vuelto a conectar en {ms} ms, pero se han perdido {lost}. La operación no se ha hecho: revisa y vuelve a lanzarla.");
        }
        Ok(Some(format!("{RECOVERED}: {why}; reconectada en {ms} ms.")))
    }

    /// Una operación de solo lectura (explorador, columnas, DDL, autocompletado…): si la conexión se cortó, se repite
    /// en la nueva. Una pérdida de estado se guarda para la siguiente sentencia.
    fn read<T>(&mut self, op: impl Fn(&mut dyn Driver) -> Result<T>) -> Result<T> {
        if let Err(e) = self.check(false) {
            if !is_code(&e, "SESSION_LOST") {
                return Err(e);
            }
            self.pending_loss = Some(e.to_string());
        }
        let first = self.d().and_then(|d| op(d));
        let value = match first {
            Ok(v) => v,
            Err(e) => match self.recover_from(e) {
                Recovery::Not(e) | Recovery::Down(e) => return Err(e),
                Recovery::Back { ms, lost, reason, .. } => {
                    if !lost.is_empty() {
                        self.pending_loss = Some(lost_msg(&reason, &lost, ms));
                    }
                    self.d().and_then(|d| op(d))?
                }
            },
        };
        self.touch();
        Ok(value)
    }

    /// Una sentencia se puede repetir sin riesgo si no escribe.
    fn repeatable(&self, sql: &str) -> bool {
        !is_mutating(sql) && !crate::mcp::batch_writes(sql, self.kind)
    }

    /// Lo que deja un lote en la sesión.
    fn after_batch(&mut self, sql: &str, in_tx: bool) {
        let e = effects(sql, self.kind);
        if self.kind != DbKind::Mssql {
            if let Some(open) = e.tx {
                self.tx_maybe = open;
            }
            self.temp |= e.temp;
            self.settings |= e.settings;
        }
        // Los drivers que siguen la transacción en modo automático lo dicen mejor que el texto.
        if matches!(self.kind, DbKind::Mssql | DbKind::Postgres | DbKind::Mysql | DbKind::Sqlite) {
            self.tx_maybe = false;
        }
        self.in_tx = in_tx;
        if e.database {
            if let Ok(db) = self.d().and_then(|d| d.current_database()) {
                self.database = db;
            }
        }
        self.touch();
    }
}

impl Driver for Guarded {
    fn execute(&mut self, sql: &str, fetch: usize) -> Result<ExecOutput> {
        if let Some(loss) = self.pending_loss.take() {
            bail!(loss);
        }
        let mut notes: Vec<String> = self.check(false)?.into_iter().collect();
        self.cancelled.store(false, Ordering::SeqCst);
        let first = self.d().and_then(|d| d.execute(sql, fetch));
        let mut out = match first {
            Ok(out) => out,
            Err(e) => match self.recover_from(e) {
                Recovery::Not(e) | Recovery::Down(e) => return Err(e),
                Recovery::Back { ms, lost, reason, cancelled, error } => {
                    if cancelled {
                        if lost.is_empty() {
                            return Err(error);
                        }
                        bail!("SESSION_LOST: {error}\n\nPara pararla hubo que cerrar la conexión, y con ella se han perdido {lost}. Celer ya ha abierto otra ({ms} ms).");
                    }
                    if !lost.is_empty() {
                        bail!(lost_msg(&reason, &lost, ms));
                    }
                    if killed_on_purpose(&error.to_string()) {
                        bail!("CONN_RESET: El servidor cerró la sesión mientras corría la sentencia ({reason}): la terminó un administrador o el servidor se reinició. Celer ha vuelto a conectar en {ms} ms, pero la sentencia no se ha repetido.");
                    }
                    if !self.repeatable(sql) {
                        bail!("CONN_RESET: La conexión con el servidor se había cortado ({reason}). Celer ha vuelto a conectar en {ms} ms, pero la sentencia no se ha repetido porque modifica datos y no se sabe si llegó a ejecutarse: compruébalo antes de lanzarla otra vez.");
                    }
                    notes.push(format!("{RECOVERED}: la conexión se había cortado ({reason}); reconectada en {ms} ms y sentencia repetida."));
                    self.d().and_then(|d| d.execute(sql, fetch))?
                }
            },
        };
        self.cursor = out.results.iter().any(|r| r.has_more);
        self.after_batch(sql, out.in_transaction);
        for (i, note) in notes.into_iter().enumerate() {
            out.messages.insert(i, note);
        }
        Ok(out)
    }

    fn fetch(&mut self, n: usize) -> Result<FetchOutput> {
        // Leer más filas no se comprueba antes: si la conexión se cortó, el resultado ya no existe y lo dice el error.
        let r = self.d().and_then(|d| d.fetch(n));
        match r {
            Ok(out) => {
                self.cursor = out.has_more || out.extra.iter().any(|r| r.has_more);
                self.touch();
                Ok(out)
            }
            Err(e) => {
                self.cursor = false;
                match self.recover_from(e) {
                    Recovery::Not(e) | Recovery::Down(e) => Err(e),
                    Recovery::Back { ms, lost, reason, .. } => {
                        if !lost.is_empty() {
                            bail!(lost_msg(&reason, &lost, ms));
                        }
                        bail!("CONN_RESET: La conexión se cortó mientras se leía el resultado ({reason}). Celer ha vuelto a conectar en {ms} ms: vuelve a ejecutar la consulta para leer el resto.")
                    }
                }
            }
        }
    }

    fn close_cursor(&mut self) -> Result<()> {
        if self.inner.is_none() {
            self.cursor = false;
            return Ok(());
        }
        let r = self.d().and_then(|d| d.close_cursor());
        self.cursor = false;
        match r {
            Ok(()) => Ok(()),
            Err(e) => match self.recover_from(e) {
                Recovery::Not(e) | Recovery::Down(e) => Err(e),
                Recovery::Back { ms, lost, reason, .. } => {
                    if !lost.is_empty() {
                        self.pending_loss = Some(lost_msg(&reason, &lost, ms));
                    }
                    Ok(())
                }
            },
        }
    }

    fn set_autocommit(&mut self, on: bool) -> Result<bool> {
        if let Some(loss) = self.pending_loss.take() {
            bail!(loss);
        }
        self.check(false)?;
        let r = self.d().and_then(|d| d.set_autocommit(on));
        let in_tx = match r {
            Ok(in_tx) => in_tx,
            Err(e) => match self.recover_from(e) {
                Recovery::Not(e) | Recovery::Down(e) => return Err(e),
                Recovery::Back { ms, lost, reason, .. } => {
                    if !lost.is_empty() {
                        self.pending_loss = Some(lost_msg(&reason, &lost, ms));
                    }
                    self.d().and_then(|d| d.set_autocommit(on))?
                }
            },
        };
        self.autocommit = on;
        self.in_tx = in_tx;
        if on {
            self.tx_maybe = false;
        }
        self.touch();
        Ok(in_tx)
    }

    fn commit(&mut self) -> Result<bool> {
        end_tx(self, true)
    }

    fn rollback(&mut self) -> Result<bool> {
        end_tx(self, false)
    }

    fn children(&mut self, path: &[String]) -> Result<Vec<MetaNode>> {
        self.read(|d| d.children(path))
    }

    fn table_columns(&mut self, obj: &ObjectRef) -> Result<Vec<TableColumn>> {
        self.read(|d| d.table_columns(obj))
    }

    fn ddl(&mut self, obj: &ObjectRef) -> Result<String> {
        self.read(|d| d.ddl(obj))
    }

    fn completion(&mut self, database: &str) -> Result<CompletionSchema> {
        self.read(|d| d.completion(database))
    }

    fn databases(&mut self) -> Result<Vec<String>> {
        self.read(|d| d.databases())
    }

    fn current_database(&mut self) -> Result<String> {
        let db = self.read(|d| d.current_database())?;
        self.database = db.clone();
        Ok(db)
    }

    fn use_database(&mut self, db: &str) -> Result<()> {
        self.read(|d| d.use_database(db))?;
        self.database = self.d().and_then(|d| d.current_database()).unwrap_or_else(|_| db.to_string());
        Ok(())
    }

    fn qualified_name(&self, o: &ObjectRef) -> String {
        match self.inner.as_deref() {
            Some(d) => d.qualified_name(o),
            None => [&o.database, &o.schema, &o.name].iter().filter(|s| !s.is_empty()).map(|s| s.as_str()).collect::<Vec<_>>().join("."),
        }
    }

    fn quote_ident(&self, s: &str) -> String {
        match self.inner.as_deref() {
            Some(d) => d.quote_ident(s),
            None => s.to_string(),
        }
    }

    fn server_info(&mut self) -> Result<String> {
        self.read(|d| d.server_info())
    }

    fn canceller(&self) -> Canceller {
        let slot = self.cancel_slot.clone();
        let flag = self.cancelled.clone();
        Arc::new(move || {
            flag.store(true, Ordering::SeqCst);
            let cancel = slot.lock().clone();
            cancel();
        })
    }

    fn progress(&self) -> Progress {
        let slot = self.progress_slot.clone();
        Arc::new(move || {
            let progress = slot.lock().clone();
            progress()
        })
    }

    fn ping(&mut self) -> Result<()> {
        self.check(true).map(|_| ())
    }

    fn broken(&self) -> bool {
        self.inner.as_deref().is_none_or(|d| d.broken())
    }

    fn session_state(&self) -> String {
        self.lost_state()
    }

    fn health(&mut self, force: bool) -> Health {
        let t0 = Instant::now();
        let ms = |t0: Instant| t0.elapsed().as_millis() as u64;
        if let Some(loss) = self.pending_loss.take() {
            return Health { ok: true, reconnected: true, lost: loss, ms: 0, error: String::new() };
        }
        match self.check(force) {
            Ok(None) => Health { ok: true, ms: ms(t0), ..Health::default() },
            Ok(Some(_)) => Health { ok: true, reconnected: true, ms: ms(t0), ..Health::default() },
            Err(e) if is_code(&e, "SESSION_LOST") => Health { ok: true, reconnected: true, lost: e.to_string(), ms: ms(t0), error: String::new() },
            Err(e) => Health { ok: false, error: e.to_string(), ms: ms(t0), ..Health::default() },
        }
    }
}

/// COMMIT o ROLLBACK. Si la conexión se había cortado con la transacción abierta, el servidor ya la deshizo: un
/// COMMIT lo dice como error (los cambios no se guardaron) y un ROLLBACK termina sin más.
fn end_tx(g: &mut Guarded, commit: bool) -> Result<bool> {
    if let Some(loss) = g.pending_loss.take() {
        if commit {
            if loss.contains("transacción") {
                bail!("{loss}\n\nEl COMMIT no se ha hecho: los cambios de esa transacción no se han guardado.");
            }
            bail!(loss);
        }
    }
    if let Err(e) = g.check(false) {
        if commit || !is_code(&e, "SESSION_LOST") {
            return Err(e);
        }
        return Ok(false);
    }
    let r = g.d().and_then(|d| if commit { d.commit() } else { d.rollback() });
    let in_tx = match r {
        Ok(in_tx) => in_tx,
        Err(e) => match g.recover_from(e) {
            Recovery::Not(e) | Recovery::Down(e) => return Err(e),
            Recovery::Back { ms, lost, reason, .. } => {
                if commit && !lost.is_empty() {
                    bail!("SESSION_LOST: La conexión con el servidor se cortó ({reason}) antes de confirmar: el servidor deshace la transacción abierta al perder la conexión, así que sus cambios no se han guardado. Celer ha vuelto a conectar en {ms} ms.");
                }
                false
            }
        },
    };
    g.in_tx = in_tx;
    g.tx_maybe = false;
    g.touch();
    Ok(in_tx)
}

impl Drop for Guarded {
    /// La sesión se cierra: si su conexión está sana y sin estado propio, queda libre para la siguiente de la misma
    /// configuración.
    fn drop(&mut self) {
        let Some(d) = self.inner.take() else { return };
        if self.key.is_empty()
            || self.cursor
            || !self.autocommit
            || self.in_tx
            || self.tx_maybe
            || self.temp
            || self.settings
            || self.pending_loss.is_some()
            || d.broken()
            || !d.session_state().is_empty()
        {
            return;
        }
        pool_put(&self.key, Idle { driver: d, owner: self.owner.clone(), home: self.home.clone(), database: self.database.clone(), since: Instant::now() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// Un servidor de mentira: cuenta conexiones y sentencias, y se le puede «cortar» la conexión.
    #[derive(Default)]
    struct Server {
        connects: AtomicUsize,
        executed: Mutex<Vec<String>>,
        /// La conexión actual está cortada (la siguiente operación falla).
        cut: AtomicBool,
        /// Como `cut`, pero el corte lo hace un administrador (KILL).
        killed: AtomicBool,
        /// Conectar falla con este error tantas veces.
        refuse: Mutex<(usize, String)>,
    }

    struct Fake {
        server: Arc<Server>,
        id: usize,
        dead: bool,
        database: String,
        autocommit: bool,
        in_tx: bool,
    }

    impl Fake {
        fn alive(&mut self) -> Result<()> {
            if !self.dead && self.server.killed.swap(false, Ordering::SeqCst) {
                self.dead = true;
                bail!("ERROR 1927 (70100): Connection was killed");
            }
            if self.dead || self.server.cut.swap(false, Ordering::SeqCst) {
                self.dead = true;
                bail!("Connection reset by peer (os error 104)");
            }
            Ok(())
        }
    }

    impl Driver for Fake {
        fn execute(&mut self, sql: &str, _fetch: usize) -> Result<ExecOutput> {
            self.alive()?;
            self.server.executed.lock().push(format!("{}:{sql}", self.id));
            let upper = sql.trim().to_uppercase();
            if upper.starts_with("BEGIN") {
                self.in_tx = true;
            }
            if upper.starts_with("COMMIT") || upper.starts_with("ROLLBACK") {
                self.in_tx = false;
            }
            if let Some(db) = upper.strip_prefix("USE ") {
                self.database = db.to_lowercase();
            }
            if upper.starts_with("SELECT ERROR") {
                bail!("syntax error near ERROR");
            }
            let mut out = ExecOutput::default();
            out.results.push(ResultSet { columns: vec![], rows: vec![vec![Cell::Int(self.id as i64)]], has_more: upper.contains("BIG"), rows_affected: None });
            out.in_transaction = self.in_tx || (!self.autocommit && !upper.starts_with("SELECT 1"));
            Ok(out)
        }
        fn fetch(&mut self, _n: usize) -> Result<FetchOutput> {
            self.alive()?;
            Ok(FetchOutput::default())
        }
        fn close_cursor(&mut self) -> Result<()> {
            Ok(())
        }
        fn set_autocommit(&mut self, on: bool) -> Result<bool> {
            self.alive()?;
            self.autocommit = on;
            Ok(false)
        }
        fn commit(&mut self) -> Result<bool> {
            self.alive()?;
            self.in_tx = false;
            Ok(false)
        }
        fn rollback(&mut self) -> Result<bool> {
            self.alive()?;
            self.in_tx = false;
            Ok(false)
        }
        fn children(&mut self, _path: &[String]) -> Result<Vec<MetaNode>> {
            self.alive()?;
            Ok(vec![MetaNode::leaf(format!("c{}", self.id), "table", None)])
        }
        fn table_columns(&mut self, _obj: &ObjectRef) -> Result<Vec<TableColumn>> {
            Ok(vec![])
        }
        fn ddl(&mut self, _obj: &ObjectRef) -> Result<String> {
            Ok(String::new())
        }
        fn completion(&mut self, _database: &str) -> Result<CompletionSchema> {
            Ok(CompletionSchema::default())
        }
        fn databases(&mut self) -> Result<Vec<String>> {
            Ok(vec![])
        }
        fn current_database(&mut self) -> Result<String> {
            Ok(self.database.clone())
        }
        fn use_database(&mut self, db: &str) -> Result<()> {
            self.alive()?;
            self.database = db.to_string();
            Ok(())
        }
        fn qualified_name(&self, o: &ObjectRef) -> String {
            o.name.clone()
        }
        fn quote_ident(&self, s: &str) -> String {
            s.to_string()
        }
        fn server_info(&mut self) -> Result<String> {
            Ok("fake".into())
        }
        fn canceller(&self) -> Canceller {
            Arc::new(|| {})
        }
        fn ping(&mut self) -> Result<()> {
            self.alive()
        }
        fn broken(&self) -> bool {
            self.dead
        }
    }

    fn connector(server: &Arc<Server>) -> Connector {
        let server = server.clone();
        Arc::new(move || {
            {
                let mut refuse = server.refuse.lock();
                if refuse.0 > 0 {
                    refuse.0 -= 1;
                    bail!("{}", refuse.1);
                }
            }
            let id = server.connects.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(Box::new(Fake { server: server.clone(), id, dead: false, database: "app".into(), autocommit: true, in_tx: false }) as Box<dyn Driver>)
        })
    }

    fn opts(kind: DbKind, key: &str) -> Opts {
        Opts { kind, owner: format!("owner-{key}"), key: key.into(), database: "app".into(), autocommit: true }
    }

    fn first_cell(out: &ExecOutput) -> i64 {
        match out.results[0].rows[0][0] {
            Cell::Int(i) => i,
            _ => -1,
        }
    }

    #[test]
    fn effects_by_dialect() {
        let e = effects("BEGIN WORK; UPDATE t SET a = 1", DbKind::Informix);
        assert_eq!(e.tx, Some(true));
        assert!(!e.settings, "UPDATE … SET is not a session option");
        assert_eq!(effects("BEGIN; INSERT INTO t VALUES (1); COMMIT", DbKind::Postgres).tx, Some(false));
        assert_eq!(effects("ROLLBACK TO SAVEPOINT a", DbKind::Postgres).tx, None);
        assert!(effects("SELECT * FROM t INTO TEMP x WITH NO LOG", DbKind::Informix).temp);
        assert!(effects("CREATE TEMPORARY TABLE x (a int)", DbKind::Mysql).temp);
        assert!(effects("create temp table x as select 1", DbKind::Postgres).temp);
        assert!(effects("SET search_path TO ventas", DbKind::Postgres).settings);
        assert!(effects("SET ISOLATION TO DIRTY READ", DbKind::Informix).settings);
        assert!(effects("SELECT set_config('a.b', '1', false)", DbKind::Postgres).settings);
        assert!(!effects("SET @v = 1", DbKind::Mssql).settings, "a T-SQL variable lives in the batch");
        assert!(effects("SET @v = 1", DbKind::Mysql).settings, "a MySQL user variable lives in the session");
        assert!(effects("USE ventas", DbKind::Mysql).database);
        assert!(effects("DATABASE stores", DbKind::Informix).database);
        // Inside strings, comments and function bodies nothing counts.
        assert_eq!(effects("SELECT 'BEGIN; SET x' -- SET y\n/* CREATE TEMP TABLE */", DbKind::Postgres), Effects::default());
        assert_eq!(effects("CREATE FUNCTION f() RETURNS void AS $$ BEGIN SET LOCAL x = 1; END $$ LANGUAGE plpgsql", DbKind::Postgres).settings, false);
        assert_eq!(effects("{ SET LOCK MODE } SELECT 1 FROM systables", DbKind::Informix), Effects::default());
        assert_eq!(effects("SELECT 1 # SET NAMES latin1", DbKind::Mysql), Effects::default());
        // A T-SQL block is not a transaction.
        assert_eq!(effects("BEGIN SELECT 1 END", DbKind::Mssql).tx, None);
    }

    #[test]
    fn error_kinds() {
        assert!(looks_lost("[08S01] [IBM][CLI Driver] SQL30081N A communication error"));
        assert!(looks_lost("Connection reset by peer (os error 104)"));
        assert!(looks_lost("FATAL: terminating connection due to administrator command"));
        assert!(looks_lost("ERROR 2013 (HY000): Lost connection to MySQL server during query"));
        assert!(!looks_lost("Msg 208, nivel 16, línea 1: Invalid object name 'x'"));
        assert!(transient("Connection reset by peer (os error 104)", false));
        assert!(transient("FATAL: the database system is starting up", false));
        assert!(!transient("connection refused (os error 111)", false), "a new connection to a closed port fails at once");
        assert!(transient("connection refused (os error 111)", true), "a server restarting is waited for when reconnecting");
        assert!(!transient("Tiempo de espera agotado al conectar con db", true));
        assert!(!transient("Login failed for user 'sa'", true));
        assert_eq!(short("SESSION_LOST: La conexión se cortó\n\ndetalle"), "La conexión se cortó");
        assert_eq!(short("Msg 102: Incorrect syntax"), "Msg 102: Incorrect syntax");
        assert_eq!(human(Duration::from_secs(45)), "45 s");
        assert_eq!(human(Duration::from_secs(185)), "3 min");
        assert_eq!(human(Duration::from_secs(7500)), "2 h 5 min");
    }

    #[test]
    fn a_dropped_connection_comes_back_and_a_read_is_repeated() {
        let server = Arc::new(Server::default());
        let mut g = Guarded::open(connector(&server), opts(DbKind::Postgres, "")).unwrap();
        assert_eq!(first_cell(&g.execute("SELECT 1", 10).unwrap()), 1);
        server.cut.store(true, Ordering::SeqCst);
        let out = g.execute("SELECT 2", 10).unwrap();
        assert_eq!(first_cell(&out), 2, "ran again on the new connection");
        assert!(out.messages[0].starts_with(RECOVERED), "{:?}", out.messages);
        assert_eq!(server.connects.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_read_killed_by_an_administrator_is_not_repeated() {
        let server = Arc::new(Server::default());
        let mut g = Guarded::open(connector(&server), opts(DbKind::Mysql, "")).unwrap();
        server.killed.store(true, Ordering::SeqCst);
        let e = g.execute("SELECT SLEEP(30)", 10).unwrap_err().to_string();
        assert!(e.starts_with("CONN_RESET:"), "{e}");
        assert!(!server.executed.lock().iter().any(|s| s.contains("SLEEP")), "the killed query is not run again");
        assert!(killed_on_purpose("FATAL: terminating connection due to administrator command"));
        assert!(killed_on_purpose("IoError { server disconnected }"), "MariaDB's KILL mid-query");
        assert!(!killed_on_purpose("Connection reset by peer (os error 104)"));
        // The session works again.
        assert_eq!(first_cell(&g.execute("SELECT 1", 10).unwrap()), 2);
    }

    #[test]
    fn a_write_is_not_repeated_after_a_cut() {
        let server = Arc::new(Server::default());
        let mut g = Guarded::open(connector(&server), opts(DbKind::Mysql, "")).unwrap();
        server.cut.store(true, Ordering::SeqCst);
        let e = g.execute("INSERT INTO t VALUES (1)", 10).unwrap_err().to_string();
        assert!(e.starts_with("CONN_RESET:"), "{e}");
        assert!(!server.executed.lock().iter().any(|s| s.contains("INSERT")), "never sent twice (nor once, here)");
        // The session works again.
        assert_eq!(first_cell(&g.execute("SELECT 1", 10).unwrap()), 2);
    }

    #[test]
    fn an_open_transaction_is_never_lost_in_silence() {
        let server = Arc::new(Server::default());
        let mut g = Guarded::open(connector(&server), opts(DbKind::Informix, "")).unwrap();
        g.execute("BEGIN WORK", 10).unwrap();
        server.cut.store(true, Ordering::SeqCst);
        let e = g.execute("SELECT 1", 10).unwrap_err().to_string();
        assert!(e.starts_with("SESSION_LOST:") && e.contains("transacción"), "{e}");
        assert!(!server.executed.lock().iter().any(|s| s == "2:SELECT 1"), "not run on the new connection");
        // After saying so, the session goes on.
        assert_eq!(first_cell(&g.execute("SELECT 1", 10).unwrap()), 2);
        // A COMMIT after a cut with the transaction open says its changes were not saved.
        g.execute("BEGIN WORK", 10).unwrap();
        server.cut.store(true, Ordering::SeqCst);
        let e = g.commit().unwrap_err().to_string();
        assert!(e.starts_with("SESSION_LOST:"), "{e}");
        // Temp tables and SET count as session state too.
        g.execute("SET ISOLATION TO DIRTY READ", 10).unwrap();
        server.cut.store(true, Ordering::SeqCst);
        let e = g.execute("SELECT 1", 10).unwrap_err().to_string();
        assert!(e.contains("SET"), "{e}");
    }

    #[test]
    fn a_transaction_lost_while_the_server_was_down_is_not_committed_later() {
        let server = Arc::new(Server::default());
        let mut g = Guarded::open(connector(&server), opts(DbKind::Postgres, "")).unwrap();
        g.execute("BEGIN", 10).unwrap();
        g.execute("INSERT INTO t VALUES (1)", 10).unwrap();
        // The explorer finds the cut while the server cannot be reached.
        server.cut.store(true, Ordering::SeqCst);
        *server.refuse.lock() = (1, "Login timeout expired".into());
        let e = g.children(&[]).unwrap_err().to_string();
        assert!(e.starts_with("CONN_DOWN:"), "{e}");
        // The network is back: COMMIT does not run on the new connection and says the changes were not saved.
        let e = g.commit().unwrap_err().to_string();
        assert!(e.starts_with("SESSION_LOST:") && e.contains("no se han guardado"), "{e}");
        assert!(!server.executed.lock().iter().any(|s| s.starts_with("2:")), "nothing ran on the new connection");
        // Same with the next statement instead of COMMIT.
        g.execute("BEGIN", 10).unwrap();
        server.cut.store(true, Ordering::SeqCst);
        *server.refuse.lock() = (1, "Login timeout expired".into());
        assert!(g.ping().is_err());
        let e = g.execute("INSERT INTO t VALUES (2)", 10).unwrap_err().to_string();
        assert!(e.starts_with("SESSION_LOST:") && e.contains("transacción"), "{e}");
        assert!(!server.executed.lock().iter().any(|s| s.contains("VALUES (2)")));
    }

    #[test]
    fn a_loss_found_by_the_explorer_is_told_by_the_next_statement() {
        let server = Arc::new(Server::default());
        let mut g = Guarded::open(connector(&server), opts(DbKind::Postgres, "")).unwrap();
        g.execute("CREATE TEMP TABLE x (a int)", 10).unwrap();
        server.cut.store(true, Ordering::SeqCst);
        // The read is repeated on the new connection…
        assert_eq!(g.children(&[]).unwrap()[0].name, "c2");
        // …and the next statement says what was lost, without running.
        let e = g.execute("SELECT 1", 10).unwrap_err().to_string();
        assert!(e.starts_with("SESSION_LOST:") && e.contains("temporales"), "{e}");
        assert_eq!(first_cell(&g.execute("SELECT 1", 10).unwrap()), 2);
    }

    #[test]
    fn an_idle_session_is_checked_before_use() {
        let server = Arc::new(Server::default());
        let mut g = Guarded::open(connector(&server), opts(DbKind::Postgres, "")).unwrap();
        g.execute("USE ventas", 10).unwrap();
        server.cut.store(true, Ordering::SeqCst);
        g.last_used = Instant::now() - CHECK_AFTER - Duration::from_secs(5);
        let out = g.execute("SELECT 1", 10).unwrap();
        assert!(out.messages[0].starts_with(RECOVERED) && out.messages[0].contains("sin usarse"), "{:?}", out.messages);
        assert_eq!(first_cell(&out), 2, "only the new connection ran it");
        assert_eq!(g.d().unwrap().current_database().unwrap(), "ventas", "the database is put back");
        // Without a pause, no check (no round trip).
        let before = server.executed.lock().len();
        g.execute("SELECT 1", 10).unwrap();
        assert_eq!(server.executed.lock().len(), before + 1);
    }

    #[test]
    fn transient_failures_are_retried_with_a_wait() {
        let server = Arc::new(Server::default());
        *server.refuse.lock() = (2, "Network is unreachable (os error 101)".into());
        let g = Guarded::open(connector(&server), opts(DbKind::Postgres, "")).unwrap();
        assert_eq!(server.connects.load(Ordering::SeqCst), 1);
        drop(g);
        *server.refuse.lock() = (1, "password authentication failed for user \"x\"".into());
        assert!(Guarded::open(connector(&server), opts(DbKind::Postgres, "")).is_err(), "a wrong password is not retried");
    }

    #[test]
    fn a_free_connection_is_reused_only_without_state() {
        let server = Arc::new(Server::default());
        let key = "pool-test";
        let g = Guarded::open(connector(&server), opts(DbKind::Postgres, key)).unwrap();
        assert!(!g.reused);
        drop(g);
        let mut g = Guarded::open(connector(&server), opts(DbKind::Postgres, key)).unwrap();
        assert!(g.reused, "the closed session's connection was free");
        assert_eq!(server.connects.load(Ordering::SeqCst), 1);
        // Another database is not served by it.
        let other = Guarded::open(connector(&server), Opts { database: "otra".into(), ..opts(DbKind::Postgres, key) }).unwrap();
        assert!(!other.reused);
        // With a transaction open, the connection is not handed on.
        g.execute("BEGIN", 10).unwrap();
        drop(g);
        let g = Guarded::open(connector(&server), opts(DbKind::Postgres, key)).unwrap();
        assert!(!g.reused);
        drop(other);
        drop(g);
        assert!(pool_forget("owner-pool-test") >= 1, "disconnecting closes the free ones");
        let g = Guarded::open(connector(&server), opts(DbKind::Postgres, key)).unwrap();
        assert!(!g.reused);
    }
}
