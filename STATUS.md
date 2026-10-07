# Celer — project status

Fast desktop SQL client: Tauri 2 + Rust core + SolidJS interface.
Full plan: [docs/ROADMAP.md](docs/ROADMAP.md) · drivers: [docs/DRIVERS.md](docs/DRIVERS.md).

## Done
- **Windows build works** with the MSVC toolchain (Visual Studio Build Tools 2022). Release installer (NSIS,
  per-user) via `npm run tauri build`.
- **Drivers** (all native, nothing to install):
  - `postgres.rs`: PostgreSQL (sync `postgres` crate). Server-side cursors (`DECLARE … NO SCROLL CURSOR`) for
    paging, cancel token, manual/auto transactions with exact `in_transaction`, multi-database tree with a cached
    secondary connection, full DDL reconstruction (tables, constraints, indexes, triggers, views, matviews,
    functions, sequences), dollar-quote aware script splitter, error position (line/column).
  - `mysql.rs`: MySQL / MariaDB. Streaming reader thread with a bounded channel (1,024 rows) so large results
    never load into memory, `KILL QUERY` cancellation, DELIMITER-aware splitter, TLS modes, SHOW CREATE DDL.
  - `mssql.rs` (tiberius), `sqlite.rs` (embedded), `odbc.rs` + `odbc_driver.rs` (Informix, generic ODBC).
- **Tests**: `cargo test --lib` — 27 tests, including integration tests against live PostgreSQL 17 and
  MariaDB 11.4 when `CELER_PG_TEST` / `CELER_MYSQL_TEST` are set (see "Test databases").
- **Interface** (redesigned, Claude-warm palette with DataGrip density):
  - Explorer: virtualised tree (10k+ objects), keyboard navigation, type-to-filter, context menus (open data,
    structure, DDL, generate SELECT/INSERT/UPDATE/DELETE/COUNT, copy names, refresh), drag a table into the editor,
    approximate row counts, auto-expands the current database on connect.
  - Consoles: CodeMirror 6 with schema-aware completion per dialect, current-statement band, run statement /
    selection / script, EXPLAIN, format, multi-cursor, folding, search; connection and database pickers per console;
    Auto/Manual transaction toggle with commit/rollback.
  - Results: canvas grid with native scrollbars, active cell, keyboard navigation, autofit, in-grid search (Ctrl+F),
    copy as TSV/CSV/JSON/Markdown/INSERT/IN/WHERE, selection aggregates (Σ, avg, min, max, distinct) in the status bar,
    infinite paging and "load all" in large chunks; Output log with errors and timings.
  - Table viewer: data with WHERE / ORDER BY filters, quick filters from a cell, editing (cells, NULL, add/clone/
    delete rows) with SQL preview and **atomic save** (one transaction, rolled back on error); columns, indexes,
    keys and highlighted DDL.
  - Inspector panel: value viewer (JSON pretty-print, wrap), record view, searchable query history.
  - Command palette (Shift Shift, Ctrl+K, Ctrl+N for tables, Ctrl+Shift+A for actions), DataGrip shortcuts.
  - Connection dialog with engine picker and connection test; production connections confirm dangerous statements;
    read-only connections enforced in the Rust core.
  - 8 themes (Celer Dark/Light, Darcula, Fjord, Sand, two high-contrast, System) with live previews, accent colours,
    density, Gib the mascot.
- **Window**: custom title bar in the theme's colours (no generic Windows frame) with Windows 11-style caption
  buttons; the window is shown after its first paint (no white flash).
- **Gib**: startup splash (thinks while loading → light bulb and smile → hops to the status bar), thinks while a
  query runs and gets an idea when a long one finishes, reacts to errors/connections/commits, contextual tips learned
  from use (mouse runs, slow queries, paging, production), waves on hover, heart on double click.
- **Table filters**: per-column filter chips (=, ≠, <, >, between, contains, starts/ends, in list with value
  checklist from loaded rows, NULL / empty), toggle/edit/remove, combined with the free WHERE; server-side sorting
  from the header; exact row count on a side session.
