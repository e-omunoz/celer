mod drivers;
#[cfg(test)]
mod engine_tests;
mod export;
mod guard;
mod jdbc;
mod mcp;
mod migrate;
mod model;
mod mssql;
mod mysql;
mod odbc;
mod odbc_driver;
mod postgres;
mod probe;
mod session;
mod sheets;
mod sqlite;
mod startup;
mod store;
mod update;
mod windows;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{Emitter, Manager, State};

use model::*;
use session::{Driver, SessionHandle, Sessions};
use store::{HistoryEntry, Store};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

struct AppState {
    store: Store,
    conns: Mutex<Vec<ConnConfig>>,
    sessions: Sessions,
    /// Contraseñas de las conexiones borradas en esta ejecución, solo en memoria: «Deshacer» las devuelve.
    trash: Mutex<HashMap<String, String>>,
    /// Servidor MCP en modo vista previa (para que la interfaz muestre lo que vería la IA).
    mcp: mcp::McpServer,
    /// Un solo escritor a la vez de los ficheros que comparten las ventanas (ajustes, biblioteca).
    files: Mutex<()>,
}

impl AppState {
    fn conn(&self, id: &str) -> CmdResult<ConnConfig> {
        self.conns
            .lock()
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| "Conexión no encontrada".to_string())
    }

    fn ibm_driver_setting(&self) -> Option<String> {
        ibm_driver_setting(&self.store)
    }

    fn make_connector(
        &self,
        cfg: ConnConfig,
    ) -> CmdResult<impl FnOnce() -> anyhow::Result<Box<dyn Driver>> + Send + 'static> {
        make_connector(&self.store, cfg)
    }
}

fn ibm_driver_setting(store: &Store) -> Option<String> {
    setting(store, "ibmDriverPath")
}

/// A text setting of settings.json (driver paths), when it is not empty.
fn setting(store: &Store, key: &str) -> Option<String> {
    // A plain read: setting a damaged file aside is for the interface's load, which tells the user.
    let settings: serde_json::Value = serde_json::from_str(&store.read("settings.json")?).ok()?;
    settings.get(key).and_then(|v| v.as_str()).map(|s| s.to_string()).filter(|s| !s.trim().is_empty())
}

/// Informix: the protocol a connection really uses. "auto" takes the Client SDK when its ODBC driver is registered
/// and JDBC otherwise; connections saved before there was a choice (no mode) keep DRDA.
fn informix_mode(cfg: &ConnConfig) -> &'static str {
    match cfg.informix_mode.as_str() {
        "sqli" => "sqli",
        "jdbc" => "jdbc",
        "auto" if odbc::informix_odbc_drivers().iter().any(|d| d.eq_ignore_ascii_case(odbc::IFX_ODBC_DRIVER)) => "sqli",
        "auto" => "jdbc",
        _ => "drda",
    }
}

fn source_label(source: &str) -> &str {
    match source {
        "settings" => "Ajustes",
        "DBeaver" => "de DBeaver",
        "Celer" => "descargado por Celer",
        other => other,
    }
}

/// What Informix over JDBC runs on, or what is missing: `JDBC_SETUP:<java,jdbc>:` lets the interface offer to
/// download it.
fn jdbc_runtime(store: &Store) -> CmdResult<(jdbc::Runtime, String)> {
    if !jdbc::bridge_included() {
        return Err("JDBC_BRIDGE_MISSING: Esta compilación de Celer no incluye el puente JDBC (se compiló sin un JDK). Usa una versión publicada de Celer o elige otro protocolo.".into());
    }
    let javas = drivers::find_java(setting(store, "javaPath").as_deref(), &store.dir, false);
    let java = drivers::pick_java(&javas).cloned();
    let jdbc = drivers::find_jdbc(&drivers::INFORMIX_JDBC, setting(store, "informixJdbcPath").as_deref(), &store.dir).into_iter().next();
    match (java, jdbc) {
        (Some(java), Some(jdbc)) => {
            let jar = PathBuf::from(&jdbc.jars[0]).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let label = format!("Java {} ({}) · {jar} ({})", java.version, source_label(java.source), source_label(jdbc.source));
            let rt = jdbc::Runtime {
                java: PathBuf::from(&java.path),
                java_major: java.major,
                driver_class: drivers::INFORMIX_JDBC.class.into(),
                jars: jdbc.jars.iter().map(PathBuf::from).collect(),
                dir: store.dir.clone(),
            };
            Ok((rt, label))
        }
        (java, jdbc) => {
            let (mut missing, mut what) = (Vec::new(), Vec::new());
            if java.is_none() {
                missing.push("java");
                what.push(match javas.first() {
                    Some(old) => format!("Java {} o superior (el de {} es Java {})", drivers::JAVA_MIN, old.path, old.major),
                    None => format!("Java {} o superior", drivers::JAVA_MIN),
                });
            }
            if jdbc.is_none() {
                missing.push("jdbc");
                what.push("el driver JDBC de Informix".to_string());
            }
            Err(format!("JDBC_SETUP:{}: Para conectar por JDBC falta {}. Celer puede descargarlo.", missing.join(","), what.join(" y ")))
        }
    }
}

/// Prepara la conexión (contraseña del almacén, driver IBM/ODBC). La usan la interfaz y el
/// servidor MCP, que no tiene `State` de Tauri.
pub(crate) fn make_connector(
    store: &Store,
    cfg: ConnConfig,
) -> CmdResult<impl FnOnce() -> anyhow::Result<Box<dyn Driver>> + Send + 'static> {
    let connector = prepare(store, cfg)?.connector;
    Ok(move || connector())
}

