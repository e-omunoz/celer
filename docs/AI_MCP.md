# AI in Celer

Celer offers two independent ways to work with AI. Both are **off by default** and follow the project's
"safe by default" principle.

## 1. In-app SQL assistant (Ctrl+Alt+I)

A panel that generates, explains, fixes and optimises SQL with Claude (official TypeScript SDK, streaming).

| | |
|---|---|
| Models | Claude Opus 5.5 (default), Claude Sonnet 5.5, Claude Haiku 4.5 — Settings › IA y MCP |
| Sent to the model | engine and database name, the schema (table and column **names**), the console SQL or selection, the last error |
| Never sent | row data |
| API key | stored in the OS credential store (Windows Credential Manager, service `Celer`), never in a file |
| Safety | Opus/Sonnet requests opt into server-side fallback (`fallbacks: "default"`); refusals and API errors are shown in the panel |

Entry points: the ✦ stripe button, palette actions (“IA: explicar / corregir / optimizar”), and “✦ Corregir con IA”
on the last failed statement in the Output log. SQL blocks in an answer can be inserted, replace the console or run.

“Copiar esquema para IA” (explorer and palette) copies an AI-ready Markdown description of a table or a whole schema,
for any assistant.

## 2. MCP server for external assistants

`celer.exe --mcp` speaks the Model Context Protocol over stdio, so Claude Desktop, Claude Code or any MCP client can
query your databases **through Celer's permissions**. Configure it in Settings › IA y MCP.

### Permission levels (per connection)

| Level | The assistant can |
|---|---|
| Sin acceso (default) | nothing — the connection is invisible |
| Solo esquema | list databases/tables, describe tables (columns, DDL), search objects |
| Lectura | the above + `sample_rows` and `run_query` (single read-only statement, row limit) |
| Lectura y escritura | the above + `execute_statement` (never on production or read-only connections) |

Defences: one statement per call; read queries are lexed under every quoting variant of the dialect and rejected if
they contain writes, `SELECT … INTO`, `FOR UPDATE`, DML CTEs or dangerous functions; then they run inside a read-only
transaction (PostgreSQL / MySQL) or `PRAGMA query_only` (SQLite) and are rolled back. Rows are capped (global and per
connection, hard cap 5000), queries time out, and columns matching the sensitive-name pattern are returned as
`[oculto]`. A query that names a protected column (also of another database on MySQL / SQL Server) is refused, and so
is one that reads a table with protected columns through a whole row (`SELECT t FROM users t`, `row_to_json(t)`),
column alias lists (`WITH s(a, b) AS …`, `AS u(a, b)`) or `UNION` / `INTERSECT` / `EXCEPT`. Masking is best-effort:
it works on names, so a view or function that renames a protected column is not caught; give assistants an account
without access to secrets when that matters. Every call is written to `mcp-audit.jsonl` (the SQL without its comments)
and shown in the settings.

### Connecting a client

- **Claude Desktop**: Settings › IA y MCP › Configurar (merges into `claude_desktop_config.json`, keeps a `.bak`), then
  restart Claude Desktop.
- **Claude Code**: copy the shown command, e.g. `claude mcp add --scope user celer -- "C:\…\celer.exe" --mcp`. The
  settings say whether it is registered, and flag a registration that points to another path of `celer.exe` (after a
  reinstall to another folder): run the command again.
- **Claude Code inside WSL**: see below.
- **Other clients**: command `celer.exe`, argument `--mcp`.

Files (in `%APPDATA%\es.celer.app`): `mcp.json` (permissions), `mcp-audit.jsonl` (log).

### Claude Code inside WSL

A WSL distro runs Windows programs through interop with their stdin and stdout piped, so Claude Code inside the
distro starts `/mnt/c/…/celer.exe --mcp` and talks to it over stdio like any MCP server. It is still the Windows
process: it reads the Windows `mcp.json`, takes passwords from the Windows credential store and writes the Windows
audit log, so the connections, levels, masking and limits are exactly the ones set in Settings. Verified from Ubuntu
on WSL 2: the release build (GUI subsystem) answers `initialize` and `tools/list` over interop stdio, and a debug
build with its own data folder (`CELER_DATA_DIR` passed through `WSLENV`) runs `list_connections`, `list_tables` and
`run_query` with passwords from the Windows credential store. No relay is needed.

Settings › IA y MCP › *Claude Code en WSL* lists the installed distros (`wsl.exe -l -q`; Docker Desktop's own ones are
left out). A running distro is looked into right away; a stopped one only on *Comprobar*, which starts it. For each:

- whether Windows interop is on (`[interop] enabled` in `/etc/wsl.conf` and the binfmt entry WSL registers), and
  where Claude Code is (`command -v claude`, then `~/.local/bin/claude` and the other usual places);
