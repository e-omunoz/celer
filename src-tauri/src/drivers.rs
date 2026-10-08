//! Localización y descarga del IBM Data Server Driver (ODBC/CLI) usado para Informix vía DRDA, y de lo que necesita
//! Informix por JDBC: Java 11 o superior y el driver JDBC de IBM. Nothing of IBM's is bundled: Celer finds what is
//! installed (DBeaver's own copies too) and downloads the rest on demand, into its data folder, without admin rights.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(windows)]
const CLI_DLL: &str = "db2cli64.dll";
#[cfg(target_os = "macos")]
const CLI_DLL: &str = "libdb2.dylib";
#[cfg(all(unix, not(target_os = "macos")))]
const CLI_DLL: &str = "libdb2.so";

#[cfg(windows)]
const DOWNLOAD_URL: &str = "https://public.dhe.ibm.com/ibmdl/export/pub/software/data/db2/drivers/odbc_cli/ntx64_odbc_cli.zip";
#[cfg(target_os = "macos")]
const DOWNLOAD_URL: &str = "https://public.dhe.ibm.com/ibmdl/export/pub/software/data/db2/drivers/odbc_cli/macos64_odbc_cli.tar.gz";
#[cfg(all(unix, not(target_os = "macos")))]
const DOWNLOAD_URL: &str = "https://public.dhe.ibm.com/ibmdl/export/pub/software/data/db2/drivers/odbc_cli/linuxx64_odbc_cli.tar.gz";

fn lib_dir() -> &'static str {
    if cfg!(windows) {
        "bin"
    } else {
        "lib"
    }
}

/// Busca la DLL del driver CLI: ruta configurada, IBM_DB_HOME, carpeta de la app y rutas habituales.
pub fn find_cli(configured: Option<&str>, app_dir: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(c) = configured.filter(|c| !c.trim().is_empty()) {
        let p = PathBuf::from(c.trim());
        candidates.push(p.clone());
        candidates.push(p.join(CLI_DLL));
        candidates.push(p.join(lib_dir()).join(CLI_DLL));
    }
    if let Ok(h) = std::env::var("IBM_DB_HOME") {
        candidates.push(PathBuf::from(h).join(lib_dir()).join(CLI_DLL));
    }
    candidates.push(
        app_dir
            .join("drivers")
            .join("clidriver")
            .join(lib_dir())
            .join(CLI_DLL),
    );
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            candidates.push(d.join("clidriver").join(lib_dir()).join(CLI_DLL));
        }
    }
    #[cfg(windows)]
    {
        candidates
            .push(PathBuf::from(r"C:\Program Files\IBM\IBM DATA SERVER DRIVER\bin").join(CLI_DLL));
        candidates.push(PathBuf::from(r"C:\Program Files\IBM\SQLLIB\bin").join(CLI_DLL));
    }
    candidates
        .into_iter()
        .find(|p| p.is_file() && p.file_name().map(|f| f == CLI_DLL).unwrap_or(false))
}

/// Prepara el entorno del proceso para que el driver encuentre sus dependencias y mensajes.
pub fn prepare_env(dll: &Path) {
    if let Some(bin) = dll.parent() {
        let home = bin.parent().unwrap_or(bin);
        let path = std::env::var("PATH").unwrap_or_default();
        let bin_s = bin.to_string_lossy().to_string();
        if !path
            .split(if cfg!(windows) { ';' } else { ':' })
            .any(|p| p.eq_ignore_ascii_case(&bin_s))
        {
            let sep = if cfg!(windows) { ";" } else { ":" };
            std::env::set_var("PATH", format!("{bin_s}{sep}{path}"));
        }
        if std::env::var("IBM_DB_HOME").is_err() {
            std::env::set_var("IBM_DB_HOME", home);
        }
    }
}

