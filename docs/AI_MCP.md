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
tool, from where) and warns about a registration with an old path; a click opens Settings › IA y MCP. It is hidden
while MCP is off. The WSL distros are read in the background at most every two minutes.
