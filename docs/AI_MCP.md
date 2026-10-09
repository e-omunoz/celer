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
- **Claude Code**: copy the shown command, e.g. `claude mcp add celer -- "C:\…\celer.exe" --mcp`.
- **Other clients**: command `celer.exe`, argument `--mcp`.

Files (in `%APPDATA%\es.celer.app`): `mcp.json` (permissions), `mcp-audit.jsonl` (log).
