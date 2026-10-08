# Database drivers

Celer aims to support as many databases as possible while keeping two rules:

1. **Native first.** When a mature pure-Rust (or self-contained) client exists, use it: no driver installation,
   best performance, works the same on every OS.
2. **Universal fallback.** Anything else is reachable through a generic layer (ODBC, ADBC, or the vendor's
   client library loaded at runtime), so the app never depends on a driver being installed just to start.

All drivers implement the same `Driver` trait (`src-tauri/src/session.rs`): execute, paged fetch, cancel,
transactions, object tree, table columns, DDL and autocompletion metadata. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Connection strategies

| Strategy | How it works | Pros | Cons |
|---|---|---|---|
| **Native Rust** | Wire protocol implemented in a Rust crate | Zero install, fastest, cross-platform | One crate per engine |
| **Vendor library (runtime-loaded)** | Load the vendor client (OCI, IBM CLI…) with `libloading` | Full vendor feature set | User needs the library; Celer can download it when the licence allows |
| **ODBC** | System driver manager (`odbc32.dll`, unixODBC, iODBC) | Reaches almost any database | Driver must be installed; quality varies |
| **ADBC** | Arrow Database Connectivity driver manager | Columnar, very fast for analytics | Young ecosystem |
| **HTTP / REST** | Engine's HTTP query API | No native protocol needed | Higher latency per request |

## Support matrix

Legend: ✅ done · 🟡 planned · ⚪ via generic layer only

### Relational: tier 1 (most used)

| Engine | Also covers | Strategy | Crate / library | Status |
|---|---|---|---|---|
| SQL Server | Azure SQL, Azure SQL MI, Synapse dedicated / PDW, Fabric Warehouse (edition from `SERVERPROPERTY('EngineEdition')`: own DDL, plan and activity on Synapse) | Native | `tiberius` | ✅ written |
| Informix | — | IBM CLI (DRDA) or Informix CSDK (SQLI, via ODBC) | `db2cli64.dll` / ODBC | ✅ written |
| PostgreSQL | CockroachDB, YugabyteDB, TimescaleDB, Citus, Neon, Supabase, AlloyDB, Greenplum | Native | `tokio-postgres` | 🟡 |
| MySQL / MariaDB | Aurora MySQL, TiDB, SingleStore, PlanetScale, Percona | Native | `mysql_async` | 🟡 |
| SQLite | libSQL / Turso (remote, still planned) | Native (embedded) | `rusqlite` (bundled) | ✅ embedded |
| Oracle | Oracle Autonomous DB | Vendor library | `oracle` crate (ODPI-C + Oracle Instant Client) | 🟡 |
| IBM Db2 | Db2 LUW, Db2 for i (AS/400), Db2 for z/OS | IBM CLI (same driver as Informix DRDA) | `db2cli64.dll` | 🟡 |

### Relational and analytical: tier 2

| Engine | Strategy | Crate / library | Notes | Status |
|---|---|---|---|---|
| Amazon Redshift | Native (PostgreSQL protocol) | `tokio-postgres` | Own catalog queries (`svv_*`) | 🟡 |
| DuckDB | Native (embedded) | `duckdb` (bundled) | Also queries CSV, Parquet and JSON files directly | 🟡 |
| ClickHouse | Native (HTTP / native protocol) | `clickhouse` | | 🟡 |
| Snowflake | ADBC or REST | `adbc` Snowflake driver | Key-pair and SSO authentication | 🟡 |
| Google BigQuery | REST | `gcp-bigquery-client` | Service account / OAuth | 🟡 |
| Trino / Presto / Starburst | HTTP protocol | `reqwest` | Federates many sources | 🟡 |
| Databricks SQL | REST (Statement Execution API) or ODBC | `reqwest` | | 🟡 |
| SAP HANA | Native | `hdbconnect` | | 🟡 |
| Firebird / InterBase | Native | `rsfbclient` (`pure_rust` feature) | | 🟡 |
| Amazon Athena | AWS SDK | `aws-sdk-athena` | Results read from S3 | 🟡 |
| Dremio and other Flight SQL engines | Arrow Flight SQL | `arrow-flight` | | 🟡 |
| Exasol | WebSocket API | `exarrow-rs` / custom | | 🟡 |

