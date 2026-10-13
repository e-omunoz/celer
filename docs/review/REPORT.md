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


# Macro review 2.3 (2026-10-12)

Mode `full`, all areas, base `origin/main`, branch `feat/integration-2.3.0`. Tracking issue #126 (Sprint 2.3).

**41 issues filed** (4 high, 17 medium, 20 low); **41 fixed**, 0 deferred, 0 open. Final verification: green, no failures, no regressions.

## Counts by area and severity

| Area | High | Medium | Low | Total | Fixed |
|---|---|---|---|---|---|
| drivers-open | 1 | 1 | 1 | 3 | 3 |
| drivers-enterprise | 1 | 0 | 2 | 3 | 3 |
| core-rust | 1 | 2 | 3 | 6 | 6 |
| frontend-state | 1 | 1 | 1 | 3 | 3 |
| ui-visual | 0 | 5 | 5 | 10 | 10 |
| ui-functional | 0 | 2 | 4 | 6 | 6 |
| connections | 0 | 5 | 2 | 7 | 7 |
| release | 0 | 1 | 2 | 3 | 3 |
| **Total** | **4** | **17** | **20** | **41** | **41** |

#142 was filed by both the connections and core-rust auditors; it is counted once, under connections, and was fixed by core-rust (1e995fc). The connections fixer re-checked it live and made no second commit.

## Issues

