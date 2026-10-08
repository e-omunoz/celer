# Changelog

All notable changes to Celer are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/lang/es/).

## [Unreleased]

### Added
- **Informix over JDBC (SQLI)**: Celer connects like DBeaver does, with IBM's JDBC driver, to servers that only listen on SQLI (`onsoctcp`, port 9088) and without the Client SDK.
  - The connection form has a new protocol, **Automático** (the default for new connections): the Client SDK when its ODBC driver is installed, JDBC otherwise. Saved connections keep their protocol.
  - Java 11 or newer is found on its own (Settings, `JAVA_HOME`, DBeaver's JRE, the `PATH`), and so is the JDBC driver (DBeaver's cache). What is missing can be downloaded, only when you ask, into Celer's data folder: Eclipse Temurin JRE 21 and the driver from Maven Central (15.0.1.4, which also reads Informix 15 servers), each checked against its SHA-256, with progress and cancel. No administrator rights are needed.
  - One Java process serves every JDBC connection; it starts while the password is asked. Results come in compact binary batches, with transactions, paging and database switching, and the same explorer, DDL, editing and scripts as the other Informix protocols.
  - Cancel stops the query on the server; when the server does not obey within 5 s (a proxy or firewall dropped the cancel), Celer cuts that connection and opens another one, says so if an open transaction was lost, and the other tabs are not affected.
  - "Probar conexión" says which way it connected.
- **Settings › Drivers** shows what each Informix protocol has (IBM CLI, Java and the JDBC driver, the Client SDK), with download buttons, "Usar" for DBeaver's copies and a check that starts Java.
- **Guide for Informix connections** in the app, shown instead of the raw error when a driver is missing or the server name, port or locale are wrong (`IM002`, `CLI0199E`, `SQL30081N`, -908, -761, -25596, -23101, -23197).

### Fixed
- **Informix**: importing a DBeaver or DbVisualizer connection keeps its `informixserver` and the other URL properties ("Parámetros extra"), and uses "Automático" instead of DRDA.
- **Informix**: an empty database no longer sends `DATABASE=;` to the driver; DRDA asks for the database before connecting.
- Driver downloads use the system's proxy (Windows Internet settings or `HTTPS_PROXY`) and can be cancelled.

## [2.0.1] - 2026-10-08

### Fixed
- **SQL Server**: closing a result before reading it all could crash the session ("no reactor running").
- **SQL Server**: text values are written as `N'…'`, so accents and other Unicode characters survive filters, edits and scripts.
- **Informix** (IBM driver on macOS and Linux): database and object names came back cut or with garbage; the driver's 32-bit lengths are now read as such.
- **Informix**:
  - foreign keys appear in the explorer ("Claves foráneas"), with their columns and the table they point to;
  - DATETIME values are written with exactly their column's fields (YEAR TO MINUTE, FRACTION(3)…), so a value from the grid can be edited, filtered and compared;
  - fractions of seconds are shown with the column's digits;
  - BOOLEAN filters and edits use `'t'` / `'f'`;
  - a script with several statements now runs all of them, not just the first: table edits, data comparison and schema comparison scripts were partly lost;
  - generated scripts no longer quote names, which Informix took as text.
- Integration tests against real SQL Server 2022 and Informix servers cover filters, edits, dates and times, MERGE, foreign-key lookup, cancel, data comparison and the startup script; execution plans and schema comparison on SQL Server.

## [2.0.0] - 2026-10-08

### Added
- **Execution plans as a tree** for every engine (Ctrl+Mayús+E, and "Analizar" to run and measure):
  - PostgreSQL and MariaDB with real rows and times;
  - MySQL, SQLite and SQL Server;
  - warnings worth acting on: big full scans, estimates far from reality, sorts spilling to disk, missing indexes suggested by SQL Server.
- **Entity-relationship diagram** of a schema:
  - tables laid out by dependency, crow's-foot relations, search;
  - hover to light a table's relations, double-click to open it;
  - export to SVG.
- **Schema comparison**: mark a schema in the explorer, then "Comparar con…" on another one (same or another connection).
  - Lists the tables that exist on only one side, and columns with another type or nullability.
  - Writes a script that makes the target match the source, in a console of the target, to review before running it.
  - Anything that would delete data stays commented out.
- **Data comparison** of two tables: mark one, then "Comparar datos con…" on the other.
  - Rows are matched by the primary key; changed cells, rows only in one table and new rows are marked (hover a changed cell for its previous value).
  - A script makes the target's rows match: INSERT and UPDATE, with the DELETEs commented out.
