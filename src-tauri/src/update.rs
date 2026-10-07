// Actualizaciones: consulta el último release en GitHub, descarga Celer Setup (verificando su SHA-256
// con el SHA256SUMS.txt publicado junto a él) y lo lanza en modo `--update`, que espera a que Celer
// se cierre, instala con las mismas opciones y lo vuelve a abrir.
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const REPO: &str = "e-omunoz/celer";
const API_LATEST: &str = "https://api.github.com/repos/e-omunoz/celer/releases/latest";
const SETUP_PREFIX: &str = "Celer-Setup-";
const SUMS_NAME: &str = "SHA256SUMS.txt";

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
    /// "setup" (automática), "portable" (abre el instalador), "msi" (descargar el .msi nuevo),
    /// "other" (macOS/Linux: descargar el paquete del sistema).
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
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(30))
        .user_agent(&format!("Celer/{} (+https://github.com/{REPO})", env!("CARGO_PKG_VERSION")))
        .build()
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
        .set("Accept", "application/vnd.github+json")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(404, _) => anyhow!("Todavía no hay versiones publicadas."),
            ureq::Error::Status(403, _) | ureq::Error::Status(429, _) => {
                anyhow!("GitHub ha limitado las consultas por ahora; inténtalo más tarde.")
            }
            ureq::Error::Status(code, _) => anyhow!("GitHub respondió con el código {code}."),
            ureq::Error::Transport(t) => anyhow!("Sin conexión con GitHub ({t})."),
        })?;
    let release: Release = serde_json::from_reader(resp.into_reader()).context("Respuesta de GitHub no válida")?;
    if release.draft || release.prerelease {
        bail!("El último release no es estable.");
    }
    let current = current_version();
    let latest = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    let kind = install_kind();
    // Only Celer Setup can update in place; MSI, macOS and Linux get the release page for their package.
    let setup = release
        .assets
        .iter()
        .filter(|_| kind == "setup" || kind == "portable")
        .find(|a| a.name.starts_with(SETUP_PREFIX) && a.name.to_ascii_lowercase().ends_with(".exe"));
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

pub fn download_dir() -> PathBuf {
    std::env::temp_dir().join("celer-update")
}

/// Descarga el instalador a %TEMP%\celer-update y comprueba su SHA-256. Devuelve la ruta.
pub fn download(url: &str, name: &str, sums_url: &str, progress: impl Fn(u64, u64)) -> Result<PathBuf> {
    check_url(url)?;
    let name = safe_name(name)?;
    let expected = if sums_url.is_empty() {
        None
    } else {
        check_url(sums_url)?;
        let sums = agent().get(sums_url).call().map_err(|e| anyhow!("No se pudo leer {SUMS_NAME}: {e}"))?.into_string()?;
        Some(expected_hash(&sums, name).ok_or_else(|| anyhow!("{SUMS_NAME} no incluye {name}."))?)
    };

    let dir = download_dir();
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(name);
    let partial = dir.join(format!("{name}.partial"));
    let resp = agent().get(url).call().map_err(|e| anyhow!("No se pudo descargar la actualización: {e}"))?;
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
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
    let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if let Some(expected) = expected {
        if got != expected {
            let _ = std::fs::remove_file(&partial);
            bail!("El instalador descargado no coincide con su firma SHA-256; no se ejecutará.");
        }
    }
    let _ = std::fs::remove_file(&dest);
    std::fs::rename(&partial, &dest)?;
    Ok(dest)
}

/// Lanza el instalador descargado. Con Celer instalado: `--update`, sin preguntas; con `relaunch`
/// muestra el progreso y reabre Celer, sin él (al cerrar la app) actualiza en silencio.
/// En copias portables o de desarrollo abre el instalador normal.
pub fn launch_installer(path: &Path, relaunch: bool) -> Result<()> {
    let dir = download_dir();
    let ok = path.parent().map(|p| p == dir).unwrap_or(false)
        && path.file_name().and_then(|n| n.to_str()).map(|n| safe_name(n).is_ok()).unwrap_or(false)
        && path.is_file();
    if !ok {
        bail!("Instalador no válido.");
    }
    let mut cmd = std::process::Command::new(path);
    if installed_by_setup() {
        cmd.arg("--update");
        if !relaunch {
            cmd.arg("--silent");
        }
    }
    cmd.spawn().with_context(|| format!("No se pudo abrir {}", path.display()))?;
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

    #[test]
    fn only_our_release_urls_and_names() {
        assert!(check_url("https://github.com/e-omunoz/celer/releases/download/v1.2.0/Celer-Setup-1.2.0.exe").is_ok());
        assert!(check_url("https://evil.example/Celer-Setup-1.2.0.exe").is_err());
        assert!(check_url("https://github.com/other/celer/releases/download/v1/x.exe").is_err());
        assert!(safe_name("Celer-Setup-1.2.0.exe").is_ok());
        assert!(safe_name("..\\Celer-Setup-1.2.0.exe").is_err());
        assert!(safe_name("Celer-1.2.0-portable.exe").is_err());
    }
}