/// Descarga y descomprime el driver en `<app_dir>/drivers`. Informa del progreso (bytes, total).
pub fn download(app_dir: &Path, progress: impl Fn(u64, u64)) -> Result<PathBuf> {
    let dest = app_dir.join("drivers");
    fs::create_dir_all(&dest)?;
    CANCEL.store(false, Ordering::SeqCst);
    let resp = agent()
        .get(DOWNLOAD_URL)
        .call()
        .map_err(|e| anyhow!("No se pudo descargar el driver: {e}"))?;
    let total: u64 = resp
        .headers()
        .get("Content-Length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut reader = resp.into_body().into_reader();
    let mut data = Vec::with_capacity(total as usize);
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            bail!("Descarga cancelada");
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
        progress(data.len() as u64, total);
    }
    if DOWNLOAD_URL.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(data))?;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i)?;
            let Some(rel) = f.enclosed_name() else {
                continue;
            };
            let out = dest.join(rel);
            if f.is_dir() {
                fs::create_dir_all(&out)?;
            } else {
                if let Some(p) = out.parent() {
                    fs::create_dir_all(p)?;
                }
                let mut w = fs::File::create(&out)?;
                std::io::copy(&mut f, &mut w)?;
            }
        }
    } else if DOWNLOAD_URL.ends_with(".tar.gz") || DOWNLOAD_URL.ends_with(".tgz") {
        unpack_tar_gz(&data, &dest)?;
    } else {
        bail!(
            "Descomprime manualmente {DOWNLOAD_URL} en {}",
            dest.display()
        );
    }
    let dll = dest.join("clidriver").join(lib_dir()).join(CLI_DLL);
    if !dll.is_file() {
        bail!("El paquete descargado no contiene {CLI_DLL}");
    }
    Ok(dll)
}

fn unpack_tar_gz(data: &[u8], dest: &Path) -> Result<()> {
    let dec = flate2::read::GzDecoder::new(std::io::Cursor::new(data));
    let mut archive = tar::Archive::new(dec);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let rel = entry
            .path()
            .map_err(|e| anyhow!("entrada tar inválida: {e}"))?
            .into_owned();
        if rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }
        let out = dest.join(rel);
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(p) = out.parent() {
            fs::create_dir_all(p)?;
        }
        let mut w = fs::File::create(&out)?;
        std::io::copy(&mut entry, &mut w)?;
        #[cfg(unix)]
        if let Ok(mode) = entry.header().mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&out, fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

// ───────────────────────────────────────────────────────────────── downloads

static CANCEL: AtomicBool = AtomicBool::new(false);

/// Stops the download in progress (it leaves nothing behind).
pub fn cancel_download() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// HTTP client for the downloads: the proxy of the environment (HTTPS_PROXY…) or, on Windows, the one in the
/// system's Internet settings.
fn agent() -> ureq::Agent {
    let mut config = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .user_agent(format!("Celer/{} (+https://github.com/{})", env!("CARGO_PKG_VERSION"), crate::update::REPO));
    if ureq::Proxy::try_from_env().is_none() {
        if let Some(proxy) = system_proxy().and_then(|p| ureq::Proxy::new(&p).ok()) {
            config = config.proxy(Some(proxy));
        }
    }
    ureq::Agent::new_with_config(config.build())
}

#[cfg(windows)]
fn system_proxy() -> Option<String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings").ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    proxy_from_setting(&key.get_value::<String, _>("ProxyServer").ok()?)
}

#[cfg(not(windows))]
fn system_proxy() -> Option<String> {
    None
}

/// Windows' ProxyServer value ("host:port", or "http=h:p;https=h2:p2") → the proxy for HTTPS, as a URL.
pub fn proxy_from_setting(value: &str) -> Option<String> {
    let value = value.trim();
    let pick = if value.contains('=') {
        let parts: Vec<(&str, &str)> = value.split(';').filter_map(|p| p.split_once('=')).map(|(k, v)| (k.trim(), v.trim())).collect();
        parts.iter().find(|(k, _)| k.eq_ignore_ascii_case("https")).or_else(|| parts.iter().find(|(k, _)| k.eq_ignore_ascii_case("http"))).map(|(_, v)| *v)?
    } else {
        value
    };
    if pick.is_empty() {
        return None;
    }
    Some(if pick.contains("://") { pick.to_string() } else { format!("http://{pick}") })
}

fn sha256_file(path: &Path) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Downloads `url` into `dest` and checks its SHA-256 before keeping it; a cancel or a wrong hash leaves nothing.
/// `progress(what, bytes, total)`.
fn download_verified(url: &str, dest: &Path, sha256: &str, what: &str, progress: &dyn Fn(&str, u64, u64)) -> Result<()> {
    if sha256_file(dest).is_some_and(|h| h.eq_ignore_ascii_case(sha256)) {
        return Ok(());
    }
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir)?;
    }
    let partial = PathBuf::from(format!("{}.partial", dest.display()));
    let resp = agent().get(url).call().map_err(|e| anyhow!("No se pudo descargar {what}: {e}"))?;
    let total = resp.headers().get("Content-Length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0u64);
    let mut reader = resp.into_body().into_reader();
    let mut file = fs::File::create(&partial).with_context(|| format!("No se pudo crear {}", partial.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    let result = (|| -> Result<()> {
        loop {
            if CANCEL.load(Ordering::SeqCst) {
                bail!("Descarga cancelada");
            }
            let n = reader.read(&mut buf).context("La descarga se ha interrumpido")?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])?;
            hasher.update(&buf[..n]);
            done += n as u64;
            progress(what, done, total);
        }
        file.flush()?;
        Ok(())
    })();
    drop(file);
    if let Err(e) = result {
        let _ = fs::remove_file(&partial);
        return Err(e);
    }
    if !hex(&hasher.finalize()).eq_ignore_ascii_case(sha256) {
        let _ = fs::remove_file(&partial);
        bail!("{what} descargado no coincide con su SHA-256: se ha descartado.");
    }
    let _ = fs::remove_file(dest);
    fs::rename(&partial, dest)?;
    Ok(())
}

