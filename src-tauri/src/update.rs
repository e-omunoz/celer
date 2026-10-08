// Actualizaciones: consulta el último release en GitHub y, solo cuando el usuario pulsa «Actualizar», descarga
// Celer Setup a la carpeta de datos local de Celer, verifica su SHA-256 con el SHA256SUMS.txt publicado junto a él
// y lo ejecuta directamente (sin cmd ni PowerShell) en modo `--update`, que espera a que Celer se cierre, instala
// con las mismas opciones y lo vuelve a abrir. Las copias portables, MSI, macOS y Linux no ejecutan nada: abren la
// página de la versión.
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const REPO: &str = "e-omunoz/celer";
const API_LATEST: &str = "https://api.github.com/repos/e-omunoz/celer/releases/latest";
/// Celer Setup en los releases desde 2.0.2: un nombre fijo, para que `releases/latest/download/<nombre>` funcione.
pub const SETUP_ASSET: &str = "Celer-Setup-Windows.exe";
/// Prefijo de Celer Setup en cualquier release (hasta 2.0.1 era `Celer-Setup-x.y.z.exe`). Las copias 2.0.1 ya
/// instaladas buscan este prefijo y `.exe`, así que también encuentran `Celer-Setup-Windows.exe`.
const SETUP_PREFIX: &str = "Celer-Setup-";
const SUMS_NAME: &str = "SHA256SUMS.txt";
/// Subcarpeta de la carpeta de datos local de Celer donde se descarga el instalador.
pub const DOWNLOAD_SUBDIR: &str = "updates";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub notes: String,
    pub published_at: String,
    pub html_url: String,
    /// Celer Setup del release (vacío si el release no lo incluye).
    pub asset_url: String,
    pub asset_name: String,
    pub asset_size: u64,
    pub sums_url: String,
    /// Celer instalado con Celer Setup (hay un uninstall.exe al lado): la actualización es automática.
    pub installed: bool,
    /// "setup" (automática), "portable" (abre la página de la versión), "msi" (copias del antiguo paquete MSI:
    /// abre la página de la versión), "other" (macOS/Linux: descargar el paquete del sistema).
    pub install_kind: &'static str,
}

/// Cómo se instaló esta copia; decide qué hace el botón de actualizar.
pub fn install_kind() -> &'static str {
    if !cfg!(windows) {
        return "other";
    }
    if installed_by_setup() {
        return "setup";
    }
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_lowercase()).unwrap_or_default();
    // The MSI installs per machine under Program Files; Celer Setup and NSIS install per user.
    if exe.contains(r"\program files") {
        "msi"
    } else {
        "portable"
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

fn agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(8)))
        .timeout_recv_response(Some(Duration::from_secs(20)))
        .user_agent(format!("Celer/{} (+https://github.com/{REPO})", env!("CARGO_PKG_VERSION")))
        .build();
    ureq::Agent::new_with_config(config)
}

fn content_length<B>(resp: &ureq::http::Response<B>) -> u64 {
    resp.headers().get("Content-Length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// "v1.2.3" / "1.2.3-beta" → (1, 2, 3). Lo que no se entiende cuenta como 0.
pub fn parse_version(v: &str) -> (u64, u64, u64) {
    let core = v.trim().trim_start_matches(['v', 'V']).split(['-', '+']).next().unwrap_or("");
    let mut it = core.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    parse_version(latest) > parse_version(current)
}

/// ¿Esta copia de Celer la instaló Celer Setup? (portable y desarrollo: no)
pub fn installed_by_setup() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("uninstall.exe").is_file()))
        .unwrap_or(false)
}

