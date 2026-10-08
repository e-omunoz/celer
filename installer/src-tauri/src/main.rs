// Celer Setup: instalador/desinstalador por usuario de Celer.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod setup;
mod win;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use setup::{InstallOptions, Layout, Payload, Progress};

const PROGRESS_EVENT: &str = "setup-progress";

static BUSY: AtomicBool = AtomicBool::new(false);

fn has_flag(flag: &str) -> bool {
    std::env::args().skip(1).any(|a| a.eq_ignore_ascii_case(flag))
}

fn is_uninstall() -> bool {
    has_flag("--uninstall")
}

/// `--update`: lanzado por Celer al actualizarse. Sin preguntas: mismas opciones, espera a que la app
/// se cierre, instala y vuelve a abrirla.
fn is_update() -> bool {
    has_flag("--update") && !is_uninstall()
}

const CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

fn mb(bytes: u64) -> f64 {
    (bytes as f64 / 1_048_576.0 * 10.0).round() / 10.0
}

struct BusyGuard;
impl BusyGuard {
    fn take() -> Result<BusyGuard, String> {
        if BUSY.swap(true, Ordering::SeqCst) {
            Err("Ya hay una operación en curso.".into())
        } else {
            Ok(BusyGuard)
        }
    }
}
impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------- comandos

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupInfo {
    version: String,
    default_dir: String,
    payload_mb: f64,
    existing: Option<setup::Existing>,
    free_mb: f64,
    webview2: bool,
    is_uninstall: bool,
    /// Modo actualización: las opciones de la instalación actual (la UI instala sin preguntar).
    update: Option<InstallOptions>,
}

#[tauri::command]
fn setup_info() -> SetupInfo {
    let payload = Payload::embedded();
    let layout = Layout::real();
    let uninstalling = is_uninstall();
    let mut existing = setup::read_existing(&layout);
    if uninstalling {
        // Al desinstalar, la carpeta real es la del propio uninstall.exe.
        if let Ok(dir) = std::env::current_exe().map_err(|e| e.to_string()).and_then(|exe| setup::resolve_uninstall_dir(&layout, &exe)) {
            let version = existing.as_ref().map(|e| e.version.clone()).unwrap_or_default();
            existing = Some(setup::Existing { dir: dir.display().to_string(), version });
        }
    }
    let default_dir = existing
        .as_ref()
        .filter(|_| !uninstalling)
        .map(|e| PathBuf::from(&e.dir))
        .filter(|d| setup::validate_install_dir(&d.to_string_lossy(), &layout.sys).is_ok())
        .unwrap_or_else(setup::default_dir);
    // defaultDir: la instalación existente si la hay (actualizar in situ); si no, %LOCALAPPDATA%\Programs\Celer.
    let free_mb = win::free_bytes(&default_dir).map(mb).unwrap_or(0.0);
    let update = (is_update() && existing.is_some()).then(|| setup::current_options(&layout, &default_dir));
    SetupInfo {
        update,
        version: payload.version.to_string(),
        default_dir: default_dir.display().to_string(),
        payload_mb: mb(payload.size),
        existing,
        free_mb,
        webview2: webview2_installed(),
        is_uninstall: uninstalling,
    }
}

#[tauri::command]
fn drive_free(dir: String) -> f64 {
    let p = PathBuf::from(dir.trim());
    if !p.is_absolute() {
        return 0.0;
    }
    win::free_bytes(&p).map(mb).unwrap_or(0.0)
}

#[tauri::command]
async fn pick_dir(app: AppHandle, current: String) -> Option<String> {
    // Abrir en la carpeta actual o en su primer ancestro existente.
    let mut start = PathBuf::from(current.trim());
    while !start.as_os_str().is_empty() && !start.is_dir() {
        if !start.pop() {
            break;
        }
    }
    let start = start.is_dir().then_some(start);
    let owner = app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        win::pick_folder(owner, start.as_deref(), "Elige la carpeta de instalación")
    })
    .await
    .ok()??;
    // Si el usuario elige una carpeta que no se llama Celer, se propone una subcarpeta Celer.
    let named_celer = picked.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case("Celer")).unwrap_or(false);
    let out = if named_celer || setup::exe_path(&picked).is_file() { picked } else { picked.join("Celer") };
    Some(out.display().to_string())
}

#[tauri::command]
async fn install(app: AppHandle, options: InstallOptions) -> Result<String, String> {
    let _busy = BusyGuard::take()?;
    let handle = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let setup_exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let layout = Layout::real();
        let payload = Payload::embedded();
        let mut emit = |p: Progress| {
            let _ = handle.emit(PROGRESS_EVENT, p);
        };
        if is_update() {
            emit(Progress { step: setup::Step::Prepare, pct: 0.0, detail: "Esperando a que Celer se cierre".into() });
            if !setup::wait_until_closed(Path::new(&options.dir), CLOSE_TIMEOUT) {
                return Err("Celer sigue abierto. Ciérralo y pulsa Reintentar.".to_string());
            }
        }
        setup::install(&layout, &payload, &options, &setup_exe, &mut emit)
    })
    .await
    .map_err(|e| format!("Error interno del instalador: {e}"))??;
    Ok(res.display().to_string())
}