// ───────────────────────────────────────────────────────────────── Java

fn java_exe() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

/// A Java runtime found on this machine.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaFound {
    pub path: String,
    pub major: u32,
    pub version: String,
    /// settings | JAVA_HOME | DBeaver | PATH | Celer
    pub source: &'static str,
}

/// The oldest Java the bridge runs on (it is compiled with `--release 11`).
pub const JAVA_MIN: u32 = 11;

/// DBeaver's own JRE (it comes with one): Windows per-user and per-machine installs, the macOS app, Linux packages.
fn dbeaver_jres() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(windows) {
        if let Some(local) = dirs::data_local_dir() {
            out.push(local.join("DBeaver").join("jre"));
            out.push(local.join("Programs").join("DBeaver").join("jre"));
        }
        let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        out.push(program_files.join("DBeaver").join("jre"));
    } else if cfg!(target_os = "macos") {
        let app = Path::new("DBeaver.app").join("Contents").join("Eclipse").join("jre").join("Contents").join("Home");
        out.push(Path::new("/Applications").join(&app));
        if let Some(h) = dirs::home_dir() {
            out.push(h.join("Applications").join(&app));
        }
    } else {
        for d in ["/usr/share/dbeaver-ce", "/usr/share/dbeaver", "/usr/lib/dbeaver", "/opt/dbeaver", "/opt/dbeaver-ce", "/snap/dbeaver-ce/current/usr/share/dbeaver-ce"] {
            out.push(Path::new(d).join("jre"));
        }
        if let Some(h) = dirs::home_dir() {
            out.push(h.join("dbeaver").join("jre"));
        }
    }
    out
}

/// The JREs Celer downloaded (`<app_dir>/drivers/jre/<version>/`).
fn celer_jres(app_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(app_dir.join("drivers").join("jre")) else { return vec![] };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')))
        .flat_map(|p| [p.join("bin").join(java_exe()), p.join("Contents").join("Home").join("bin").join(java_exe())])
        .collect();
    out.sort();
    out.reverse();
    out
}

/// Where Celer looks for Java, in order: Settings, JAVA_HOME, DBeaver's JRE, the PATH, the one Celer downloaded.
fn java_candidates(configured: Option<&str>, app_dir: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut c = Vec::new();
    if let Some(p) = configured.map(str::trim).filter(|p| !p.is_empty()) {
        // The executable, a JRE/JDK folder, its bin folder or a macOS bundle.
        let p = PathBuf::from(p);
        for path in [p.clone(), p.join("bin").join(java_exe()), p.join(java_exe()), p.join("Contents").join("Home").join("bin").join(java_exe())] {
            c.push((path, "settings"));
        }
    }
    if let Some(home) = std::env::var_os("JAVA_HOME").filter(|h| !h.is_empty()) {
        c.push((PathBuf::from(home).join("bin").join(java_exe()), "JAVA_HOME"));
    }
    for jre in dbeaver_jres() {
        c.push((jre.join("bin").join(java_exe()), "DBeaver"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            c.push((dir.join(java_exe()), "PATH"));
        }
    }
    for java in celer_jres(app_dir) {
        c.push((java, "Celer"));
    }
    c
}

/// Major version from `java -version` / the `release` file: "1.8.0_392" → 8, "21.0.4" → 21, "17-ea" → 17.
pub fn parse_java_major(version: &str) -> Option<u32> {
    let v = version.trim().trim_matches('"');
    let mut parts = v.split(|c: char| !c.is_ascii_digit());
    let first: u32 = parts.next()?.parse().ok()?;
    if first == 1 {
        return parts.next()?.parse().ok();
    }
    Some(first)
}

/// Version of a Java: its `release` file (JDK/JRE 9 and newer have one), or `java -version`.
fn java_version(java: &Path) -> Option<(u32, String)> {
    let real = fs::canonicalize(java).unwrap_or_else(|_| java.to_path_buf());
    if let Some(home) = real.parent().and_then(|bin| bin.parent()) {
        if let Ok(text) = fs::read_to_string(home.join("release")) {
            if let Some(v) = text.lines().find_map(|l| l.strip_prefix("JAVA_VERSION=")) {
                let v = v.trim().trim_matches('"').to_string();
                if let Some(major) = parse_java_major(&v) {
                    return Some((major, v));
                }
            }
        }
    }
    let mut cmd = std::process::Command::new(java);
    // Java directly (no shell in between), and no hsperfdata file in the system's temp folder.
    cmd.args(["-XX:-UsePerfData", "-version"]).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stderr);
    let quoted = text.lines().find_map(|l| l.split('"').nth(1))?.to_string();
    Some((parse_java_major(&quoted)?, quoted))
}