/// Una conexión lista para abrirse, y para volver a abrirse si se corta: el conector, la vía por la que llega al
/// servidor («Probar conexión» la muestra) y la clave de su configuración en el pool genérico.
struct Prepared {
    connector: guard::Connector,
    route: String,
    /// "" si el motor no usa el pool genérico (SQL Server lleva el suyo; SQLite abre al instante).
    key: String,
    kind: DbKind,
}

fn prepare(store: &Store, mut cfg: ConnConfig) -> CmdResult<Prepared> {
    // Sin contraseña escrita (el diálogo manda "" para «sin cambios»), la guardada.
    if cfg.password.as_deref().is_none_or(str::is_empty) && !cfg.integrated_auth {
        cfg.password = store.get_password(&cfg.id).or(cfg.password);
    }
    let kind = cfg.kind;
    let mut route = String::new();
    let mut jdbc_rt: Option<jdbc::Runtime> = None;
    let odbc_lib = match kind {
        DbKind::Mssql | DbKind::Sqlite | DbKind::Postgres | DbKind::Mysql => None,
        DbKind::Informix => {
            let prefix = if cfg.informix_mode == "auto" { "Automático → " } else { "" };
            let mode = informix_mode(&cfg);
            cfg.informix_mode = mode.to_string();
            match mode {
                "drda" => {
                    if cfg.database.trim().is_empty() {
                        return Err("Por DRDA hay que indicar la base de datos: el driver IBM CLI no conecta sin ella.".into());
                    }
                    let dll = drivers::find_cli(ibm_driver_setting(store).as_deref(), &store.dir).ok_or_else(|| {
                        "IBM_DRIVER_MISSING: No se encontró el driver IBM Data Server (ODBC/CLI). Descárgalo desde Ajustes → Drivers.".to_string()
                    })?;
                    drivers::prepare_env(&dll);
                    route = format!("{prefix}DRDA · IBM Data Server Driver (CLI)");
                    Some(dll.to_string_lossy().to_string())
                }
                "jdbc" => {
                    let (rt, label) = jdbc_runtime(store)?;
                    route = format!("{prefix}SQLI por JDBC · {label}");
                    jdbc_rt = Some(rt);
                    None
                }
                _ => {
                    route = format!("{prefix}SQLI · Informix Client SDK (ODBC)");
                    Some(odbc::system_manager().to_string())
                }
            }
        }
        DbKind::Odbc => Some(odbc::system_manager().to_string()),
    };
    // The startup script runs inside each driver, on every connection it opens; a read-only connection
    // refuses one that writes before connecting at all.
    startup::check(&cfg).map_err(err)?;
    let key = match kind {
        DbKind::Mssql | DbKind::Sqlite => String::new(),
        _ => mssql::pool_key(&cfg),
    };
    let connector: guard::Connector = Arc::new(move || -> anyhow::Result<Box<dyn Driver>> {
        let cfg = cfg.clone();
        let driver: Box<dyn Driver> = match (kind, jdbc_rt.clone()) {
            (DbKind::Sqlite, _) => Box::new(sqlite::SqliteDriver::connect(cfg)?),
            (DbKind::Mssql, _) => Box::new(mssql::MssqlDriver::connect(cfg)?),
            (DbKind::Postgres, _) => Box::new(postgres::PostgresDriver::connect(cfg)?),
            (DbKind::Mysql, _) => Box::new(mysql::MysqlDriver::connect(cfg)?),
            (DbKind::Informix, Some(rt)) => Box::new(jdbc::connect(cfg, rt)?),
            (DbKind::Informix | DbKind::Odbc, _) => {
                let path = odbc_lib.clone().unwrap_or_else(|| odbc::system_manager().to_string());
                Box::new(odbc_driver::OdbcDriver::connect(cfg, path)?)
            }
        };
        Ok(driver)
    });
    Ok(Prepared { connector, route, key, kind })
}

