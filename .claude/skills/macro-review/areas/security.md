# Area: security and privacy

Code: `src-tauri/src/mcp.rs`, `store.rs` (credentials), `update.rs`, `guard.rs`, `lib.rs`, `capabilities/*.json`,
`tauri.conf.json` (CSP), `installer/src-tauri/src/*`, the AI assistant (`@anthropic-ai/sdk` usage in `src/`);
docs `SECURITY.md`, `docs/AI_MCP.md`.

## Check
- Secrets: passwords and API keys only in the OS credential store; never in `connections.json`, logs, history,
  exports, crash text, MCP audit log, AI prompts, or the clipboard by default.
- AI assistant: only schema goes out, never row data (trace every code path that builds a prompt); the key is never
  sent anywhere but the Anthropic API.
- MCP server (`celer.exe --mcp`): per-connection permission levels enforced in Rust; row limits; sensitive-column
  masking cannot be bypassed with aliases, expressions, `SELECT *`, views or CTEs; audit log complete; read-only
  connections reject writes including `SELECT … INTO`, CTE with DML, procedures, `COPY`, `LOAD DATA`.
- Production confirmation for dangerous statements: detection of DELETE/UPDATE without WHERE, DROP, TRUNCATE across
  comments, case and multi-statement scripts.
- Tauri: CSP, capabilities per window, no `shell` open of untrusted URLs, file dialogs only.
- Updater and installer: SHA-256 checked before running, HTTPS only, no hidden commands, per-user install paths,
  uninstall leaves no secrets.
- SQL injection in generated SQL (identifier/literal quoting in `sqlgen.ts`, filters, FK lookup, import).
- `npm audit --omit=dev` and `cargo audit` (if installed) — report only advisories that affect shipped code.