/// Every Java found, in the order Celer tries them (`all`: false stops at the first one that runs the bridge).
pub fn find_java(configured: Option<&str>, app_dir: &Path, all: bool) -> Vec<JavaFound> {
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut out = Vec::new();
    for (path, source) in java_candidates(configured, app_dir) {
        if !path.is_file() {
            continue;
        }
        let real = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if seen.contains(&real) {
            continue;
        }
        seen.push(real);
        let Some((major, version)) = java_version(&path) else { continue };
        let usable = major >= JAVA_MIN;
        out.push(JavaFound { path: path.to_string_lossy().to_string(), major, version, source });
        if usable && !all {
            break;
        }
    }
    out
}

/// The Java a JDBC connection uses: the first one found that is new enough.
pub fn pick_java(found: &[JavaFound]) -> Option<&JavaFound> {
    found.iter().find(|j| j.major >= JAVA_MIN)
}

#[derive(Deserialize)]
struct AdoptiumAsset {
    binary: AdoptiumBinary,
}

#[derive(Deserialize)]
struct AdoptiumBinary {
    package: AdoptiumPackage,
}

#[derive(Deserialize)]
struct AdoptiumPackage {
    checksum: String,
    link: String,
    name: String,
}

/// The Adoptium names of this OS and architecture (None: no Temurin JRE for them).
pub fn adoptium_platform() -> Option<(&'static str, &'static str)> {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return None;
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "aarch64",
        _ => return None,
    };
    Some((os, arch))
}

/// Downloads Eclipse Temurin JRE 21 for this machine (Adoptium's API gives the package and its SHA-256) into
/// `<app_dir>/drivers/jre`. Returns its `java`.
pub fn download_jre(app_dir: &Path, progress: impl Fn(&str, u64, u64)) -> Result<PathBuf> {
    CANCEL.store(false, Ordering::SeqCst);
    let (os, arch) = adoptium_platform().ok_or_else(|| anyhow!("No hay un JRE de Temurin para este sistema: instala Java 11 o superior e indica su ruta"))?;
    let api = format!("https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture={arch}&image_type=jre&os={os}&vendor=eclipse");
    let resp = agent().get(&api).call().map_err(|e| anyhow!("No se pudo consultar Adoptium: {e}"))?;
    let assets: Vec<AdoptiumAsset> = serde_json::from_reader(resp.into_body().into_reader()).context("Respuesta de Adoptium no válida")?;
    let package = assets.into_iter().next().map(|a| a.binary.package).ok_or_else(|| anyhow!("Adoptium no tiene un JRE 21 para {os}/{arch}"))?;
    let name_ok = !package.name.is_empty() && package.name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '+'));
    let hash_ok = package.checksum.len() == 64 && package.checksum.chars().all(|c| c.is_ascii_hexdigit());
    if !package.link.starts_with("https://github.com/adoptium/") || !name_ok || !hash_ok {
        bail!("Adoptium devolvió un paquete inesperado ({})", package.link);
    }
    let root = app_dir.join("drivers").join("jre");
    fs::create_dir_all(&root)?;
    let archive = root.join(&package.name);
    download_verified(&package.link, &archive, &package.checksum, "Java (Temurin JRE 21)", &progress)?;
    let tmp = root.join(format!(".extract-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp)?;
    let unpacked = if package.name.ends_with(".zip") { unzip(&archive, &tmp) } else { untar_gz(&archive, &tmp) };
    if let Err(e) = unpacked {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e.context("No se pudo descomprimir Java"));
    }
    let top = fs::read_dir(&tmp)?.flatten().map(|e| e.path()).find(|p| p.is_dir()).ok_or_else(|| anyhow!("El paquete de Java está vacío"))?;
    let dest = root.join(top.file_name().unwrap_or_default());
    let _ = fs::remove_dir_all(&dest);
    fs::rename(&top, &dest)?;
    let _ = fs::remove_dir_all(&tmp);
    let _ = fs::remove_file(&archive);
    [dest.join("bin").join(java_exe()), dest.join("Contents").join("Home").join("bin").join(java_exe())]
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| anyhow!("El paquete de Java no contiene {}", java_exe()))
}

