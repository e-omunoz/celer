# Macro review 2.1 (2026-10-09)

Mode `full`, all areas, base `origin/main`, branch `review/macro-2.1`. 34 agents (auditors, verifiers, fixers). Ledger: milestone *Macro review 2.1*, tracking issue #11.

**74 issues filed** (1 critical, 10 high, 33 medium, 30 low); **73 fixed**, 1 deferred. Final verification: green, no regressions.

## Issues

| # | Severity | Area | Issue | Fix |
|---|---|---|---|---|
| #12 | critical | connections | Read-only connections can modify data through Export: export_query runs any SQL without the read-only check | c7f6989 |
| #13 | high | ui-functional | Exporting a console result re-runs the whole last-run script (writes included, no confirmation) and exports the first result, not the one on show | ef35a0f |
| #14 | high | drivers-open | MySQL/MariaDB: a batch whose later statement fails returns Ok, so saveTable commits a partial save and reports success | 5a44497 |
| #15 | high | drivers-open | Read-only PostgreSQL connections allow writes through DO blocks and EXPLAIN ANALYZE | 5873027 |
| #16 | high | drivers-open | PostgreSQL/MySQL/SQLite: statements after a result larger than one page are dropped without a message when the cursor is closed | 8fd926d |
| #17 | high | drivers-open | SQLite manual-commit mode silently reverts to autocommit after the first commit or rollback | e87ada5 |
| #18 | high | drivers-enterprise | SQL Server named instance is ignored because the form always fills port 1433, so the SQL Browser lookup never runs | 25081e8 |
| #19 | high | connections | Saved connections are wiped when connections.json fails to load once (locked, damaged, or one unknown entry) | 351e9c1 |
| #20 | high | connections | After a failed reconnect the open transaction is forgotten: later statements and COMMIT run on a new connection (partial commit) | be79d95 |
| #21 | high | frontend-state | Changing a console's connection while its session is still opening attaches the old connection's session, so queries run on the wrong server | 884e7ad |
| #22 | high | security | MCP: quoting a function name skips the dangerous-function deny-list, so a read-level assistant can call pg_read_file, pg_terminate_backend or get_lock, even on production connections | ad1684f |
| #23 | medium | ui-visual | Alto contraste claro (and Sand, partly) inherit dark-theme syntax and object-icon colours, about 2:1 on white | dc129ae |
| #24 | medium | ui-visual | Ejecutar button label is white on --run, 1.47:1 in Alto contraste oscuro and below AA in every theme except Alto contraste claro | ce96471 |
| #25 | medium | ui-visual | Result grid truncates by character count with no cell clip, so wide glyphs (CJK, emoji) paint over the next columns | 7f52a22 |
| #26 | medium | ui-visual | White text on the default accent (3.12:1) and on --danger fails AA, including in both high-contrast themes | 224f825 |
| #27 | medium | ui-functional | Closing a console tab drops unsaved library or file edits without asking, and closing a window treats any file-backed console as safe | 682850e |
| #28 | medium | ui-functional | Copy as JSON and JSON export drop columns that share a name | 5900369 |
| #29 | medium | ui-functional | Focus is left on <body> after the palette or a confirm dialog closes, so editor and grid shortcuts stop working | b5f92a5 |
| #30 | medium | drivers-open | Table viewer edits and deletes on a binary primary key match no row but report 'Cambios guardados' | c633d33 |
| #31 | medium | drivers-open | SQL INSERT export does not round-trip MySQL backslashes, binary columns or PostgreSQL NaN/Infinity | edda33c |
| #32 | medium | drivers-open | Exports silently truncate binary values longer than 4096 bytes in every format | 932f48a |
| #33 | medium | drivers-open | MySQL/SQLite: autocompletion refresh after DDL closes the console's open cursor, so the grid shows a truncated result as complete | f0aed96 |
| #34 | medium | drivers-open | SQLite ':memory:' connections give each session (explorer, every console and table tab) its own empty database | c3e465b |
| #35 | medium | drivers-enterprise | SQL Server: a semicolon-free batch starting with INSERT/UPDATE/DELETE/MERGE goes through execute(), which drops later SELECT grids and adds their rows to the affected count | e5a4d03 |
| #36 | medium | drivers-enterprise | SQL Server: GO batch separators are not split, so SSMS-generated scripts fail | 95dcc0b |
| #37 | medium | drivers-enterprise | Informix schema sync emits ALTER TABLE ... MODIFY without the target column's DEFAULT or constraints, which drops them silently | bbc2a03 |
| #38 | medium | drivers-enterprise | SQL Server session_effects misses EXECUTE AS, SETUSER, OPEN SYMMETRIC/MASTER KEY and global cursors, so pooled or reserve connections leak or lose that state | 03640bf |
| #39 | medium | drivers-enterprise | SQL Server table DDL hardcodes IDENTITY(1,1), omits CHECK constraints, INCLUDE columns, index filters and PERSISTED, and writes columnstore/XML/spatial indexes as plain indexes | 920e281 |
| #40 | medium | drivers-enterprise | Informix table DDL omits FOREIGN KEY and UNIQUE constraints and writes the PRIMARY KEY columns in table order | bd49c35 |
| #41 | medium | drivers-enterprise | Informix split_batch sends the whole script unsplit whenever CREATE PROCEDURE/FUNCTION/TRIGGER appears anywhere, even in a comment or string | 07312c0 |
| #42 | medium | drivers-enterprise | Statements after a SELECT that fills more than one page are dropped without notice when the user moves on (Informix/ODBC pending queue; same pattern in PostgreSQL and SQL Server) | b3f72a4 |
| #43 | medium | core-rust | Cancelling an export is usually ignored: the raw driver drops cancel between fetches while the UI reports 'ExportaciÃ³n cancelada' | f84d826 |
| #44 | medium | core-rust | JSON export sorts keys alphabetically and loses columns that share a name | cbb6811 |
| #45 | medium | core-rust | Failed or cancelled text exports truncate the destination file first and leave a partial file | eb111a9 |
| #46 | medium | core-rust | No single-instance guard: a second Celer process overwrites connections.json and workspace from its stale memory | fd152e8 |
| #47 | medium | frontend-state | runText/rerunActive put the old tab.selection back after the run, overwriting a selection made during the run, so the next Ctrl+Enter runs the statement at the cursor | 5b35b70 |
| #48 | medium | frontend-state | Changing a console's connection closes its session and rolls back an open transaction without the confirm that closeTab/disconnect show | b9cb4ae |
| #49 | medium | frontend-state | SqlPane's conditional hasMore prop creates an undisposed Solid memo on every grid paint and mouse event | c887160 |
| #50 | medium | security | MCP sensitive-column masking is bypassed by a whole-row reference, CTE column-alias lists, UNION, views, or (on MySQL) a column from another database | 0e6c162 |
| #51 | medium | security | Read-only connections in the GUI still run writes through PostgreSQL DO blocks, REFRESH/CLUSTER, or a bare T-SQL procedure call, because the check is lexical and PostgreSQL/SQL Server set no read-only mode at session level | 807360d |
| #52 | medium | security | Production confirmation is skipped when a MySQL '#' comment precedes DROP/DELETE/UPDATE, and for PostgreSQL EXPLAIN ANALYZE <DML> | 8d63f9e |
| #53 | medium | security | An ODBC PWD= typed into the connection string (as the placeholder suggests), or a password in Extra, is saved in clear in connections.json and included in the 'sin contraseÃ±a' export | b8aa541 |
| #54 | medium | release | Upgrading over an existing install (the README's `--silent`, or the GUI) resets the desktop shortcut and .sql association to defaults and removes them | 1ea9a09 |
| #55 | medium | release | CI does not build or test installer/src-tauri; installer breakage is first caught by the tag-triggered release run | e648346 |
| #56 | low | ui-visual | CodeMirror find/replace panel and other built-in UI strings are in English | 4826422 |
| #57 | low | ui-visual | Sand theme --text-muted (3.7:1) and --text-faint (about 2.3:1) fail AA | 342b4e9 |
| #58 | low | ui-visual | --text-faint carries informative text (headings, row counts, field hints) at 2.6-3.5:1 in Celer Claro, Darcula and Celer Oscuro | f87e59e |
| #59 | low | ui-visual | Onboarding appearance step omits the high-contrast themes its welcome card advertises | b730066 |
| #60 | low | ui-visual | Unconnected consoles get the English tab title 'console' | ede0e82 |
| #61 | low | ui-visual | Table viewer hides the ORDER BY field below 760px even though the data toolbar wraps, hiding an active ordering | a721afd |
| #62 | low | ui-visual | 'Ventana nueva' command label includes unrelated shortcut notes and gets truncated | 42e6494 |
| #63 | low | ui-functional | Ctrl+Shift+N is swallowed in read-only grids, so it neither sets NULL nor opens a new window | 0ae12b7 |
| #64 | low | ui-functional | The explorer menu shows Ctrl+F5 for 'Actualizar' but nothing handles that key | 94db6c3 |
| #65 | low | ui-functional | Toasts at the bottom right cover the right-hand buttons of the table changes bar | 2ca00b0 |
| #66 | low | drivers-open | SQLite reports a stale 'N filas afectadas' for DDL and transaction-control statements | 2142379 |
| #67 | low | drivers-enterprise | SQL Server PRINT and low-severity RAISERROR messages are discarded | deferred |
| #68 | low | drivers-enterprise | SQL Server money/smallmoney decoded as f64: large amounts lose exact cents and the 4-decimal scale is not kept | 54ff555 |
| #69 | low | drivers-enterprise | Generic ODBC: a driver installed only as 32-bit is reported as missing (IM002), and IM014 gets no hint | a61dda0 |
| #70 | low | drivers-enterprise | Informix INTERVAL type names drop the leading-field precision (DAY(5) TO HOUR becomes DAY TO HOUR) | a7dcd11 |
| #71 | low | connections | Test connection marks 'Inicio de sesiÃ³n' failed when only the database is wrong (PostgreSQL/MySQL) | 7896552 |
| #72 | low | connections | SQL Server JDBC URL with a bracketed IPv6 address silently becomes localhost:1433 | 0d3a19a |
| #73 | low | core-rust | Excel export keeps the whole workbook in RAM and reports the row limit only after fetching every row | d83e2d8 |
| #74 | low | core-rust | History compaction caps entries by count only, so with large SQL it rewrites the whole file on every add_history | b9143fc |
| #75 | low | frontend-state | loadCompletion applies an older completion response after the database changed again, so completion describes the wrong database | 8422544 |
| #76 | low | frontend-state | Status-bar selection aggregates and Ln/Col keep the previous tab's values after switching tabs | c0a5859 |
| #77 | low | frontend-state | Assistant/library panel loses the active console's completion when focus goes from window A to B and back to A | 266ed5a |
| #78 | low | frontend-state | Statement highlight runs doc.toString() + splitSql over the whole script on every keystroke and cursor move, with no size limit | f3c9f19 |
| #79 | low | frontend-state | Moving a tab to another window JSON-clones and re-serializes its whole loaded result through the window inbox | daae472 |
| #80 | low | security | MCP audit log keeps only the first 500 characters of the SQL, so a long leading comment hides the executed query | baf7f1e |
| #81 | low | release | dev/release.ps1 does not check that it runs on an up-to-date main before tagging and pushing | 44525e8 |
| #82 | low | release | The rewritten dev/release.ps1 leaves Cargo.lock (and package-lock.json) at the previous version in the release commit | ffb88a9 |
| #83 | low | release | README screenshots (docs/media/*.png) show the 2.0.1 UI and miss the script library button and the new explorer header | 9a372d1 |
| #84 | low | release | upload-artifact@v4 / download-artifact@v4 in release-desktop.yml and engines.yml still target Node 20 | cf98b72 |
| #85 | low | release | CONTRIBUTING.md asks for Conventional Commits, but the project uses plain 'Area: what changed' subjects | d553c6e |

## Deferred

- #67 SQL Server PRINT / low-severity RAISERROR messages: tiberius 0.13 consumes the TDS INFO tokens, so showing them needs a patched or forked tiberius. Documented in `docs/DRIVERS.md` (SQL Server: known limits), labelled `review:deferred`.

## Not checked

- No local SQL Server or Informix (no Docker/WSL; SQL Server Express install failed): those findings rest on code, tiberius sources and the engines workflow on GitHub Actions.
- JDBC bridge not built locally (no JDK `jar` on PATH for `build.rs`); bridge behaviour reviewed in code only.
- Driver, connection and core findings were proven with probe tests in scratch copies of the crate, not by driving the desktop UI.
- Not covered: real Windows display scaling, the light OS theme, 1920x1080, several native windows, native file dialogs (import, opening .sql), and live install/upgrade/uninstall with Celer Setup.
- macOS and Linux builds were not run.
- Worth hardening, not filed: CSP is null, the installer allows `opener:allow-open-path **`, the updater checksum comes from the same release (so it checks integrity, not authenticity), and the update download has no read timeout.