#[tauri::command]
fn launch(path: String) -> Result<(), String> {
    setup::launch(Path::new(&path))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UninstallOptions {
    #[serde(default = "yes")]
    keep_data: bool,
}
fn yes() -> bool {
    true
}

/// Devuelve la ruta de `uninstall.exe` si se queda en la carpeta (es el proceso en ejecución; ver `UninstallOutcome`).
#[tauri::command]
async fn uninstall(app: AppHandle, options: UninstallOptions) -> Result<Option<String>, String> {
    let _busy = BusyGuard::take()?;
    let handle = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let me = std::env::current_exe().map_err(|e| e.to_string())?;
        let layout = Layout::real();
        let dir = setup::resolve_uninstall_dir(&layout, &me)?;
        let mut emit = |p: Progress| {
            let _ = handle.emit(PROGRESS_EVENT, p);
        };
        setup::uninstall(&layout, &dir, options.keep_data, &me, &mut emit)
    })
    .await
    .map_err(|e| format!("Error interno del desinstalador: {e}"))??;
    Ok(outcome.left_behind.map(|p| p.display().to_string()))
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

// ---------------------------------------------------------------- WebView2

fn webview2_installed() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY};
    use winreg::RegKey;
    const CLIENT: &str = r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let ok = |root, flags| {
        RegKey::predef(root)
            .open_subkey_with_flags(CLIENT, KEY_READ | flags)
            .and_then(|k| k.get_value::<String, _>("pv"))
            .map(|v| !v.is_empty() && v != "0.0.0.0")
            .unwrap_or(false)
    };
    ok(HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY) || ok(HKEY_LOCAL_MACHINE, 0) || ok(HKEY_CURRENT_USER, 0)
}

// ---------------------------------------------------------------- modo silencioso

/// `celer-setup.exe --silent [--dir <ruta>] [--desktop] [--no-start-menu] [--associate-sql] [--launch]`
/// `uninstall.exe --uninstall --silent [--purge-data]`
/// Errores en `%TEMP%\celer-setup.log`; código de salida 0/1.
fn run_silent() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let layout = Layout::real();
    let me = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return log_exit(Err(e.to_string())),
    };
    let mut noop = |_: Progress| {};
    if is_uninstall() {
        let res = setup::resolve_uninstall_dir(&layout, &me)
            .and_then(|dir| setup::uninstall(&layout, &dir, !has_flag("--purge-data"), &me, &mut noop));
        let res = res.map(|out| match &out.left_behind {
            Some(exe) => format!("desinstalado ({} queda hasta la próxima instalación)", exe.display()),
            None => "desinstalado".to_string(),
        });
        return log_exit(res);
    }
    let dir = args
        .iter()
        .position(|a| a.eq_ignore_ascii_case("--dir"))
        .and_then(|i| args.get(i + 1).cloned())
        .or_else(|| setup::read_existing(&layout).map(|e| e.dir))
        .unwrap_or_else(|| setup::default_dir().display().to_string());
    let opts = if is_update() && setup::read_existing(&layout).is_some() {
        // --silent --update: same options as the current install, after the app has closed
        // (Celer reopens only with --launch: the user closed it on purpose).
        let mut opts = setup::current_options(&layout, Path::new(&dir));
        opts.launch_after = has_flag("--launch");
        if !setup::wait_until_closed(Path::new(&opts.dir), CLOSE_TIMEOUT) {
            return log_exit(Err("Celer sigue abierto; no se ha actualizado.".into()));
        }
        opts
    } else {
        InstallOptions {
            dir,
            desktop_shortcut: has_flag("--desktop"),
            start_menu: !has_flag("--no-start-menu"),
            associate_sql: has_flag("--associate-sql"),
            launch_after: has_flag("--launch"),
        }
    };
    let res = setup::install(&layout, &Payload::embedded(), &opts, &me, &mut noop);
    if let (Ok(exe), true) = (&res, opts.launch_after) {
        let _ = setup::launch(exe);
    }
    log_exit(res.map(|p| format!("instalado en {}", p.display())))
}

fn log_exit(res: Result<String, String>) -> i32 {
    use std::io::Write;
    let (code, line) = match &res {
        Ok(m) => (0, format!("OK: {m}")),
        Err(e) => (1, format!("ERROR: {e}")),
    };
    if let Ok(mut f) =
        std::fs::OpenOptions::new().create(true).append(true).open(std::env::temp_dir().join("celer-setup.log"))
    {
        let _ = writeln!(f, "{line}");
    }
    code
}

// ---------------------------------------------------------------- main

fn main() {
    if has_flag("--silent") {
        std::process::exit(run_silent());
    }
    let uninstalling = is_uninstall();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![setup_info, drive_free, pick_dir, install, launch, uninstall, quit])
        .setup(move |app| {
            let cfg = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .expect("ventana main en tauri.conf.json");
            // Perfil de WebView2 en %TEMP%: el instalador no deja carpetas en AppData.
            let data = std::env::temp_dir().join("celer-setup-webview");
            let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg)?.data_directory(data);
            if uninstalling {
                builder = builder.title("Desinstalar Celer");
            }
            let window = builder.build()?;
            // Red de seguridad: si la UI no llega a mostrar la ventana, mostrarla igualmente.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                if !window.is_visible().unwrap_or(true) {
                    let _ = window.show();
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("no se pudo iniciar Celer Setup");
    app.run(|_, _| {});
}