fn unzip(archive: &Path, dest: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(fs::File::open(archive)?))?;
    for i in 0..zip.len() {
        if CANCEL.load(Ordering::SeqCst) {
            bail!("Descarga cancelada");
        }
        let mut f = zip.by_index(i)?;
        let Some(rel) = f.enclosed_name() else { continue };
        let out = dest.join(rel);
        if f.is_dir() {
            fs::create_dir_all(&out)?;
        } else {
            if let Some(p) = out.parent() {
                fs::create_dir_all(p)?;
            }
            std::io::copy(&mut f, &mut fs::File::create(&out)?)?;
        }
    }
    Ok(())
}

fn untar_gz(archive: &Path, dest: &Path) -> Result<()> {
    let dec = flate2::read::GzDecoder::new(std::io::BufReader::new(fs::File::open(archive)?));
    // `unpack` keeps permissions and links, and refuses entries outside `dest`.
    tar::Archive::new(dec).unpack(dest)?;
    Ok(())
}

// ───────────────────────────────────────────────────────────────── JDBC drivers

/// A jar on Maven Central, with its SHA-256 fixed here (checked on every download).
pub struct MavenJar {
    pub group: &'static str,
    pub artifact: &'static str,
    pub version: &'static str,
    pub sha256: &'static str,
}

/// A JDBC driver the bridge can load: its class, its jar and what it needs at run time. Nothing here is specific to
/// an engine: another one only needs its own `JdbcSpec` (see docs/DRIVERS.md).
pub struct JdbcSpec {
    pub class: &'static str,
    pub jar: MavenJar,
    pub deps: &'static [MavenJar],
}

/// Informix: IBM's driver from the 15.0 line, which also reads Informix 15 servers (4.50 fails to parse their version)
/// and runs on Java 8+; and org.mongodb:bson, which its POM lists for the BSON type. A 4.50 found in DBeaver's cache is
/// still used first: it is fine for 12.10 and 14.10 servers.
pub const INFORMIX_JDBC: JdbcSpec = JdbcSpec {
    class: "com.informix.jdbc.IfxDriver",
    jar: MavenJar { group: "com.ibm.informix", artifact: "jdbc", version: "15.0.1.4", sha256: "152fe3380e414261266d7bde6bacae348c94b6db0cf16f969d1094368449cec7" },
    deps: &[MavenJar { group: "org.mongodb", artifact: "bson", version: "3.8.0", sha256: "d30b5aeba3ae9b7c68c8a6103b41918c5f7318972007b9b92033ee861762d87e" }],
};

const MAVEN: &str = "https://repo1.maven.org/maven2";

/// A JDBC driver found on this machine.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JdbcFound {
    /// The driver jar first, then the ones it needs that were found.
    pub jars: Vec<String>,
    pub version: String,
    /// settings | DBeaver | Celer
    pub source: &'static str,
}

/// "jdbc-4.50.10.1.jar" → "4.50.10.1".
fn jar_version(path: &Path, prefix: &str) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().to_string();
    let v = name.strip_prefix(prefix)?.strip_suffix(".jar")?;
    v.starts_with(|c: char| c.is_ascii_digit()).then(|| v.to_string())
}

fn version_key(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).map(|p| p.parse().unwrap_or(0)).collect()
}

/// The newest `<artifact>-<version>.jar` in `dir`.
fn newest_jar(dir: &Path, artifact: &str) -> Option<(PathBuf, String)> {
    let prefix = format!("{artifact}-");
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter_map(|p| jar_version(&p, &prefix).map(|v| (p, v)))
        .max_by_key(|(_, v)| version_key(v))
}

/// DBeaver's driver cache (`DBeaverData/drivers/maven/maven-central/<group>/<artifact>-<version>.jar`) on Windows,
/// Linux and macOS.
fn dbeaver_maven() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(d) = dirs::data_dir() {
        roots.push(d.join("DBeaverData"));
    }
    if let Some(h) = dirs::home_dir() {
        roots.push(h.join("Library").join("DBeaverData"));
        roots.push(h.join(".local").join("share").join("DBeaverData"));
    }
    roots.sort();
    roots.dedup();
    roots.into_iter().map(|r| r.join("drivers").join("maven").join("maven-central")).filter(|p| p.is_dir()).collect()
}

/// Where Celer keeps the jars it downloads: the same layout as DBeaver's cache, under its data folder.
fn celer_maven(app_dir: &Path) -> PathBuf {
    app_dir.join("drivers").join("jdbc").join("maven")
}

