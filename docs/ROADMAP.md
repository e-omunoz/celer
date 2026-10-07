# Roadmap

## Phase 0 — Foundations ✅ (mostly)
- [x] Project scaffold: Tauri 2 + Rust + SolidJS
- [x] Core: sessions, `Driver` trait, paging, cancellation, transactions
- [x] Drivers: SQL Server (native), Informix (IBM CLI / CSDK), generic ODBC
- [x] Export: CSV, TSV, JSON, SQL, Excel
- [x] Persistence: connections, OS credential store, history
- [ ] Switch the Windows build to the MSVC toolchain and get the core compiling
- [ ] Core integration tests against SQL Server and Informix containers

## Phase 1 — Usable client (MVP)
- [ ] Connection manager: folders, colours, production / read-only flags, test connection
- [ ] Object tree with lazy loading and filtering
- [ ] SQL editor (CodeMirror 6): syntax highlighting per dialect, schema-aware autocompletion,
      run statement at cursor (Ctrl+Enter), run script (Alt+X), cancel, format SQL
- [ ] Canvas result grid: virtualized rows and columns, resize, sort, selection, copy as TSV/CSV/SQL,
      value viewer for long text / JSON / binary
- [ ] Multiple results and messages per execution
- [ ] Table viewer: data, columns, indexes, keys, DDL
- [ ] Data editing with primary keys: edit cells, insert / delete rows, SQL preview before saving
- [ ] Export dialog with progress and cancellation
- [ ] Query history panel with search
- [ ] Themes: light, dark, high contrast and accent colours; font size; follows the OS theme
- [ ] Workspace restore: open tabs and their content survive restarts

## Phase 2 — Tier 1 drivers
- [ ] PostgreSQL family (PostgreSQL, CockroachDB, YugabyteDB, TimescaleDB, Redshift)
- [ ] MySQL / MariaDB family
- [ ] SQLite (and libSQL / Turso)
- [ ] Oracle (Instant Client, downloaded on demand)
- [ ] IBM Db2 (LUW, i, z/OS) via the IBM CLI driver
- [ ] Generic connection form driven by each driver's field description
- [ ] Capability flags wired into the UI

## Phase 3 — Productivity
- [ ] Execution plans (graphical for SQL Server and PostgreSQL, text elsewhere)
- [ ] Command palette (Ctrl+K) and configurable shortcuts
- [ ] Snippets and saved scripts
- [ ] Result comparison and filtering inside the grid
- [ ] ER diagram of a schema
- [ ] Data import from CSV / Excel
- [ ] Schema and data compare between two connections

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
- [ ] Signed Windows installer (NSIS / MSI) and portable build
- [ ] Auto-update
- [ ] Linux (AppImage, deb) and macOS (dmg) builds
- [ ] User documentation

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

Each target is compared against DBeaver on the same machine and data.