/// Cierra las conexiones libres que dejaron las sesiones de una conexión guardada (al desconectarla, editarla o
/// borrarla): que no queden sesiones suyas abiertas en el servidor.
fn forget_free(conn_id: &str) {
    guard::pool_forget(conn_id);
    mssql::pool_forget(conn_id);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnSummary {
    #[serde(flatten)]
    cfg: ConnConfig,
    has_password: bool,
}

/// Las conexiones guardadas han cambiado: las demás ventanas las vuelven a leer (windows.ts).
fn connections_changed(window: &tauri::WebviewWindow) {
    let _ = window.emit("celer://shared", serde_json::json!({ "name": "connections", "from": window.label() }));
}

#[tauri::command]
fn list_connections(state: State<'_, Arc<AppState>>) -> Vec<ConnSummary> {
    state
        .conns
        .lock()
        .iter()
        .cloned()
        .map(|c| ConnSummary {
            has_password: c.save_password && state.store.get_password(&c.id).is_some(),
            cfg: c,
        })
        .collect()
}

#[tauri::command]
fn save_connection(window: tauri::WebviewWindow, state: State<'_, Arc<AppState>>, cfg: ConnConfig) -> CmdResult<ConnConfig> {
    let saved = save_cfg(&state, cfg)?;
    connections_changed(&window);
    Ok(saved)
}

fn save_cfg(app: &AppState, mut cfg: ConnConfig) -> CmdResult<ConnConfig> {
    if cfg.id.is_empty() {
        cfg.id = uuid::Uuid::new_v4().to_string();
    }
    if cfg.save_password {
        if let Some(p) = cfg.password.as_ref().filter(|p| !p.is_empty()) {
            app.store.set_password(&cfg.id, p).map_err(err)?;
        }
    } else {
        app.store.delete_password(&cfg.id);
    }
    cfg.password = None;
    let mut conns = app.conns.lock();
    match conns.iter_mut().find(|c| c.id == cfg.id) {
        Some(c) => {
            // Las conexiones libres de la configuración anterior ya no sirven.
            forget_free(&cfg.id);
            *c = cfg.clone();
        }
        None => conns.push(cfg.clone()),
    }
    app.store.save_connections(&conns).map_err(err)?;
    Ok(cfg)
}

/// «Deshacer» un borrado: la conexión vuelve con su id y con la contraseña que tenía guardada.
#[tauri::command]
fn restore_connection(window: tauri::WebviewWindow, state: State<'_, Arc<AppState>>, mut cfg: ConnConfig) -> CmdResult<ConnConfig> {
    let kept = state.trash.lock().remove(&cfg.id);
    if cfg.password.as_deref().is_none_or(str::is_empty) {
        cfg.password = kept;
    }
    let saved = save_cfg(&state, cfg)?;
    connections_changed(&window);
    Ok(saved)
}

/// Una copia de una conexión guardada, con otro id y otro nombre y con su contraseña guardada.
#[tauri::command]
fn duplicate_connection(window: tauri::WebviewWindow, state: State<'_, Arc<AppState>>, id: String, name: String) -> CmdResult<ConnConfig> {
    let mut cfg = state.conn(&id)?;
    cfg.password = if cfg.save_password { state.store.get_password(&id) } else { None };
    cfg.id = String::new();
    cfg.name = name;
    let saved = save_cfg(&state, cfg)?;
    connections_changed(&window);
    Ok(saved)
}

#[tauri::command]
fn reorder_connections(window: tauri::WebviewWindow, state: State<'_, Arc<AppState>>, ids: Vec<String>) -> CmdResult<()> {
    {
        let mut conns = state.conns.lock();
        conns.sort_by_key(|c| ids.iter().position(|i| *i == c.id).unwrap_or(usize::MAX));
        state.store.save_connections(&conns).map_err(err)?;
    }
    connections_changed(&window);
    Ok(())
}

#[tauri::command]
fn delete_connection(window: tauri::WebviewWindow, state: State<'_, Arc<AppState>>, id: String) -> CmdResult<()> {
    for s in state.sessions.remove_for_conn(&id) {
        s.cancel();
    }
    forget_free(&id);
    // Hasta cerrar Celer, en memoria: «Deshacer» la devuelve con la conexión.
    if let Some(p) = state.store.get_password(&id) {
        state.trash.lock().insert(id.clone(), p);
    }
    state.store.delete_password(&id);
    {
        let mut conns = state.conns.lock();
        conns.retain(|c| c.id != id);
        state.store.save_connections(&conns).map_err(err)?;
    }
    connections_changed(&window);
    Ok(())
}

/// «Probar conexión»: cada paso con su tiempo (resolver el nombre, abrir el puerto, TLS, iniciar sesión, la base) y,
/// si falla, qué hacer. Solo falla del todo si ni siquiera se puede intentar (falta un driver).
#[tauri::command]
async fn test_connection(state: State<'_, Arc<AppState>>, cfg: ConnConfig) -> CmdResult<probe::Report> {
    let app = state.inner().clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    // En un hilo propio: resolver nombres, abrir sockets y los drivers bloquean (y algunos llevan su propio runtime).
    std::thread::Builder::new()
        .name("celer-test-connection".into())
        .spawn(move || {
            let report = prepare(&app.store, cfg.clone()).map(|p| probe::run(&cfg, p.connector, &p.route));
            let _ = tx.send(report);
        })
        .map_err(err)?;
    rx.await.map_err(|_| "La prueba de conexión terminó inesperadamente".to_string())?
}

/// An Informix connection over JDBC is about to open: Java starts now, while the user types the password.
#[tauri::command]
fn jdbc_prewarm(state: State<'_, Arc<AppState>>, conn_id: String) {
    let Ok(cfg) = state.conn(&conn_id) else { return };
    if cfg.kind != DbKind::Informix || !matches!(cfg.informix_mode.as_str(), "jdbc" | "auto") {
        return;
    }
    let app = state.inner().clone();
    std::thread::spawn(move || {
        if informix_mode(&cfg) == "jdbc" {
            if let Ok((rt, _)) = jdbc_runtime(&app.store) {
                jdbc::prewarm(rt);
            }
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    session_id: String,
    database: String,
    server_info: String,
    /// Lo que tardó en estar lista (iniciar sesión, o tomar una conexión libre de la misma configuración).
    connect_ms: u64,
    reused: bool,
}

/// Abre una sesión vigilada (guard.rs): ya en la base y con el modo de transacción que pide la pestaña, sin idas y
/// vueltas después; reconecta sola si la conexión se corta y avisa si con ello se pierde estado.
#[tauri::command]
async fn open_session(
    state: State<'_, Arc<AppState>>,
    conn_id: String,
    password: Option<String>,
    database: Option<String>,
    autocommit: Option<bool>,
) -> CmdResult<SessionInfo> {
    let mut cfg = state.conn(&conn_id)?;
    if password.is_some() {
        cfg.password = password;
    }
    let wanted = database.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    // Los motores que eligen la base al conectar entran ya en ella (sin USE ni, en PostgreSQL, otra conexión).
    if let Some(db) = &wanted {
        if matches!(cfg.kind, DbKind::Postgres | DbKind::Mysql | DbKind::Mssql | DbKind::Informix) {
            cfg.database = db.clone();
        }
    }
    let home = wanted.unwrap_or_else(|| cfg.database.trim().to_string());
    let prepared = prepare(&state.store, cfg)?;
    let opts = guard::Opts { kind: prepared.kind, owner: conn_id.clone(), key: prepared.key, database: home, autocommit: autocommit.unwrap_or(true) };
    let connector = prepared.connector;
    let timing = Arc::new(Mutex::new((0u64, false)));
    let seen = timing.clone();
    let h = SessionHandle::open(conn_id, move || {
        let g = guard::Guarded::open(connector, opts)?;
        *seen.lock() = (g.connect_ms, g.reused);
        Ok(Box::new(g) as Box<dyn Driver>)
    })
    .await
    .map_err(err)?;
    let (database, server_info) = h
        .run(|d| {
            Ok((
                d.current_database().unwrap_or_default(),
                d.server_info().unwrap_or_default(),
            ))
        })
        .await
        .map_err(err)?;
    let (connect_ms, reused) = *timing.lock();
    let id = uuid::Uuid::new_v4().to_string();
    state.sessions.insert(id.clone(), Arc::new(h));
    Ok(SessionInfo {
        session_id: id,
        database,
        server_info,
        connect_ms,
        reused,
    })
}

/// Comprueba una sesión (una ida y vuelta barata si lleva un rato parada, o siempre con `force`) y la reconecta si se
/// cortó: la interfaz lo pide al volver de una suspensión o cuando el usuario lo pide.
#[tauri::command]
async fn check_session(state: State<'_, Arc<AppState>>, session_id: String, force: bool) -> CmdResult<Health> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    h.run(move |d| Ok(d.health(force))).await.map_err(err)
}

#[tauri::command]
fn close_session(state: State<'_, Arc<AppState>>, session_id: String) {
    if let Some(h) = state.sessions.remove(&session_id) {
        h.cancel();
    }
}

/// Disconnect: closes every session of a connection (explorer, consoles, tables, exports, temporary ones) and
/// returns how many there were.
#[tauri::command]
fn close_connection_sessions(state: State<'_, Arc<AppState>>, conn_id: String) -> usize {
    let closed = state.sessions.remove_for_conn(&conn_id);
    for h in &closed {
        h.cancel();
    }
    // Las sesiones se cierran en sus hilos (y dejan su conexión libre si pueden): las libres se cierran un poco
    // después, cuando ya han llegado.
    let id = conn_id.clone();
    std::thread::spawn(move || {
        forget_free(&id);
        std::thread::sleep(std::time::Duration::from_millis(1500));
        forget_free(&id);
    });
    closed.len()
}

#[tauri::command]
async fn execute(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    sql: String,
    fetch: usize,
) -> CmdResult<ExecOutput> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    let cfg = state.conn(&h.conn_id)?;
    // Every statement of the batch is checked (a leading SELECT must not hide a later DELETE).
    if cfg.read_only && (session::is_mutating(&sql) || mcp::batch_writes(&sql, cfg.kind)) {
        return Err(
            "La conexión es de solo lectura: no se permiten sentencias que modifiquen datos".into(),
        );
    }
    h.run(move |d| d.execute(&sql, fetch)).await.map_err(err)
}

#[tauri::command]
async fn fetch(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    n: usize,
) -> CmdResult<FetchOutput> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    h.run(move |d| d.fetch(n)).await.map_err(err)
}

#[tauri::command]
async fn close_cursor(state: State<'_, Arc<AppState>>, session_id: String) -> CmdResult<()> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    h.run(|d| d.close_cursor()).await.map_err(err)
}

#[tauri::command]
fn cancel(state: State<'_, Arc<AppState>>, session_id: String) -> CmdResult<()> {
    state.sessions.get(&session_id).map_err(err)?.cancel();
    Ok(())
}

/// What a session is doing besides the statement itself (reading the rest of a result to keep the session), while
/// it runs.
#[tauri::command]
fn session_progress(state: State<'_, Arc<AppState>>, session_id: String) -> Option<String> {
    state.sessions.get(&session_id).ok().and_then(|h| h.progress())
}

#[tauri::command]
async fn set_autocommit(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    on: bool,
) -> CmdResult<bool> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    h.run(move |d| d.set_autocommit(on)).await.map_err(err)
}

#[tauri::command]
async fn commit(state: State<'_, Arc<AppState>>, session_id: String) -> CmdResult<bool> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    h.run(|d| d.commit()).await.map_err(err)
}

#[tauri::command]
async fn rollback(state: State<'_, Arc<AppState>>, session_id: String) -> CmdResult<bool> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    h.run(|d| d.rollback()).await.map_err(err)
}

#[tauri::command]
async fn meta_children(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    path: Vec<String>,
) -> CmdResult<Vec<MetaNode>> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    h.run(move |d| d.children(&path)).await.map_err(err)
}