- the command, with `celer.exe` converted to the distro's path, honouring `[automount] root`:
  `claude mcp add --scope user celer -- '/mnt/c/…/celer.exe' --mcp --client=wsl:<distro>`;
- *Registrar en WSL*: shows that exact command, asks for confirmation and runs it inside the distro
  (`wsl.exe -d <distro> -e sh -lc …`; an earlier `celer` entry of user scope is removed first);
- whether it is registered, read from the distro's `~/.claude.json` (through `\\wsl.localhost\<distro>\…`, or
  `cat` inside the distro): user scope or any project. An entry whose command is another path of `celer.exe` is
  flagged *registrado con otra ruta* with a *Volver a registrar* button.

`--client=wsl:<distro>` tells the audit log where the client runs: each entry records the client (`Windows`,
`WSL (Ubuntu)`, `Linux`) and the client program from `initialize` (`claude-code`…), and the settings show it.

### Status bar indicator

While MCP is on, the status bar shows «MCP · Windows + WSL (Ubuntu)»: where the registered clients are (Claude Desktop
and Claude Code on Windows, Claude Code in each WSL distro). Its tooltip lists the clients, the last call (when, which
tool, from where) and warns about a registration with an old path. A click opens «Actividad de la IA»: the last 30
calls of the audit log (what, on which connection, when, from which client; refused ones in red) and a button to
Settings › IA y MCP. It is hidden while MCP is off. The WSL distros are read in the background at most every two
minutes.

### Controlling the app («Controlar la aplicación»)

Off by default. With it on, the assistant can also work with the running Celer; with it off, `tools/list` does not
include any of these tools and calling one is refused. Sub-switches: *Abrir pestañas*, *Escribir en la biblioteca*,
*Ejecutar lo que abre* (off by default).

| Tool | Needs | Does |
|---|---|---|
| `get_app_state` | the switch | the windows and their tabs (which window has the focus, the active tab, connection and database of each). Tabs of connections at level *Sin acceso* show only their kind; console SQL and table filters only at *Lectura* or more |
| `list_library`, `get_library_script` | the switch | the script library (name, folder, tags, notes, connection; the SQL with `get_library_script`). Scripts of connections at *Sin acceso* are left out |
| `add_library_script` | *Escribir en la biblioteca*; *Solo esquema* on its connection, if any | adds a script (name made unique, marked as the AI's, with its notes) |
| `open_console` | *Abrir pestañas*; *Solo esquema* | a console with the SQL written, on a connection and database |
| `open_console` with `run` | *Ejecutar lo que abre*; *Lectura* for one read statement (the `run_query` filter and masking checks), *Lectura y escritura* for one modifying statement (the `execute_statement` filter; never production or read-only) | runs it in that console, as «Ejecutar» does (the production and no-WHERE confirmations still ask); the AI gets whether it ran and the summary line, not the rows |
| `open_table` | *Abrir pestañas*; *Lectura* | a table or view in the viewer, optionally with a WHERE filter and ORDER BY, which are checked as a `run_query` of `SELECT * FROM t WHERE … ORDER BY …` |
| `open_object` | *Abrir pestañas*; *Solo esquema* | a table or view on its DDL, columns, indexes or keys |
| `open_er_diagram` | *Abrir pestañas*; *Solo esquema* | the diagram of a table and its relations, or of a schema |

Every check (switches, levels, read filter, masking) happens in the MCP process before anything reaches the app, and
every call, refused or not, is in `mcp-audit.jsonl` (a run is marked `[ejecutar]`). The running query in a console is
not wrapped in a read-only transaction the way `run_query` is: at *Lectura* the lexical read filter is what stops a
write, as it is for a read-only connection in the app.

**The local channel.** The running Celer listens on a loopback TCP port chosen by the system and writes `mcp-app.json`
(port, random token, process id) in its data folder; `celer --mcp` reads it, checks that a Celer answers (a hello
line), sends one request with the token and waits for the answer. When Celer is not open the tools say so
(«Celer no está abierto…»); the database tools keep working. The file is removed when Celer closes. From WSL the MCP
process is still a Windows process, so it reaches the same loopback.

**What the user sees.** The request goes to the last focused Celer window. A tab the AI opened carries a ✦ badge
(«Abierto por la IA · hace N min», with the client) and flashes briefly; a notice says «La IA ha abierto «X» en la
ventana Y» with «Ir». Nothing takes the focus: while the user is typing (a key in the last 4 s) the tab opens in the
background and the notice says so; an E-R diagram, which covers the workspace, is offered in a notice instead of
opened; a Celer window in the background gets its taskbar button flashed. Library scripts the AI added show the badge
and their notes in the library.
