# Architecture

```
┌─ UI: SolidJS + TypeScript (WebView2 / WebKit) ─────────────────────────────┐
│  CodeMirror 6 SQL editor · canvas data grid · object tree · themes         │
│  Talks to the core only through Tauri commands and events                  │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ invoke() / events (JSON, paged)
┌─ Core: Rust (src-tauri) ──────┴─────────────────────────────────────────────┐
│  lib.rs        Tauri commands, app state                                    │
│  windows.rs    Several windows: inboxes, layout file, tab drag, focus       │
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
  Transient connect failures are retried with a wait. Without state to lose, that check waits at most `PING_LIMIT`
  (1.5 s): a connection cut without a word (a firewall, a server's idle timeout whose close never arrives) does not
  answer, and the check gives it up on its own thread instead of waiting for the system's TCP timeout. While the new
  connection opens, the session's `progress` says «Reconectando…». Connections with «Mantener viva» get the same
  check from `src/connWatch.ts` (`keep_alive_session`) before their server's idle limit; idle sessions are also
  checked when the window gets focus.
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
| Settings and open tabs | `settings.json`, `workspace.json` (every window: its tabs, panels, place and monitor) |
| Query history | `history.jsonl` (append-only, compacted at 5,000 entries) |
| Downloaded drivers (IBM CLI, JDBC jars, Java) and the JDBC bridge | `%APPDATA%\es.celer.app\drivers\` |

## Windows

Celer can have several windows: full windows (`main`, and `win-2`, `win-3`… opened with Ctrl+Shift+N or by dragging
a tab out of its tab bar) and panel windows (`panel-library`, `panel-ai`, `panel-plan-N`, `panel-er-N`,
`panel-compare-N`, `panel-schema-compare-N`, `panel-data-compare-N`).

```
┌ main ──────────────┐  ┌ win-2 ─────────────┐  ┌ panel-library ─┐
│ state.ts: its tabs,│  │ state.ts: its tabs,│  │ the library,   │
│ explorer, panels   │  │ explorer, panels   │  │ for the focused│
└─────────┬──────────┘  └─────────┬──────────┘  └───────┬────────┘
          │ invoke · events celer://inbox, shared, focus, windows, drag
┌─────────┴────────────── core: windows.rs, lib.rs ──────┴──────────┐
│ sessions (no window owns them) · one inbox per window              │
│ workspace.json · settings.json · library.json · connections.json   │
│ (one writer: the core)                                             │
└────────────────────────────────────────────────────────────────────┘
```

**State.** Every window is its own page with its own copy of `state.ts`. Its store is split in two:

- *shared by every window*: saved connections, settings (theme and shortcuts included), the script library and
  Gib's memory. The core owns the files: settings are saved as a patch that the core merges into `settings.json`
  (two windows changing different settings never undo each other), the library as a whole file, connections through
  their commands. After each write the core emits `celer://shared` and the other windows take the new value.
  Gib's memory lives in the webview storage, which all windows share; only the window that shows Gib writes it and
  the others read it again on the `storage` event;
- *this window's own*: its tabs and their sessions, its explorer (the connections it opened, each with its own
  metadata session), its side panels, focus, dialogs and the passwords typed in it.

**Sessions** live in the core (`AppState.sessions`), not in a window. Moving a tab is moving its state: the source
window sends the tab as it is (text, results loaded so far, pending edits, plan, pinned results, session id and the
password typed for its connection) to the target window's inbox, the target adds it with the same session and the
source drops it without closing the session. The connection, an open transaction, a cursor with rows still to fetch
and `#temp` tables go on as they were. A tab cannot move while it runs, loads or connects (its answer would arrive in
the old window). Disconnecting in one window closes only that window's sessions while other windows are open.

**Inboxes.** `window_post` leaves a message for another window (or for all) and the core rings it with
`celer://inbox`; the window drains its inbox with `window_inbox`. A window that is still loading finds its messages
when it starts. Tab moves, panel contents, a panel's actions, Gib's events and the questions asked when Celer quits
all travel this way.

**Dragging a tab out.** `dragstart` calls `tab_drag_start` (the other windows highlight their tab bar). A drop on
another window's tab bar claims the tab with its position (`tab_drag_claim`). On `dragend` the source waits a moment
for that claim and calls `tab_drag_end`, which returns the claim, the pointer and every window's frame;
`dropTarget` (windowModel.ts) decides: the window that claimed it, else the window under the pointer, else a new
window where the tab was let go, or nothing over its own window.

**Panels in their own window.** The library and the assistant exist once and work with the active console of the
last focused full window: that window sends them its console (text, connection, database, error, completion) and
the consoles linked to library scripts, and they ask it to insert, replace, run or open (`forwardFromPanel`). A plan,
an E-R diagram or a comparison is sent by the window it was on; plans and schema or data comparisons are sent again
when they change, and what needs a session (plan again, swap the sides, open the script, open a table) is done by
that window. "Acoplar" sends the panel back and closes its window.

**Layout.** `workspace.json` version 2 has one entry per window (the main one first): its tabs, its explorer and
side panel, and its place (physical position and size of the normal frame, maximized, monitor and its scale). The
first window's tabs are also at the top level, as version 1 had them, so an older Celer still opens them. Each window
sends its entry (`window_report`) and the core writes the whole file. At start the main window takes the first entry
and opens the others again; `placeOnScreen` moves a window whose monitor is gone to one that is there, centred and
fitted. Plans, diagrams and comparisons are not restored (they need the session that made them).

**Closing.** The last full window closes Celer as before (open transactions and unsaved edits are confirmed). Another
window asks about its tabs with work that would be lost (transaction, table edits, a console not saved to a file or
the library): move them to the main window with their sessions, or discard them; then it is forgotten. The main
window with others open asks whether to quit Celer or close only itself. "Salir de Celer" asks every window about its
risks, has every window write its entry and ends, so all of them come back next time. Gib lives in one window at a
time (the focused full window, else the main one): `celer://focus` moves him, and the other windows send him their
events.

**Logic without the app around it**, tested by `dev/windows-check.ts`: `windowModel.ts` (labels, the layout file,
monitors, the drop target, what a closing window would lose, Gib's window). The core's composition of the file is
tested in `windows.rs`.

## Security

- Read-only connections reject data-modifying statements in the core.
- Connections can be marked as production: the UI confirms `UPDATE` / `DELETE` without `WHERE`.
- Passwords never touch disk in plain text.
- Release builds are code-signed.
- Windows are opened only by the core, with the app's own page and labels `win-*` or `panel-*`. Each kind has its
  capability: full windows the same permissions as the main one except changing the title
  (`capabilities/windows.json`); panels neither open links nor folders (`capabilities/panels.json`). Placing a
  window, reading the monitors and following a drag are app commands that act on the calling window. No new
  processes, and nothing is written outside Celer's data folder.
- Native file drops are off (`dragDropEnabled: false`): drag and drop is the page's own HTML5 one.
