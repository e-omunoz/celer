# Celer — project status

Fast desktop SQL client: Tauri 2 + Rust core + SolidJS interface.
Full plan: [docs/ROADMAP.md](docs/ROADMAP.md) · drivers: [docs/DRIVERS.md](docs/DRIVERS.md).

## Done (2.4.0)

What each area is for is defined in [docs/ARCHITECTURE.md › Areas](docs/ARCHITECTURE.md#areas); here is what each
one has today.

- **Platform**: Windows, macOS (universal dmg) and Linux (AppImage, deb, rpm) builds from GitHub Actions on a `vX.Y.Z`
  tag; Celer Setup (per-user, no administrator, silent mode for deployment) and portable builds; in-app updates on
  Windows verified against `SHA256SUMS.txt`. Several windows with tabs dragged between them (a ghost card follows the
  tab, and outside the windows an outline shows exactly where the new window opens), sessions kept, and the layout
  restored per monitor; F6 / Shift+F6 move the focus between panels. Custom title bar in the theme's colours.
- **Drivers** (nothing to install except for Informix):
  - PostgreSQL (server-side cursors, full DDL, dollar-quote aware splitter, error position), MySQL / MariaDB
    (streaming reader, `KILL QUERY`, `DELIMITER`), SQL Server (TDS, Windows authentication, its own connection pool),
    SQLite (embedded), Informix over JDBC (Celer's bridge, one shared JVM; Java and the driver found or downloaded on
    demand), the Client SDK or IBM CLI (DRDA), and any ODBC source.
  - Watched sessions on every engine: checked before use, reconnected when nothing was lost, `SESSION_LOST` when a
    transaction, temporary tables or `SET` would be; connections reused for a few minutes; a startup script per
    connection; "Probar conexión" step by step with an explanation of each failure.
- **Explorer**: connections in nested folders, favourites, recent, search across every field, manual or alphabetical
  order, multi-selection (connections, folders, objects) with undo; virtualised object tree (10k+ objects); per-object
  menus to open, generate SQL (SELECT with joins, INSERT, UPDATE, DELETE, UPSERT/MERGE, DROP, DDL), export, import,
  diagram and compare; connection export/import as JSON without passwords; server activity (sessions, cancel, kill).
- **Consoles**: CodeMirror 6 with schema-aware completion per dialect, live templates, query parameters, current
  statement band, run statement / selection / script, Ctrl+click to open a table, warnings on UPDATE/DELETE without
  WHERE, Auto/Manual transactions with commit/rollback, `.sql` files kept with their encoding and line endings.
  **Execution plans** as a tree on every engine, with real rows and times where the engine measures them (EXPLAIN
  ANALYZE) and warnings worth acting on.
- **Results**: canvas grid paged from an open cursor ("Cargar todo" in chunks, cancellable), keyboard navigation,
  search, quick filter over loaded rows, columns reordered by dragging, copy as TSV/CSV/JSON/XML/Markdown/INSERT/IN/
  WHERE, selection aggregates in the status bar, a pinned result compared with the current one.
- **Table viewer**: per-column filter chips and free WHERE / ORDER BY (with a fix for `"text"`), server-side sort,
  exact count, typed cell editors (booleans, dates, foreign-key lookup), add/clone/delete rows, SQL preview and atomic
  save, foreign keys followed to the referenced row; Columns, Indexes, Keys and DDL tabs.
  On Informix, «Historial de la fila» reads a row's past changes from the logical logs (CDC API over JDBC), with
  before → after per column, and says why when it cannot or when the history may be partial.
- **Library**: named scripts in folders with tags and a connection, linked consoles that save back, search and
  palette entries, drag into the editor, import/export of `.sql` files keeping folders and tags.
- **History**: every statement with connection, time, duration and rows, searchable, pasted or reopened in a click.
- **E-R diagram**: a whole schema or one table with its relations both ways, expandable a level at a time, centred on
  a table, searchable, SVG export, in its own window if wanted.
- **Schema and data compare**: two schemas (same or different connections) with a script to make the target match;
  two tables' rows paired by primary key (up to 50,000 per table) with an INSERT/UPDATE script, DELETEs commented.
- **Import / export**: streaming export to CSV, TSV, Excel, JSON, XML, SQL INSERT, Markdown and HTML with progress
  and cancel; import of CSV, TSV, JSON and spreadsheets (xlsx, xls, ods) with column mapping, preview, required-column
  warnings and one transaction.
- **Test data**: fills a table with realistic, valid rows (up to 1,000,000) on every engine: a generator per column
  inferred from type and name (Spanish or English data), CHECK lists and ranges, enums, unique and foreign keys kept,
  reproducible by seed, previewed; inserted through the import pipeline in one transaction with cancel, or written as
  a script or CSV / JSON.
- **Migrate**: connections from DBeaver (saved passwords only when asked) and DbVisualizer, with folders, production
  flags and Informix properties.
- **Settings**: 8 themes (Celer Oscuro and Claro, Darcula, Fjord, Sand, high contrast dark and light, follow the
  system, with a theme for its light mode and one for its dark mode) with live previews; a theme editor makes custom
  themes from any built-in one (every token, fonts, radius, motion speed; live preview, WCAG contrast checks,
  `.celer-theme.json` export/import); sections grouped as General, Editor, Conexiones and IA y MCP; accent colour,
  density, interface and editor size, motion, page size, templates, every shortcut rebindable (AltGr safe), safety
  confirmations, AI and MCP, Informix drivers.
- **AI / MCP**: in-app assistant (Claude Opus 5.5 by default, Sonnet 5.5 / Haiku 4.5) that writes, explains, fixes
  and optimises SQL from the schema, never rows, key in the OS credential store; MCP server (`celer --mcp`) with a
  permission level per connection, row and time limits, masked columns and an audit log. See
  [docs/AI_MCP.md](docs/AI_MCP.md).
- **Gib**: start-up splash, thinks while queries run and shows progress with cancel on long operations, idle
  routines, reactions, tips learned from use and advice about the query just run; quiet or off in Settings.
- **Safety**: read-only connections enforced in the Rust core, production connections confirm risky statements,
  passwords only in the OS credential store, damaged data files set aside instead of overwritten.
- **Tests**: `cargo test --lib` has 250 tests, the live ones run against every engine when its `CELER_*_TEST`
  variable is set (`dev/wsl.ps1 test`, or `engines.yml` on GitHub Actions for SQL Server and Informix); 31 pure logic
  checks (`dev/*-check.ts`); 26 end-to-end scripts that drive the desktop app over CDP (`dev/*-check.mjs`) plus
  `dev/e2e.mjs`, all run by `dev/check-all.ps1`.
- **Performance** (debug build, PostgreSQL, 6 columns): first page of 200k rows in 3 ms; loading all 200,000 rows in
  1.3 s with a 54 MB JS heap; scrolling the grid at ~7 ms per frame.
- Browser preview: `npm run dev` runs the same UI against an in-memory sql.js demo.

## Next

Implemented in the current sprint (2.4; one branch per package, integrated in one PR; listed here so the docs match
the code): theme editor (#107); tear-off outline and ghost card for dragged tabs (#108); consistent motion, component
styles, drag and drop and F6 between panels (#110); the approved reorganisation of menus, toolbars, dialogs and
settings, with keyboard submenus (#111); Informix row history from the logical logs (#123); test data generator on
every engine (#172); and the fixes from the sprint's macro review.

Still open (see [docs/ROADMAP.md](docs/ROADMAP.md) for the longer view):

1. **Drivers**: Oracle and IBM Db2, a generic connection form driven by each driver's fields, and capability flags
   wired into the UI (Phase 2 of the roadmap).
2. **Platform**: code signing for the Windows builds.
3. **Docs**: keep this file and the roadmap refreshed at the end of each sprint (#121).

## Development
```powershell
npm install
# Rust builds go to D: (C: is nearly full); dev/run-desktop.ps1 sets this
$env:CARGO_TARGET_DIR = "D:\celer-target"
npm run tauri dev                         # or: powershell -File dev\run-desktop.ps1
```
`dev/run-desktop.ps1` builds a debug app and starts it with the DevTools protocol on port 9333;
`node dev/cdp.mjs eval|shot|click|type|key …` drives it for end-to-end checks.

## Test databases

Every engine runs in Docker inside WSL (`dev\wsl.ps1 db up|seed`, or `bash dev/wsl/engines.sh up|seed` from WSL);
ports, credentials and the `CELER_*_TEST` variables are in
[docs/review/ENGINE_MATRIX.md](docs/review/ENGINE_MATRIX.md). Portable PostgreSQL and MariaDB servers for Windows
are still there:

| Engine | Start | Connection |
|---|---|---|
| PostgreSQL 17 | `powershell -File dev\testdb-postgres.ps1 start` | `localhost:54329`, user/password `celer`, db `celer` |
| MariaDB 11.4 | `powershell -File dev\testdb-mysql.ps1 start` | `127.0.0.1:33069`, user/password `celer`, db `celer` |

Seeds: `dev/seed-postgres.sql`, `dev/seed-mysql.sql`, `dev/seed-mssql.sql`, `dev/seed-informix.sql` (PostgreSQL and
MySQL have a 200k-row `events` table for paging tests).
```powershell
$env:CELER_PG_TEST = "host=localhost port=54329 user=celer password=celer dbname=celer"
$env:CELER_MYSQL_TEST = "mysql://celer:celer@127.0.0.1:33069/celer"
cd src-tauri; cargo test --lib
```
