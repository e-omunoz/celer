//! Besides Tauri's own build step, compiles the JDBC bridge (bridge/CelerBridge.java) into
//! `OUT_DIR/celer-bridge.jar`, which src/jdbc.rs embeds with `include_bytes!`.
//!
//! - `CELER_BRIDGE_JAR`: a jar built elsewhere, used as it is.
//! - Otherwise `javac` and `jar` from `JAVA_HOME` (or the `PATH`), JDK 11 or newer.
//! - Without a JDK the jar is left empty: the app builds and says at run time that the bridge is missing. A release
//!   build (or `CELER_REQUIRE_BRIDGE=1`, as CI sets) fails instead, so a published Celer always carries it.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    bridge();
    tauri_build::build()
}

fn bridge() {
    println!("cargo:rerun-if-changed=bridge/CelerBridge.java");
    println!("cargo:rerun-if-env-changed=CELER_BRIDGE_JAR");
    println!("cargo:rerun-if-env-changed=CELER_REQUIRE_BRIDGE");
    println!("cargo:rerun-if-env-changed=JAVA_HOME");
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let jar = out_dir.join("celer-bridge.jar");
    let required = env::var("PROFILE").as_deref() == Ok("release") || env::var("CELER_REQUIRE_BRIDGE").is_ok_and(|v| v == "1");

    if let Ok(given) = env::var("CELER_BRIDGE_JAR") {
        println!("cargo:rerun-if-changed={given}");
        fs::copy(&given, &jar).unwrap_or_else(|e| panic!("CELER_BRIDGE_JAR={given}: {e}"));
        return;
    }
    match compile(&out_dir, &jar) {
        Ok(()) => {}
        Err(why) if required => panic!(
            "\n\nNo se pudo compilar el puente JDBC (src-tauri/bridge): {why}\n\
             Hace falta un JDK 11 o superior (JAVA_HOME o javac en el PATH), o CELER_BRIDGE_JAR con el jar ya hecho.\n\n"
        ),
        Err(why) => {
            println!("cargo:warning=Puente JDBC no incluido ({why}): las conexiones Informix por JDBC no funcionarán en esta compilación");
            fs::write(&jar, b"").unwrap();
        }
    }
}

fn tool(name: &str) -> PathBuf {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    if let Some(home) = env::var_os("JAVA_HOME") {
        let p = Path::new(&home).join("bin").join(&exe);
        if p.is_file() {
            return p;
        }
    }
    PathBuf::from(exe)
}

fn compile(out_dir: &Path, jar: &Path) -> Result<(), String> {
    let classes = out_dir.join("bridge-classes");
    let _ = fs::remove_dir_all(&classes);
    fs::create_dir_all(&classes).map_err(|e| e.to_string())?;
    let src = Path::new("bridge").join("CelerBridge.java");
    let javac = Command::new(tool("javac"))
        .args(["--release", "11", "-encoding", "UTF-8", "-nowarn", "-d"])
        .arg(&classes)
        .arg(&src)
        .output()
        .map_err(|e| format!("javac: {e}"))?;
    if !javac.status.success() {
        return Err(format!("javac: {}", String::from_utf8_lossy(&javac.stderr)));
    }
    let _ = fs::remove_file(jar);
    let packed = Command::new(tool("jar"))
        .arg("cf")
        .arg(jar)
        .arg("-C")
        .arg(&classes)
        .arg(".")
        .output()
        .map_err(|e| format!("jar: {e}"))?;
    if !packed.status.success() {
        return Err(format!("jar: {}", String::from_utf8_lossy(&packed.stderr)));
    }
    Ok(())
}