/// Versión de esta copia. En compilaciones de depuración `CELER_FAKE_VERSION` la sustituye para probar
/// el flujo completo contra el último release real.
fn current_version() -> String {
    #[cfg(debug_assertions)]
    if let Ok(v) = std::env::var("CELER_FAKE_VERSION") {
        return v;
    }
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn check() -> Result<UpdateInfo> {
    let resp = agent()
        .get(API_LATEST)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| match e {
            ureq::Error::StatusCode(404) => anyhow!("Todavía no hay versiones publicadas."),
            ureq::Error::StatusCode(403 | 429) => anyhow!("GitHub ha limitado las consultas por ahora; inténtalo más tarde."),
            ureq::Error::StatusCode(code) => anyhow!("GitHub respondió con el código {code}."),
            other => anyhow!("Sin conexión con GitHub ({other})."),
        })?;
    let release: Release = serde_json::from_reader(resp.into_body().into_reader()).context("Respuesta de GitHub no válida")?;
    if release.draft || release.prerelease {
        bail!("El último release no es estable.");
    }
    let current = current_version();
    let latest = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    let kind = install_kind();
    // Only a copy installed by Celer Setup updates itself; portable, MSI, macOS and Linux get the release page.
    let setup = if kind == "setup" { setup_asset(&release.assets) } else { None };
    let sums = release.assets.iter().find(|a| a.name == SUMS_NAME);
    Ok(UpdateInfo {
        available: is_newer(&latest, &current),
        current,
        latest,
        notes: release.body.unwrap_or_default(),
        published_at: release.published_at.unwrap_or_default(),
        html_url: release.html_url,
        asset_url: setup.map(|a| a.browser_download_url.clone()).unwrap_or_default(),
        asset_name: setup.map(|a| a.name.clone()).unwrap_or_default(),
        asset_size: setup.map(|a| a.size).unwrap_or(0),
        sums_url: sums.map(|a| a.browser_download_url.clone()).unwrap_or_default(),
        installed: installed_by_setup(),
        install_kind: kind,
    })
}

/// Celer Setup entre los ficheros de un release: `Celer-Setup-Windows.exe` o, en releases antiguos,
/// `Celer-Setup-x.y.z.exe`.
fn setup_asset(assets: &[Asset]) -> Option<&Asset> {
    assets
        .iter()
        .find(|a| a.name == SETUP_ASSET)
        .or_else(|| assets.iter().find(|a| safe_name(&a.name).is_ok()))
}

/// Busca el hash de `name` en un SHA256SUMS ("<hex>  <nombre>" por línea).
pub fn expected_hash(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let file = parts.next()?.trim_start_matches('*');
        (file == name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())).then(|| hash.to_ascii_lowercase())
    })
}

/// Solo descargas de los releases de este repositorio (el front no puede pedir otra URL).
fn check_url(url: &str) -> Result<()> {
    let ok = url.starts_with(&format!("https://github.com/{REPO}/releases/download/"));
    if !ok {
        bail!("URL de descarga no permitida.");
    }
    Ok(())
}

fn safe_name(name: &str) -> Result<&str> {
    let ok = name.starts_with(SETUP_PREFIX)
        && name.to_ascii_lowercase().ends_with(".exe")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'));
    if !ok {
        bail!("Nombre de instalador no válido.");
    }
    Ok(name)
}