#[tauri::command]
async fn table_columns(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    obj: ObjectRef,
) -> CmdResult<Vec<TableColumn>> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    h.run(move |d| d.table_columns(&obj)).await.map_err(err)
}

#[tauri::command]
async fn object_ddl(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    obj: ObjectRef,
) -> CmdResult<String> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    h.run(move |d| d.ddl(&obj)).await.map_err(err)
}

#[tauri::command]
async fn completion(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    database: String,
) -> CmdResult<CompletionSchema> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    h.run(move |d| d.completion(&database)).await.map_err(err)
}

#[tauri::command]
async fn list_databases(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> CmdResult<Vec<String>> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    h.run(|d| d.databases()).await.map_err(err)
}

#[tauri::command]
async fn use_database(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    database: String,
) -> CmdResult<String> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    h.run(move |d| {
        d.use_database(&database)?;
        d.current_database()
    })
    .await
    .map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectSql {
    qualified: String,
    select: String,
}

#[tauri::command]
async fn object_sql(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    obj: ObjectRef,
) -> CmdResult<ObjectSql> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    h.run(move |d| {
        let q = d.qualified_name(&obj);
        Ok(ObjectSql {
            select: format!("SELECT * FROM {q}"),
            qualified: q,
        })
    })
    .await
    .map_err(err)
}

