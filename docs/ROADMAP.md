# Roadmap

## Phase 0 — Foundations ✅
- [x] Project scaffold: Tauri 2 + Rust + SolidJS
- [x] Core: sessions, `Driver` trait, paging, cancellation, transactions
- [x] Drivers: SQL Server (native), Informix (IBM CLI / CSDK), generic ODBC
- [x] Export: CSV, TSV, JSON, SQL, Excel
- [x] Persistence: connections, OS credential store, history
- [x] Core compiles on Linux (`cargo test --lib`)
- [x] Windows build on the MSVC toolchain
- [x] Core integration tests against every engine (`engine_tests.rs`; SQL Server and Informix in `engines.yml`)

## Phase 1 — Usable client (MVP)
- [x] Connection manager: folders, colours, production / read-only flags, test connection
- [x] Object tree with lazy loading and filtering
- [x] SQL editor (CodeMirror 6): syntax highlighting per dialect, schema-aware autocompletion,
      run statement at cursor (Ctrl+Enter), run script (Alt+X), cancel, format SQL
- [x] Canvas result grid: virtualized rows and columns, resize, sort, selection, copy as TSV/CSV/SQL,
      value viewer for long text / JSON / binary
- [x] Multiple results and messages per execution
- [x] Table viewer: data, columns, indexes, keys, DDL
- [x] Data editing with primary keys: edit cells, insert / delete rows, SQL preview before saving
- [x] Export dialog with progress and cancellation
- [x] Query history panel with search
- [x] Themes: light, dark, high contrast and accent colours; font size; follows the OS theme
- [x] Workspace restore: open tabs and their content survive restarts
- [x] Several windows: tabs dragged between them with their sessions, layout restored per monitor
- [x] Connection organisation: nested folders, favourites, recent, search, multi-selection with undo
- [x] Reconnection that never loses work in silence; "Probar conexión" step by step

## Phase 2 — Tier 1 drivers
- [x] PostgreSQL (native; CockroachDB, YugabyteDB, TimescaleDB, Redshift speak its protocol)
- [x] MySQL / MariaDB family
- [x] SQLite (embedded). libSQL / Turso still planned
- [ ] Oracle (Instant Client, downloaded on demand)
- [ ] IBM Db2 (LUW, i, z/OS) via the IBM CLI driver
- [x] Informix over JDBC (Celer's bridge), Client SDK and IBM CLI (DRDA); generic ODBC
- [ ] Generic connection form driven by each driver's field description
- [ ] Capability flags wired into the UI

## Phase 3 — Productivity ✅
- [x] Execution plans as a tree for every engine, with real rows and times (EXPLAIN ANALYZE)
- [x] Command palette (Ctrl+K) and configurable shortcuts
- [x] Live templates, query parameters and a script library
- [x] Result comparison (pinned vs current) and a quick filter inside the grid
- [x] ER diagram of a schema (SVG export)
- [x] Data import from CSV, JSON and Excel / OpenDocument
- [x] Schema compare between two connections, with a synchronization script
- [x] Server activity: sessions and running queries, cancel and kill
- [x] Typed cell editors: booleans, dates, foreign-key lookup
- [x] Data compare between two tables, with a synchronization script
- [x] Test data generator: realistic, valid rows for a table on every engine
- [x] Theme editor: custom themes with live preview, contrast checks and export/import
- [x] Informix row history from the logical logs
- [x] Migration of connections from DBeaver and DbVisualizer
- [x] AI assistant and MCP server with permissions per connection

## Next — from the open issues

Delivered in the latest sprint (2.4, integrated in one PR, see [STATUS.md](../STATUS.md)): look and feel (theme
editor #107, tear-off outline and ghost card for dragged tabs #108, consistent motion, styles and F6 between panels
#110); simplify (the approved reorganisation of menus, toolbars, dialogs and settings, with keyboard submenus #111);
drivers (Informix point-in-time row history from the logical logs #123); working tools (test data generator on every
engine #172); and the fixes from the sprint's macro review.

Next sprints, from what is still open (refreshed at the end of each sprint):

- **Drivers** — Oracle and IBM Db2, the generic connection form and capability flags (Phase 2)
- **Platform** — code signing for the Windows builds (Phase 6)
- **Docs** — keep STATUS and this roadmap refreshed at the end of each sprint (#121)

## Phase 4 — Tier 2 drivers (analytics and cloud)
- [ ] DuckDB (including CSV / Parquet / JSON files)
- [ ] ClickHouse, Trino / Presto, SAP HANA, Firebird
- [ ] Snowflake, BigQuery, Databricks, Athena
- [ ] Arrow Flight SQL / ADBC

## Phase 5 — Tier 3 drivers (NoSQL)
- [ ] MongoDB with document viewer and aggregation editor
- [ ] Redis / Valkey key browser
- [ ] Cassandra / ScyllaDB
- [ ] Elasticsearch / OpenSearch

## Phase 6 — Release
- [x] Windows installer (Celer Setup) and portable build, built on GitHub Actions — code signing still to come
- [x] Auto-update (Windows)
- [x] Linux (AppImage, deb, rpm) and macOS (universal dmg) builds
- [x] User documentation ([GUIA.md](GUIA.md))

## Performance targets

Measured on every release against the seeded test containers (LAN database, 10-column table):

| Workload | Target |
|---|---|
| Cold start | < 0.8 s |
| Idle memory | < 120 MB |
| App overhead on the first 500 rows | < 25 ms |
| Load 100,000 rows into the grid | < 1.5 s |
| Export 1,000,000 rows to CSV | limited by database / network |
| Grid scrolling, 50 columns | 60 fps |
| Object tree with 10,000 tables | < 0.7 s |

Each target is measured on the same machine and data from one release to the next, so regressions show up early.
