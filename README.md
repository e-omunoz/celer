<p align="center">
  <img src="docs/media/banner.svg" alt="Celer. Swift SQL for every database. Gib, the mascot, thinks, gets an idea and waves while a query streams its rows." width="100%" />
</p>

<p align="center">
  <b>Swift SQL for every database.</b><br/>
  A fast, native desktop SQL client for PostgreSQL, MySQL/MariaDB, SQL Server, SQLite, Informix and ODBC,<br/>
  with an editor that knows your schema, an AI assistant with permissions and a mascot who keeps you company.
</p>

<p align="center">
  <a href="https://github.com/e-omunoz/celer/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/e-omunoz/celer?style=flat-square&color=F26B2A&label=release"></a>
  <a href="https://github.com/e-omunoz/celer/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/e-omunoz/celer/total?style=flat-square&color=4C88B8&label=downloads"></a>
  <a href="https://github.com/e-omunoz/celer/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/e-omunoz/celer/ci.yml?branch=main&style=flat-square&label=build"></a>
  <img alt="Windows, macOS and Linux" src="https://img.shields.io/badge/Windows%20·%20macOS%20·%20Linux-2B2724?style=flat-square">
</p>

<p align="center">
  <a href="https://github.com/e-omunoz/celer/releases/latest"><b>Download</b></a> ·
  <a href="docs/GUIA.md">User guide (Spanish)</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://github.com/e-omunoz/celer/releases/latest/download/Celer-Setup-Windows.exe"><img alt="Download for Windows (Celer-Setup-Windows.exe)" src="docs/media/download-windows.svg" width="250" /></a>
  <a href="https://github.com/e-omunoz/celer/releases/latest/download/Celer-macOS.dmg"><img alt="Download for macOS (Celer-macOS.dmg)" src="docs/media/download-macos.svg" width="250" /></a>
  <a href="https://github.com/e-omunoz/celer/releases/latest/download/Celer-Portable-Linux.AppImage"><img alt="Download for Linux (Celer-Portable-Linux.AppImage)" src="docs/media/download-linux.svg" width="250" /></a>
  <br/>
  <sub>
    Portable: <a href="https://github.com/e-omunoz/celer/releases/latest/download/Celer-Portable-Windows.exe">Windows</a> ·
    <a href="https://github.com/e-omunoz/celer/releases/latest/download/Celer-Portable-Linux.AppImage">Linux</a> ·
    Packages: <a href="https://github.com/e-omunoz/celer/releases/latest/download/Celer-Linux.deb">.deb</a> ·
    <a href="https://github.com/e-omunoz/celer/releases/latest/download/Celer-Linux.rpm">.rpm</a> ·
    <a href="https://github.com/e-omunoz/celer/releases/latest/download/SHA256SUMS.txt">SHA256SUMS.txt</a> ·
    <a href="https://github.com/e-omunoz/celer/releases/latest">release notes</a>
  </sub>
</p>

Open Celer, double-click a table and you are looking at its rows before you notice it loaded. Write a query and
completion offers the columns of the tables you are using. Ctrl+click a table name to open it, Ctrl+click a
foreign key to jump to the row it points to. Load 200,000 rows and the window keeps responding; if anything takes
long, Gib shows what he is doing and a button to cancel it.

Celer is a Rust core with a light web interface (Tauri 2). The installer is about 13 MB, installs for your user only,
without administrator rights, and keeps itself up to date.

> [!NOTE]
> The interface is in Spanish. An English translation is planned and contributions are welcome.

## See it in action

<p align="center">
  <img src="docs/media/demo.gif" alt="Celer starting up, opening a 200,000-row table, filtering it and running an aggregate query" width="100%" />
</p>

## Features

- **Fast by design.** One session per tab, each on its own thread: a slow query never blocks the rest. Results come
  in pages from an open cursor, the grid is drawn on a canvas, and 200,000 rows load in about two seconds.
- **An editor that knows your schema.** Completion offers tables after `FROM`/`JOIN`, the columns of the tables in
  the statement everywhere else, and `alias.` or `schema.` narrow the list. **Ctrl+click** (or F4 / Ctrl+B) on a
  table opens it. The statement under the caret is highlighted; Ctrl+Enter runs it.
  Live templates (`sel`, `ins`, `cte`…), query parameters (`:name`, `?`) asked before running, and a warning on a
  `DELETE` or `UPDATE` without `WHERE`.
