//! Empaqueta el ejecutable de Celer dentro del instalador.
//!
//! - Lee `celer.exe` (por defecto `D:\celer-target\release\celer.exe`, o la ruta de `CELER_PAYLOAD`).
//! - Lo comprime con zstd en `OUT_DIR/celer.exe.zst` (el crate lo incluye con `include_bytes!`).
//! - Lee la versión de `../../src-tauri/Cargo.toml` y la expone como `CELER_VERSION`.
//! - Expone el tamaño sin comprimir como `CELER_PAYLOAD_SIZE`.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_PAYLOAD: &str = r"D:\celer-target\release\celer.exe";
const ZSTD_LEVEL: i32 = 19;

fn main() {
    println!("cargo:rerun-if-env-changed=CELER_PAYLOAD");
    println!("cargo:rerun-if-env-changed=CELER_ZSTD_LEVEL");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    // --- Versión de la app principal ---
    let app_manifest = manifest_dir.join("..").join("..").join("src-tauri").join("Cargo.toml");
    println!("cargo:rerun-if-changed={}", app_manifest.display());
    let version = read_package_version(&app_manifest).unwrap_or_else(|e| {
        panic!("\n\nceler-setup: no se pudo leer la versión de {}: {e}\n\n", app_manifest.display())
    });
    println!("cargo:rustc-env=CELER_VERSION={version}");

    // --- Payload ---
    let payload = env::var("CELER_PAYLOAD").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(DEFAULT_PAYLOAD));
    println!("cargo:rerun-if-changed={}", payload.display());
    let data = match fs::read(&payload) {
        Ok(d) if !d.is_empty() => d,
        Ok(_) => fail_payload(&payload, "el archivo está vacío"),
        Err(e) => fail_payload(&payload, &e.to_string()),
    };
    if data.len() < 2 || &data[..2] != b"MZ" {
        fail_payload(&payload, "no parece un ejecutable de Windows (falta la cabecera MZ)");
    }

    let level = env::var("CELER_ZSTD_LEVEL").ok().and_then(|s| s.parse().ok()).unwrap_or(ZSTD_LEVEL);
    let compressed = compress(&data, level);
    fs::write(out_dir.join("celer.exe.zst"), &compressed).expect("no se pudo escribir el payload comprimido");
    println!("cargo:rustc-env=CELER_PAYLOAD_SIZE={}", data.len());
    println!(
        "cargo:warning=payload {} -> {:.1} MB comprimido ({:.1} MB original, zstd {level})",
        payload.display(),
        compressed.len() as f64 / 1_048_576.0,
        data.len() as f64 / 1_048_576.0
    );

    tauri_build::build();
}

fn compress(data: &[u8], level: i32) -> Vec<u8> {
    let mut enc = zstd::stream::Encoder::new(Vec::with_capacity(data.len() / 2), level).expect("zstd");
    let threads = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1);
    let _ = enc.multithread(threads);
    let _ = enc.include_checksum(true);
    let _ = enc.set_pledged_src_size(Some(data.len() as u64));
    std::io::Write::write_all(&mut enc, data).expect("zstd write");
    enc.finish().expect("zstd finish")
}

fn fail_payload(path: &Path, why: &str) -> ! {
    panic!(
        "\n\nceler-setup: falta el payload de Celer.\n  Ruta: {}\n  Motivo: {why}\n  \
         Compila antes la app (`tauri build` en la raíz del proyecto, con CARGO_TARGET_DIR=D:\\celer-target)\n  \
         o indica otra ruta con la variable de entorno CELER_PAYLOAD.\n\n",
        path.display()
    );
}

/// Devuelve `version = "x.y.z"` de la sección `[package]`.
fn read_package_version(path: &Path) -> Result<String, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut in_package = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_package = l == "[package]";
            continue;
        }
        if in_package {
            if let Some(rest) = l.strip_prefix("version") {
                let rest = rest.trim_start();
                if let Some(rest) = rest.strip_prefix('=') {
                    let v = rest.trim().trim_matches('"');
                    if !v.is_empty() {
                        return Ok(v.to_string());
                    }
                }
            }
        }
    }
    Err("no hay `version` en [package]".into())
}