| Issue | Severity | Area | Title | Status |
|---|---|---|---|---|
| #128 | high | drivers-open | MySQL: explicit_tx guessed from statement text, so a failed script after START TRANSACTION leaves an open transaction shown as closed | fixed f6d9ef3 |
| #129 | high | drivers-enterprise | SQL Server: a runtime error after a result's columns arrive is reported as success; Export writes a truncated file; GO scripts keep running | fixed 9850737 |
| #130 | high | core-rust | Importing a workbook with one stray far-away cell aborts the process (calamine dense range) | fixed fc69118 |
| #131 | high | frontend-state | Result comparison's PK lookup closes the console's open cursor (SQL Server truncates, MySQL/MariaDB/SQLite fail on «Cargar todo») | fixed 942f67c |
| #132 | medium | ui-visual | Status bar items overlap at 1024-1366px with env chip, TX status or MCP indicator | fixed b6d3713 |
| #133 | medium | ui-visual | Console toolbar pickers spill past their buttons and under the environment chip | fixed f992a63 |
| #134 | medium | ui-visual | Tab bar: TX badge sticks out of a squeezed tab | fixed 1ddc55f |
| #135 | medium | ui-visual | «Capturar la ventana» shows an empty explorer when the tree is scrolled | fixed 3693f87 |
| #136 | medium | ui-visual | «Ejecutar en…» footer buttons fall outside the dialog on short viewports | fixed 329b955 |
| #137 | medium | ui-functional | «Ejecutar en…» with one target runs the open console's selection/unsaved text, not the saved script | fixed ed0e409 |
| #138 | medium | ui-functional | true/false values go in as bare TRUE/FALSE, rejected by SQL Server, ODBC to SQL Server and Informix | fixed 0e6f89d |
| #139 | medium | drivers-open | PostgreSQL: per-partition FK clones listed as real keys; the DDL then fails | fixed d8846c7 |
| #140 | medium | connections | A mistyped SSH password from the connect prompt shadows the saved one for the whole run | fixed 5b45c49 |
| #141 | medium | connections | Through an SSH tunnel, TLS with certificate validation checks against 127.0.0.1 | fixed ad6fe8d (MySQL/MariaDB: chain only, see below) |
| #142 | medium | connections / core-rust | SSH forward has no timeout: Probar conexión and Connect hang about 2 minutes | fixed 1e995fc |
| #143 | medium | connections | Pre-use check with session state has no time limit after an idle pause; Detener has no effect | fixed 8354809 |
| #144 | medium | connections | JDBC import maps MySQL/MariaDB connectTimeout=0 / socketTimeout=0 to 1 s | fixed 7a9651d |
| #145 | medium | core-rust | A damaged settings.json is set aside silently at startup | fixed 193871e |
| #146 | medium | core-rust | SQL Server: query time limit (like Detener) drops the connection and rolls back a manual transaction | fixed 53be834 |
| #147 | medium | frontend-state | settleTransactions sends Commit/Rollback on a console that is still running | fixed 1c572ea, 8139b9f |
| #148 | medium | release | SECURITY.md omits 2.3's wsl.exe probes, ~/.claude.json reads, MCP loopback channel, SSH known_hosts/agent | fixed fb0307c |
| #149 | low | ui-visual | «Otro…» environment button drops 8px | fixed 0f6f8ad |
| #150 | low | ui-visual | Gib's speech bubble covered by toasts | fixed 8de5d64 |
| #151 | low | ui-visual | Cross-window quit prompt says «en todas» with a single transaction | fixed 9322fec |
| #152 | low | ui-visual | Transaction reminder repeats the connection name | fixed c2cb7c4 |
| #153 | low | ui-visual | Compare chips «cambiadas» / «solo en B» below 4.5:1 in Sand and Celer Claro | fixed a1797c9 |
| #154 | low | ui-functional | Renaming a variable to a used name silently deletes the other variable | fixed dc614b1 |
| #155 | low | ui-functional | Transaction threshold below 0.5 min saved as 0 | fixed 15385fb |
| #156 | low | ui-functional | Variable hover shows a value inside a multi-line /* */ comment | fixed ee5fa44 |
| #157 | low | ui-functional | Close-window dialog uses plural with one tab at risk | fixed 33bd077 |
| #158 | low | drivers-open | SQLite: FK target uses REFERENCES text as written and the database name as schema | fixed bdf0e69 |
| #159 | low | drivers-enterprise | SQL Server: PRINT/INFO before the error lost when a single DML statement fails | fixed 0becf94 |
| #160 | low | drivers-enterprise | Informix DRDA: DECIMAL(p) as DOUBLE, DRDA/JDBC type differences undocumented | fixed 0836157 (documented and pinned by test) |
| #161 | low | connections | JDBC import splits sessionVariables inside quotes; currentSchema with spaces unescaped | fixed a253fb8 |
| #162 | low | connections | «Sin contraseñas» export keeps sslpassword=, Token=, api_key= | fixed c2edd78 |
| #163 | low | core-rust | History capped at about 15k entries by the 4 MB compaction | fixed eed963f |
| #164 | low | core-rust | Disconnecting an SSH-tunnelled connection leaves the bastion session and port open | fixed 7e4362f |
| #165 | low | core-rust | mssql_abandoned_cursor 500 ms wall-clock bound flaky under load | fixed e87c6ed |
| #166 | low | frontend-state | Detached plan/compare panels keep sending «Transacción abierta» reminders | fixed 4fe34ea |
| #167 | low | release | README screenshots predate 2.3 | fixed 31cb8eb |
| #168 | low | release | CONTRIBUTING.md Node version and Checks section out of date | fixed 6c4b79d |

Partial: #141 on MySQL/MariaDB validates the certificate chain but not its name (the mysql 26 crate cannot check a different name); the connection form says so under «Confiar en el certificado». #130: .ods keeps calamine's own 100M-cell limit, so a stray far cell in an .ods can still use about 3 GB.

## Checks run

