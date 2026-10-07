# Celer — project status

Desktop SQL client intended to replace DBeaver: Tauri 2 + Rust core + SolidJS interface.
Full plan: [docs/ROADMAP.md](docs/ROADMAP.md) · drivers: [docs/DRIVERS.md](docs/DRIVERS.md).

## Done
- Rust backend written (not yet successfully compiled):
  - `src-tauri/src/mssql.rs`: native SQL Server driver (tiberius), SQL and Windows authentication.
  - `src-tauri/src/odbc.rs` + `odbc_driver.rs`: ODBC/CLI with dynamic loading; Informix (DRDA via the IBM CLI driver, or SQLI via the Client SDK) and generic ODBC.
  - `session.rs`: one session per tab on its own thread, paged results, cancellation, transactions.
  - `export.rs` (CSV/TSV/JSON/SQL/Excel), `store.rs` (connections, credentials in the OS store, history), `drivers.rs` (IBM driver discovery/download), `lib.rs` (Tauri commands).
- Frontend switched from React to SolidJS (`vite-plugin-solid`); placeholder app builds.
- `dev/seed-mssql.sql` and `dev/seed-informix.sql`: test data for the Docker containers `dbx-mssql` and `dbx-informix`.
- Documentation: architecture, driver plan and roadmap in `docs/`.

## Next
1. Build: the antivirus blocked MinGW's `ld.exe` (false positive). Decision: switch to the MSVC toolchain
   (Visual Studio Build Tools 2022) and run `rustup default stable-x86_64-pc-windows-msvc`.
   Remove the MinGW path from `dev/env.ps1`.
2. Compile the core and test it against the SQL Server and Informix containers.
3. Phase 1 of the roadmap: the user interface.
4. Phase 2: tier 1 drivers (PostgreSQL, MySQL/MariaDB, SQLite, Oracle, Db2).

## Rebuilding
Run `npm install` at the root; the backend builds from `src-tauri` with `cargo build`.