#[tauri::command]
async fn quote_idents(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    names: Vec<String>,
) -> CmdResult<Vec<String>> {
    let h = state.sessions.get(&session_id).map_err(err)?;
    h.run(move |d| Ok(names.iter().map(|n| d.quote_ident(n)).collect()))
        .await
        .map_err(err)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    export_id: String,
    rows: u64,
}

#[tauri::command]
async fn export_query(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    conn_id: String,
    database: String,
    sql: String,
    export_id: String,
    options: export::ExportOptions,
) -> CmdResult<u64> {
    let cfg = state.conn(&conn_id)?;
    let mssql = cfg.kind == DbKind::Mssql;
    let connector = state.make_connector(cfg)?;
    let h = SessionHandle::open(conn_id, connector).await.map_err(err)?;
    let h = Arc::new(h);
    // Se registra para poder cancelarla con `cancel(export_id)`.
    state.sessions.insert(export_id.clone(), h.clone());
    let eid = export_id.clone();
    let res = h
        .run(move |d| {
            if !database.is_empty() {
                let _ = d.use_database(&database);
            }
            let last = std::cell::Cell::new(std::time::Instant::now());
            export::export(d, &sql, &options, mssql, &|rows| {
                if last.get().elapsed().as_millis() > 250 {
                    last.set(std::time::Instant::now());
                    let _ = app.emit(
                        "export-progress",
                        ExportProgress {
                            export_id: eid.clone(),
                            rows,
                        },
                    );
                }
            })
        })
        .await;
    state.sessions.remove(&export_id);
    res.map_err(err)
}

#[tauri::command]
fn add_history(state: State<'_, Arc<AppState>>, entry: HistoryEntry) -> CmdResult<()> {
    state.store.add_history(&entry).map_err(err)
}

#[tauri::command]
fn get_history(state: State<'_, Arc<AppState>>, filter: String, limit: usize) -> Vec<HistoryEntry> {
    state.store.history(&filter, limit)
}

#[tauri::command]
fn clear_history(state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    state.store.clear_history().map_err(err)
}

// Off the main thread: a locked file is retried for a moment.
#[tauri::command(async)]
fn load_json(state: State<'_, Arc<AppState>>, name: String) -> CmdResult<serde_json::Value> {
    if !matches!(name.as_str(), "settings" | "workspace" | "library") {
        return Err("Nombre no permitido".into());
    }
    state.store.load_json(&format!("{name}.json")).map_err(err)
}

/// Ajustes y biblioteca, que comparten todas las ventanas. `merge`: `value` trae solo unas claves, que se
/// ponen sobre lo que tiene el fichero (dos ventanas que cambian ajustes distintos a la vez no se deshacen nada).
/// La disposición de las ventanas (`workspace.json`) la escribe windows.rs con la parte de cada una.
#[tauri::command]
fn save_json(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<AppState>>,
    name: String,
    value: serde_json::Value,
    merge: Option<bool>,
) -> CmdResult<()> {
    if !matches!(name.as_str(), "settings" | "library") {
        return Err("Nombre no permitido".into());
    }
    let file = format!("{name}.json");
    let _writing = state.files.lock();
    let value = if merge.unwrap_or(false) {
        merged(state.store.read(&file).as_deref(), value)
    } else {
        value
    };
    state
        .store
        .write_atomic(&file, &serde_json::to_string(&value).map_err(err)?)
        .map_err(err)?;
    // Las demás ventanas se ponen al día (windows.ts, "celer://shared").
    let _ = window.emit("celer://shared", serde_json::json!({ "name": name, "value": value, "from": window.label() }));
    Ok(())
}

/// Las claves de primer nivel de `patch` sobre el objeto de `current` (lo que no sea un objeto se descarta).
fn merged(current: Option<&str>, patch: serde_json::Value) -> serde_json::Value {
    let mut base = current
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    if let (Some(target), serde_json::Value::Object(changes)) = (base.as_object_mut(), patch) {
        for (key, value) in changes {
            target.insert(key, value);
        }
    }
    base
}

#[tauri::command]
fn read_text_file(path: String) -> CmdResult<TextFile> {
    let bytes = std::fs::read(&path).map_err(err)?;
    let encoding = detect_encoding(&bytes).to_string();
    Ok(TextFile { text: decode_text(&bytes), encoding })
}

#[derive(Serialize)]
struct TextFile {
    text: String,
    /// utf-8 | utf-8-bom | utf-16le | utf-16be | windows-1252: saving writes it back the same way.
    encoding: String,
}

/// La codificación que `decode_text` usa para estos bytes.
fn detect_encoding(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return "utf-8-bom";
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return "utf-16le";
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return "utf-16be";
    }
    if bytes.len() >= 4 {
        let sample = &bytes[..bytes.len().min(4096) & !1];
        let zeros = |offset: usize| sample.iter().skip(offset).step_by(2).filter(|&&b| b == 0).count();
        let half = sample.len() / 2;
        if zeros(1) * 10 > half * 6 && zeros(0) * 10 < half {
            return "utf-16le";
        }
        if zeros(0) * 10 > half * 6 && zeros(1) * 10 < half {
            return "utf-16be";
        }
    }
    if std::str::from_utf8(bytes).is_ok() {
        "utf-8"
    } else {
        "windows-1252"
    }
}

