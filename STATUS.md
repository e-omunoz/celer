# Celer — project status

Desktop SQL client intended to replace DBeaver: Tauri 2 + Rust core + SolidJS interface.
Full plan: [docs/ROADMAP.md](docs/ROADMAP.md) · drivers: [docs/DRIVERS.md](docs/DRIVERS.md).

## Done
- Rust core compiles on Linux. `cargo test --lib` covers keyword splitting, Informix type mapping,
  and the SQLite driver (paging, metadata, scripts, transactions).
- Drivers:
  - `src-tauri/src/mssql.rs`: native SQL Server (tiberius), SQL and Windows authentication.
  - `src-tauri/src/odbc.rs` + `odbc_driver.rs`: ODBC/CLI with dynamic loading; Informix (DRDA via the IBM CLI driver, or SQLI via the Client SDK) and generic ODBC.
  - `src-tauri/src/sqlite.rs`: embedded SQLite (`rusqlite`, bundled). Paged fetch, `sqlite3_interrupt` cancellation, transactions, catalog and DDL.
  - `session.rs`: one session per tab on its own thread, paged results, cancellation, transactions.
  - `export.rs` (CSV/TSV/JSON/SQL/Excel), `store.rs` (connections, OS credential store with a mode-600 file fallback, history), `drivers.rs` (IBM driver discovery/download, including `.tar.gz`), `lib.rs` (Tauri commands).
- Phase 1 interface (SolidJS): connection manager, lazy object tree with filter, CodeMirror 6 SQL editor,
  canvas result grid, multi-result tabs, table viewer with primary-key editing and SQL preview, export dialog,
  query history, and light / dark / high-contrast themes.
- Browser preview: outside Tauri the same UI runs against an in-memory sql.js database with seeded demo data.
- `dev/seed-mssql.sql` and `dev/seed-informix.sql`: test data for the Docker containers `dbx-mssql` and `dbx-informix`.
- Documentation: architecture, driver plan and roadmap in `docs/`.

## Next
1. Windows build: the antivirus blocked MinGW's `ld.exe` (false positive). Switch to the MSVC toolchain
   (Visual Studio Build Tools 2022) and run `rustup default stable-x86_64-pc-windows-msvc`.
   Remove the MinGW path from `dev/env.ps1`.
2. Integration tests against the SQL Server and Informix containers.
3. Remaining tier 1 drivers: PostgreSQL, MySQL/MariaDB, Oracle, Db2, and remote libSQL / Turso.

## Rebuilding
Run `npm install` at the root; the backend builds from `src-tauri` with `cargo build`.
