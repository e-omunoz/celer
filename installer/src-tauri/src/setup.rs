//! Lógica del instalador, independiente de Tauri (la usan los comandos, el modo
//! silencioso y los tests). Todas las rutas/claves que se tocan salen de [`Layout`],
//! de modo que los tests pueden usar nombres distintos (`CelerTest`).

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf, Prefix};

use serde::Serialize;
use winreg::enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS, KEY_READ};
use winreg::RegKey;

use crate::win;

pub const APP_IDENTIFIER: &str = "es.celer.app";
pub const APP_EXE: &str = "celer.exe";
pub const UNINSTALL_EXE: &str = "uninstall.exe";
pub const UNINSTALL_ROOT: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
pub const CLASSES_ROOT: &str = r"Software\Classes";

// ---------------------------------------------------------------- payload

/// Ejecutable de Celer comprimido (zstd) incrustado por build.rs.
pub struct Payload {
    pub compressed: &'static [u8],
    pub size: u64,
    pub version: &'static str,
}

impl Payload {
    pub fn embedded() -> Payload {
        Payload {
            compressed: include_bytes!(concat!(env!("OUT_DIR"), "/celer.exe.zst")),
            size: env!("CELER_PAYLOAD_SIZE").parse().expect("CELER_PAYLOAD_SIZE"),
            version: env!("CELER_VERSION"),
        }
    }
}

// ---------------------------------------------------------------- progreso

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Step {
    Prepare,
    Extract,
    Shortcuts,
    Register,
    Finish,
}

#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    pub step: Step,
    pub pct: f64,
    pub detail: String,
}

pub type ProgressFn<'a> = &'a mut dyn FnMut(Progress);

fn report(p: &mut dyn FnMut(Progress), step: Step, pct: f64, detail: impl Into<String>) {
    p(Progress { step, pct: pct.clamp(0.0, 100.0), detail: detail.into() });
}

// ---------------------------------------------------------------- layout

/// Carpetas del sistema que no se aceptan como destino.
#[derive(Clone, Debug, Default)]
pub struct SysDirs {
    /// Carpetas de Windows: ni ellas ni nada dentro.
    pub system: Vec<PathBuf>,
    /// Requieren administrador (Program Files, ProgramData): ni ellas ni nada dentro.
    pub admin: Vec<PathBuf>,
    /// Carpetas de usuario que no se aceptan *exactamente* (sí una subcarpeta).
    pub exact: Vec<PathBuf>,
}

impl SysDirs {
    pub fn real() -> SysDirs {
        let kf = |ids: &[&windows::core::GUID]| ids.iter().filter_map(|id| win::known_folder(id)).collect::<Vec<_>>();
        let mut system = kf(&[&win::FOLDERID_Windows]);
        if let Some(w) = std::env::var_os("SystemRoot") {
            system.push(PathBuf::from(w));
        }
        let mut admin = kf(&[&win::FOLDERID_ProgramFiles, &win::FOLDERID_ProgramFilesX86, &win::FOLDERID_ProgramData]);
        for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"] {
            if let Some(v) = std::env::var_os(var) {
                admin.push(PathBuf::from(v));
            }
        }
        let exact = kf(&[
            &win::FOLDERID_Profile,
            &win::FOLDERID_Desktop,
            &win::FOLDERID_Documents,
            &win::FOLDERID_Downloads,
            &win::FOLDERID_RoamingAppData,
            &win::FOLDERID_LocalAppData,
            &win::FOLDERID_UserProgramFiles,
            &win::FOLDERID_Programs,
        ]);
        SysDirs { system, admin, exact }
    }
}

/// Todo lo que el instalador crea fuera de la carpeta de instalación.
#[derive(Clone, Debug)]
pub struct Layout {
    /// Nombre de la subclave en `HKCU\...\Uninstall` ("Celer").
    pub uninstall_key: String,
    /// ProgID de la asociación ("Celer.sql").
    pub progid: String,
    /// Extensión asociada (".sql").
    pub ext: String,
    pub start_menu_lnk: PathBuf,
    pub desktop_lnk: PathBuf,
    /// Datos de usuario de la app; solo se borran si el usuario lo pide.
    pub data_dirs: Vec<PathBuf>,
    /// Carpetas donde una desinstalación anterior pudo dejar su `uninstall.exe` (la carpeta por defecto): la
    /// siguiente instalación lo retira.
    pub leftover_dirs: Vec<PathBuf>,
    pub sys: SysDirs,
}

impl Layout {
    pub fn real() -> Layout {
        let appdata = win::known_folder(&win::FOLDERID_RoamingAppData)
            .or_else(|| std::env::var_os("APPDATA").map(PathBuf::from))
            .unwrap_or_default();
        let local = win::known_folder(&win::FOLDERID_LocalAppData)
            .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
            .unwrap_or_default();
        let programs = win::known_folder(&win::FOLDERID_Programs)
            .unwrap_or_else(|| appdata.join(r"Microsoft\Windows\Start Menu\Programs"));
        let desktop = win::known_folder(&win::FOLDERID_Desktop).unwrap_or_default();
        let mut data_dirs = Vec::new();
        if !appdata.as_os_str().is_empty() {
            data_dirs.push(appdata.join(APP_IDENTIFIER));
        }
        if !local.as_os_str().is_empty() {
            data_dirs.push(local.join(APP_IDENTIFIER));
        }
        Layout {
            uninstall_key: "Celer".into(),
            progid: "Celer.sql".into(),
            ext: ".sql".into(),
            start_menu_lnk: programs.join("Celer.lnk"),
            desktop_lnk: desktop.join("Celer.lnk"),
            data_dirs,
            leftover_dirs: vec![default_dir()],
            sys: SysDirs::real(),
        }
    }

    pub fn uninstall_key_path(&self) -> String {
        format!(r"{UNINSTALL_ROOT}\{}", self.uninstall_key)
    }
}

