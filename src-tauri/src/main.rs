// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `celer --mcp`: servidor MCP por stdio para asistentes de IA, sin abrir ninguna ventana.
    if std::env::args().skip(1).any(|a| a == "--mcp") {
        std::process::exit(celer_lib::run_mcp());
    }
    celer_lib::run()
}
