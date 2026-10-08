mod drivers;
mod export;
mod mcp;
mod migrate;
mod model;
mod mssql;
mod mysql;
mod odbc;
mod odbc_driver;
mod postgres;
mod session;
mod sqlite;
mod store;
mod update;

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
    /// Servidor MCP en modo vista previa (para que la interfaz muestre lo que vería la IA).
    mcp: mcp::McpServer,
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
    store
        .load_json("settings.json")
        .get("ibmDriverPath")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Prepara la conexión (contraseña del almacén, driver IBM/ODBC). La usan la interfaz y el
/// servidor MCP, que no tiene `State` de Tauri.
pub(crate) fn make_connector(
    store: &Store,
    mut cfg: ConnConfig,
) -> CmdResult<impl FnOnce() -> anyhow::Result<Box<dyn Driver>> + Send + 'static> {
    if cfg.password.is_none() && !cfg.integrated_auth {
        cfg.password = store.get_password(&cfg.id);
    }
    let kind = cfg.kind;
    let odbc_lib = match kind {
        DbKind::Mssql | DbKind::Sqlite | DbKind::Postgres | DbKind::Mysql => None,
        DbKind::Informix if cfg.informix_mode == "drda" => {
            let dll = drivers::find_cli(ibm_driver_setting(store).as_deref(), &store.dir).ok_or_else(|| {
                "IBM_DRIVER_MISSING: No se encontró el driver IBM Data Server (ODBC/CLI). Descárgalo desde Ajustes → Drivers.".to_string()
            })?;
            drivers::prepare_env(&dll);
            Some(dll.to_string_lossy().to_string())
        }
        DbKind::Informix | DbKind::Odbc => Some(odbc::system_manager().to_string()),
    };
    Ok(move || -> anyhow::Result<Box<dyn Driver>> {
        match kind {
            DbKind::Sqlite => Ok(Box::new(sqlite::SqliteDriver::connect(cfg)?)),
            DbKind::Mssql => Ok(Box::new(mssql::MssqlDriver::connect(cfg)?)),
            DbKind::Postgres => Ok(Box::new(postgres::PostgresDriver::connect(cfg)?)),
            DbKind::Mysql => Ok(Box::new(mysql::MysqlDriver::connect(cfg)?)),
            DbKind::Informix | DbKind::Odbc => {
                let path = odbc_lib.unwrap_or_else(|| odbc::system_manager().to_string());
                Ok(Box::new(odbc_driver::OdbcDriver::connect(cfg, path)?))
            }
        }
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnSummary {
    #[serde(flatten)]
    cfg: ConnConfig,
    has_password: bool,
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
fn save_connection(state: State<'_, Arc<AppState>>, mut cfg: ConnConfig) -> CmdResult<ConnConfig> {
    if cfg.id.is_empty() {
        cfg.id = uuid::Uuid::new_v4().to_string();
    }
    if cfg.save_password {
        if let Some(p) = cfg.password.as_ref().filter(|p| !p.is_empty()) {
            state.store.set_password(&cfg.id, p).map_err(err)?;
        }
    } else {
        state.store.delete_password(&cfg.id);
    }
    cfg.password = None;
    let mut conns = state.conns.lock();
    match conns.iter_mut().find(|c| c.id == cfg.id) {
        Some(c) => *c = cfg.clone(),
        None => conns.push(cfg.clone()),
    }
    state.store.save_connections(&conns).map_err(err)?;
    Ok(cfg)
}

#[tauri::command]
fn reorder_connections(state: State<'_, Arc<AppState>>, ids: Vec<String>) -> CmdResult<()> {
    let mut conns = state.conns.lock();
    conns.sort_by_key(|c| ids.iter().position(|i| *i == c.id).unwrap_or(usize::MAX));
    state.store.save_connections(&conns).map_err(err)
}

#[tauri::command]
fn delete_connection(state: State<'_, Arc<AppState>>, id: String) -> CmdResult<()> {
    for s in state.sessions.remove_for_conn(&id) {
        s.cancel();
    }
    state.store.delete_password(&id);
    let mut conns = state.conns.lock();
    conns.retain(|c| c.id != id);
    state.store.save_connections(&conns).map_err(err)
}

#[tauri::command]
async fn test_connection(state: State<'_, Arc<AppState>>, cfg: ConnConfig) -> CmdResult<String> {
    let connector = state.make_connector(cfg)?;
    let t0 = std::time::Instant::now();
    let h = SessionHandle::open("test".into(), connector)
        .await
        .map_err(err)?;
    let connect_ms = t0.elapsed().as_millis();
    let t1 = std::time::Instant::now();
    let info = h.run(|d| d.server_info()).await.map_err(err)?;
    Ok(format!(
        "{info}\nConexión: {connect_ms} ms · ida y vuelta: {} ms",
        t1.elapsed().as_millis()
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    session_id: String,
    database: String,
    server_info: String,
}

#[tauri::command]
async fn open_session(
    state: State<'_, Arc<AppState>>,
    conn_id: String,
    password: Option<String>,
) -> CmdResult<SessionInfo> {
    let mut cfg = state.conn(&conn_id)?;
    if password.is_some() {
        cfg.password = password;
    }
    let connector = state.make_connector(cfg)?;
    let h = SessionHandle::open(conn_id, connector).await.map_err(err)?;
    let (database, server_info) = h
        .run(|d| {
            Ok((
                d.current_database().unwrap_or_default(),
                d.server_info().unwrap_or_default(),
            ))
        })
        .await
        .map_err(err)?;
    let id = uuid::Uuid::new_v4().to_string();
    state.sessions.insert(id.clone(), Arc::new(h));
    Ok(SessionInfo {
        session_id: id,
        database,
        server_info,
    })
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

#[tauri::command]
fn load_json(state: State<'_, Arc<AppState>>, name: String) -> CmdResult<serde_json::Value> {
    if !matches!(name.as_str(), "settings" | "workspace") {
        return Err("Nombre no permitido".into());
    }
    Ok(state.store.load_json(&format!("{name}.json")))
}

#[tauri::command]
fn save_json(
    state: State<'_, Arc<AppState>>,
    name: String,
    value: serde_json::Value,
) -> CmdResult<()> {
    if !matches!(name.as_str(), "settings" | "workspace") {
        return Err("Nombre no permitido".into());
    }
    state
        .store
        .write_atomic(
            &format!("{name}.json"),
            &serde_json::to_string(&value).map_err(err)?,
        )
        .map_err(err)
}

#[tauri::command]
fn read_text_file(path: String) -> CmdResult<String> {
    let bytes = std::fs::read(&path).map_err(err)?;
    let s = String::from_utf8(bytes.clone())
        .unwrap_or_else(|_| bytes.iter().map(|&b| b as char).collect());
    Ok(s.trim_start_matches('\u{feff}').to_string())
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> CmdResult<()> {
    std::fs::write(&path, content).map_err(err)
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
                let _ = app.emit("driver-download", DownloadProgress { done, total });
            }
        })
        .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(err)?
    .map_err(err)
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

// ───────────── Actualizaciones ─────────────

#[tauri::command]
async fn update_check() -> CmdResult<update::UpdateInfo> {
    tauri::async_runtime::spawn_blocking(update::check).await.map_err(err)?.map_err(err)
}

#[tauri::command]
async fn update_download(app: tauri::AppHandle, url: String, name: String, sums_url: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let last = std::cell::Cell::new(0u64);
        update::download(&url, &name, &sums_url, |done, total| {
            if done - last.get() > 256 * 1024 || done == total {
                last.set(done);
                let _ = app.emit("update-download", DownloadProgress { done, total });
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
    update::launch_installer(std::path::Path::new(&path), relaunch).map_err(err)?;
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
                mcp,
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_connections,
            save_connection,
            reorder_connections,
            delete_connection,
            test_connection,
            open_session,
            close_session,
            close_connection_sessions,
            execute,
            fetch,
            close_cursor,
            cancel,
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
            app_info,
            migration_sources,
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
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Celer");
}