/// Instalador descargado y verificado en esta sesión, con su SHA-256: lo único que `launch_installer` ejecuta.
static VERIFIED: std::sync::Mutex<Option<(PathBuf, String)>> = std::sync::Mutex::new(None);

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path).with_context(|| format!("No se pudo leer {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Borra lo que dejaron descargas anteriores (instaladores ya usados, descargas a medias).
fn clean_downloads(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let ours = safe_name(name.trim_end_matches(".partial")).is_ok();
        if ours && entry.path().is_file() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Descarga el instalador a `dir` (la carpeta `updates` de los datos locales de Celer) y comprueba su SHA-256
/// con el SHA256SUMS.txt del mismo release: sin esa comprobación no se descarga nada. Devuelve la ruta.
pub fn download(dir: &Path, url: &str, name: &str, sums_url: &str, progress: impl Fn(u64, u64)) -> Result<PathBuf> {
    check_url(url)?;
    let name = safe_name(name)?;
    if sums_url.is_empty() {
        bail!("Esta versión no publica {SUMS_NAME}: descárgala desde GitHub.");
    }
    check_url(sums_url)?;
    let sums = agent()
        .get(sums_url)
        .call()
        .map_err(|e| anyhow!("No se pudo leer {SUMS_NAME}: {e}"))?
        .body_mut()
        .read_to_string()
        .map_err(|e| anyhow!("No se pudo leer {SUMS_NAME}: {e}"))?;
    let expected = expected_hash(&sums, name).ok_or_else(|| anyhow!("{SUMS_NAME} no incluye {name}."))?;

    std::fs::create_dir_all(dir).with_context(|| format!("No se pudo crear {}", dir.display()))?;
    if let Ok(mut verified) = VERIFIED.lock() {
        *verified = None;
    }
    clean_downloads(dir);
    let dest = dir.join(name);
    let partial = dir.join(format!("{name}.partial"));
    let resp = agent().get(url).call().map_err(|e| anyhow!("No se pudo descargar la actualización: {e}"))?;
    let total = content_length(&resp);
    let mut reader = resp.into_body().into_reader();
    let mut file = std::fs::File::create(&partial).with_context(|| format!("No se pudo crear {}", partial.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    loop {
        let n = reader.read(&mut buf).context("La descarga se ha interrumpido")?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        hasher.update(&buf[..n]);
        done += n as u64;
        progress(done, total);
    }
    file.flush()?;
    drop(file);
    if total > 0 && done != total {
        let _ = std::fs::remove_file(&partial);
        bail!("La descarga está incompleta ({done} de {total} bytes).");
    }
    let got = hex(&hasher.finalize());
    if got != expected {
        let _ = std::fs::remove_file(&partial);
        bail!("El instalador descargado no coincide con su SHA-256 publicado; no se ejecutará.");
    }
    let _ = std::fs::remove_file(&dest);
    std::fs::rename(&partial, &dest)?;
    if let Ok(mut verified) = VERIFIED.lock() {
        *verified = Some((dest.clone(), expected));
    }
    Ok(dest)
}

/// Ejecuta el instalador descargado y verificado en esta sesión, directamente (sin intérprete de órdenes de por
/// medio), tras volver a comprobar su SHA-256. Solo en copias instaladas por Celer Setup: `--update`, sin preguntas;
/// con `relaunch` muestra el progreso y reabre Celer, sin él (al cerrar la app) actualiza en silencio.
pub fn launch_installer(dir: &Path, path: &Path, relaunch: bool) -> Result<()> {
    if install_kind() != "setup" {
        bail!("Esta copia de Celer no se actualiza sola: descarga la versión nueva desde GitHub.");
    }
    let verified = VERIFIED.lock().ok().and_then(|v| v.clone());
    let ok = path.parent().map(|p| p == dir).unwrap_or(false)
        && path.file_name().and_then(|n| n.to_str()).map(|n| safe_name(n).is_ok()).unwrap_or(false)
        && path.is_file();
    let Some((verified_path, hash)) = verified.filter(|(p, _)| ok && p == path) else {
        bail!("Instalador no válido.");
    };
    if sha256_file(&verified_path)? != hash {
        bail!("El instalador ha cambiado desde que se descargó; no se ejecutará.");
    }
    let mut cmd = std::process::Command::new(&verified_path);
    cmd.current_dir(dir).arg("--update");
    if !relaunch {
        cmd.arg("--silent");
    }
    cmd.spawn().with_context(|| format!("No se pudo abrir {}", verified_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(parse_version("v1.2.3"), (1, 2, 3));
        assert_eq!(parse_version("1.10.0-beta.1"), (1, 10, 0));
        assert!(is_newer("v1.10.0", "1.9.9"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(!is_newer("1.1.0", "1.1.0"));
        assert!(!is_newer("v1.0.9", "1.1.0"));
    }

    #[test]
    fn sums() {
        let h = "a".repeat(64);
        let sums = format!("{h}  Celer-Setup-1.2.0.exe\n{}  Celer-1.2.0-portable.exe\n", "b".repeat(64));
        assert_eq!(expected_hash(&sums, "Celer-Setup-1.2.0.exe"), Some(h));
        assert_eq!(expected_hash(&sums, "Celer-Setup-9.9.9.exe"), None);
        assert_eq!(expected_hash("zzz  Celer-Setup-1.2.0.exe", "Celer-Setup-1.2.0.exe"), None);
    }

    /// The single SHA256SUMS.txt of a release from 2.0.2 on, as `sha256sum` writes it (also in binary mode).
    #[test]
    fn sums_with_fixed_names() {
        let (setup, portable) = ("c".repeat(64), "d".repeat(64));
        let sums = format!(
            "{setup}  Celer-Setup-Windows.exe\n{portable} *Celer-Portable-Windows.exe\n{}  Celer-macOS.dmg\n{}  Celer-Linux.deb\n",
            "e".repeat(64),
            "f".repeat(64)
        );
        assert_eq!(expected_hash(&sums, SETUP_ASSET), Some(setup));
        assert_eq!(expected_hash(&sums, "Celer-Portable-Windows.exe"), Some(portable));
        assert_eq!(expected_hash(&sums, "Celer-Setup-2.0.2.exe"), None);
    }

    #[test]
    fn only_our_release_urls_and_names() {
        assert!(check_url("https://github.com/e-omunoz/celer/releases/download/v1.2.0/Celer-Setup-1.2.0.exe").is_ok());
        assert!(check_url("https://github.com/e-omunoz/celer/releases/download/v2.0.2/Celer-Setup-Windows.exe").is_ok());
        assert!(check_url("https://evil.example/Celer-Setup-1.2.0.exe").is_err());
        assert!(check_url("https://github.com/other/celer/releases/download/v1/x.exe").is_err());
        assert!(safe_name("Celer-Setup-1.2.0.exe").is_ok());
        assert!(safe_name(SETUP_ASSET).is_ok());
        assert!(safe_name("..\\Celer-Setup-1.2.0.exe").is_err());
        assert!(safe_name("Celer-1.2.0-portable.exe").is_err());
        assert!(safe_name("Celer-Portable-Windows.exe").is_err());
    }

    fn asset(name: &str) -> Asset {
        Asset { name: name.into(), browser_download_url: format!("https://github.com/{REPO}/releases/download/v2.0.2/{name}"), size: 1 }
    }

    /// What a new release offers: the fixed name, never the portable copy or a package of another system.
    #[test]
    fn finds_setup_in_new_and_old_releases() {
        let new = ["Celer-Portable-Windows.exe", "Celer-macOS.dmg", "Celer-Setup-Windows.exe", "SHA256SUMS.txt"].map(asset);
        assert_eq!(setup_asset(&new).map(|a| a.name.as_str()), Some(SETUP_ASSET));
        let old = ["Celer-2.0.1-portable.exe", "Celer-2.0.1-nsis-setup.exe", "Celer-Setup-2.0.1.exe", "SHA256SUMS.txt"].map(asset);
        assert_eq!(setup_asset(&old).map(|a| a.name.as_str()), Some("Celer-Setup-2.0.1.exe"));
        let none = ["Celer-Portable-Windows.exe", "Celer-Linux.deb"].map(asset);
        assert!(setup_asset(&none).is_none());
    }

    /// Celer 2.0.1 (already installed) picks the asset with `starts_with("Celer-Setup-") && ends_with(".exe")`,
    /// checks the URL and the name as below and looks the hash up in SHA256SUMS.txt: the fixed name passes all of it.
    #[test]
    fn celer_2_0_1_accepts_the_fixed_name() {
        let name = "Celer-Setup-Windows.exe";
        assert!(name.starts_with("Celer-Setup-") && name.to_ascii_lowercase().ends_with(".exe"));
        let old_safe_name = |n: &str| {
            n.starts_with("Celer-Setup-")
                && n.to_ascii_lowercase().ends_with(".exe")
                && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
        };
        assert!(old_safe_name(name));
        // 2.0.1 also offers the Setup to portable copies: the portable asset must not match its filter.
        assert!(!old_safe_name("Celer-Portable-Windows.exe"));
        assert!(check_url(&asset(name).browser_download_url).is_ok());
        let sums = format!("{}  {name}\n", "0".repeat(64));
        assert_eq!(expected_hash(&sums, name), Some("0".repeat(64)));
    }

    #[test]
    fn downloads_are_cleaned_and_only_verified_files_run() {
        let dir = std::env::temp_dir().join(format!("celer-update-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for f in ["Celer-Setup-Windows.exe", "Celer-Setup-Windows.exe.partial", "Celer-Setup-2.0.1.exe", "notes.txt"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        clean_downloads(&dir);
        let left: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(left, vec!["notes.txt".to_string()], "only our installers are removed");
        // Nothing was downloaded and verified in this session: nothing runs.
        std::fs::write(dir.join(SETUP_ASSET), b"MZ").unwrap();
        assert!(launch_installer(&dir, &dir.join(SETUP_ASSET), true).is_err());
        assert_eq!(sha256_file(&dir.join("notes.txt")).unwrap(), hex(&Sha256::digest(b"x")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