- **Tables you can explore.** Filter chips per column (equals, contains, between, value lists…), your own `WHERE`
  and `ORDER BY` with live help (it warns when `"text"` would be read as a column name and fixes it in one click),
  sorting on the server and an exact count on demand. Edit cells with editors that know the type (a true/false
  picker, a calendar, the referenced rows of a foreign key) and save everything in one transaction.
- **Foreign keys you can follow.** FK columns are marked in the header; Ctrl+click a value to open the referenced
  row, or open the referenced table from the *Claves* tab.
- **See why a query is slow.** Execution plans as a tree for every engine, with real rows and times (EXPLAIN
  ANALYZE) and warnings worth acting on. Server activity shows the sessions and running queries, with cancel and
  kill.
- **Understand and compare schemas.** An entity-relationship diagram of any schema (export to SVG), and a schema
  comparison between two connections that writes the script to make them match. The rows of two tables can be
  compared the same way.
- **Results you can keep.** Pin a result, run again and compare both: changed cells and new or missing rows are
  marked. Quick filter over the loaded rows.
- **Never frozen.** Long operations show Gib at his laptop with live progress and **Cancelar**: loading every row
  stops after the chunk in flight and keeps what arrived; server queries are cancelled on the server.
- **Export and import.** Stream CSV, TSV, Excel, JSON, XML, SQL `INSERT`s, Markdown or HTML straight to disk;
  import CSV, JSON or Excel / OpenDocument sheets with column mapping in a single transaction. Generate SELECT with
  joins, INSERT, UPDATE, UPSERT/MERGE and DDL from the explorer.
- **AI with permissions.** An assistant that writes, explains, fixes and optimises SQL with Claude using your schema,
  never your rows. An **MCP server** (`celer.exe --mcp`) lets Claude Desktop, Claude Code and other clients use your
  connections with a permission level per connection, row and time limits, masked columns and an audit log.
- **Bring your connections.** Import them from **DBeaver** (saved passwords included, if you want) and
  **DbVisualizer**, with folders, production flags and SSH tunnels. Reach servers behind a bastion through an **SSH
  tunnel** (password, key or agent, jump hosts). Export them with their passwords, sealed with a passphrase
  (Argon2id + AES-256-GCM). Drag connections between folders in the explorer.
- **Made for long days.** Eight themes, compact or comfortable density, a command palette (Shift Shift),
  shortcuts you can change, a script library, a startup script per connection, and **Gib**: he thinks while queries
  run, has an idea when a long one finishes, goes for a coffee or juggles when you are away, and swats the cursor if
  you poke him while he waits.
- **Updates in the app.** Celer checks GitHub for new releases, shows what's new and installs them in one click,
  after verifying the download against the release's SHA-256 sums.

<p align="center">
  <img src="docs/media/gib-idle.gif" alt="Gib's idle routines: yawning, a coffee, coding on his laptop, juggling, dancing, reading, and swatting the cursor away" width="290" /><br/>
  <sub>Gib when you are idle: a coffee, the laptop, juggling… and he swats the cursor if you poke him while he waits.</sub>
</p>

<table>
  <tr>
    <td width="50%"><img src="docs/media/hero.png" alt="SQL console with a join and its results" /><br/><sub>Console, explorer and results</sub></td>
    <td width="50%"><img src="docs/media/completion.png" alt="Completion offering the columns of the statement's tables" /><br/><sub>Completion with the statement's columns</sub></td>
  </tr>
  <tr>
    <td><img src="docs/media/table.png" alt="Table viewer with a filter chip" /><br/><sub>Table viewer with column filters</sub></td>
    <td><img src="docs/media/keys.png" alt="Keys tab with a button to open the referenced table" /><br/><sub>Foreign keys: jump to the referenced table or row</sub></td>
  </tr>
  <tr>
    <td><img src="docs/media/plan.png" alt="Execution plan as a tree with real rows and times" /><br/><sub>Execution plan with real rows and times</sub></td>
    <td><img src="docs/media/er.png" alt="Entity-relationship diagram of a schema" /><br/><sub>Entity-relationship diagram</sub></td>
  </tr>
  <tr>
    <td><img src="docs/media/schemas.png" alt="Schema comparison with the columns that differ" /><br/><sub>Schema comparison and sync script</sub></td>
    <td><img src="docs/media/shortcuts.png" alt="Keyboard shortcuts settings" /><br/><sub>Shortcuts you can change</sub></td>
  </tr>
  <tr>
    <td><img src="docs/media/busy.png" alt="Gib at his laptop while 200,000 rows load, with a Cancel button" /><br/><sub>Loading 200,000 rows, cancellable</sub></td>
    <td><img src="docs/media/palette.png" alt="Command palette" /><br/><sub>Command palette</sub></td>
  </tr>
  <tr>
    <td><img src="docs/media/ai.png" alt="AI assistant panel" /><br/><sub>AI assistant</sub></td>
    <td><img src="docs/media/mcp.png" alt="MCP permissions per connection" /><br/><sub>MCP server with permissions per connection</sub></td>
  </tr>
  <tr>
    <td><img src="docs/media/export.png" alt="Export dialog" /><br/><sub>Streaming export</sub></td>
    <td><img src="docs/media/light.png" alt="Light theme" /><br/><sub>Light theme</sub></td>
  </tr>
