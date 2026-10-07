# Celer

A fast, lightweight desktop SQL client, built as an alternative to DBeaver.
Powered by **Tauri 2**, a **Rust** core and a **SolidJS** interface.

> **Status:** phase 1 client is usable. The Rust core compiles on Linux, SQLite is embedded,
> and the SolidJS interface covers connections, the object tree, the SQL editor and the data grid.
> See [STATUS.md](STATUS.md) and the [roadmap](docs/ROADMAP.md).

## Goals

- **Performance:** instant startup, low memory usage, and result sets of millions of rows without freezing the UI.
- **Every database:** native drivers where possible, plus ODBC, ADBC and vendor libraries for everything else.
- **Modern interface:** light and dark themes, an SQL editor with autocompletion, and a canvas data grid.
- **Cross-platform:** Windows first, then Linux and macOS.

## Databases

Native Rust drivers need nothing installed. The rest load the vendor's client library at runtime, so the
app never depends on a driver just to start. Full matrix and plan: [docs/DRIVERS.md](docs/DRIVERS.md).

| Group | Engines | Status |
|---|---|---|
| Done | SQL Server (native), Informix (IBM CLI / Client SDK), SQLite (embedded), any ODBC source | ✅ written |
| Tier 1 | PostgreSQL family (CockroachDB, YugabyteDB, TimescaleDB…), MySQL / MariaDB family, libSQL / Turso, Oracle, IBM Db2 (LUW, i, z/OS) | 🟡 planned |
| Tier 2 | Redshift, DuckDB, ClickHouse, Snowflake, BigQuery, Trino / Presto, Databricks, SAP HANA, Firebird, Athena, Flight SQL | 🟡 planned |
| Tier 3 (NoSQL) | MongoDB, Redis / Valkey, Cassandra / ScyllaDB, Elasticsearch / OpenSearch | 🟡 planned |
| Via ODBC | Teradata, Vertica, SAP ASE (Sybase), Access, Progress OpenEdge, and more | ⚪ generic |

## Core features

- One session per tab, each on its own thread: a slow query never blocks anything else.
- Paged results with an open cursor, query cancellation, and manual transaction mode (commit / rollback).
- Object explorer: databases, schemas, tables, views, procedures, functions, indexes and keys.
- DDL generation and metadata for autocompletion.
- Streaming export to CSV, TSV, JSON, SQL (INSERT) and Excel.
- Passwords stored in the operating system's credential store, plus query history.

## Performance targets

| Workload | Target |
|---|---|
| Cold start | < 0.8 s |
| Idle memory | < 120 MB |
| Load 100,000 rows into the grid | < 1.5 s |
| Grid scrolling, 50 columns | 60 fps |

Details and the comparison method against DBeaver: [docs/ROADMAP.md](docs/ROADMAP.md#performance-targets).

## Documentation

- [Architecture](docs/ARCHITECTURE.md): stack, sessions, paging, the `Driver` trait, persistence.
- [Drivers](docs/DRIVERS.md): support matrix, connection strategies, licensing, test containers.
- [Roadmap](docs/ROADMAP.md): phases, features and performance targets.
- [Status](STATUS.md): where the work currently stands.

## Project layout

```
src/                 User interface (SolidJS + TypeScript)
src-tauri/src/
  lib.rs             Commands exposed to the UI
  session.rs         Driver trait and sessions on dedicated threads
  mssql.rs           SQL Server driver
  sqlite.rs          Embedded SQLite driver
  odbc.rs            ODBC/CLI layer with dynamic loading
  odbc_driver.rs     Informix and generic ODBC
  export.rs          Result export
  store.rs           Connections, settings and history
  drivers.rs         Vendor client library discovery and download
docs/                Architecture, drivers and roadmap
dev/                 Test data scripts
```

## Development

Requirements: [Rust](https://rustup.rs), [Node.js](https://nodejs.org) 20+ and, on Windows, Visual Studio Build Tools with the C++ workload (MSVC toolchain).

```bash
npm install
npm run tauri dev
```

The same interface runs in a browser (`npm run dev`) against an in-memory SQLite demo
(`sql.js`). Desktop commands use the Rust drivers.

To build the installer:

```bash
npm run tauri build
```

### Test databases (Docker)

```bash
docker run -d --name dbx-mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD="<password>" -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
docker run -d --name dbx-informix --privileged -e LICENSE=accept -p 9088:9088 -p 9089:9089 icr.io/informix/informix-developer-database:latest
```

Then load the data with `dev/seed-mssql.sql` and `dev/seed-informix.sql`. Images for the other engines are
listed in [docs/DRIVERS.md](docs/DRIVERS.md#test-environments).
