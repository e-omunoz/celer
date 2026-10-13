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
| **JDBC bridge** | The vendor's pure-Java driver in one shared JVM, over stdin/stdout | The same drivers DBeaver uses; no native client install | Needs Java 11+ (DBeaver's JRE works) |

## Support matrix

Legend: ✅ done · 🟡 planned · ⚪ via generic layer only

### Relational: tier 1 (most used)

| Engine | Also covers | Strategy | Crate / library | Status |
|---|---|---|---|---|
| SQL Server | Azure SQL, Azure SQL MI, Synapse dedicated / PDW, Fabric Warehouse (edition from `SERVERPROPERTY('EngineEdition')`: own DDL, plan and activity on Synapse) | Native | `tiberius` | ✅ written |
| Informix | — | IBM JDBC driver (SQLI, through Celer's JDBC bridge), Informix CSDK (SQLI, via ODBC) or IBM CLI (DRDA) | `com.ibm.informix:jdbc` / ODBC / `db2cli64.dll` | ✅ written |
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
| Informix JDBC driver (`com.ibm.informix:jdbc`, with `org.mongodb:bson`) | Found in DBeaver's cache (its 4.50 first), or downloaded on demand from Maven Central: 15.0.1.4, which also reads Informix 15 servers (SHA-256 fixed in `drivers.rs`) | IBM licence: not bundled |
| Java (Eclipse Temurin JRE 21) | Any Java 11+ already installed (DBeaver's first), or downloaded on demand from Adoptium (SHA-256 from its API) | GPLv2 with Classpath Exception: not bundled |
| Informix Client SDK, other ODBC drivers | Installed by the user | Vendor licences |
| SQLite, DuckDB | Bundled (compiled in) | Public domain / MIT |

## A schema's foreign keys in one query

The E-R diagram reads every foreign key of a schema at once (`Driver::schema_foreign_keys`, command
`schema_foreign_keys`): constraint, table and columns, referenced table and columns, in key order, names unquoted.
One catalog query per engine, limited to the tables of the explorer's Tablas folder:

| Engine | Catalog |
|---|---|
| PostgreSQL | `pg_constraint` (`contype = 'f'`) with `unnest(conkey, confkey) WITH ORDINALITY`; no partitions |
| MySQL / MariaDB | `information_schema.KEY_COLUMN_USAGE` (base and system-versioned tables) |
| SQL Server, Fabric Warehouse | `sys.foreign_keys` + `sys.foreign_key_columns`; Synapse dedicated has none (no folder either) |
| Informix (DRDA and JDBC) | `sysconstraints` + `sysreferences` + `sysindexes` + `syscolumns`, both sides in one `UNION ALL`, columns ordered by the index parts |
| SQLite | `pragma_foreign_key_list` joined to `sqlite_schema`; `REFERENCES t` without columns resolved to t's primary key |
| Generic ODBC | `SQLForeignKeys` with no table where the driver allows it, otherwise table by table (the explorer gets a Claves foráneas folder) |

`session::per_table_foreign_keys` reads the same through each table's "fks" folder (what the diagram did before,
and the default for a driver without its own query); the engine tests compare both on every engine and run the join
of each key's tables (`dev/engine-sql.ts`). On a 1,500-table Informix schema the diagram of one table goes from about
6 s locally (one call per table, far more over a slow link) to about 0.1 s (`informix_large_schema_fks`).

## SQL Server: the patched `tiberius`

Celer builds against its own copy of `tiberius` 0.13.0 in `src-tauri/vendor/tiberius` (MIT / Apache-2.0, licences
kept), wired in with `[patch.crates-io]` in `src-tauri/Cargo.toml`. Upstream reads the TDS `INFO` tokens and only
logs them; the patch hands them to the caller as `QueryItem::Info` on the query stream and as
`ExecuteResult::messages()` (#67). So `PRINT`, `RAISERROR` with severity 10 or less (`WITH NOWAIT` too) and server
warnings appear in the Output area, in order, as in SSMS: `PRINT` text as it is, the rest as `Msg n, nivel c: …`.
"Changed database context" and "Changed language setting" (5701, 5703) are left out: they only echo a `USE` or a
`SET LANGUAGE`. A message that arrives while the rows of a result are read in pages comes with that page
(`FetchOutput.messages`). Errors (severity 11 and up) still fail the batch with their `Msg` number. What changed and
how to move to a newer `tiberius` is in `vendor/tiberius/PATCHES.md`; the engine test `mssql_engine` checks it.

## SQL Server: known limits

- A batch of several statements run as a query reports no row counts (`tiberius` keeps the TDS `DONE` tokens to
  itself); a batch of a single `INSERT`/`UPDATE`/`DELETE`/`MERGE` reports its count.
- `money` is shown exact with its 4 decimals up to ±450,359,962,737 (2^52 ten-thousandths): `tiberius` decodes it
  to an `f64`, from which Celer takes the integer back. Beyond that the last digit may already be rounded (#68).
- Scripts are split on `GO` lines (`GO n` repeats a batch), as SSMS and sqlcmd do; other sqlcmd commands (`:r`,
  `:setvar`) are not read.

## Informix: which protocol

| Protocol | Driver | Server side | Needs |
|---|---|---|---|
| **Automático** (default for new connections) | The Client SDK if its ODBC driver is registered, JDBC otherwise | | |
| SQLI (JDBC) | IBM's JDBC driver in the bridge | `onsoctcp` listener (usually 9088) | Java 11+ and the driver jar: both found or downloaded |
| SQLI (Client SDK / ODBC) | `IBM INFORMIX ODBC DRIVER (64-bit)` | `onsoctcp` listener | The Client SDK installed (admin rights) |
| DRDA (IBM CLI) | IBM Data Server Driver | `drsoctcp` listener (often 9089) | The CLI driver, downloaded from IBM's public site |

The three share the Informix dialect in `odbc_driver.rs` (catalog queries, batches split per statement, DDL, foreign keys,
database switching): it runs over a `Link` (`exec`, `query_all`, transactions, cancel, reconnect), which `OdbcConn`
(odbc.rs) and `JdbcConn` (jdbc.rs) implement.

**DRDA and the CLI driver's own reconnection.** IBM's CLI driver comes with automatic client reroute (ACR) on, with
seamless failover: when the server ends a session (`onmode -z`, a restart, the network), the driver opens another one
and runs the statement again without telling anyone, so `guard.rs` never sees the cut and cannot say what was lost.
There is no connection string keyword for it, only `enableACR` in the `<acr>` section of a database in
`db2dsdriver.cfg`, which the driver matches by database name, host and port. Before each DRDA connection Celer adds
that database to its own `drivers/db2dsdriver.cfg` in its data folder (no passwords; `enableACR` false) and points
`DB2DSDRIVER_CFG_PATH` to it (`drivers.rs`, `cli_acr_off`). A `db2dsdriver.cfg` of the user's (that variable already
set, or the file in the driver's `cfg/` folder) is left as it is and wins. SQLI (Client SDK) and JDBC are not affected.

**After the server drops an idle connection (#97).** Measured with the engine tests (`informix_recovery_measured`,
Informix 15 in Docker): when the server ends the session and its close reaches Celer (`onmode -z`), the dead socket
fails at once (DRDA 0.5 ms, JDBC 5 ms), a new login takes 14 ms (DRDA) / 18 ms (JDBC), and the guard's check, new
connection and replay of the database and transaction mode bring the next query back in 15-20 ms. The 10-12 s seen
come from a connection cut without a word (a firewall or NAT, or a server whose close never arrives): the first
round trip gets no answer and no error until the operating system gives up on the socket (about 10-20 s on Windows,
minutes on Linux). So `guard.rs` checks a session idle for a minute with a bounded round trip: without state to lose
it waits at most 1.5 s, then leaves that connection on its own thread and opens another, so the query answers in
about 1.5 s plus a login (`*_silent_cut` tests, every engine, through a proxy that goes quiet: 1.51-1.60 s). With a
transaction, temporary tables or `SET` of its own the real answer is waited for (reconnecting would lose them).
JDBC logins time out after `LOGINTIMEOUT` (8 s unless set in Parámetros extra); `IFX_SOC_TIMEOUT` is not set, as it
would bound every read of the socket and cut long queries too. «Mantener viva» in a connection's advanced options
(off by default) takes the minutes after which the server ends idle sessions, and Celer checks idle sessions at 80 %
of that, so they are never cut.

**Informix types over DRDA.** The DRDA protocol has no type for some Informix types, so the server converts them
before IBM's CLI driver sees them, and the values differ from SQLI (JDBC), which gets Informix's own types. Measured on
Informix 15 (`informix_types_drda_and_jdbc` in `engine_tests.rs`, which fails if a driver changes this):

| Informix column | Over DRDA (column type shown) | Over SQLI (JDBC) |
|---|---|---|
| Floating `DECIMAL(p)` (no scale) | `double`: about 15 significant digits, the rest silently rounded (`12345678901234567890.123456789` reads `12345678901234567000`) | `decimal`, exact |
| `DECIMAL(p,s)` (fixed scale), `MONEY` | `decimal`, exact | `decimal`, exact |
| `DATETIME … TO FRACTION(n)` | `timestamp`, always 6 fraction digits (`10:30:15.123000`) | the column's own `n` digits (`10:30:15.123`) |
| `DATETIME HOUR TO MINUTE` | `time`, with seconds (`10:30:00`) | `10:30` |
| `BOOLEAN` | `smallint`, 1/0 | `boolean`, true/false |

When exact floating decimals matter, connect over SQLI (JDBC), or give the column a scale (`DECIMAL(32,9)`). Celer does
not rewrite these values: a statement reads only the result's columns, not which table column each one came from.
SQLI through the Client SDK (ODBC) is not covered by the engine tests (no Linux build of the SDK in the environment).

### The JDBC bridge

`src-tauri/bridge/CelerBridge.java` is a small program with no dependencies, compiled with `javac --release 11` by
`build.rs` and embedded in Celer (`include_bytes!`). Celer writes it to `drivers/jdbc/` in its data folder and runs it
with the Java it found.

- **One JVM for the whole app**, started on the first JDBC connection (or as soon as one is being opened, while the
  password is asked). Each request names its session; each session runs on its own thread in the JVM, so a slow query
  never holds up another one. The thread that reads Celer's requests never calls the driver.
- **Cancel**: `Statement.cancel()` runs on a helper thread. Informix sends it as TCP urgent data, which some proxies
  and firewalls drop; if the statement is still running 5 s later, the bridge cuts its connection
  (`Connection.abort`, which closes the socket without waiting for the driver) and answers "Consulta cancelada (se
  reabre la conexión…)". Celer opens a new connection on the same database (startup script and manual mode again) and
  says so when an open transaction was lost with it.
- **Only stdin and stdout**, never a network port. Frames have a length prefix; rows travel in batches in a compact
  binary format (a null bitmap per row and typed values: varints, doubles, UTF-8 text, bytes), with the first page
  inside the answer to the query and a 4 MB cap per batch. The protocol is described at the top of `jdbc.rs`.
- **Nothing engine-specific in the bridge or its protocol**: the driver class, its jars, the URL and the properties
  come with each connection, and the driver is loaded in a class loader of its own. The password travels in those
  properties, through the pipe: never on a command line, in the environment or in a log. The one exception is
  `LO_READ`, which reads an Informix smart large object descriptor through the driver's `IfxSmartBlob`, found by
  reflection (the bridge still has no compile-time dependency): the CDC API hands its records over that way (below).
- Java is started directly (no shell in between) with fixed arguments and without a console window
  (`CREATE_NO_WINDOW`), from the bridge's folder; it writes nothing outside Celer's data folder (`-XX:-UsePerfData`,
  `java.io.tmpdir` there, and on JDK 19+ a class-data archive next to the jar that speeds up the next start).
- A build without a JDK leaves the bridge out (`build.rs` warns) and JDBC connections say so; a release build fails
  without it, so a published Celer always has it. CI builds it with `actions/setup-java`.

Informix's own part lives on the Rust side: the URL (`jdbc:informix-sqli://host:port/db:INFORMIXSERVER=name`), the
properties (`FET_BUF_SIZE=262144`, the fastest in the engine tests' 200,000-row read; `INFORMIXCONTIME`; `DB_LOCALE` /
`CLIENT_LOCALE` from the environment unless given) and the
user's "Parámetros extra", which win over Celer's. `DELIMIDENT` is not set: Celer writes Informix names unquoted, as
on the other protocols.

### Row history from the logical logs (CDC)

«Historial de la fila» (`rowhistory.rs`, issue #123) reads a row's past values from Informix's logical logs through the
CDC API (`syscdcv1`), on a JDBC connection of its own. Measured on Informix 15 (the spike report is on the issue):

- `onlog` has every before and after image, but it runs on the server host and prints raw rows by rowid: not usable
  from a client.
- A CDC session (`cdc_opensess`, `cdc_startcapture` for the table's capturable columns, `cdc_activatesess` from the
  start of the oldest log on disk) returns committed inserts, update before/after pairs and deletes with full values,
  also for changes made **before** full row logging was turned on (Informix logged whole rows for the updates
  tested of tables with a variable-length column, up to rows spanning pages; a table with only fixed-length columns
  logs its updates as partial `HUPDAT` records that the CDC API does not send at all when full row logging was off at the
  time). For such a table (no VARCHAR, NVARCHAR or LVARCHAR column, by `syscolumns.coltype`) Celer says so in the offer
  to turn full row logging on, labels a history read with it turned on just for the read as partial, and in every case
  compares the end of the history with the row as it is now and labels the history partial if they differ. The records
  are read as a smart large object whose descriptor is the session id, which only SQLI offers: JDBC (the bridge's
  `LO_READ`) yes, DRDA no; the Client SDK path is not wired. The protocol is a precondition of the connection, so the
  menu entry stays enabled on Informix and the dialog says «No se puede reconstruir: la conexión usa DRDA…».
- The transaction number in the records (`BEGINTX`/`COMMTX`) is a slot of the server's transaction table, reused by
  later transactions (measured: autocommit statements of four sessions, seconds apart, all came as 16). Celer names a
  transaction by the log position of its commit, which is unique and shared by the changes of one transaction.
- A connection lost during the read (the session ended with `onmode -z`, the server restarted) keeps what was read,
  labelled partial with the position it reached; the clean-up goes through a new connection, and if that fails too the
  dialog says full row logging could not be turned off (the ledger below puts it right on the next read).
- `cdc_startcapture` refuses a table without full row logging (-83706). Its state is bit `0x04000000` of
  `sysmaster:sysptnhdr.flags`. Celer never turns it on by itself: the user may allow it for one read, and Celer turns
  it off again after (a read-only connection refuses).
- An ordinary user (CONNECT only) gets -674 on the CDC routines: `informix` was the user that could run them.
- An LSN in a log no longer on disk gives -83713; the read then starts at the next log. Logs only in a backup are out
  of reach.
- A dropped table can leave records under the same partnum. The read starts at the log where the table was created
  (the first one that filled after `sysptnhdr.created`), changes committed before that time are left out and counted,
  and when the API cannot read such records (-83790, `CDC_E_INTERNAL`, measured with a partnum reused by dozens of
  test tables) Celer bisects to the first position from which it reads cleanly (to within 32 bytes) and goes on from
  there, which it notes. Across an in-place `ALTER TABLE` the server returns old rows in the new layout (added columns
  NULL), which the history notes.
- `sysptnhdr.created` is not always the creation time: after an unclean stop before the checkpoint that followed a
  `CREATE TABLE`, fast recovery replays it on start and stamps the time of the replay (measured: 20:54:40 became
  20:55:05; the server started at 20:54:58, `sysmaster:sysshmvals.sh_boottime`, and went on-line at 20:55:08, its
  `Startup` checkpoint in `sysmaster:syscheckpoint`). A clean restart does not. A creation time between the start and
  the on-line mode (the `Startup` checkpoint while it is among the last 20, else the first internal session, pid 0 in
  `sysmaster:syssessions`) is taken as the replay's. The read still starts from it and leaves out the commits before
  it, as for any table: before it the log may hold a dropped table that had the same partnum (measured: three tables
  created and dropped before it all had the new one's partnum, and their records of the same key are in the log), and
  nothing there tells them from the table's own. The history is partial with that reason (the changes before the
  recovery's time are not shown), never calls them a dropped table's, says neither that the row had no changes nor
  where it began; changes after the recovery are shown. After the recovery the API sometimes refuses the transaction
  of the table's first insert (-83800, seen in one of four runs); the read goes past it as before any creation, and
  says it as a part of the log not read. Once the server restarts again, such a creation time can no longer be told
  from a real one.
- An LSN offset is the log page number shifted 12 bits plus the byte in the page. The read is complete when the
  session has nothing more to give (a timeout) at or past the page being written when the read began. The API only
  hands over what its log reader has reached: when it waits 10 s without progress, the history says the latest changes
  are not available yet (partial).
- **The server's reader is not reliable across reads** (measured, Informix 15.0.1.0.3, repeated runs). A session that
  reaches the end of a log while its last page is still being written leaves that log readable only up to that
  position for every later session: they get only timeouts there, or nothing at all (a blocked `LO_READ` that never
  returns), and the reader does not go on to the next log. A server restart clears it; so does a log switch for the
  changes made after it. Errors on the records of dropped tables (-83790, -83800) abandon sessions abnormally and
  leave the reader worse for the next read. What Celer does about it: every CDC request has a 30 s limit (a stuck one
  is abandoned, and the clean-up, closing the session and turning full row logging off, goes through another
  connection); a read stops at 120 s; no progress for 10 s in a log that is already complete is taken as such a
  wall, remembered, and the read goes on from the next log, saying that part of that log could not be seen; a read cut
  short never says «no changes» (that needs a read that reached the end). The history of a row is therefore complete
  only when the reader was healthy for the whole range; otherwise it says what is missing. The engine test restarts a
  restartable server (`CELER_INFORMIX_CONTAINER`) before it reads, since only the first read after a restart is
  dependable; its partition numbers are reused after DROP TABLE, so it drops its table, switches the log and only then
  creates the next.
- Celer turns full row logging on only for a read. It notes the table in `informix-full-row-logging.txt` in its data
  folder first and removes the note once the setting is off again, so a read that was cut short (Celer closed, the
  connection lost) is put right by the next read of that table, which turns it off after reading and says so.
- Values are decoded in Rust from the CDC format (big-endian integers, Informix packed decimals for DECIMAL, MONEY,
  DATETIME and INTERVAL, length-prefixed VARCHAR/LVARCHAR, text in the database's code set); the size Celer computes for
  each column must add up to the size the server announces, or the table is refused. TEXT, BYTE, BLOB, CLOB and user
  types are not captured and are listed as left out.

### Adding another engine over JDBC

Engines whose best client is a Java driver (Azure Synapse or SQL Server features through `mssql-jdbc`, Oracle through
`ojdbc`, Db2 through `jcc`…) can reuse the bridge as it is:

1. A `JdbcSpec` in `drivers.rs`: the driver class and its Maven coordinates, version and SHA-256, plus the jars it
   needs. `find_jdbc` then looks for it in Settings, DBeaver's cache (`DBeaverData/drivers/maven/maven-central`) and
   Celer's downloads, and `download_jdbc` fetches it from Maven Central.
2. A `Params` function (`jdbc.rs`) that builds the URL and the properties from the connection.
3. A dialect: the `Driver` trait over `JdbcConn` — either a new one, or `LinkDriver` (`odbc_driver.rs`) taught the
   engine's catalog queries.
4. The route in `lib.rs` (`connector_and_route`) and the form fields in the interface.

### Guide for users

Settings › Drivers shows what each protocol has and offers the downloads; the in-app guide (and
[GUIA.md](GUIA.md#drivers-de-informix)) explains where to get the Client SDK, how to ask for a DRDA listener, and what
to do about the server name and the locale.

## Test environments

Every driver gets an integration test suite run against a Docker container with seeded data
(`dev/seed-<engine>.sql`), plus the same benchmark loads (see [ROADMAP.md](ROADMAP.md)).

| Engine | Docker image |
|---|---|
| SQL Server | `mcr.microsoft.com/mssql/server:2022-latest` |
| Informix | `icr.io/informix/informix-developer-database` (tested over DRDA and over JDBC, with a 200,000-row speed comparison) |
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