/// Texto en la codificación pedida. Windows-1252 solo si todos los caracteres caben; si no, UTF-8 (devuelve la
/// codificación usada).
fn encode_text(text: &str, encoding: &str) -> (Vec<u8>, &'static str) {
    match encoding {
        "utf-8-bom" => ([&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat(), "utf-8-bom"),
        "utf-16le" => ([0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(|u| u.to_le_bytes())).collect(), "utf-16le"),
        "utf-16be" => ([0xFE, 0xFF].into_iter().chain(text.encode_utf16().flat_map(|u| u.to_be_bytes())).collect(), "utf-16be"),
        "windows-1252" => {
            let bytes: Option<Vec<u8>> = text
                .chars()
                .map(|c| (0u8..=255).find(|&b| windows_1252(b) == c))
                .collect();
            match bytes {
                Some(b) => (b, "windows-1252"),
                None => (text.as_bytes().to_vec(), "utf-8"),
            }
        }
        _ => (text.as_bytes().to_vec(), "utf-8"),
    }
}

/// Texto de un fichero .sql con la codificación detectada: BOM de UTF-8 o UTF-16 (LE/BE), UTF-16 sin BOM
/// (muchos ceros alternos, como los que guarda SSMS), UTF-8 válido y, si no, Windows-1252 (ANSI de Windows).
fn decode_text(bytes: &[u8]) -> String {
    let utf16 = |data: &[u8], le: bool| {
        let units = data
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&units)
    };
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest, true);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(rest, false);
    }
    if bytes.len() >= 4 {
        let sample = &bytes[..bytes.len().min(4096) & !1];
        let zeros = |offset: usize| sample.iter().skip(offset).step_by(2).filter(|&&b| b == 0).count();
        let half = sample.len() / 2;
        if zeros(1) * 10 > half * 6 && zeros(0) * 10 < half {
            return utf16(bytes, true);
        }
        if zeros(0) * 10 > half * 6 && zeros(1) * 10 < half {
            return utf16(bytes, false);
        }
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.iter().map(|&b| windows_1252(b)).collect(),
    }
}

/// Un byte de Windows-1252: igual que Latin-1 salvo 0x80–0x9F (€, comillas tipográficas, guiones…).
fn windows_1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    if (0x80..0xA0).contains(&b) {
        HIGH[(b - 0x80) as usize]
    } else {
        b as char
    }
}

#[cfg(test)]
mod text_tests {
    use super::decode_text;

    #[test]
    fn decodes_common_encodings() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFSELECT 'a\xC3\xB1o'"), "SELECT 'año'");
        assert_eq!(decode_text("SELECT 'año'".as_bytes()), "SELECT 'año'");
        let le: Vec<u8> = [0xFF, 0xFE].into_iter().chain("SELECT 'ñ'".encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
        assert_eq!(decode_text(&le), "SELECT 'ñ'");
        let be: Vec<u8> = [0xFE, 0xFF].into_iter().chain("SELECT 1".encode_utf16().flat_map(|u| u.to_be_bytes())).collect();
        assert_eq!(decode_text(&be), "SELECT 1");
        let no_bom: Vec<u8> = "SELECT 'año' FROM t".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(decode_text(&no_bom), "SELECT 'año' FROM t");
        assert_eq!(decode_text(b"SELECT 'a\xF1o \x80'"), "SELECT 'año €'");
    }

    #[test]
    fn round_trips_every_encoding() {
        use super::{detect_encoding, encode_text};
        let text = "SELECT 'año €' -- ñ";
        for encoding in ["utf-8", "utf-8-bom", "utf-16le", "utf-16be", "windows-1252"] {
            let (bytes, used) = encode_text(text, encoding);
            assert_eq!(used, encoding);
            assert_eq!(detect_encoding(&bytes), encoding, "{encoding}");
            assert_eq!(decode_text(&bytes), text, "{encoding}");
        }
        // Not representable in Windows-1252: saved as UTF-8 instead.
        assert_eq!(encode_text("中文", "windows-1252").1, "utf-8");
    }
}

#[tauri::command]
fn write_text_file(path: String, content: String, encoding: Option<String>) -> CmdResult<String> {
    let (bytes, used) = encode_text(&content, encoding.as_deref().unwrap_or("utf-8"));
    std::fs::write(&path, bytes).map_err(err)?;
    Ok(used.to_string())
}

/// Una hoja de un libro Excel u OpenDocument, para importarla.
#[tauri::command]
async fn read_spreadsheet(path: String, sheet: Option<String>) -> CmdResult<sheets::Sheet> {
    tauri::async_runtime::spawn_blocking(move || sheets::read(&path, sheet.as_deref()))
        .await
        .map_err(err)?
        .map_err(err)
}

#[tauri::command]
fn odbc_drivers() -> CmdResult<Vec<String>> {
    odbc::list_drivers().map_err(err)
}

#[tauri::command]
fn odbc_dsns() -> CmdResult<Vec<String>> {
    odbc::list_dsns().map_err(err)
}

#[tauri::command]
fn ibm_driver_status(state: State<'_, Arc<AppState>>) -> Option<String> {
    drivers::find_cli(state.ibm_driver_setting().as_deref(), &state.store.dir)
        .map(|p| p.to_string_lossy().to_string())
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    done: u64,
    total: u64,
    /// What is being downloaded, for the drivers (several files in a row).
    what: String,
}

#[tauri::command]
async fn ibm_driver_download(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<String> {
    let dir = state.store.dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let last = std::cell::Cell::new(0u64);
        drivers::download(&dir, |done, total| {
            if done - last.get() > 512 * 1024 || done == total {
                last.set(done);
                let _ = app.emit("driver-download", DownloadProgress { done, total, what: "IBM Data Server Driver".into() });
            }
        })
        .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(err)?
    .map_err(err)
}

/// Informix drivers on this machine, for Settings › Drivers: IBM CLI, Java and the JDBC driver (every one found, and
/// the one connections use), and the Client SDK's ODBC driver.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InformixDrivers {
    cli: Option<String>,
    java: Vec<drivers::JavaFound>,
    java_used: Option<drivers::JavaFound>,
    java_min: u32,
    jdbc: Vec<drivers::JdbcFound>,
    jdbc_used: Option<drivers::JdbcFound>,
    jdbc_version: &'static str,
    odbc: Vec<String>,
    /// The Client SDK's driver is registered under the name Celer uses: "Automático" takes it.
    sdk_ready: bool,
    /// The JDBC bridge is part of this build.
    bridge: bool,
    /// Celer can download a JRE for this system.
    jre_download: bool,
}