fn found(jar: PathBuf, deps: Vec<PathBuf>, version: String, source: &'static str) -> JdbcFound {
    JdbcFound { jars: std::iter::once(jar).chain(deps).map(|j| j.to_string_lossy().to_string()).collect(), version, source }
}

/// Every copy of the driver found, in the order Celer tries them: Settings (a jar, or a folder with one), DBeaver's
/// cache, Celer's download. Its dependencies come from the same place or, failing that, from the others.
pub fn find_jdbc(spec: &JdbcSpec, configured: Option<&str>, app_dir: &Path) -> Vec<JdbcFound> {
    let celer = celer_maven(app_dir);
    let mut maven_roots = dbeaver_maven();
    maven_roots.push(celer.clone());
    let dep_anywhere = |dep: &MavenJar| maven_roots.iter().find_map(|root| newest_jar(&root.join(dep.group), dep.artifact)).map(|d| d.0);
    let mut out = Vec::new();
    if let Some(p) = configured.map(str::trim).filter(|p| !p.is_empty()) {
        let p = PathBuf::from(p);
        let jar = if p.is_file() {
            Some((p.clone(), jar_version(&p, &format!("{}-", spec.jar.artifact)).unwrap_or_default()))
        } else {
            newest_jar(&p, spec.jar.artifact)
        };
        if let Some((jar, version)) = jar {
            let dir = jar.parent().map(Path::to_path_buf).unwrap_or_default();
            let deps = spec.deps.iter().filter_map(|d| newest_jar(&dir, d.artifact).map(|j| j.0).or_else(|| dep_anywhere(d))).collect();
            out.push(found(jar, deps, version, "settings"));
        }
    }
    for root in &maven_roots {
        let Some((jar, version)) = newest_jar(&root.join(spec.jar.group), spec.jar.artifact) else { continue };
        let deps = spec.deps.iter().filter_map(|d| newest_jar(&root.join(d.group), d.artifact).map(|j| j.0).or_else(|| dep_anywhere(d))).collect();
        out.push(found(jar, deps, version, if *root == celer { "Celer" } else { "DBeaver" }));
    }
    out
}

/// Downloads the driver and its dependencies from Maven Central (their SHA-256 are fixed in the spec) into Celer's
/// data folder.
pub fn download_jdbc(spec: &JdbcSpec, app_dir: &Path, progress: impl Fn(&str, u64, u64)) -> Result<JdbcFound> {
    CANCEL.store(false, Ordering::SeqCst);
    let root = celer_maven(app_dir);
    let mut paths = Vec::new();
    for (i, jar) in std::iter::once(&spec.jar).chain(spec.deps.iter()).enumerate() {
        let dest = root.join(jar.group).join(format!("{}-{}.jar", jar.artifact, jar.version));
        let url = format!("{MAVEN}/{}/{}/{}/{}-{}.jar", jar.group.replace('.', "/"), jar.artifact, jar.version, jar.artifact, jar.version);
        let what = if i == 0 { format!("El driver JDBC ({}:{})", jar.group, jar.artifact) } else { format!("{} (para el driver JDBC)", jar.artifact) };
        download_verified(&url, &dest, jar.sha256, &what, &progress)?;
        paths.push(dest);
    }
    let jar = paths.remove(0);
    Ok(found(jar, paths, spec.jar.version.into(), "Celer"))
}

// ───────────────────────────────────────── IBM CLI (DRDA): sin reconexión automática del propio driver

/// El driver IBM CLI trae activada la reconexión automática (ACR, «automatic client reroute») con reintento
/// transparente: si el servidor corta la sesión (`onmode -z`, un reinicio, la red), el driver abre otra por su cuenta y
/// repite la sentencia sin decir nada. Celer ya reconecta en `guard.rs`, y avisa cuando se pierde algo (transacción,
/// tablas temporales, `SET`); con ACR el corte ni siquiera le llega. No hay palabra clave de la cadena de conexión
/// para apagarlo: solo `enableACR` en la sección `<acr>` de la base en `db2dsdriver.cfg`, que el driver busca por
/// nombre de base, servidor y puerto. Celer escribe el suyo en su carpeta de datos (`drivers/db2dsdriver.cfg`, sin
/// contraseñas), con una entrada por cada base a la que conecta por DRDA, y lo señala con `DB2DSDRIVER_CFG_PATH`.
/// Si el usuario tiene su propio `db2dsdriver.cfg` (esa variable ya puesta, o el fichero en `cfg/` del driver), se
/// respeta tal cual y no se toca.
struct CliCfg {
    /// El fichero de Celer, o None si manda el del usuario.
    file: Option<PathBuf>,
    entries: std::collections::BTreeSet<(String, String, u16)>,
}