### NoSQL: tier 3 (needs specific UI views)

| Engine | Strategy | Crate | UI | Status |
|---|---|---|---|---|
| MongoDB | Native | `mongodb` | Document (JSON) viewer, collection browser, aggregation editor | 🟡 |
| Redis / Valkey | Native | `redis` | Key browser by type (string, hash, list, set, zset, stream), TTL | 🟡 |
| Cassandra / ScyllaDB | Native (CQL) | `scylla` | Tabular, keyspaces and tables | 🟡 |
| Elasticsearch / OpenSearch | HTTP (SQL API + DSL) | `reqwest` | Indices, mappings, JSON query console | 🟡 |

### Generic layer only: tier 4

Reached through ODBC (or the vendor library) with the generic dialect: Teradata, Vertica, SAP ASE (Sybase),
SAP IQ, Microsoft Access (`.mdb` / `.accdb`), Progress OpenEdge, Pervasive / Actian Zen, Ingres, MaxDB,
Excel and text files via the Microsoft Access/Text drivers, and any other ODBC source. ⚪

Generic ODBC itself (DSN or full connection string) is ✅ written.

## Per-driver capability flags

Each driver declares what it supports so the UI only shows what works:

| Capability | Meaning |
|---|---|
| `schemas` | Has a schema level between database and objects |
| `multiDatabase` | Can list and switch databases on one connection |
| `transactions` | Manual commit / rollback |
| `cancel` | Running queries can be cancelled |
| `explain` | Execution plan available (and its syntax) |
| `editing` | Table data can be edited (needs primary keys) |
| `ddl` | Object source / DDL can be generated |
| `procedures` | Stored procedures and functions |
| `documents` | Document model (MongoDB, Elasticsearch): JSON view instead of grid |
| `keyValue` | Key-value model (Redis) |

## Driver distribution and licensing

| Library | Distribution | Licence notes |
|---|---|---|
| Native Rust crates | Compiled into Celer | MIT / Apache-2.0 (checked with `cargo deny`) |
| IBM Data Server Driver (Informix DRDA, Db2) | Downloaded on demand from IBM's public site | IBM licence: not bundled |
| Oracle Instant Client | Downloaded on demand from Oracle | Oracle licence: not bundled; user accepts it |
| Informix Client SDK, other ODBC drivers | Installed by the user | Vendor licences |
| SQLite, DuckDB | Bundled (compiled in) | Public domain / MIT |

## Test environments

Every driver gets an integration test suite run against a Docker container with seeded data
(`dev/seed-<engine>.sql`), plus the same benchmark loads (see [ROADMAP.md](ROADMAP.md)).

| Engine | Docker image |
|---|---|
| SQL Server | `mcr.microsoft.com/mssql/server:2022-latest` |
| Informix | `icr.io/informix/informix-developer-database` |
| PostgreSQL | `postgres:17` |
| MySQL / MariaDB | `mysql:8.4`, `mariadb:11` |
| Oracle | `gvenzl/oracle-free` |
| Db2 | `icr.io/db2_community/db2` |
| ClickHouse | `clickhouse/clickhouse-server` |
| SAP HANA | `saplabs/hanaexpress` |
| Firebird | `firebirdsql/firebird` |
| Trino | `trinodb/trino` |
| CockroachDB | `cockroachdb/cockroach` |
| MongoDB | `mongo:8` |
| Redis | `redis:8` / `valkey/valkey` |
| Cassandra / ScyllaDB | `cassandra:5`, `scylladb/scylla` |
| Elasticsearch / OpenSearch | `elasticsearch:8`, `opensearchproject/opensearch` |

Cloud-only engines (Snowflake, BigQuery, Databricks, Athena, Redshift) are tested against free tiers or trial accounts.