#[tauri::command(async)]
fn informix_drivers(state: State<'_, Arc<AppState>>) -> InformixDrivers {
    let store = &state.store;
    let java = drivers::find_java(setting(store, "javaPath").as_deref(), &store.dir, true);
    let jdbc = drivers::find_jdbc(&drivers::INFORMIX_JDBC, setting(store, "informixJdbcPath").as_deref(), &store.dir);
    let odbc = odbc::informix_odbc_drivers();
    InformixDrivers {
        cli: drivers::find_cli(ibm_driver_setting(store).as_deref(), &store.dir).map(|p| p.to_string_lossy().to_string()),
        java_used: drivers::pick_java(&java).cloned(),
        java,
        java_min: drivers::JAVA_MIN,
        jdbc_used: jdbc.first().cloned(),
        jdbc,
        jdbc_version: drivers::INFORMIX_JDBC.jar.version,
        sdk_ready: odbc.iter().any(|d| d.eq_ignore_ascii_case(odbc::IFX_ODBC_DRIVER)),
        odbc,
        bridge: jdbc::bridge_included(),
        jre_download: drivers::adoptium_platform().is_some(),
    }
}

/// Downloads what Informix over JDBC needs, only when the user asks for it: "java" (Temurin JRE 21, which the
/// interface offers only when no Java was found) or "jdbc" (the driver, from Maven Central). Nothing is run here.
#[tauri::command]
async fn jdbc_download(app: tauri::AppHandle, state: State<'_, Arc<AppState>>, what: String) -> CmdResult<String> {
    let dir = state.store.dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let last = std::cell::Cell::new(0u64);
        let progress = |label: &str, done: u64, total: u64| {
            if done < last.get() || done - last.get() > 256 * 1024 || done == total {
                last.set(done);
                let _ = app.emit("driver-download", DownloadProgress { done, total, what: label.to_string() });
            }
        };
        match what.as_str() {
            "java" => drivers::download_jre(&dir, progress).map(|p| p.to_string_lossy().to_string()),
            "jdbc" => drivers::download_jdbc(&drivers::INFORMIX_JDBC, &dir, progress).map(|f| f.jars.join("\n")),
            _ => Err(anyhow::anyhow!("Descarga desconocida: {what}")),
        }
    })
    .await
    .map_err(err)?
    .map_err(err)
}

#[tauri::command]
fn driver_download_cancel() {
    drivers::cancel_download();
}

/// Starts the bridge with the Java and driver connections would use and loads the driver: what it answers.
#[tauri::command]
async fn jdbc_check(state: State<'_, Arc<AppState>>) -> CmdResult<String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (rt, label) = jdbc_runtime(&app.store)?;
        let version = jdbc::check(&rt).map_err(err)?;
        Ok(format!("{label} · driver {version} cargado"))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
fn app_info(state: State<'_, Arc<AppState>>) -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "dataDir": state.store.dir.to_string_lossy(),
    })
}

// ───────────── Migración desde otras herramientas ─────────────

/// Connection files of DBeaver and DbVisualizer found on this machine (read-only).
#[tauri::command]
async fn migration_sources() -> Vec<migrate::SourceFile> {
    tauri::async_runtime::spawn_blocking(migrate::find_sources).await.unwrap_or_default()
}

/// DBeaver's encrypted credentials next to a listed data-sources.json: only when the user ticked «Importar también las
/// contraseñas guardadas» and pressed Importar.
#[tauri::command]
async fn migration_dbeaver_credentials(path: String) -> CmdResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || migrate::dbeaver_credentials(&path)).await.map_err(err)?
}

// ───────────── Actualizaciones ─────────────

#[tauri::command]
async fn update_check() -> CmdResult<update::UpdateInfo> {
    tauri::async_runtime::spawn_blocking(update::check).await.map_err(err)?.map_err(err)
}

/// Where updates are downloaded: `updates` in Celer's local data folder (%LOCALAPPDATA%\es.celer.app on Windows: not
/// the roaming profile, and not the system's temp folder). Debug builds with `CELER_DATA_DIR` use that folder.
fn updates_dir(app: &tauri::AppHandle) -> PathBuf {
    let base = dev_data_dir()
        .or_else(|| app.path().app_local_data_dir().ok())
        .unwrap_or_else(|| app.state::<Arc<AppState>>().store.dir.clone());
    base.join(update::DOWNLOAD_SUBDIR)
}

/// Runs only when the user presses «Actualizar» in the update dialog.
#[tauri::command]
async fn update_download(app: tauri::AppHandle, url: String, name: String, sums_url: String) -> CmdResult<String> {
    let dir = updates_dir(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let last = std::cell::Cell::new(0u64);
        update::download(&dir, &url, &name, &sums_url, |done, total| {
            if done - last.get() > 256 * 1024 || done == total {
                last.set(done);
                let _ = app.emit("update-download", DownloadProgress { done, total, what: String::new() });
            }
        })
        .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(err)?
    .map_err(err)
}

/// Lanza el instalador descargado y cierra Celer (el instalador espera a que termine de cerrarse).
/// El front ya ha pasado por la guarda de cierre (transacciones abiertas, ediciones sin guardar).
#[tauri::command]
fn update_install(app: tauri::AppHandle, path: String, relaunch: bool) -> CmdResult<()> {
    update::launch_installer(&updates_dir(&app), std::path::Path::new(&path), relaunch).map_err(err)?;
    if !relaunch {
        // The window is already closing on its own.
        return Ok(());
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        app.exit(0);
    });
    Ok(())
}