static CLI_CFG_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
static CLI_CFG: std::sync::Mutex<Option<CliCfg>> = std::sync::Mutex::new(None);

/// La carpeta de datos de Celer: su `db2dsdriver.cfg` va en `drivers/`.
pub fn use_cli_cfg_dir(dir: &Path) {
    let _ = CLI_CFG_DIR.set(dir.to_path_buf());
}

/// Antes de conectar por DRDA a `database` en `host:port`: el `db2dsdriver.cfg` de Celer lleva esa base con ACR
/// apagado. `lib` es la biblioteca del driver (`None` al reconectar, cuando ya se decidió qué fichero manda).
pub fn cli_acr_off(lib: Option<&Path>, host: &str, port: u16, database: &str) {
    let (host, database) = (host.trim(), database.trim());
    if host.is_empty() || database.is_empty() {
        return;
    }
    let mut guard = CLI_CFG.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        let (Some(lib), Some(dir)) = (lib, CLI_CFG_DIR.get()) else { return };
        *guard = Some(cli_cfg_start(lib, dir));
    }
    let Some(cfg) = guard.as_mut() else { return };
    let Some(file) = cfg.file.clone() else { return };
    if cfg.entries.insert((database.to_string(), host.to_string(), port)) {
        if let Err(e) = write_cli_cfg(&file, &cfg.entries) {
            eprintln!("Celer: no se pudo escribir {}: {e}", file.display());
        }
    }
}

fn cli_cfg_start(lib: &Path, dir: &Path) -> CliCfg {
    let file = dir.join("drivers").join("db2dsdriver.cfg");
    let users = std::env::var_os("DB2DSDRIVER_CFG_PATH").filter(|v| !v.is_empty() && Path::new(v) != file);
    let in_driver = lib.parent().and_then(Path::parent).map(|home| home.join("cfg").join("db2dsdriver.cfg"));
    if users.is_some() || in_driver.is_some_and(|f| f.is_file()) {
        return CliCfg { file: None, entries: Default::default() };
    }
    let entries = fs::read_to_string(&file).map(|text| parse_cli_cfg(&text)).unwrap_or_default();
    // Antes de que el driver se cargue: lo lee al iniciarse.
    std::env::set_var("DB2DSDRIVER_CFG_PATH", &file);
    CliCfg { file: Some(file), entries }
}

fn xml_attr(value: &str) -> String {
    value.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;")
}

fn cli_cfg_text(entries: &std::collections::BTreeSet<(String, String, u16)>) -> String {
    let mut out = String::from(
        "<configuration>\n   <!-- Escrito por Celer: sin reconexión automática del driver (ACR) en las bases a las que conecta por DRDA; Celer reconecta y avisa por su cuenta -->\n   <databases>\n",
    );
    for (database, host, port) in entries {
        out.push_str(&format!(
            "      <database name=\"{}\" host=\"{}\" port=\"{port}\">\n         <acr>\n            <parameter name=\"enableACR\" value=\"false\"/>\n         </acr>\n      </database>\n",
            xml_attr(database),
            xml_attr(host)
        ));
    }
    out.push_str("   </databases>\n</configuration>\n");
    out
}

/// Las bases del fichero que escribió Celer (lo que no sea suyo no se lee).
fn parse_cli_cfg(text: &str) -> std::collections::BTreeSet<(String, String, u16)> {
    let attr = |line: &str, name: &str| -> Option<String> {
        let start = line.find(&format!(" {name}=\""))? + name.len() + 3;
        let end = start + line[start..].find('"')?;
        Some(line[start..end].replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
    };
    text.lines()
        .map(str::trim)
        .filter(|line| line.starts_with("<database "))
        .filter_map(|line| Some((attr(line, "name")?, attr(line, "host")?, attr(line, "port")?.parse().ok()?)))
        .collect()
}

fn write_cli_cfg(file: &Path, entries: &std::collections::BTreeSet<(String, String, u16)>) -> Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("cfg.tmp");
    fs::write(&tmp, cli_cfg_text(entries))?;
    fs::rename(&tmp, file)?;
    Ok(())
}

#[cfg(test)]
mod tests {

