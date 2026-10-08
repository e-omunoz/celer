# Area: Rust core (commands, threads, files)

Code: `src-tauri/src/lib.rs`, `main.rs`, `windows.rs`, `store.rs`, `export.rs`, `sheets.rs`, `startup.rs`,
`update.rs`, `migrate.rs`, `session.rs`; `src-tauri/Cargo.toml`, `tauri.conf.json`, `capabilities/*.json`.
Run `cargo clippy --all-targets` and `cargo test --lib` in `src-tauri` and read the warnings.

## Look for
- `unwrap()`/`expect()`/indexing/slicing that can panic on user data or I/O; panics inside threads that leave a
  session or a lock poisoned; `Mutex` held across blocking I/O or across `await`.
- Blocking work on the main/UI thread (long queries, file I/O, network) that freezes the window.
- Threads, channels or child processes (JVM bridge, exports) never joined or killed on close/cancel/app exit.
- Files: non-atomic writes of `connections.json`, `workspace.json`, layout and library (write temp + rename),
  concurrent writers from several windows, corrupt/old-version files on start (migration, fallback, no crash).
- Errors swallowed or turned into generic text; error messages in the wrong language for the UI.
- Export/import: encoding (UTF-8 BOM for Excel CSV), delimiter escaping, huge files, cancel leaves partial files.
- Update flow: SHA-256 verified before run, no download before the user asks, portable copies.
- Command surface: every `#[tauri::command]` validates its input; capabilities grant only what each window needs.
- Cross-platform: path handling, case sensitivity, macOS/Linux code paths that compile but were never run.
