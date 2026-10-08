# Area: drivers — SQL Server/Synapse, Informix (DRDA/ODBC and JDBC), generic ODBC

Code: `src-tauri/src/mssql.rs` (tiberius), `odbc.rs`, `odbc_driver.rs`, `jdbc.rs`, `bridge/CelerBridge.java`,
`build.rs`, `engine_tests.rs`; UI side `src/components/InformixDrivers.tsx`, `src/sqlgen.ts`, `dev/engine-sql.ts`;
seeds `dev/seed-mssql.sql`, `dev/seed-informix.sql`; docs `docs/DRIVERS.md`.
Live servers exist only in `.github/workflows/engines.yml`. You may read its latest logs
(`gh run list --workflow engines.yml`, `gh run view <id> --log`) but do not trigger runs — the orchestrator does.

## Check
- SQL Server: types (datetime2/datetimeoffset precision, money, uniqueidentifier, xml, varbinary(max), sql_variant,
  hierarchyid, rowversion), multiple result sets, PRINT/RAISERROR messages, `GO` batches, `#temp` tables kept per
  session, cancel (attention), KILL detection, Azure transient errors, Synapse differences (no some catalog views,
  DDL), TLS/trust server certificate, named instances and ports, Windows auth if supported.
- Informix DRDA (IBM CLI) and JDBC bridge: DATETIME qualifiers/fractions, INTERVAL, DECIMAL/MONEY, BOOLEAN 't'/'f',
  LVARCHAR, BYTE/TEXT/BLOB/CLOB, NCHAR locales (`DB_LOCALE`/`CLIENT_LOCALE`), unquoted identifiers (no DELIMIDENT),
  one statement at a time, cancel watchdog, reconnection after `onmode -z`, `db2dsdriver.cfg` ACR off,
  bridge process lifetime (orphan JVMs, stdout/stderr deadlocks, framing errors, big rows, 256 KB fetch buffer).
- JDBC bridge protocol: every request has a timeout; errors surface with the server message; Java missing or wrong
  version is explained to the user; driver jar download/location.
- Generic ODBC: DSN and connection-string forms, driver not installed, 32/64-bit mismatch messages.
- DDL reconstruction and generated SQL per engine (quoting, literals, paging syntax `TOP`/`FIRST`/`SKIP`).