    #[test]
    fn cli_cfg_turns_acr_off_per_database_and_reads_back() {
        let mut entries = std::collections::BTreeSet::new();
        entries.insert(("ventas".to_string(), "db.example.com".to_string(), 9089u16));
        entries.insert(("a\"b&c".to_string(), "h<1>".to_string(), 1u16));
        let text = cli_cfg_text(&entries);
        assert!(text.contains("<database name=\"ventas\" host=\"db.example.com\" port=\"9089\">"), "{text}");
        assert_eq!(text.matches("<parameter name=\"enableACR\" value=\"false\"/>").count(), 2, "{text}");
        assert!(text.contains("name=\"a&quot;b&amp;c\" host=\"h&lt;1&gt;\""), "{text}");
        assert_eq!(parse_cli_cfg(&text), entries);
    }

    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("celer-drivers-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn java_versions() {
        assert_eq!(parse_java_major("1.8.0_392"), Some(8));
        assert_eq!(parse_java_major("\"21.0.4\""), Some(21));
        assert_eq!(parse_java_major("11"), Some(11));
        assert_eq!(parse_java_major("17-ea"), Some(17));
        assert_eq!(parse_java_major("abc"), None);
    }

    #[test]
    fn java_found_in_order_with_its_version() {
        let app = temp("java");
        // A JRE Celer downloaded, and an old Java given in Settings: the old one is listed but not picked.
        let jre = app.join("drivers").join("jre").join("jdk-21.0.4+7-jre");
        fs::create_dir_all(jre.join("bin")).unwrap();
        fs::write(jre.join("bin").join(java_exe()), b"").unwrap();
        fs::write(jre.join("release"), "IMPLEMENTOR=\"Eclipse Adoptium\"\nJAVA_VERSION=\"21.0.4\"\n").unwrap();
        let old = app.join("old-java");
        fs::create_dir_all(old.join("bin")).unwrap();
        fs::write(old.join("bin").join(java_exe()), b"").unwrap();
        fs::write(old.join("release"), "JAVA_VERSION=\"1.8.0_392\"\n").unwrap();
        let found = find_java(Some(old.to_str().unwrap()), &app, true);
        let first = &found[0];
        assert_eq!((first.source, first.major), ("settings", 8));
        let celer = found.iter().find(|j| j.source == "Celer").expect("the downloaded JRE");
        assert_eq!((celer.major, celer.version.as_str()), (21, "21.0.4"));
        let picked = pick_java(&found).unwrap();
        assert!(picked.major >= JAVA_MIN, "{picked:?}");
        let _ = fs::remove_dir_all(app);
    }

    #[test]
    fn jdbc_jars_found() {
        let app = temp("jdbc");
        let mine = app.join("mine");
        fs::create_dir_all(&mine).unwrap();
        for f in ["jdbc-4.10.16.jar", "jdbc-4.50.10.1.jar", "jdbc-4.50.9.jar", "bson-3.8.0.jar", "notes.txt"] {
            fs::write(mine.join(f), b"x").unwrap();
        }
        let found = find_jdbc(&INFORMIX_JDBC, Some(mine.to_str().unwrap()), &app);
        assert_eq!(found[0].source, "settings");
        assert_eq!(found[0].version, "4.50.10.1", "the newest version");
        assert_eq!(found[0].jars.len(), 2, "with bson: {:?}", found[0].jars);
        assert!(found[0].jars[1].ends_with("bson-3.8.0.jar"));
        // Celer's own download, in the Maven layout.
        let dir = celer_maven(&app).join("com.ibm.informix");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("jdbc-15.0.1.4.jar"), b"x").unwrap();
        let found = find_jdbc(&INFORMIX_JDBC, None, &app);
        assert!(found.iter().any(|f| f.source == "Celer" && f.version == "15.0.1.4"), "{found:?}");
        assert_eq!(jar_version(Path::new("/x/jdbc-15.0.1.4.jar"), "jdbc-").as_deref(), Some("15.0.1.4"));
        assert!(version_key("4.50.10.1") > version_key("4.50.9"));
        let _ = fs::remove_dir_all(app);
    }

    #[test]
    fn windows_proxy_settings() {
        assert_eq!(proxy_from_setting("proxy.local:8080").as_deref(), Some("http://proxy.local:8080"));
        assert_eq!(proxy_from_setting("http=a:80;https=b:443").as_deref(), Some("http://b:443"));
        assert_eq!(proxy_from_setting("http=a:80;ftp=c:21").as_deref(), Some("http://a:80"));
        assert_eq!(proxy_from_setting("ftp=c:21"), None);
        assert_eq!(proxy_from_setting(""), None);
    }

    #[test]
    fn a_cancelled_or_tampered_download_leaves_nothing() {
        let dir = temp("verify");
        let dest = dir.join("x.jar");
        fs::write(&dest, b"hello").unwrap();
        // Already there with the right hash: nothing is downloaded.
        let ok = download_verified("https://invalid.invalid/x.jar", &dest, &hex(&Sha256::digest(b"hello")), "x", &|_: &str, _: u64, _: u64| {});
        assert!(ok.is_ok());
        let _ = fs::remove_dir_all(dir);
    }
}