- Full engine suite `bash dev/wsl/engines.sh test` (every dev/*-check.ts, tsc, `cargo test --lib`) after each area's fixes: **ALL ENGINES PASS** on PostgreSQL 17, MySQL 8.4, MariaDB 11.4, SQL Server 2022, Informix DRDA, Informix JDBC, SQLite, ODBC (psqlODBC to PostgreSQL) and SSH tunnels to every server engine. Last runs: 231-232 passed, 0 failed, 1 ignored, plus 24 on MariaDB.
- Fast checks in parallel: all 30 dev/*-check.ts, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p installer`, `npm run build`: pass.
- Parallel tests: the dev/*-check.ts ran concurrently (xargs -P 8) in every area; a parallel stress run of the test binary ran mssql_cancel_keeps_the_transaction x5, ssh_tunnel_closes_on_disconnect x5, mssql_abandoned_cursor x3, a_stray_far_away_cell x3 and ssh_tunnel_auth_jumps_and_refusals x2 concurrently: all passed. Cross-engine mid_result_error_* tests run one per engine. The 10 ui-visual browser scenarios were re-run in parallel on a fresh Vite server with all fixes together: all confirmed.
- New or extended tests: mysql::tests::it_tracks_transactions (#128), engine_tests::pg_schema_foreign_keys (#139), engine_tests::sqlite_schema_foreign_keys (#158), mid_result_error_* on every engine and mssql_engine (#129, #159), informix_types_drda_and_jdbc (#160), sheets::a_stray_far_away_cell_is_refused_before_allocating (#130), startup_tests::a_damaged_settings_file_is_left_for_the_interface_to_report (#145), mssql_cancel_keeps_the_transaction (#146), ssh_tunnel_auth_jumps_and_refusals forward case (#142), ssh_tunnel_closes_on_disconnect (#164), store history_compacts_by_size (#163), mssql_abandoned_cursor (#131, #165), postgres::tests::pg_commit_of_an_aborted_transaction (#147), store::tests::a_saved_or_deleted_secret_replaces_the_one_typed_for_this_run (#140), engine_tests::ssh_tunnel_validates_tls_by_server_name (#141, needs CELER_SSH_TLS_CA), guard::tests::a_silent_cut_with_state_is_bounded_and_can_be_stopped plus stateful_silent_cut on every engine (#143), migrate-check/explorer-check/connform-check (#144, #161, #162), snippets/variables/txwatch/windows/contrast checks (#138, #154-#157, #152, #153). Each driver fix was reproduced failing before the fix.
- Desktop app (Windows debug build, WebView2, CDP): #131 and #147 on all 8 connections (PostgreSQL, MySQL, MariaDB, SQL Server, Informix DRDA, Informix JDBC, SQLite, ODBC SQL Server), each compared against a pre-fix build; #166 on PostgreSQL; #167 screenshots retaken from the debug app.
- Browser preview (headless Chromium, demo SQLite): before/after for #132-#136, #149, #150, #152, #153, #137, #154, #155, #156.
- #138 literals live in WSL Docker on PostgreSQL, MySQL 8.4, MariaDB 11.4, SQL Server 2022, Informix (dbaccess) and SQLite.
- #141 live with a temporary test CA on PostgreSQL, MySQL, MariaDB and SQL Server through the tunnel (reverted afterwards).
- `cargo clippy --lib --tests`: no new warnings in changed code.

## Not checked

- Desktop app (WebView2) not driven for most fixes: the drivers-open, drivers-enterprise, core-rust, connections and ui-functional fixes are covered by live driver/engine tests and the browser preview, not clicked through in the app. #151 and #157 (cross-window, Tauri only) are covered by tsc and windows-check only. The #140 and #141 UI parts are covered by tsc and core tests only. #145's notice in the window was not seen live.
- Engines per fix: ui-visual and release changes do not reach a connection, so no engine is reported as tested for them. #166 tested on PostgreSQL only. #142 forward timeout and #164 measured through the WSL bastion. #138 ODBC checked by unit test only; Informix DRDA vs JDBC not separated (literal does not depend on the driver). SQLite does not apply to #140-#143.
- Windows-only paths: IBM CLI on db2cli64.dll, Windows ODBC DSNs, Informix SQLI through Client SDK ODBC, Windows authentication and named instances on SQL Server, Windows TCP retransmission timeout, Credential Manager splitting, Pageant/OpenSSH agent, mcp_wsl wsl.exe probing, Windows notifications.
- macOS and Linux (WSLg) desktop builds; real 125 %/150 % OS scaling (emulated in CSS pixels only); OS light/dark switching and the splash; comfortable density; CJK glyphs in the grid; installer UI, E-R diagram, plan view, compare and update dialog not revisited visually.
- Release gate 5: no `Release` or `Engines (SQL Server, Informix)` workflow run on GitHub for this branch yet, so the Windows and macOS 2.3.0 packages were not built. Linux deb/rpm/AppImage built locally. Portable build startup and the installer run not checked.
- Azure SQL / Synapse / Fabric; generic ODBC drivers without SQLForeignKeys; MySQL with lower_case_table_names=1/2; 1M-row «Cargar todo» memory per engine; grid/explorer/editor performance checklist.
- Security: in-app AI chat trace, Tauri CSP/capabilities, updater and installer, cross-database masking re-proof, live SSH unknown-key rejection, `npm audit` / `cargo audit`.
- MCP «Controlar la aplicación» and the MCP indicator popover on the desktop app; report sending; native file dialogs; updates dialog; AI assistant panel.
- Load-induced flakes seen during parallel audit runs, not filed: informix_silent_cut, guard::tests::progress_says_reconnecting, mcp::tests::app_tools_informix_jdbc, odbc_open_result_is_freed_before_its_connection (Informix -244 lock contention); all passed when rerun alone.
- Leftovers: s2_* test tables may remain on MySQL, MariaDB, SQL Server and Informix; variable s2v and library script «s2 runon» in D:\celer-devdata-slot2.


# Macro review 2.4 (2026-10-13)

Mode `full`, all areas, base `origin/main`, branch `feat/integration-2.4.0`. Tracking issue #171 (Sprint 2.4). Focus: the 2.4 features (test data generator #172, theme editor #107, motion #110, tear-off outline #108, menus #111, Informix row history #123).

**41 issues filed** (1 high, 13 medium, 27 low); **41 fixed**, 0 deferred, 0 open. Final verification: green, no failures, no regressions.

## Counts by area and severity

| Area | High | Medium | Low | Total | Fixed |
|---|---|---|---|---|---|
| security | 1 | 0 | 2 | 3 | 3 |
| ui-visual | 0 | 2 | 5 | 7 | 7 |
| ui-functional | 0 | 1 | 3 | 4 | 4 |
| drivers-open | 0 | 2 | 6 | 8 | 8 |
| drivers-enterprise | 0 | 4 | 2 | 6 | 6 |
| connections | 0 | 0 | 0 | 0 | 0 |
| core-rust | 0 | 0 | 4 | 4 | 4 |
| frontend-state | 0 | 3 | 2 | 5 | 5 |
| release | 0 | 1 | 3 | 4 | 4 |
| **Total** | **1** | **13** | **27** | **41** | **41** |

#180 was filed by the drivers-enterprise, connections and core-rust auditors; it is counted once, under drivers-enterprise. It was fixed in two parts: the SSH tunnel by drivers-enterprise (23699b6) and the startup script by connections (025c421); core-rust re-checked it and made no commit.

## Issues

| Issue | Severity | Area | Title | Status |
|---|---|---|---|---|
| #174 | high | security | Test data: MySQL/MariaDB catalog queries escape only quotes, so a table name with a backslash runs injected SQL when the dialog opens | fixed 48be1ed |
| #175 | medium | ui-visual | Theme editor: Contraste panel shrinks to a sliver at 1024x640 and 1366x768 at 125 % | fixed e5bcb73 |
| #176 | medium | ui-visual | Built-in themes fail the editor's CONTRAST_PAIRS; Fjord's --danger is 2.46:1 on dialogs | fixed 321fc4a |
| #177 | medium | ui-functional | Test data «Insertar» (and CSV/Excel import) reloads open tabs of the table, discarding unsaved edits | fixed 73f9106 |
| #178 | medium | drivers-open | MySQL 8: DEFAULT CURRENT_TIMESTAMP columns (DEFAULT_GENERATED) reported as identity | fixed aedb3d1 |
| #179 | medium | drivers-open | Test data on MariaDB JSON columns: plain text rejected by the implicit json_valid CHECK | fixed 8c37328 |
| #180 | medium | drivers-enterprise / connections / core-rust | Row history bypasses the connection's SSH tunnel and startup script | fixed 23699b6, 025c421 |
| #181 | medium | drivers-enterprise | Test data over ODBC to MariaDB: out-of-list ENUM values, downgraded error, success reported with 0 rows | fixed d8322d9 |
| #182 | medium | drivers-enterprise | Test data on Informix: multi-field INTERVAL columns get '1' (-1263) | fixed 3416b13 |
| #183 | medium | drivers-enterprise | Test data on SQL Server: CHECK with N'...' literals not parsed | fixed 3f9616d |
| #184 | medium | frontend-state | Test data dialog: Sets of up to 200,000 values rebuilt through the store proxy on each change (freezes, ~300 MB kept) | fixed 99565cd |
| #185 | medium | frontend-state | Test data JSON export of 1M wide rows fails with «Invalid string length» | fixed 4a1b881 |
| #186 | medium | frontend-state | Scrim mousedown or Esc during a test data insert cancels and rolls back with no confirmation (import too) | fixed 0b4b4fe |
| #187 | medium | release | STATUS.md and docs/ROADMAP.md still describe the 2.3 sprint | fixed 60af03e |
| #188 | low | ui-visual | Row history .rh-op chips and theme editor level chips below 4.5:1 on their tint | fixed 67fa6fe |
| #189 | low | ui-visual | Test data: pattern option always reads «Patrón ([A-Z]{3}-\d{4})» | fixed 3ed8a89 |
| #190 | low | ui-visual | Test data dialog: generator labels and preview cells cut off, no tooltip | fixed ba3454d |
| #191 | low | ui-visual | Row history: failure to turn full row logging back off shown only as a muted note | fixed 9a092da |
| #192 | low | ui-visual | SQLite: INTEGER PRIMARY KEY reported as nullable («NULL» badge on the key) | fixed 7af539f |
| #193 | low | ui-functional | Workspace shortcuts (Ctrl+W, Ctrl+Tab, F5…) fire behind modal dialogs | fixed 740db2c |
| #194 | low | ui-functional | Test data on Informix: all-default tables generate INSERT … DEFAULT VALUES (syntax error) | fixed 7957ce4 |
| #195 | low | ui-functional | Test data on SQL Server/Informix: existing NULL in a nullable UNIQUE column not seeded | fixed 547e20f |
| #196 | low | drivers-open | Test data: a sequence on a unique integer key can run past the type's range without warning | fixed 742b481 |
| #197 | low | drivers-open | Test data and import on MyISAM/Aria: message says nothing was inserted though rows stay | fixed 670e5b2 |
| #198 | low | drivers-open | Test data on MySQL/MariaDB BIT(n>1) and spatial columns: rejected values | fixed 639d9f5 |
| #199 | low | drivers-open | Test data on PostgreSQL domains ignores base type modifiers, NOT NULL and CHECK | fixed 9367968 |
| #200 | low | drivers-open | CHECK reader misses negative bounds as PostgreSQL and MySQL 8 store them | fixed 9606590 |
| #201 | low | drivers-open | SQLite: INTEGER PRIMARY KEY DESC treated as the rowid alias | fixed e16becb |
| #202 | low | drivers-enterprise | Row history ledger keyed by DBSERVERNAME and table only (cross-server confusion) | fixed d26d2fd |
| #203 | low | drivers-enterprise | Test data on an unrecognised ODBC engine loads the whole referenced table | fixed bbc5f8d |
| #204 | low | core-rust | Test data CSV export uses ',' and no BOM, unlike Celer's CSV export | fixed f0f2382 |
| #205 | low | core-rust | Overlapping row-history reads of one table turn full row logging off under each other | fixed 7917f2f |
| #206 | low | core-rust | Engine gate flaky: informix_jdbc_row_history CDC retry and its docker restart | fixed 81a317b |
| #207 | low | core-rust | write_text_file is a sync command on the main thread; large exports freeze every window | fixed cbdd2f3 |
| #208 | low | frontend-state | «Generar antes datos de …» resets the child table's settings | fixed 503d401 |
| #209 | low | frontend-state | Tab drag sends the console's full SQL as the card preview to every window | fixed a62acca |
| #210 | low | security | Test data script: a newline in the table name ends the «--» header comment | fixed 4f2c874 |
| #211 | low | security | Row history on a read-only Informix connection turns full row logging off on a left-over ledger entry | fixed 3808d53 |
| #212 | low | release | STATUS test inventory stale; check-all.ps1 skips 15 .ts checks and 11 .mjs scripts | fixed d8c9eb1 |
| #213 | low | release | READMEs omit 2.4's features and the Alt+1 / F6 shortcuts | fixed ce8a68e |
| #214 | low | release | docs/media screenshots show the removed explorer button and lack the Variables button | fixed f3474a5 |

Not fixed, outside these issues: with the Teal or Green accent, accent-coloured text stays below 4.5:1 in the light themes.

## Checks run

- Full engine suite `bash dev/wsl/engines.sh test` (every dev/*-check.ts, tsc, `cargo test --lib`) after the security, ui-visual, ui-functional, drivers-open, drivers-enterprise, connections and core-rust fixes: **ALL ENGINES PASS** on PostgreSQL 17, MySQL 8.4, MariaDB 11.4, SQL Server 2022, Informix DRDA, Informix JDBC, SQLite, ODBC (psqlODBC to PostgreSQL, and MariaDB Connector/ODBC to MariaDB in the new testdata_odbc_mysql run) and SSH tunnels. Last core-rust run: 280 passed, 0 failed, 1 ignored (sheets), MariaDB rerun 29 passed.
- Fast checks: all 35 dev/*-check.ts, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p installer`, `npm run build`: pass in every area. frontend-state also ran `cargo test --lib` without engines (281 passed, 1 ignored).
- Before/after reproductions: #174 on MySQL 8.4 and MariaDB 11.4 (the victim table was dropped before the fix and survives after); #210 on PostgreSQL 17 via psql; #211, #205, #202 on Informix JDBC (informix_jdbc_row_history extended); #180 through the celer-sshd bastion (ssh_tunnel_row_history) and with a broken startup script (row_history_runs_startup_script); #183 on SQL Server; #182 on Informix DRDA and JDBC; #181 on MariaDB Connector/ODBC 3.2.6; #195 on SQL Server (Msg 2627); #194 confirmed with dbaccess; #179 and #199 engine tests fail before the fix.
- New or extended engine tests: testdata_sequence_range (#196, every engine), testdata_negative_checks (#200, every engine), testdata_defaults (#194, every engine), testdata_unique_null (#195, every engine), mysql_default_generated_is_not_identity (#178), testdata_mysql_types (#179, #198), testdata_mysql_non_transactional (#197, MyISAM and Aria), testdata_pg_domains (#199, PostgreSQL and ODBC), testdata_mssql / testdata_informix / testdata_informix_jdbc (#182, #183), testdata_odbc_mysql (#181), ssh_tunnel_row_history and row_history_runs_startup_script (#180), sqlite::tests::identity_is_only_the_rowid_alias (#201), rowhistory unit tests a_running_read_holds_its_ledger_key, the_ledger_key_tells_servers_apart and the LiveClaim last-out case (#205, #211, #202), write_text_tests::writes_a_file_in_pieces (#185). informix_jdbc_row_history followed by informix_large_schema_fks now passes in sequence (#206).
- New logic checks: testdata-check (#174, #179, #181-#185 timing, #189, #194-#200, #203, #204, #208, #210), contrast-check (every built-in theme passes CONTRAST_PAIRS and the chip/error pairs, #176, #188), motion-check previewLines (#209).
- Browser preview (Vite on port 1420, demo SQLite, headless Chromium): before/after for #175, #176, #189, #190, #192 (demo copy), #177, #193, #184 (155 ms to 1 ms per change, heap back to ~145 MB), #185 (1,000,000-row JSON export in 18 s), #186, #208.
- Desktop app (Windows debug build): editor-check, result-compare-check, import-typed-check and windows-check (on a fresh workspace) pass for #212; README stills and demo.gif recaptured with dev/readme-media.mjs for #214.

## Not checked

- Desktop app (WebView2) not driven for the fixes except the release area: security, ui-visual, ui-functional, drivers, connections, core-rust and frontend-state fixes rest on engine tests, logic checks and the browser preview. Not seen in the app: the «Historial de la fila» click-through, the new test-data and import warnings and toasts, the #204 Excel/BOM output, #207 window responsiveness, a real export to disk through the new write_text_file/finish_text_file commands (#185), and the cross-window drag preview (#209).
- Engines per fix: frontend-state fixes were tested live on SQLite (demo backend) only; the other engines were not run for them (UI state and file writing; insert SQL unchanged). ui-visual and release changes do not reach a connection. Row history exists only on Informix JDBC; other engines return «unavailable» before connecting. #191's case where Celer cannot turn logging back off was not reproduced live. ImportDialog's #186 guard was not driven live.
- Generic ODBC to SQL Server, Informix or an unrecognised engine not tested in WSL (no driver); MySQL Connector/ODBC not tested (only MariaDB Connector/ODBC). Windows ODBC DSNs, Windows authentication, Azure SQL / Synapse.
- Tear-off ghost outline and window placement (#108): needs a real OS drag across native windows and monitors; code review only (Windows, WSLg/Wayland, mixed DPI, macOS).
- Live Informix CDC row-history events (full row logging, log switches, onmode -z mid-read, LO_READ timeout path): the CDC reader returned no events while celer-ifx was restarted and put in quiescent mode by other agents. Tables without a primary key, very long logs, non-UTF-8 DB_LOCALE and a non-informix user (-674) not tested.
- Test data: CSV/JSON output through the native save dialog not written and checked in the app; large «Script SQL» (20k, 1M rows) only on PostgreSQL; production confirm and read-only blocking checked in code only; Insertar/Cancelar UI flow driven live only on PostgreSQL in the visual pass.
- Theme editor (leave guard, import/export, delete), menu keyboard submenus (#110/#111), OS light/dark following, comfortable density, 150 % scaling and 1920x1080 for the new dialogs, installer UI, splash/onboarding and other screens unchanged since 2.3.
- Release gate: only CI ran on GitHub for this branch (green, run 38340769684). The Engines workflow (SQL Server, Informix) and a Release build (Windows/macOS/Linux packages, SHA256SUMS) have not run on feat/integration-2.4.0; the new windows-sys dependency is not built on macOS. Linux packages not built locally. Portable start-up, runtime-deps-check.mjs, testdata-e2e-check.mjs, layout-check.mjs and perf-probe.mjs not run. No macOS machine.
- Security: `cargo audit` not installed (`npm audit --omit=dev`: 0 vulnerabilities). #174 proven with the mysql/mariadb CLI on the generated SQL, not through the app's IPC. PostgreSQL with standard_conforming_strings=off and the unquoted Informix `${database}:` prefix not tested live. Theme import sanitiser, drag-ghost window and installer --data-dir reviewed in code only. MCP, store, updater and guard not re-audited.
- Unchanged since v2.3.0, not re-audited: cursors and paging at 1M rows, cancel during fetch, script splitting, DDL reconstruction, export round trips, SQL Server/Informix cancel/KILL/GO/TLS/named instances/DRDA ACR/bridge framing, connection UI (state dots, test step display, per-engine fields, import submenu), grid/explorer/editor performance, export/import flows, library, AI assistant, updates dialog, quit-and-restore.
- Load-induced result discarded: one informix_jdbc_engine failure (-244 lock held by another auditor's concurrent run) passed when rerun alone under the flock; one core-rust run with Informix tests run in parallel was discarded and rerun clean.
- Leftovers: s1_td_j (full row logging possibly left on) and s1_td_v in celerdemo on Informix could not be dropped (server in quiescent mode, -27002).