- **Export**: from a console, a filtered table or the explorer; CSV (delimiter), TSV, Excel (auto-fit), JSON,
  SQL INSERT (batched rows, dialect-correct booleans), Markdown and HTML; streaming with progress, cancel and
  "show in folder".
- **Import**: CSV/TSV into a table with delimiter/header detection, automatic column mapping, preview, required
  column warnings, batched multi-row INSERTs, all-or-nothing transaction.
- **AI**: in-app assistant (Claude via the official SDK, streaming; Opus 5.5 by default, Sonnet 5.5 / Haiku 4.5
  selectable) that generates, explains, fixes and optimises SQL from the real schema — never row data; the API key
  lives in the OS credential store. "Copiar esquema para IA" copies an AI-ready Markdown description. MCP server
  (`celer.exe --mcp`) for external assistants with per-connection permission levels, row limits, sensitive-column
  masking and an audit log, configurable in Settings › IA y MCP.
- **Logo**: redesigned mark and app icon (all sizes regenerated from `docs/brand/app-icon.svg`).
- **Engine logos**: official PostgreSQL, MySQL, MariaDB (detected from the server banner) and SQLite marks from Simple
  Icons (CC0 paths, `dev/brand-icons.mjs`); Microsoft and IBM don't license theirs, so SQL Server, Informix and ODBC use a
  neutral database glyph. See [docs/AI_MCP.md](docs/AI_MCP.md) for the AI features.
- **Quality pass**: 23 issues from a code review fixed (statement under the cursor after `;`, formatter and line
  comments, Manual mode after reconnect, read-only batches, LIKE escaping, MySQL backslashes, dialect quoting,
  stale counts, dead table tabs after disconnect, F5 reloading the page, close-with-unsaved-work prompt, …).
- **Tests**: `cargo test --lib` (40, incl. live PostgreSQL/MariaDB and MCP); `node dev/e2e.mjs` drives the running
  desktop app over CDP (14 end-to-end checks: connect, filters, count, server sort, all export formats with 200k rows,
  credential store, MCP defaults, read-only protection, Ctrl+Enter).
- **Performance** (debug build, PostgreSQL, 6 columns): first page of 200k rows in 3 ms; loading all 200,000 rows in
  1.3 s with a 54 MB JS heap; scrolling the grid at ~7 ms per frame.
- Browser preview: `npm run dev` runs the same UI against an in-memory sql.js demo.

## Next
1. SQL Server integration tests (no local server yet) and Informix.
2. Graphical execution plans; ER diagrams; schema/data compare.
3. Data import (CSV/Excel), saved scripts library, migration assistant from DBeaver/DataGrip.
4. Signed installer and auto-update.

## Development
```powershell
npm install
# Rust builds go to D: (C: is nearly full); dev/run-desktop.ps1 sets this
$env:CARGO_TARGET_DIR = "D:\celer-target"
npm run tauri dev                         # or: powershell -File dev\run-desktop.ps1
```
`dev/run-desktop.ps1` builds a debug app and starts it with the DevTools protocol on port 9333;
`node dev/cdp.mjs eval|shot|click|type|key …` drives it for end-to-end checks.

## Test databases (portable, no admin)
| Engine | Start | Connection |
|---|---|---|
| PostgreSQL 17 | `powershell -File dev\testdb-postgres.ps1 start` | `localhost:54329`, user/password `celer`, db `celer` |
| MariaDB 11.4 | `powershell -File dev\testdb-mysql.ps1 start` | `127.0.0.1:33069`, user/password `celer`, db `celer` |

Seeds: `dev/seed-postgres.sql`, `dev/seed-mysql.sql` (each has a 200k-row `events` table for paging tests).
```powershell
$env:CELER_PG_TEST = "host=localhost port=54329 user=celer password=celer dbname=celer"
$env:CELER_MYSQL_TEST = "mysql://celer:celer@127.0.0.1:33069/celer"
cd src-tauri; cargo test --lib
```
