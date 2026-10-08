# Architecture

```
┌─ UI: SolidJS + TypeScript (WebView2 / WebKit) ─────────────────────────────┐
│  CodeMirror 6 SQL editor · canvas data grid · object tree · themes         │
│  Talks to the core only through Tauri commands and events                  │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ invoke() / events (JSON, paged)
┌─ Core: Rust (src-tauri) ──────┴─────────────────────────────────────────────┐
│  lib.rs        Tauri commands, app state                                    │
│  session.rs    Driver trait · one OS thread per session · job queue         │
│  guard.rs      Watched sessions: check before use, reconnect, generic pool  │
│  probe.rs      "Probar conexión" step by step (DNS, port, TLS, login, query) │
│  drivers       mssql.rs · odbc.rs + odbc_driver.rs · (postgres, mysql, …)   │
│  export.rs     Streaming export (CSV, TSV, JSON, SQL, XLSX)                 │
│  store.rs      Connections, settings, workspace, history; OS credential store│
│  drivers.rs    Discovery and on-demand download of vendor client libraries  │
│  jdbc.rs       JDBC bridge: one shared JVM over stdin/stdout (bridge/*.java) │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Why this stack

- **Rust core:** C-level speed for protocol handling, result decoding and export; memory safety; one binary.
- **Tauri 2:** native window with the OS webview (no bundled browser): small installer (~10 MB) and low memory.
- **SolidJS:** fine-grained reactivity without a virtual DOM; faster updates and a smaller bundle than React.
- **Canvas grid:** draws only the visible cells, so scrolling stays at 60 fps with many columns and rows.

## Sessions

Every editor tab, table viewer and export gets its own **session**: a dedicated OS thread that owns one
database connection. The UI sends jobs (closures) through a channel and awaits the reply asynchronously.

- A slow query never blocks the window or other tabs.
- **Cancellation** goes around the queue: each driver exposes a `Canceller` callable from any thread
  (`SQLCancel` for ODBC, dropping the connection for SQL Server).
- A panic inside a driver is caught on the session thread and reported as an error; the app keeps running.
- A separate metadata session per connection serves the object tree and autocompletion.
- Sessions opened by the interface are **watched** (`guard.rs`): one idle for a minute is checked with a cheap
  round trip (`Driver::ping`) before use; a dropped connection is replaced by a new one in the same database and
  transaction mode, and the operation goes on if nothing was lost (reads run again, writes never). With a transaction,
  temporary tables or `SET` of its own, the session says so (`SESSION_LOST:`) instead of reconnecting in silence.
  Transient connect failures are retried with a wait.
- The connection of a session that closes without state of its own stays free for a few minutes for the next session
  with the same settings (`guard.rs` for every engine; SQL Server keeps its own pool of raw connections in `mssql.rs`).

## Result paging

`execute(sql, fetch)` returns the first `fetch` rows of the first large result and keeps the cursor open;
`fetch(n)` reads more as the user scrolls. Smaller result sets in the same batch are returned complete.
Cells travel as JSON values; integers outside JavaScript's safe range and decimals travel as text so no
precision is lost.

## The `Driver` trait

| Method | Purpose |
|---|---|
| `execute` / `fetch` / `close_cursor` | Run a batch, page through results |
| `set_autocommit` / `commit` / `rollback` | Transactions |
| `children(path)` | Lazy object tree |
| `table_columns` / `ddl` / `completion` | Metadata for editing, source view and autocompletion |
| `databases` / `current_database` / `use_database` | Database switching |
| `qualified_name` / `quote_ident` | Dialect-aware SQL generation |
| `server_info` / `canceller` | Diagnostics and cancellation |
| `ping` / `broken` / `session_state` | Cheap liveness check, a dropped connection, what another connection would not have |

New drivers implement this trait and declare their capability flags (see [DRIVERS.md](DRIVERS.md)).
Each driver also describes its connection form (fields, defaults, validation), so the UI builds the
connection dialog generically instead of hard-coding one per engine.

## Persistence

| Data | Location |
|---|---|
| Connections (without passwords) | `%APPDATA%\es.celer.app\connections.json` |
| Passwords | Windows Credential Manager / macOS Keychain / Secret Service |
| Settings and open tabs | `settings.json`, `workspace.json` |
| Query history | `history.jsonl` (append-only, compacted at 5,000 entries) |
| Downloaded drivers (IBM CLI, JDBC jars, Java) and the JDBC bridge | `%APPDATA%\es.celer.app\drivers\` |

## Security

- Read-only connections reject data-modifying statements in the core.
- Connections can be marked as production: the UI confirms `UPDATE` / `DELETE` without `WHERE`.
- Passwords never touch disk in plain text.
- Release builds are code-signed.
