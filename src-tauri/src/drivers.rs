//! Localización y descarga del IBM Data Server Driver (ODBC/CLI) usado para Informix vía DRDA.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Result};

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
    let resp = ureq::get(DOWNLOAD_URL)
        .call()
        .map_err(|e| anyhow!("No se pudo descargar el driver: {e}"))?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut data = Vec::with_capacity(total as usize);
    let mut buf = vec![0u8; 256 * 1024];
    loop {
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