// ───────────── MCP (asistentes de IA externos) ─────────────

#[tauri::command]
fn mcp_config_get(state: State<'_, Arc<AppState>>) -> mcp::McpConfig {
    mcp::load_config(&state.store)
}

#[tauri::command]
fn mcp_config_set(state: State<'_, Arc<AppState>>, config: mcp::McpConfig) -> CmdResult<()> {
    mcp::save_config(&state.store, config).map_err(err)
}

#[tauri::command]
fn mcp_audit(state: State<'_, Arc<AppState>>, limit: usize) -> Vec<mcp::AuditEntry> {
    mcp::read_audit(&state.store, limit)
}

#[tauri::command]
fn mcp_clear_audit(state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    mcp::clear_audit(&state.store).map_err(err)
}

#[tauri::command]
fn mcp_client_info() -> mcp::ClientInfo {
    mcp::client_info()
}

#[tauri::command]
fn mcp_install_claude_desktop() -> CmdResult<String> {
    mcp::install_claude_desktop()
}

/// Ejecuta una herramienta MCP con los permisos actuales (sin exigir `enabled` y sin auditar).
/// Devuelve `{ isError, text, json }`: `text` es exactamente lo que recibiría el asistente.
#[tauri::command]
async fn mcp_test_tool(
    state: State<'_, Arc<AppState>>,
    name: String,
    args: serde_json::Value,
) -> CmdResult<serde_json::Value> {
    if !mcp::TOOL_NAMES.contains(&name.as_str()) {
        return Err(format!("Herramienta desconocida: {name}"));
    }
    Ok(state.mcp.call_tool(&name, &args).await.to_preview())
}

// ───────────── Clave de la API del asistente integrado ─────────────

const AI_KEY_ID: &str = "celer-ai-anthropic-key";

/// Solo en el almacén de credenciales del sistema: nunca se escribe en un fichero JSON
/// (a diferencia de `Store::set_password`, que tiene `secrets.json` como alternativa).
fn ai_key_entry() -> CmdResult<keyring::Entry> {
    keyring::Entry::new(store::keyring_service(), AI_KEY_ID).map_err(err)
}

#[tauri::command]
fn ai_key_get() -> Option<String> {
    store::keyring_get(AI_KEY_ID).filter(|k| !k.is_empty())
}

#[tauri::command]
fn ai_key_status() -> bool {
    ai_key_get().is_some()
}

#[tauri::command]
fn ai_key_set(key: String) -> CmdResult<()> {
    let entry = ai_key_entry()?;
    let key = key.trim();
    store::mark_deleted(AI_KEY_ID, key.is_empty());
    if key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(err(e)),
        }
    } else {
        entry.set_password(key).map_err(err)
    }
}

/// `celer --mcp`: servidor MCP por stdio, sin ventana. Devuelve el código de salida.
pub fn run_mcp() -> i32 {
    mcp::serve_stdio()
}

/// Debug builds only: `CELER_DATA_DIR` points the app at a separate data folder, so automated tests never touch
/// the configuration of an installed copy.
pub(crate) fn dev_data_dir() -> Option<std::path::PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os("CELER_DATA_DIR").filter(|v| !v.is_empty()).map(std::path::PathBuf::from)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = dev_data_dir().unwrap_or_else(|| {
                app.path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::env::temp_dir().join("celer"))
            });
            let store = Store::new(dir.clone());
            let conns = store.load_connections();
            let mcp = mcp::McpServer::new(dir, true);
            // The window starts hidden and the UI shows it after its first paint (no white flash).
            // Safety net: show it anyway if the UI has not done so shortly after start.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                });
            }
            app.manage(Arc::new(AppState {
                store,
                conns: Mutex::new(conns),
                sessions: Sessions::default(),
                trash: Mutex::new(HashMap::new()),
                mcp,
                files: Mutex::new(()),
            }));
            app.manage(windows::Windows::default());
            Ok(())
        })
        .on_window_event(windows::on_event)
        .invoke_handler(tauri::generate_handler![
            list_connections,
            save_connection,
            reorder_connections,
            delete_connection,
            restore_connection,
            duplicate_connection,
            test_connection,
            open_session,
            check_session,
            close_session,
            close_connection_sessions,
            read_spreadsheet,
            execute,
            fetch,
            close_cursor,
            cancel,
            session_progress,
            set_autocommit,
            commit,
            rollback,
            meta_children,
            table_columns,
            object_ddl,
            completion,
            list_databases,
            use_database,
            object_sql,
            quote_idents,
            export_query,
            add_history,
            get_history,
            clear_history,
            load_json,
            save_json,
            read_text_file,
            write_text_file,
            odbc_drivers,
            odbc_dsns,
            ibm_driver_status,
            ibm_driver_download,
            informix_drivers,
            jdbc_download,
            jdbc_check,
            jdbc_prewarm,
            driver_download_cancel,
            app_info,
            migration_sources,
            migration_dbeaver_credentials,
            update_check,
            update_download,
            update_install,
            mcp_config_get,
            mcp_config_set,
            mcp_audit,
            mcp_clear_audit,
            mcp_client_info,
            mcp_install_claude_desktop,
            mcp_test_tool,
            ai_key_status,
            ai_key_set,
            ai_key_get,
            windows::window_open,
            windows::window_inbox,
            windows::window_post,
            windows::window_list,
            windows::window_layout_load,
            windows::window_report,
            windows::window_forget,
            windows::window_screen,
            windows::window_place,
            windows::window_raise,
            windows::window_quit,
            windows::tab_drag_start,
            windows::tab_drag_claim,
            windows::tab_drag_end,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Celer");
}