/// `%LOCALAPPDATA%\Programs\Celer`
pub fn default_dir() -> PathBuf {
    win::known_folder(&win::FOLDERID_UserProgramFiles)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("Programs")))
        .unwrap_or_else(|| PathBuf::from(r"C:\Celer"))
        .join("Celer")
}

// ---------------------------------------------------------------- rutas (puras)

/// Clave de comparación de rutas: separadores `\`, sin barra final, minúsculas.
pub fn path_key(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\");
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    let t = s.trim_end_matches('\\');
    // "C:" -> "c:" ; mantener "c:" para la raíz
    t.to_lowercase()
}

/// ¿`p` es `base` o está dentro de `base`? (sin distinguir mayúsculas)
pub fn is_within(p: &Path, base: &Path) -> bool {
    let (a, b) = (path_key(p), path_key(base));
    !b.is_empty() && (a == b || a.starts_with(&format!("{b}\\")))
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    path_key(a) == path_key(b)
}

const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1",
    "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Valida la carpeta de instalación (sin tocar el disco). Devuelve la ruta normalizada.
pub fn validate_install_dir(input: &str, sys: &SysDirs) -> Result<PathBuf, String> {
    let raw = input.trim().replace('/', "\\");
    if raw.is_empty() {
        return Err("Indica una carpeta de instalación.".into());
    }
    if raw.starts_with(r"\\") {
        return Err("Elige una carpeta en una unidad local (no una ruta de red).".into());
    }
    let b = raw.as_bytes();
    if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' {
        return Err(r"La ruta debe ser absoluta, por ejemplo D:\Apps\Celer.".into());
    }
    let mut out = PathBuf::from(format!("{}:\\", (b[0] as char).to_ascii_uppercase()));
    let mut parts = 0;
    for part in raw[3..].split('\\') {
        if part.is_empty() {
            continue; // barras repetidas o final
        }
        if part == "." || part == ".." {
            return Err("La ruta no puede contener «.» ni «..».".into());
        }
        if let Some(c) = part.chars().find(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (*c as u32) < 32) {
            return Err(format!("La ruta contiene un carácter no válido: «{c}»."));
        }
        if part.ends_with(' ') || part.ends_with('.') {
            return Err(format!("«{part}» no es un nombre de carpeta válido (termina en espacio o punto)."));
        }
        let stem = part.split('.').next().unwrap_or("").trim_end().to_lowercase();
        if RESERVED.contains(&stem.as_str()) {
            return Err(format!("«{part}» es un nombre reservado de Windows."));
        }
        out.push(part);
        parts += 1;
    }
    if parts == 0 {
        return Err(r"No instales en la raíz de una unidad; usa una subcarpeta (por ejemplo D:\Celer).".into());
    }
    if out.as_os_str().len() > 200 {
        return Err("La ruta es demasiado larga.".into());
    }
    if let Some(s) = sys.system.iter().find(|s| is_within(&out, s)) {
        return Err(format!("«{}» es una carpeta del sistema. Elige otra carpeta.", s.display()));
    }
    if let Some(s) = sys.admin.iter().find(|s| is_within(&out, s)) {
        return Err(format!(
            "Instalar en «{}» requiere permisos de administrador. Celer se instala solo para tu usuario: \
             elige una carpeta dentro de tu perfil o en otra unidad.",
            s.display()
        ));
    }
    if let Some(s) = sys.exact.iter().find(|s| same_path(&out, s)) {
        return Err(format!("Elige una subcarpeta para Celer, no «{}» directamente.", s.display()));
    }
    Ok(out)
}

/// Comprueba que una ruta es «C:\...» absoluta (para rutas que vienen del registro).
fn is_abs_local(p: &Path) -> bool {
    matches!(p.components().next(), Some(Component::Prefix(px)) if matches!(px.kind(), Prefix::Disk(_)))
        && p.has_root()
}

// ---------------------------------------------------------------- registro (puras)

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegVal {
    Str(String),
    Dword(u32),
}

pub fn exe_path(dir: &Path) -> PathBuf {
    dir.join(APP_EXE)
}

pub fn uninstaller_path(dir: &Path) -> PathBuf {
    dir.join(UNINSTALL_EXE)
}

pub fn uninstall_string(dir: &Path) -> String {
    format!("\"{}\" --uninstall", uninstaller_path(dir).display())
}

pub fn quiet_uninstall_string(dir: &Path) -> String {
    format!("\"{}\" --uninstall --silent", uninstaller_path(dir).display())
}

pub fn open_command(exe: &Path) -> String {
    format!("\"{}\" \"%1\"", exe.display())
}

pub fn icon_ref(exe: &Path) -> String {
    format!("\"{}\",0", exe.display())
}

/// Valores de la clave `HKCU\...\Uninstall\<key>`.
pub fn uninstall_entries(dir: &Path, version: &str, size_kb: u32) -> Vec<(&'static str, RegVal)> {
    let exe = exe_path(dir);
    vec![
        ("DisplayName", RegVal::Str("Celer".into())),
        ("DisplayVersion", RegVal::Str(version.into())),
        ("Publisher", RegVal::Str("Celer".into())),
        ("DisplayIcon", RegVal::Str(format!("{},0", exe.display()))),
        ("InstallLocation", RegVal::Str(dir.display().to_string())),
        ("UninstallString", RegVal::Str(uninstall_string(dir))),
        ("QuietUninstallString", RegVal::Str(quiet_uninstall_string(dir))),
        ("EstimatedSize", RegVal::Dword(size_kb)),
        ("NoModify", RegVal::Dword(1)),
        ("NoRepair", RegVal::Dword(1)),
    ]
}

/// Valores de la asociación: (subclave relativa a Software\Classes, nombre, valor).
pub fn assoc_entries(progid: &str, exe: &Path) -> Vec<(String, &'static str, String)> {
    vec![
        (progid.to_string(), "", "Consulta SQL".to_string()),
        (format!(r"{progid}\DefaultIcon"), "", icon_ref(exe)),
        (format!(r"{progid}\shell\open"), "", "Abrir con Celer".to_string()),
        (format!(r"{progid}\shell\open\command"), "", open_command(exe)),
    ]
}