</table>

## Installation

The buttons at the top always download the latest version. Every release has the same file names:

| System | File |
|---|---|
| Windows | `Celer-Setup-Windows.exe` (installer) · `Celer-Portable-Windows.exe` (runs without installing) |
| macOS | `Celer-macOS.dmg` (Apple silicon and Intel) |
| Linux | `Celer-Portable-Linux.AppImage` · `Celer-Linux.deb` · `Celer-Linux.rpm` |
| All | `SHA256SUMS.txt` with the SHA-256 of every file |

### Windows

1. Download **`Celer-Setup-Windows.exe`** (the Windows button above, or from the
   [latest release](https://github.com/e-omunoz/celer/releases/latest)) and run it.
2. Choose the folder and shortcuts (or just click *Instalar*).
3. Open Celer: a short guide shows you around and can create a sample database to play with.

Celer installs to `%LOCALAPPDATA%\Programs\Celer`, adds a Start menu entry and appears in *Settings › Apps* for
uninstalling. It runs on Windows 10 and 11 (WebView2, included with Windows). When there is a new version, Celer
tells you; nothing is downloaded until you press *Actualizar*. You can also run a newer installer over it.

Because the executables are not code-signed yet, SmartScreen may warn the first time (*More info › Run anyway*).
Every release can be verified with its `SHA256SUMS.txt`, as described in [SECURITY.md](SECURITY.md).

`Celer-Portable-Windows.exe` runs from any folder without installing. It does not update itself: when there is a new
version, Celer opens its release page.

### macOS and Linux

`Celer-macOS.dmg` is universal (Apple silicon and Intel). For Linux there are `Celer-Portable-Linux.AppImage`,
`Celer-Linux.deb` and `Celer-Linux.rpm`. They are not signed: on macOS open it the first time with right click ›
*Open*; on Linux make the AppImage executable (`chmod +x`). Updates inside the app are for Windows; on macOS and Linux
Celer opens the release page so you can download the new package.

### Deploying in an organization

Celer Setup installs silently, for the user that runs it and without administrator rights, so a deployment tool
(Intune, Configuration Manager…) must run it in the user's context. The link
`https://github.com/e-omunoz/celer/releases/latest/download/Celer-Setup-Windows.exe` always serves the latest version.

```bat
Celer-Setup-Windows.exe --silent [--dir "C:\Tools\Celer"] [--desktop | --no-desktop] [--no-start-menu | --start-menu] [--associate-sql | --no-associate-sql] [--launch]
"%LOCALAPPDATA%\Programs\Celer\uninstall.exe" --uninstall --silent [--purge-data]
```

| | |
|---|---|
| Upgrade | Run the newer `Celer-Setup-Windows.exe --silent`; settings and connections are kept, and so are the folder, the shortcuts and the `.sql` association of the current installation unless a flag changes them (`--no-desktop`, `--no-associate-sql`…) |
| Exit code | 0 on success; errors are written to `%TEMP%\celer-setup.log` |
| Uninstall | Removes everything except `uninstall.exe` itself (Windows does not let a running program delete itself); the next installation removes it, or delete it by hand |

Up to 2.0.1 there was also an MSI package. It is no longer published: copies installed with it keep working; to move
to Celer Setup, uninstall the MSI copy (your data is kept) and install `Celer-Setup-Windows.exe`.

## Databases

| Engine | Driver | Status |
|---|---|---|
| PostgreSQL | native: server-side cursors, cancel, full DDL | ✅ |
| MySQL / MariaDB | native: streaming, `KILL QUERY`, `DELIMITER` | ✅ |
| SQL Server | native (TDS), Windows authentication | ✅ |
| SQLite | embedded | ✅ |
| Informix | JDBC (Celer's bridge, Java found or downloaded on demand), Client SDK or IBM CLI | ✅ |
| Any ODBC source | ODBC driver manager | ✅ |
| Oracle, Db2, DuckDB, ClickHouse, Snowflake… | — | planned |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` / `Ctrl+Shift+Enter` | Run the statement / the whole script |
| `Ctrl+click` · `F4` · `Ctrl+B` | Open the table under the caret (in the SQL) |
| `Ctrl+click` on an FK value | Open the referenced row |
| `Shift` `Shift` · `Ctrl+K` | Search tables, tabs and actions |
| `Ctrl+N` | Go to table |
| `Ctrl+Shift+A` | Actions |
| `Ctrl+Shift+L` | New console |
| `Ctrl+Shift+N` | New window (drag a tab out of the tab bar to move it to one). With the focus in the explorer it creates a folder; in a table grid it sets NULL |
| `Ctrl+Alt+N` | New connection |
| `Ctrl+Alt+L` | Format SQL |
| `Ctrl+Shift+E` | Execution plan |
| `Ctrl+F2` | Stop |
| `Ctrl+Alt+I` | AI assistant |
| `Ctrl+Alt+E` | History |
| `Ctrl+Alt+B` | Save the console in the script library |
| `Alt+8` | Script library |
| `Ctrl+Alt+S` | Settings |
| `Ctrl+Alt+Shift+C` / `Ctrl+Alt+Shift+R` | Commit / rollback |

Every shortcut can be changed in *Ajustes › Atajos de teclado*. On macOS, `Ctrl` is `⌘`.

## Privacy and security

- No accounts, no telemetry. Your data never leaves the computer unless you ask for it.
- Passwords and the AI key live in the operating system's credential store, never in files.
- Network access beyond your databases is limited to: the update check against the GitHub Releases API (it sends
  nothing about you and can be turned off), the IBM driver download when you ask for it, and the AI assistant if you
  configure your own key (it receives the schema, never row data).
- The MCP server runs locally over stdio, is off by default and only sees what each connection's permission allows.
- Read-only connections refuse writes, even hidden in a batch; production connections ask before risky statements.

Details and how to report a vulnerability: [SECURITY.md](SECURITY.md).

## Performance

Measured on a laptop against the seeded PostgreSQL test database:

| | |
|---|---|
| First page of 500 rows | a few milliseconds after the server answers |
| Load 200,000 rows into the grid | about 2 s, the window stays responsive |
| Select all / copy 200,000 rows | ~40 ms / ~250 ms |
| Export 200,000 rows to CSV | ~1 s, streaming to disk |

## Building from source

Requirements: [Rust](https://rustup.rs) (stable), [Node.js](https://nodejs.org) 20+ and, on Windows, the Visual Studio
Build Tools with the C++ workload.

```bash
git clone https://github.com/e-omunoz/celer
cd celer
npm install
npm run tauri dev
```

`npm run dev` runs the same interface in a browser against an in-memory SQLite demo. Releases are built and published
by GitHub Actions when a `vX.Y.Z` tag is pushed (see [CONTRIBUTING.md](CONTRIBUTING.md#releases)).

| Folder | Contents |
|---|---|
| `src/` | Interface (SolidJS + TypeScript): workspace, grid, editor, explorer, dialogs, AI panel, guide |
| `src/gib/` | Gib, the start-up splash and the status-bar companion |
| `src-tauri/src/` | Rust core: drivers, sessions, export, MCP server, updates, migration |
| `installer/` | Celer Setup: the custom installer and uninstaller |
| `docs/` | Architecture, design, drivers, roadmap, AI/MCP; `docs/media` is regenerated by `dev/readme-media.mjs` |
| `dev/` | Test databases, end-to-end checks, media capture and release scripts |

## Contributing

Bug reports and ideas are welcome in [Issues](https://github.com/e-omunoz/celer/issues). Conventions, checks and how
releases are made are in [CONTRIBUTING.md](CONTRIBUTING.md). Please report security problems privately as described
in [SECURITY.md](SECURITY.md).

<p align="center">
  <img src="docs/brand/app-icon.svg" alt="" width="44" /><br/>
  <sub>Made with care · Gib says hi 👋</sub>
</p>
