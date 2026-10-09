# Engine matrix: every change is tested on every database type

Rule: any implementation, fix or review that touches behaviour reachable from a connection (queries, results, grid,
editing, filters, export/import, explorer, DDL, generated SQL, connections, reconnection, cancel, transactions, AI
schema, MCP, library runs) is tested **live on every engine below**, not only on the one in the issue. A test report
lists each engine with ✅ / ❌ / ⚠️ not applicable (and why). "Not tested on X" is a failure to report, not a pass.

| Engine | Where it runs | From Windows (desktop app) | Cargo integration test env |
|---|---|---|---|
| PostgreSQL 17 | WSL `celer-pg` · or `dev\testdb-postgres.ps1` | `localhost:15432` celer/celer db `celer` (portable: 54329) | `CELER_PG_TEST` |
| MySQL 8.4 | WSL `celer-mysql` | `localhost:33306` celer/celer db `celer` | `CELER_MYSQL_TEST` (run 1) |
| MariaDB 11.4 | WSL `celer-mariadb` · or `dev\testdb-mysql.ps1` | `localhost:33307` celer/celer (portable: 33069) | `CELER_MYSQL_TEST` (run 2) |
| SQL Server 2022 | WSL `celer-mssql` | `localhost:1433` sa/`Celer_Test_2026!` db `celerdemo` | `CELER_MSSQL_TEST` |
| Informix over DRDA (IBM CLI) | WSL `celer-ifx` | `localhost:9089` informix/in4mix db `celerdemo` | `CELER_INFORMIX_TEST` |
| Informix over JDBC (bridge) | WSL `celer-ifx` | `localhost:9088` server `informix` | `CELER_INFORMIX_JDBC_TEST` |
| SQLite | embedded | any `.db` file; browser preview uses it (`src/demo.ts`) | unit tests |
| Generic ODBC | Windows ODBC DSN to any engine above; in WSL, psqlODBC to `celer-pg` | e.g. a PostgreSQL/MySQL ODBC DSN | `CELER_ODBC_TEST` (connection string) + `CELER_ODBC_LIB` (driver manager), set by `engines.sh` |

Seeds (`dev\wsl.ps1 db seed`): `dev/seed-postgres.sql`, `seed-mysql.sql` (MySQL and MariaDB), `seed-mssql.sql`,
`seed-informix.sql`. Azure SQL / Synapse cannot be run locally: check the dialect branches in code and say so.

## How to run it
- Cargo tests on every engine: `powershell -ExecutionPolicy Bypass -File dev\wsl.ps1 test -Ref <branch>`
  (starts the containers if needed). On GitHub: `gh workflow run engines.yml --ref <branch>` for SQL Server + Informix.
- In the app: `dev\wsl.ps1 db up`, then `dev\run-desktop.ps1`, create one connection per row of the table (keep them
  in `D:\celer-devdata`), and walk the feature on each, taking a screenshot per engine into `review-out/<topic>/`.
- Engine-specific SQL the UI writes is checked per dialect in `dev/engine-sql.ts` and `src-tauri/src/engine_tests.rs`:
  a change to generated SQL extends both.
