# Area: drivers — PostgreSQL, MySQL/MariaDB, SQLite

Code: `src-tauri/src/postgres.rs`, `mysql.rs`, `sqlite.rs`, `drivers.rs`, `model.rs`, `export.rs`; SQL the UI writes:
`src/sqlgen.ts`, `dev/engine-sql.ts`; seeds `dev/seed-postgres.sql`, `dev/seed-mysql.sql`.
Live servers: `dev/testdb-postgres.ps1 start` (port 54329) and `dev/testdb-mysql.ps1`; then
`CELER_PG_TEST` / `CELER_MYSQL_TEST` and `cargo test --lib` in `src-tauri` (see `engine_tests.rs` for the env format).

## Check per engine
- Type mapping both ways: NULL, bool, int8/bigint unsigned, numeric/decimal precision, float NaN/Inf, money,
  date/time/timestamp/timestamptz/interval, time zones, uuid, json/jsonb, arrays, enums, bytea/blob, bit, geometry,
  very long text, unicode/emoji, zero dates in MySQL.
- Paging and streaming: server-side cursors (PG), bounded channel reader (MySQL), "load all", memory with 1M rows.
- Cancel during execute and during fetch; cancel then reuse the session.
- Transactions: auto/manual, `in_transaction` accuracy, commit/rollback after errors, implicit commits (MySQL DDL).
- Script splitting: dollar quotes, `DELIMITER`, comments, strings with `;`, `BEGIN…END` blocks; error line/column.
- Metadata/DDL reconstruction against the seed (tables, constraints, indexes, triggers, views, matviews, functions,
  sequences, partitions), multi-database tree, approximate counts.
- Generated SQL (`sqlgen.ts`): quoting of odd identifiers (spaces, quotes, reserved words, mixed case), literals,
  booleans, edits on tables without a primary key.
- Export/import fidelity per type (round trip a table).