/// Tamaño en KB (redondeado hacia arriba) para `EstimatedSize`.
pub fn size_kb(bytes: u64) -> u32 {
    bytes.div_ceil(1024).min(u32::MAX as u64) as u32
}

// ---------------------------------------------------------------- registro (efectos)

fn hkcu() -> RegKey {
    RegKey::predef(HKEY_CURRENT_USER)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Existing {
    pub dir: String,
    pub version: String,
}

/// Instalación registrada (clave Uninstall con `InstallLocation`).
pub fn read_existing(layout: &Layout) -> Option<Existing> {
    let key = hkcu().open_subkey_with_flags(layout.uninstall_key_path(), KEY_READ).ok()?;
    let dir: String = key.get_value("InstallLocation").ok()?;
    let dir = dir.trim().trim_matches('"').trim_end_matches('\\').to_string();
    if dir.is_empty() {
        return None;
    }
    let version: String = key.get_value("DisplayVersion").unwrap_or_default();
    Some(Existing { dir, version })
}

fn write_uninstall_key(layout: &Layout, dir: &Path, version: &str, size: u32) -> io::Result<()> {
    let (key, _) = hkcu().create_subkey(layout.uninstall_key_path())?;
    for (name, val) in uninstall_entries(dir, version, size) {
        match val {
            RegVal::Str(s) => key.set_value(name, &s)?,
            RegVal::Dword(d) => key.set_value(name, &d)?,
        }
    }
    Ok(())
}

/// Borra la clave Uninstall solo si apunta a `dir` (o no tiene InstallLocation).
fn remove_uninstall_key(layout: &Layout, dir: &Path) -> io::Result<()> {
    let path = layout.uninstall_key_path();
    let Ok(key) = hkcu().open_subkey_with_flags(&path, KEY_READ) else {
        return Ok(());
    };
    let loc: String = key.get_value("InstallLocation").unwrap_or_default();
    drop(key);
    let loc = loc.trim().trim_matches('"');
    if loc.is_empty() || same_path(Path::new(loc), dir) {
        hkcu().delete_subkey_all(&path)?;
    }
    Ok(())
}

fn register_assoc(layout: &Layout, exe: &Path) -> io::Result<()> {
    let classes = hkcu().open_subkey_with_flags(CLASSES_ROOT, KEY_ALL_ACCESS)?;
    for (sub, name, val) in assoc_entries(&layout.progid, exe) {
        let (k, _) = classes.create_subkey(&sub)?;
        k.set_value(name, &val)?;
    }
    let (ext, _) = classes.create_subkey(&layout.ext)?;
    let (owp, _) = ext.create_subkey("OpenWithProgids")?;
    owp.set_value(&layout.progid, &String::new())?;
    // Predeterminado de la extensión: solo si nadie lo reclama ya.
    let current: String = ext.get_value("").unwrap_or_default();
    if current.is_empty() || current.eq_ignore_ascii_case(&layout.progid) {
        ext.set_value("", &layout.progid)?;
    }
    Ok(())
}

/// ¿El ProgID está registrado apuntando a un ejecutable dentro de `dir`?
fn assoc_points_into(layout: &Layout, dir: &Path) -> bool {
    let path = format!(r"{CLASSES_ROOT}\{}\shell\open\command", layout.progid);
    let Ok(k) = hkcu().open_subkey_with_flags(path, KEY_READ) else {
        return false;
    };
    let cmd: String = k.get_value("").unwrap_or_default();
    cmd.to_lowercase().contains(&path_key(&exe_path(dir)))
}

/// Quita nuestra asociación (ProgID, valor en OpenWithProgids y el predeterminado si es nuestro).
/// Nunca borra valores de otros programas; solo elimina claves que quedan vacías.
fn unregister_assoc(layout: &Layout) -> io::Result<bool> {
    let classes = hkcu().open_subkey_with_flags(CLASSES_ROOT, KEY_ALL_ACCESS)?;
    let mut changed = false;
    if classes.open_subkey(&layout.progid).is_ok() {
        classes.delete_subkey_all(&layout.progid)?;
        changed = true;
    }
    if let Ok(ext) = classes.open_subkey_with_flags(&layout.ext, KEY_ALL_ACCESS) {
        if let Ok(owp) = ext.open_subkey_with_flags("OpenWithProgids", KEY_ALL_ACCESS) {
            if owp.delete_value(&layout.progid).is_ok() {
                changed = true;
            }
            let empty = owp.query_info().map(|i| i.values == 0 && i.sub_keys == 0).unwrap_or(false);
            drop(owp);
            if empty {
                let _ = ext.delete_subkey("OpenWithProgids");
            }
        }
        let current: String = ext.get_value("").unwrap_or_default();
        if current.eq_ignore_ascii_case(&layout.progid) {
            let _ = ext.delete_value("");
            changed = true;
        }
        let empty = ext.query_info().map(|i| i.values == 0 && i.sub_keys == 0).unwrap_or(false);
        drop(ext);
        if empty {
            let _ = classes.delete_subkey(&layout.ext);
        }
    }
    Ok(changed)
}

// ---------------------------------------------------------------- archivos

fn io_msg(what: &str, path: &Path, e: &io::Error) -> String {
    let why = match e.kind() {
        io::ErrorKind::PermissionDenied => "acceso denegado".to_string(),
        io::ErrorKind::NotFound => "no existe".to_string(),
        _ => e.to_string(),
    };
    format!("{what} «{}»: {why}.", path.display())
}

/// Borra el acceso directo si apunta a algo dentro de alguna de `dirs`.
fn remove_shortcut_if_ours(lnk: &Path, dirs: &[&Path]) -> bool {
    if !lnk.is_file() {
        return false;
    }
    match win::shortcut_target(lnk) {
        Some(t) if dirs.iter().any(|d| is_within(&t, d)) => fs::remove_file(lnk).is_ok(),
        _ => false,
    }
}

fn remove_file_if_exists(p: &Path) -> io::Result<()> {
    match fs::remove_file(p) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// ¿`dir` es lo que deja una desinstalación: `uninstall.exe` sin `celer.exe`?
pub fn is_leftover(dir: &Path) -> bool {
    uninstaller_path(dir).is_file() && !exe_path(dir).exists()
}

/// Retira el `uninstall.exe` que dejó una desinstalación anterior (y la carpeta, si queda vacía).
pub fn remove_leftover(dir: &Path) -> bool {
    if !is_leftover(dir) {
        return false;
    }
    remove_old_install(dir);
    !uninstaller_path(dir).exists()
}

/// Quita los archivos conocidos de una instalación anterior en otra carpeta (best effort).
fn remove_old_install(dir: &Path) {
    for f in [APP_EXE, UNINSTALL_EXE, "celer.exe.partial", "uninstall.exe.partial"] {
        let _ = remove_file_if_exists(&dir.join(f));
    }
    let _ = fs::remove_dir(dir); // solo si queda vacía
}

// ---------------------------------------------------------------- instalar

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptions {
    pub dir: String,
    #[serde(default)]
    pub desktop_shortcut: bool,
    #[serde(default = "yes")]
    pub start_menu: bool,
    #[serde(default)]
    pub associate_sql: bool,
    #[serde(default)]
    pub launch_after: bool,
}

fn yes() -> bool {
    true
}

/// Opciones que reproducen la instalación actual: al actualizar desde la app solo cambia la versión
/// (mismos accesos directos, misma asociación .sql) y Celer se vuelve a abrir al terminar.
pub fn current_options(layout: &Layout, dir: &Path) -> InstallOptions {
    let _com = win::Com::init();
    let ours = |lnk: &Path| lnk.is_file() && win::shortcut_target(lnk).map(|t| is_within(&t, dir)).unwrap_or(false);
    InstallOptions {
        dir: dir.display().to_string(),
        desktop_shortcut: ours(&layout.desktop_lnk),
        start_menu: ours(&layout.start_menu_lnk),
        associate_sql: assoc_points_into(layout, dir),
        launch_after: true,
    }
}

/// Espera a que Celer termine de cerrarse en `dir` (la app lanza el instalador y sale).
/// Devuelve `false` si sigue abierto pasado `timeout`.
pub fn wait_until_closed(dir: &Path, timeout: std::time::Duration) -> bool {
    let exe = exe_path(dir);
    let started = std::time::Instant::now();
    while win::is_running(&exe) {
        if started.elapsed() > timeout {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    true
}

const EXTRACT_FROM: f64 = 5.0;
const EXTRACT_TO: f64 = 85.0;
const CHUNK: usize = 256 * 1024;

/// Instala (o actualiza in situ). Devuelve la ruta de `celer.exe`.
/// `setup_exe` es el ejecutable que se copia como `uninstall.exe`.
pub fn install(
    layout: &Layout,
    payload: &Payload,
    opts: &InstallOptions,
    setup_exe: &Path,
    progress: ProgressFn,
) -> Result<PathBuf, String> {
    let _com = win::Com::init();
    report(progress, Step::Prepare, 0.0, "Comprobando la carpeta");
    let dir = validate_install_dir(&opts.dir, &layout.sys)?;
    let exe = exe_path(&dir);
    if win::is_running(&exe) {
        return Err("Cierra Celer antes de actualizar.".into());
    }
    // Instalación previa en otra carpeta: se traslada.
    let old_dir = read_existing(layout)
        .map(|e| PathBuf::from(e.dir))
        .filter(|d| is_abs_local(d) && !same_path(d, &dir) && validate_install_dir(&d.to_string_lossy(), &layout.sys).is_ok());
    if let Some(od) = &old_dir {
        if win::is_running(&exe_path(od)) {
            return Err("Cierra Celer antes de actualizar.".into());
        }
    }

    fs::create_dir_all(&dir).map_err(|e| match e.kind() {
        io::ErrorKind::PermissionDenied => format!(
            "No tienes permiso para crear «{}». Elige una carpeta dentro de tu perfil o en otra unidad.",
            dir.display()
        ),
        _ => io_msg("No se pudo crear la carpeta", &dir, &e),
    })?;
    let probe = dir.join(".celer-setup-probe");
    File::create(&probe).and_then(|mut f| f.write_all(b"ok")).map_err(|e| match e.kind() {
        io::ErrorKind::PermissionDenied => format!(
            "No tienes permiso para escribir en «{}». Elige otra carpeta (por ejemplo, dentro de tu perfil).",
            dir.display()
        ),
        _ => io_msg("No se puede escribir en", &dir, &e),
    })?;
    let _ = fs::remove_file(&probe);

    let need = payload.size + 8 * 1024 * 1024;
    if let Some(free) = win::free_bytes(&dir) {
        if free < need {
            return Err(format!(
                "No hay espacio suficiente en la unidad: hacen falta {:.0} MB y quedan {:.0} MB.",
                need as f64 / 1_048_576.0,
                free as f64 / 1_048_576.0
            ));
        }
    }
    report(progress, Step::Prepare, EXTRACT_FROM, "Carpeta lista");

    // --- extraer celer.exe (temporal + renombrado atómico)
    let partial = dir.join("celer.exe.partial");
    let res = extract(payload, &partial, progress);
    if let Err(e) = res {
        let _ = fs::remove_file(&partial);
        return Err(e);
    }
    if let Err(e) = fs::rename(&partial, &exe) {
        let _ = fs::remove_file(&partial);
        return Err(if e.kind() == io::ErrorKind::PermissionDenied {
            "No se pudo reemplazar celer.exe: está en uso. Cierra Celer antes de actualizar.".into()
        } else {
            io_msg("No se pudo escribir", &exe, &e)
        });
    }

    // --- desinstalador (copia de este mismo ejecutable)
    report(progress, Step::Extract, EXTRACT_TO + 1.0, "Copiando el desinstalador");
    let uninst = uninstaller_path(&dir);
    if !same_path(setup_exe, &uninst) {
        let tmp = dir.join("uninstall.exe.partial");
        fs::copy(setup_exe, &tmp)
            .and_then(|_| fs::rename(&tmp, &uninst))
            .map_err(|e| {
                let _ = fs::remove_file(&tmp);
                io_msg("No se pudo crear", &uninst, &e)
            })?;
    }

    // --- accesos directos
    let ours: Vec<&Path> = std::iter::once(dir.as_path()).chain(old_dir.as_deref()).collect();
    report(progress, Step::Shortcuts, 88.0, "Creando accesos directos");
    for (wanted, lnk, label) in [
        (opts.start_menu, &layout.start_menu_lnk, "menú Inicio"),
        (opts.desktop_shortcut, &layout.desktop_lnk, "escritorio"),
    ] {
        if wanted {
            if let Some(parent) = lnk.parent() {
                let _ = fs::create_dir_all(parent);
            }
            win::create_shortcut(lnk, &exe, &dir, "Celer - cliente SQL")
                .map_err(|e| format!("No se pudo crear el acceso directo del {label}: {}", e.message()))?;
        } else {
            remove_shortcut_if_ours(lnk, &ours);
        }
    }
    report(progress, Step::Shortcuts, 91.0, "Accesos directos listos");

    // --- registro
    report(progress, Step::Register, 92.0, "Registrando en Windows");
    let mut assoc_changed = false;
    if opts.associate_sql {
        register_assoc(layout, &exe).map_err(|e| format!("No se pudo asociar los archivos .sql: {e}"))?;
        assoc_changed = true;
    } else if ours.iter().any(|d| assoc_points_into(layout, d)) {
        assoc_changed = unregister_assoc(layout).unwrap_or(false);
    }
    report(progress, Step::Register, 95.0, "Registrando en Windows");
    let installed = fs::metadata(&exe).map(|m| m.len()).unwrap_or(payload.size)
        + fs::metadata(&uninst).map(|m| m.len()).unwrap_or(0);
    write_uninstall_key(layout, &dir, payload.version, size_kb(installed))
        .map_err(|e| format!("No se pudo registrar Celer en «Aplicaciones instaladas»: {e}"))?;

    // --- final
    report(progress, Step::Finish, 97.0, "Últimos retoques");
    if let Some(od) = &old_dir {
        remove_old_install(od);
    }
    for leftover in layout.leftover_dirs.iter().filter(|d| !same_path(d, &dir)) {
        remove_leftover(leftover);
    }
    if assoc_changed {
        win::notify_assoc_changed();
    }
    report(progress, Step::Finish, 100.0, "Listo");
    Ok(exe)
}

fn extract(payload: &Payload, dest: &Path, progress: ProgressFn) -> Result<(), String> {
    let total = payload.size.max(1);
    let total_mb = total as f64 / 1_048_576.0;
    let mut dec = zstd::stream::read::Decoder::with_buffer(payload.compressed)
        .map_err(|e| format!("El instalador está dañado: {e}"))?;
    let mut out = File::create(dest).map_err(|e| io_msg("No se pudo crear", dest, &e))?;
    let mut buf = vec![0u8; CHUNK];
    let mut written: u64 = 0;
    let mut last_pct = -1.0f64;
    report(progress, Step::Extract, EXTRACT_FROM, format!("Copiando Celer · 0 de {total_mb:.1} MB"));
    loop {
        let n = dec.read(&mut buf).map_err(|e| format!("El instalador está dañado: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| io_msg("No se pudo escribir", dest, &e))?;
        written += n as u64;
        let pct = EXTRACT_FROM + (EXTRACT_TO - EXTRACT_FROM) * (written as f64 / total as f64).min(1.0);
        if pct - last_pct >= 0.25 {
            last_pct = pct;
            report(
                progress,
                Step::Extract,
                pct,
                format!("Copiando Celer · {:.1} de {total_mb:.1} MB", written as f64 / 1_048_576.0),
            );
        }
    }
    out.sync_all().map_err(|e| io_msg("No se pudo escribir", dest, &e))?;
    drop(out);
    if written != payload.size {
        return Err(format!(
            "El instalador está dañado (se esperaban {} bytes y se obtuvieron {written}).",
            payload.size
        ));
    }
    report(progress, Step::Extract, EXTRACT_TO, format!("Copiando Celer · {total_mb:.1} de {total_mb:.1} MB"));
    Ok(())
}

// ---------------------------------------------------------------- desinstalar

/// Resultado de desinstalar.
///
/// Windows no deja borrar un ejecutable mientras corre, y `uninstall.exe` es el que está desinstalando. No se programa
/// ningún borrado a escondidas (ni un `cmd` oculto que reintente `del`, ni `MoveFileEx` al reiniciar, que exige
/// administrador, ni una copia en %TEMP%): `uninstall.exe` se queda en su carpeta, la pantalla final lo dice y la
/// siguiente instalación de Celer lo retira (`remove_leftover`).
#[derive(Debug, Default)]
pub struct UninstallOutcome {
    /// `uninstall.exe` que sigue en la carpeta porque es el proceso en ejecución.
    pub left_behind: Option<PathBuf>,
}

/// Carpeta a desinstalar: la del propio `uninstall.exe` si está junto a `celer.exe`
/// (o coincide con el registro); si no, la registrada.
pub fn resolve_uninstall_dir(layout: &Layout, current_exe: &Path) -> Result<PathBuf, String> {
    let registered = read_existing(layout).map(|e| PathBuf::from(e.dir));
    if let Some(parent) = current_exe.parent() {
        let is_uninstaller = current_exe
            .file_name()
            .map(|n| n.to_string_lossy().eq_ignore_ascii_case(UNINSTALL_EXE))
            .unwrap_or(false);
        if is_uninstaller
            && (exe_path(parent).is_file() || registered.as_deref().map(|r| same_path(r, parent)).unwrap_or(false))
        {
            return Ok(parent.to_path_buf());
        }
    }
    registered.ok_or_else(|| "No se encontró ninguna instalación de Celer.".to_string())
}

pub fn uninstall(
    layout: &Layout,
    dir: &Path,
    keep_data: bool,
    current_exe: &Path,
    progress: ProgressFn,
) -> Result<UninstallOutcome, String> {
    let _com = win::Com::init();
    report(progress, Step::Prepare, 0.0, "Preparando la desinstalación");
    let dir = validate_install_dir(&dir.to_string_lossy(), &layout.sys)
        .map_err(|e| format!("La carpeta registrada no es válida para desinstalar: {e}"))?;
    let exe = exe_path(&dir);
    if win::is_running(&exe) {
        return Err("Cierra Celer antes de desinstalar.".into());
    }
    report(progress, Step::Prepare, 10.0, "Preparando la desinstalación");

    report(progress, Step::Shortcuts, 20.0, "Quitando accesos directos");
    remove_shortcut_if_ours(&layout.start_menu_lnk, &[&dir]);
    remove_shortcut_if_ours(&layout.desktop_lnk, &[&dir]);
    report(progress, Step::Shortcuts, 35.0, "Quitando la asociación de archivos");
    let assoc_changed = if assoc_points_into(layout, &dir) { unregister_assoc(layout).unwrap_or(false) } else { false };

    report(progress, Step::Register, 50.0, "Quitando el registro de Windows");
    remove_uninstall_key(layout, &dir).map_err(|e| format!("No se pudo quitar la entrada de Windows: {e}"))?;
    if assoc_changed {
        win::notify_assoc_changed();
    }

    report(progress, Step::Finish, 65.0, "Eliminando archivos");
    for f in [APP_EXE, "celer.exe.partial", "uninstall.exe.partial"] {
        let p = dir.join(f);
        remove_file_if_exists(&p).map_err(|e| io_msg("No se pudo eliminar", &p, &e))?;
    }
    if !keep_data {
        report(progress, Step::Finish, 80.0, "Eliminando tus datos y ajustes");
        for d in &layout.data_dirs {
            // Seguridad: solo carpetas llamadas como el identificador de la app.
            let named_ok = d.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case(APP_IDENTIFIER)).unwrap_or(false);
            if named_ok && d.is_dir() {
                fs::remove_dir_all(d).map_err(|e| io_msg("No se pudieron eliminar los datos de", d, &e))?;
            }
        }
    }
    let uninst = uninstaller_path(&dir);
    let mut outcome = UninstallOutcome::default();
    if same_path(current_exe, &uninst) {
        outcome.left_behind = Some(uninst);
    } else {
        let _ = remove_file_if_exists(&uninst);
        let _ = fs::remove_dir(&dir); // solo si quedó vacía
    }
    report(progress, Step::Finish, 100.0, "Listo");
    Ok(outcome)
}

/// Arranca Celer desacoplado del instalador.
pub fn launch(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let ok_name = path.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case(APP_EXE)).unwrap_or(false);
    if !ok_name || !path.is_file() {
        return Err(format!("No se encuentra Celer en «{}».", path.display()));
    }
    let cwd = path.parent().unwrap_or(Path::new("."));
    let spawn = |flags: u32| std::process::Command::new(path).current_dir(cwd).creation_flags(flags).spawn();
    spawn(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB)
        .or_else(|_| spawn(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP))
        .map(|_| ())
        .map_err(|e| format!("No se pudo abrir Celer: {e}"))
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn sys() -> SysDirs {
        SysDirs {
            system: vec![PathBuf::from(r"C:\Windows")],
            admin: vec![
                PathBuf::from(r"C:\Program Files"),
                PathBuf::from(r"C:\Program Files (x86)"),
                PathBuf::from(r"C:\ProgramData"),
            ],
            exact: vec![PathBuf::from(r"C:\Users\ana"), PathBuf::from(r"C:\Users\ana\AppData\Local\Programs")],
        }
    }

    #[test]
    fn accepts_normal_dirs() {
        let s = sys();
        assert_eq!(
            validate_install_dir(r"C:\Users\ana\AppData\Local\Programs\Celer", &s).unwrap(),
            PathBuf::from(r"C:\Users\ana\AppData\Local\Programs\Celer")
        );
        assert_eq!(validate_install_dir("  d:/Apps//Celer\\ ", &s).unwrap(), PathBuf::from(r"D:\Apps\Celer"));
        assert_eq!(validate_install_dir(r"D:\Program Files Mine\Celer", &s).unwrap(), PathBuf::from(r"D:\Program Files Mine\Celer"));
        assert!(validate_install_dir(r"C:\Windows2\Celer", &s).is_ok());
    }

    #[test]
    fn rejects_bad_dirs() {
        let s = sys();
        for bad in [
            "",
            "   ",
            r"Celer",
            r"\Celer",
            r"C:Celer",
            r"\\server\share\Celer",
            r"C:\",
            r"D:\\",
            r"C:\Apps\..\Windows",
            r"C:\Apps\.\Celer",
            r"C:\Apps\Ce*ler",
            r"C:\Apps\Ce:ler",
            r"C:\Apps\Celer.",
            r"C:\Apps\CON",
            r"C:\Apps\nul.txt\Celer",
        ] {
            assert!(validate_install_dir(bad, &s).is_err(), "debería rechazar {bad:?}");
        }
    }

    #[test]
    fn rejects_system_and_admin_dirs() {
        let s = sys();
        let e = validate_install_dir(r"c:\windows\System32\Celer", &s).unwrap_err();
        assert!(e.contains("sistema"), "{e}");
        let e = validate_install_dir(r"C:\Program Files\Celer", &s).unwrap_err();
        assert!(e.contains("administrador"), "{e}");
        assert!(validate_install_dir(r"C:\PROGRAM FILES (X86)\Celer", &s).is_err());
        assert!(validate_install_dir(r"C:\ProgramData\Celer", &s).is_err());
        let e = validate_install_dir(r"C:\Users\ana\", &s).unwrap_err();
        assert!(e.contains("subcarpeta"), "{e}");
        assert!(validate_install_dir(r"C:\Users\ana\AppData\Local\Programs", &s).is_err());
        assert!(validate_install_dir(r"C:\Users\ana\Celer", &s).is_ok());
    }

    #[test]
    fn path_helpers() {
        assert!(is_within(Path::new(r"C:\A\B\c.exe"), Path::new(r"c:\a\b\")));
        assert!(is_within(Path::new(r"C:\A\B"), Path::new(r"C:\A\B")));
        assert!(!is_within(Path::new(r"C:\A\BC"), Path::new(r"C:\A\B")));
        assert!(!is_within(Path::new(r"C:\A"), Path::new("")));
        assert!(same_path(Path::new(r"\\?\C:\X\Y"), Path::new("c:/x/y/")));
    }

    #[test]
    fn uninstall_values() {
        let dir = Path::new(r"D:\Apps\Celer");
        let v = uninstall_entries(dir, "1.2.3", 20_480);
        let get = |n: &str| v.iter().find(|(k, _)| *k == n).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(get("DisplayName"), RegVal::Str("Celer".into()));
        assert_eq!(get("DisplayVersion"), RegVal::Str("1.2.3".into()));
        assert_eq!(get("Publisher"), RegVal::Str("Celer".into()));
        assert_eq!(get("DisplayIcon"), RegVal::Str(r"D:\Apps\Celer\celer.exe,0".into()));
        assert_eq!(get("InstallLocation"), RegVal::Str(r"D:\Apps\Celer".into()));
        assert_eq!(get("UninstallString"), RegVal::Str(r#""D:\Apps\Celer\uninstall.exe" --uninstall"#.into()));
        assert_eq!(
            get("QuietUninstallString"),
            RegVal::Str(r#""D:\Apps\Celer\uninstall.exe" --uninstall --silent"#.into())
        );
        assert_eq!(get("EstimatedSize"), RegVal::Dword(20_480));
        assert_eq!(get("NoModify"), RegVal::Dword(1));
        assert_eq!(get("NoRepair"), RegVal::Dword(1));
    }

    #[test]
    fn assoc_values() {
        let exe = Path::new(r"D:\Apps\Celer\celer.exe");
        let v = assoc_entries("Celer.sql", exe);
        assert!(v.contains(&(r"Celer.sql\shell\open\command".into(), "", r#""D:\Apps\Celer\celer.exe" "%1""#.into())));
        assert!(v.contains(&(r"Celer.sql\DefaultIcon".into(), "", r#""D:\Apps\Celer\celer.exe",0"#.into())));
        assert_eq!(size_kb(0), 0);
        assert_eq!(size_kb(1), 1);
        assert_eq!(size_kb(2048), 2);
        assert_eq!(size_kb(2049), 3);
    }

    #[test]
    fn options_deserialize_camel_case() {
        let o: InstallOptions = serde_json::from_str(
            r#"{"dir":"D:\\X","desktopShortcut":true,"startMenu":false,"associateSql":true,"launchAfter":true}"#,
        )
        .unwrap();
        assert!(o.desktop_shortcut && !o.start_menu && o.associate_sql && o.launch_after);
        let p = serde_json::to_value(Progress { step: Step::Extract, pct: 50.0, detail: "x".into() }).unwrap();
        assert_eq!(p["step"], "extract");
    }

    #[test]
    fn leftover_uninstaller_is_removed_only_alone() {
        let base = std::env::temp_dir().join(format!("celer-setup-leftover-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        // Solo uninstall.exe: lo que deja una desinstalación. Se retira con la carpeta.
        let alone = base.join("alone");
        fs::create_dir_all(&alone).unwrap();
        fs::write(uninstaller_path(&alone), b"MZ").unwrap();
        assert!(is_leftover(&alone));
        assert!(remove_leftover(&alone));
        assert!(!alone.exists());
        // Una instalación completa no se toca.
        let full = base.join("full");
        fs::create_dir_all(&full).unwrap();
        fs::write(uninstaller_path(&full), b"MZ").unwrap();
        fs::write(exe_path(&full), b"MZ").unwrap();
        assert!(!is_leftover(&full));
        assert!(!remove_leftover(&full));
        assert!(exe_path(&full).is_file() && uninstaller_path(&full).is_file());
        // Con archivos del usuario: se va uninstall.exe y la carpeta se queda.
        let mixed = base.join("mixed");
        fs::create_dir_all(&mixed).unwrap();
        fs::write(uninstaller_path(&mixed), b"MZ").unwrap();
        fs::write(mixed.join("notas.txt"), b"mio").unwrap();
        assert!(remove_leftover(&mixed));
        assert!(mixed.join("notas.txt").is_file() && !uninstaller_path(&mixed).exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn embedded_payload_is_sane() {
        let p = Payload::embedded();
        assert!(p.size > 1_000_000);
        assert!(!p.version.is_empty());
        let mut dec = zstd::stream::read::Decoder::with_buffer(p.compressed).unwrap();
        let mut head = [0u8; 2];
        dec.read_exact(&mut head).unwrap();
        assert_eq!(&head, b"MZ");
    }

    /// Instala en D:\celer-installer-test\it\Celer con claves/atajos de prueba,
    /// verifica, actualiza, desinstala y comprueba la limpieza.
    /// `cargo test -- --ignored`
    #[test]
    #[ignore]
    fn integration_install_uninstall() {
        let base = PathBuf::from(r"D:\celer-installer-test\it");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let layout = Layout {
            uninstall_key: "CelerTest".into(),
            progid: "CelerTest.sql".into(),
            ext: ".celertestsql".into(),
            start_menu_lnk: base.join(r"startmenu\Celer.lnk"),
            desktop_lnk: base.join(r"desktop\Celer.lnk"),
            data_dirs: vec![base.join(r"appdata").join(APP_IDENTIFIER)],
            leftover_dirs: vec![base.join("leftover")],
            sys: SysDirs::real(),
        };
        // Limpieza previa de claves de prueba (por si un run anterior falló).
        let _ = hkcu().delete_subkey_all(layout.uninstall_key_path());
        let _ = hkcu().delete_subkey_all(format!(r"{CLASSES_ROOT}\{}", layout.progid));
        let _ = hkcu().delete_subkey_all(format!(r"{CLASSES_ROOT}\{}", layout.ext));

        let payload = Payload::embedded();
        let setup_exe = std::env::current_exe().unwrap();
        let dir = base.join("Celer");
        let opts = InstallOptions {
            dir: dir.display().to_string(),
            desktop_shortcut: true,
            start_menu: true,
            associate_sql: true,
            launch_after: false,
        };
        let mut events = Vec::new();
        let exe = install(&layout, &payload, &opts, &setup_exe, &mut |p| events.push(p)).expect("install");
        let _com = win::Com::init();

        // Archivos
        assert_eq!(exe, dir.join(APP_EXE));
        assert_eq!(fs::metadata(&exe).unwrap().len(), payload.size);
        assert_eq!(&fs::read(&exe).unwrap()[..2], b"MZ");
        assert!(dir.join(UNINSTALL_EXE).is_file());
        assert!(!dir.join("celer.exe.partial").exists());
        // Progreso: monótono, con todos los pasos y terminando en 100.
        assert!(events.windows(2).all(|w| w[1].pct >= w[0].pct), "progreso no monótono");
        assert!(events.iter().filter(|e| e.step == Step::Extract).count() > 20);
        for s in [Step::Prepare, Step::Extract, Step::Shortcuts, Step::Register, Step::Finish] {
            assert!(events.iter().any(|e| e.step == s), "falta {s:?}");
        }
        assert_eq!(events.last().unwrap().pct, 100.0);
        // Accesos directos
        for lnk in [&layout.start_menu_lnk, &layout.desktop_lnk] {
            assert!(same_path(&win::shortcut_target(lnk).expect("lnk"), &exe));
        }
        // Registro
        let key = hkcu().open_subkey(layout.uninstall_key_path()).unwrap();
        let loc: String = key.get_value("InstallLocation").unwrap();
        assert_eq!(loc, dir.display().to_string());
        let ver: String = key.get_value("DisplayVersion").unwrap();
        assert_eq!(ver, payload.version);
        let us: String = key.get_value("UninstallString").unwrap();
        assert_eq!(us, uninstall_string(&dir));
        let kb: u32 = key.get_value("EstimatedSize").unwrap();
        assert!(kb as u64 >= payload.size / 1024);
        drop(key);
        assert_eq!(read_existing(&layout), Some(Existing { dir: dir.display().to_string(), version: payload.version.into() }));
        let cmd: String = hkcu()
            .open_subkey(format!(r"{CLASSES_ROOT}\{}\shell\open\command", layout.progid))
            .unwrap()
            .get_value("")
            .unwrap();
        assert_eq!(cmd, open_command(&exe));
        let ext = hkcu().open_subkey(format!(r"{CLASSES_ROOT}\{}", layout.ext)).unwrap();
        assert_eq!(ext.get_value::<String, _>("").unwrap(), layout.progid);
        drop(ext);

        // Actualización in situ, sin escritorio ni asociación: se retiran los nuestros.
        let opts2 = InstallOptions { desktop_shortcut: false, associate_sql: false, ..opts.clone() };
        install(&layout, &payload, &opts2, &setup_exe, &mut |_| {}).expect("upgrade");
        assert!(layout.start_menu_lnk.is_file());
        assert!(!layout.desktop_lnk.exists());
        assert!(hkcu().open_subkey(format!(r"{CLASSES_ROOT}\{}", layout.progid)).is_err());
        assert!(hkcu().open_subkey(format!(r"{CLASSES_ROOT}\{}", layout.ext)).is_err());

        // Desinstalar conservando datos.
        let data = &layout.data_dirs[0];
        fs::create_dir_all(data).unwrap();
        fs::write(data.join("settings.json"), "{}").unwrap();
        // Un archivo ajeno en la carpeta no se toca y la carpeta se conserva.
        fs::write(dir.join("notas-del-usuario.txt"), "mío").unwrap();
        assert_eq!(resolve_uninstall_dir(&layout, &setup_exe).unwrap(), dir);
        let mut ev = Vec::new();
        let out = uninstall(&layout, &dir, true, &setup_exe, &mut |p| ev.push(p)).expect("uninstall");
        assert!(out.left_behind.is_none());
        assert_eq!(ev.last().unwrap().pct, 100.0);
        assert!(!exe.exists() && !dir.join(UNINSTALL_EXE).exists());
        assert!(dir.join("notas-del-usuario.txt").is_file());
        assert!(!layout.start_menu_lnk.exists());
        assert!(hkcu().open_subkey(layout.uninstall_key_path()).is_err());
        assert!(data.join("settings.json").is_file(), "keepData debe conservar los datos");
        fs::remove_file(dir.join("notas-del-usuario.txt")).unwrap();

        // Reinstalar con todo y desinstalar borrando datos.
        install(&layout, &payload, &opts, &setup_exe, &mut |_| {}).expect("reinstall");
        uninstall(&layout, &dir, false, &setup_exe, &mut |_| {}).expect("uninstall 2");
        assert!(!dir.exists(), "la carpeta vacía debe eliminarse");
        assert!(!data.exists(), "keepData=false debe borrar los datos");
        assert!(!layout.start_menu_lnk.exists() && !layout.desktop_lnk.exists());
        assert!(hkcu().open_subkey(layout.uninstall_key_path()).is_err());
        assert!(hkcu().open_subkey(format!(r"{CLASSES_ROOT}\{}", layout.progid)).is_err());
        assert!(hkcu().open_subkey(format!(r"{CLASSES_ROOT}\{}", layout.ext)).is_err());

        let _ = fs::remove_dir_all(&base);
    }
}