- **Server activity**: sessions and running queries, with cancel and kill (PostgreSQL, MySQL/MariaDB, SQL Server, Informix).
- **Compare results**: pin a result, run again and compare. Changed cells, new rows and rows that are gone are marked, matched by a key that is guessed or chosen.
- **Pinned results** that survive new runs, and a **quick filter** over the loaded rows.
- **Script library** (Biblioteca): named scripts saved in the app (Ctrl+Alt+B), to open, rename, update and delete from the side panel.
- **Configurable keyboard shortcuts** (Ajustes › Atajos de teclado):
  - record new keys, remove keys, reset one command or all;
  - conflicts offer to move the key;
  - the editor's own keys are flagged;
  - AltGr characters (€, @, #) are never taken as shortcuts.
- **Live templates** (sel, selw, ins, upd, cte, …) with linked fields, editable in Ajustes › Plantillas.
- **Query parameters** (`:name`, `?`, `${name}`) asked before running.
- **Typed cell editors** in the table viewer:
  - booleans with t / f / space or a true–false picker;
  - dates with a calendar that keeps the time and the zone;
  - foreign keys with the referenced rows to pick from, searched by key or by a name-like column.
- **Import JSON and Excel / OpenDocument** (.xlsx, .xls, .ods, with a sheet chooser), next to CSV.
- **More generated scripts**: SELECT with JOINs of the foreign keys, UPSERT / MERGE, DROP, COUNT, `:name` parameters.
- **Startup script per connection** (SET search_path, SET LOCK MODE…). It runs on every connection the driver opens, reconnects included.
- Export and copy as **XML**; the value viewer indents XML as well as JSON.
- Scripts keep their **encoding** (UTF-8, UTF-8 with BOM, UTF-16, Windows-1252) and **line endings** when saved in place (Ctrl+S, "Guardar como…" Ctrl+Mayús+S).
- Undo a pending table edit per cell or per row.
- Table tabs, console cursors, autocommit mode and files are restored with the workspace.
- **Gib** has a life of his own when you are idle:
  - yawns, goes for a coffee, codes on his laptop, dozes, juggles, reads, dances…
  - swats the cursor like a fly if you poke him while he waits;
  - follows the system's reduced-motion setting, or Ajustes › Animaciones.

### Fixed
- **Desconectar** did nothing: the session stayed in the store. It now closes every session of the connection, cancels running exports and asks first when there is an open transaction or unsaved edits.
- The start-up guide was lost when its "import from DBeaver" step opened the import assistant.
- "Actualizar" in the explorer did not reload folders already expanded below the node: a table created elsewhere did not show up.
- A DELETE or UPDATE inside a CTE (`WITH d AS (DELETE …) SELECT …`) is now warned about and confirmed in production.
- Big integers in JSON imports are kept exactly (no rounding past 2^53).
- A settings, workspace or library file that cannot be read is set aside instead of being overwritten.
- The console toolbar no longer paints over the side panel in narrow windows; side panel tabs show icons only when narrow.
- Many smaller fixes from three review passes (explain cursors and transactions, SQL Server DML plans, MySQL subqueries in plans, PostgreSQL parallel times, Informix database switching…).

## [1.3.1] - 2026-10-08

### Added
- Drag connections between folders in the explorer (drop on a folder, on another connection to place it
  before it, or on "Sin carpeta" to take it out of its folder).

### Fixed
- The folder selector in a connection's properties only listed the current folder. It now lists every folder,
  "Sin carpeta" and "Nueva carpeta…".
- The guided tour's highlight ring was cut off at the window edges; it is now drawn inside the element.

### Changed
- New README (English and Spanish) with a screenshot gallery, and a social preview image for the repository.

## [1.3.0] - 2026-10-08

### Added
- **Import connections from DBeaver and DbVisualizer** ("Nuevo" menu, command palette or the start-up guide).
  - Shows a checklist of what was found and maps each driver to Celer's.
  - Flags connections that already exist and lists unsupported drivers explicitly.
  - Keeps folders, production flags and SQL Server instances.
  - Optionally imports DBeaver's saved passwords into the OS credential store.
  - Never modifies the source tools.
- **Ctrl+click / F4 / Ctrl+B on a table name** (or an alias) in the SQL opens the table. Holding Ctrl underlines it like a link.
- **Foreign keys you can follow**:
  - Ctrl+click on an FK value (or "Ir a la fila referenciada") opens the referenced row;
  - FK columns are marked with ↗ in the header;
  - the "Claves" tab opens the referenced table.
- Gib is sad while being uninstalled (and a tear falls).

### Fixed
- Completion offered only keywords and functions before a console's first run, and never unqualified
  columns. It now uses the real catalog from the moment the connection opens, with context:
  - tables after FROM/JOIN/UPDATE/INTO;
  - the statement's columns (with their table or alias) everywhere else;
  - alias./table. → columns, schema. → tables.
- Gib lost his shirt, sleeves and fur when another Gib was hidden in an inactive tab (shared SVG ids).
  His left arm is now drawn in front of the torso.
- Gib at the laptop (busy) was redrawn:
  - real arms and a big laptop;
  - a focused face instead of a cross one;
  - typing animation with a glint on the glasses.
- The start-up tour's bubble could be cut at the window edges, and the last step cropped Gib.
  The bubble now uses its real height and always fits; the spotlight covers Gib entirely.
- "1 filas" → "1 fila".

### Changed
- Dependencies: ureq 3 (update checks and driver downloads), sha2 0.11, mysql 26.
- macOS and Linux packages are built on demand (manual workflow) instead of on every release.

## [1.2.0] - 2026-10-08

### Added
- Busy overlay with Gib over the grid for long operations. It shows live progress and has **Cancelar**:
  - "Cargar todo" stops after the chunk in flight and keeps the rows loaded so far;
  - server reloads with filters or sorting are cancelled on the server.
- WHERE box help in the table viewer:
  - warns while you type when `"text"` would be read as a column name (PostgreSQL, SQL Server, Informix), with a one-click fix to `'text'`;
  - suggests `'%text%'` for `LIKE` without wildcards;
  - points engine errors at the right spot of your WHERE instead of the generated query.

### Fixed
- The window froze with 100k+ rows loaded: select all, copy, column selection and search did quadratic work
  (`unwrap` walked every row on each call). With 200k rows, select all now takes ~40 ms and copying ~250 ms.
- Local sorting of big console results is several times faster (sort keys are computed once).
- Release notes in the update dialog: wrapped list items were shown as loose paragraphs.

## [1.1.0] - 2026-10-07

### Added
- Native **PostgreSQL** driver: server-side cursors for paging, cancellation, manual/auto transactions,
  multi-database tree, full DDL reconstruction, dollar-quote aware splitter, error positions.
- Native **MySQL / MariaDB** driver: streaming reader with bounded memory, `KILL QUERY` cancellation,
  `DELIMITER`-aware splitter, TLS modes, `SHOW CREATE` DDL.
- Redesigned interface (warm palette, dense and quiet layout) with 8 themes, virtualised explorer, command
  palette, inspector (value, record, history), Output log, toasts and context menus.
- Custom window frame with Windows 11-style caption buttons in the theme's colours.
- **Gib**: startup splash (thinks → idea → hops to the status bar), reactions to queries, errors, connections and
  commits, contextual tips learned from use.
- **Start-up guide**: appearance, first connection or a sample SQLite database, an interactive spotlight tour of the
  interface and the essential shortcuts.
- Table viewer: per-column filter chips (incl. value checklists), server-side sorting, exact row count.
- Export to CSV, TSV, Excel, JSON, SQL INSERT (batched), Markdown and HTML with progress, cancel and
  "show in folder"; import from CSV/TSV with column mapping in a single transaction.
- **AI**: in-app SQL assistant with Claude (schema only, never row data; key in the OS credential store) and an
  **MCP server** (`celer.exe --mcp`) with per-connection permission levels, row limits, sensitive-column masking
  and an audit log.
- Official engine logos (PostgreSQL, MySQL, MariaDB, SQLite) and a redesigned app logo and icon.
- **Celer Setup**: a custom installer and uninstaller in the app's style (per-user, no admin), with a silent mode.
- **Automatic updates**: Celer looks for new releases on start-up, shows what's new and updates itself in one click.
  - The download is verified against the release's SHA-256 sums.
  - The installer keeps your options and reopens Celer.
  - Closing Celer with an update downloaded installs it quietly.
- Gib has articulated arms and full-body animations: hand on chin while thinking, finger up on an idea, a real wave.
- End-to-end test harness over CDP (`dev/e2e.mjs`) and live database integration tests.

### Fixed
- Desktop sessions could not open (Tauri 2 expects camelCase command arguments).
- Ctrl+Enter right after `;` ran the next statement; the formatter swallowed code after `--` comments.
- Manual transaction mode was lost after a reconnect; read-only connections could be bypassed with a batch.
- Saving table edits is now atomic; LIKE filters escape `%`/`_`; MySQL backslashes and dialect quoting.
- F5 no longer reloads the window; closing asks about open transactions and unsaved edits.
- Load-all of 200k rows went from 23 s to 1.3 s with an eighth of the memory.

## [1.0.0] - 2026-09-30

### Added
- Phase 1 client: SQL Server, Informix, SQLite and ODBC drivers, CodeMirror editor, canvas grid, table viewer,
  export, history and themes.

[Unreleased]: https://github.com/e-omunoz/celer/compare/v2.0.1...HEAD
[2.0.1]: https://github.com/e-omunoz/celer/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/e-omunoz/celer/compare/v1.3.1...v2.0.0
[1.3.1]: https://github.com/e-omunoz/celer/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/e-omunoz/celer/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/e-omunoz/celer/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/e-omunoz/celer/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/e-omunoz/celer/releases/tag/v1.0.0
