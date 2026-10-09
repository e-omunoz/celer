# Changelog

All notable changes to Celer are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/lang/es/).

## [Unreleased]

### Added
- **Several windows** (desktop app):
  - **Ctrl+Shift+N** opens a new window, with its own explorer and tabs, connected to what the first one is;
  - drag a tab out of the tab bar and it opens in a new window where you drop it, or drag it onto another window's
    tab bar; the tab's menu and the palette also move it ("Mover a una ventana nueva", "Mover a la ventana 2");
  - a moved console keeps its session: same connection, open transaction, rows still to fetch and `#temp` tables;
  - the library, the AI assistant, the execution plan, the E-R diagram and the comparisons can go to a window of their
    own and come back ("Acoplar"); the library and the assistant work with the last window you used;
  - connections, library, settings, theme, shortcuts and Gib are the same in every window, and Gib lives in one of
    them at a time;
  - closing a window that is not the last asks what to do with tabs that would lose work (move them to the main
    window or discard them); "Salir de Celer" closes them all and the next start opens every window again, with its
    tabs, size, place and monitor (on another monitor if that one is gone).
- **Script library**, now useful beyond saving (Alt+8, or the book in the side bar):
  - folders and subfolders, tags and an optional connection per script; drag scripts and folders to move them;
  - search by name, folder, tag (`#tag`) and SQL; library scripts also appear in the palette;
  - open, or open and run (Ctrl+Enter), insert into the console, or drag into the editor to paste the SQL;
  - rename in place (F2), duplicate (Ctrl+D), copy the SQL, delete with undo (Del), context menu (Shift+F10);
  - a console opened from the library shows unsaved changes (dot in the toolbar and in the list); save them or drop them;
  - import `.sql` files, export a script as plain SQL, or a folder or the whole library as one `.sql` that imports back with its folders and tags;
  - sort by name or recent use, and show only the scripts of the active connection;
  - palette entries for all of the above.
- **Gib's advice about the statement you just ran**: `= NULL`, `NOT IN (SELECT …)`, comma joins without `WHERE`, and, when it was slow, `LIKE '%…'`, functions on columns in `WHERE`, `UNION` vs `UNION ALL` and `ORDER BY` without a limit. A query run again and again gets a nudge to save it in the library.
- **Connections reconnect on their own** (every engine): a session idle for more than a minute is checked with a cheap round trip before use, and every open session is checked when the computer wakes up or the network comes back.
  - With nothing to lose, the statement goes on in the new connection and the output says so; a statement that writes is never repeated (it is not known whether it ran).
  - **Never in silence with a transaction, #temp tables or `SET` of the session**: the statement does not run and the console says what was lost; a pending COMMIT fails instead of pretending it saved.
  - Transient failures when connecting (network coming back, a server starting, Azure's transient errors) are retried with a wait.
  - TCP keepalive on SQL Server, PostgreSQL and MySQL connections, so firewalls and NAT do not drop them while idle.
- **Connection state** on the explorer's connection dot and on each tab (connecting, reconnected, session lost, no connection), with the connect time in the tooltip.
- **Faster connections on every engine**:
  - a console connects in the background as soon as it opens or is shown, and its connection too when it needs no password;
  - each session starts straight in its database and transaction mode (no `USE` or extra round trips; on PostgreSQL, no second connection);
  - the connection of a closed session without state of its own is kept for a few minutes and reused by the next session with the same settings (PostgreSQL, MySQL, Informix, ODBC; SQL Server already did), and closed on disconnect;
  - fewer round trips on connect: PostgreSQL reads its database and version at once, MySQL and Informix remember the current database, the database list comes from the explorer's first level and autocompletion loads after the tree;
  - the time spent connecting shows in the output of the first statement of a console that had to connect.
- **"Probar conexión" step by step**: resolving the name, opening the port, TLS (negotiated on PostgreSQL, read from MySQL's greeting), logging in and a test query in the database, each one timed, the driver or route used and, on failure, what it means and what to do next to the driver's original error.
- **Connection form, paste a JDBC URL**: the engine and every field are filled from `jdbc:sqlserver`, `jdbc:jtds:sqlserver`, `jdbc:informix-sqli`, `jdbc:ids`, `jdbc:postgresql`, `jdbc:mysql`, `jdbc:mariadb` and `jdbc:sqlite` URLs; the URL's password is never copied, and unused properties are listed.
- **Connection form, field by field**: clear messages under each field (server, port, file, ODBC string, Informix database and INFORMIXSERVER, user, extra parameters, repeated name), with one-click fixes; errors block saving and testing. Fields an engine or option does not use are hidden, and the Informix protocol moves out of the advanced options.
- **Explorer folders**: nested folders ("Clientes/Egarsat") that can be created empty, renamed, dragged into each other and deleted (their contents move up), with undo; manual or alphabetical order.
- **Connection management in the explorer**: rename in place (F2), duplicate with the saved password (Ctrl+D), delete with undo (Delete), favourites on top (Ctrl+Shift+F) and recent connections; full context menus and keyboard shortcuts.
- **Search and quick filters** for connections by name, host, database, user, folder or engine, plus favourites, connected, production and per-engine filters (Ctrl+F).
- **Export and import connections** as a portable JSON without passwords; importing skips the connections that already exist.
- **Informix over JDBC (SQLI)**: Celer connects like DBeaver does, with IBM's JDBC driver, to servers that only listen on SQLI (`onsoctcp`, port 9088) and without the Client SDK.
  - The connection form has a new protocol, **Automático** (the default for new connections): the Client SDK when its ODBC driver is installed, JDBC otherwise. Saved connections keep their protocol.
  - Java 11 or newer is found on its own (Settings, `JAVA_HOME`, DBeaver's JRE, the `PATH`), and so is the JDBC driver (DBeaver's cache). What is missing can be downloaded, only when you ask, into Celer's data folder: Eclipse Temurin JRE 21 and the driver from Maven Central (15.0.1.4, which also reads Informix 15 servers), each checked against its SHA-256, with progress and cancel. No administrator rights are needed.
  - One Java process serves every JDBC connection; it starts while the password is asked. Results come in compact binary batches, with transactions, paging and database switching, and the same explorer, DDL, editing and scripts as the other Informix protocols.
  - Reads come in 256 KB blocks (`FET_BUF_SIZE=262144`, the fastest measured; "Parámetros extra" can change it): 200,000 rows in about 1 s, nearly three times faster than over DRDA.
  - Cancel stops the query on the server; when the server does not obey within 5 s (a proxy or firewall dropped the cancel), Celer cuts that connection and opens another one, says so if an open transaction was lost, and the other tabs are not affected.
  - "Probar conexión" says which way it connected.
- **Settings › Drivers** shows what each Informix protocol has (IBM CLI, Java and the JDBC driver, the Client SDK), with download buttons, "Usar" for DBeaver's copies and a check that starts Java.
- **Guide for Informix connections** in the app, shown instead of the raw error when a driver is missing or the server name, port or locale are wrong (`IM002`, `CLI0199E`, `SQL30081N`, -908, -761, -25596, -23101, -23197).
- **Azure Synapse dedicated SQL pool / PDW**, recognised on connect (`SERVERPROPERTY('EngineEdition')`) and named in the server description:
  - table DDL with its distribution (`HASH`, `ROUND_ROBIN`, `REPLICATE`) and storage (`CLUSTERED COLUMNSTORE INDEX` with its `ORDER`, `HEAP`, `CLUSTERED INDEX`), primary and unique keys `NOT ENFORCED`, no foreign keys;
  - execution plan through `EXPLAIN`: the distributed steps, with a warning on big data movements;
  - server activity from `sys.dm_pdw_exec_sessions` and `sys.dm_pdw_exec_requests`; "Terminar sesión" runs `KILL 'SID…'`;
  - the explorer leaves out what Synapse lacks (foreign keys, triggers, synonyms, sequences), and syntax Synapse rejects says so instead of showing the parser's raw error.
- **Fabric Warehouse / Synapse serverless**: table DDL with `IDENTITY` without seed and keys `NOT ENFORCED`.
- **SQL Server, faster connections**:
  - a console connects as soon as it opens, in the background, so the first run does not pay the login;
  - the connection of a closed session (a table, a count, a side session) is kept for a few minutes and reused by the next session with the same settings, without a new login; never one with a transaction, `#temp` tables or `SET` options of its own;
  - the database, the edition and the server description are read in a single round trip on connect, and are not asked again;
  - TDS packets of 8000 bytes (4096 before), as mssql-jdbc;
  - the output shows the time spent connecting or cutting the previous result when there was any; with `CELER_MSSQL_TRACE` set, every statement's times also go to the standard error.

### Changed
- **Releases are built entirely on GitHub Actions**, for Windows too: pushing a `vX.Y.Z` tag builds the three systems and publishes the release. `dev\release.ps1` only bumps the version, tags and pushes.
- **One file per kind, always with the same name**, so `releases/latest/download/<file>` and the README's Windows, macOS and Linux buttons always give the latest version: `Celer-Setup-Windows.exe`, `Celer-Portable-Windows.exe`, `Celer-macOS.dmg`, `Celer-Linux.deb`, `Celer-Linux.rpm`, `Celer-Portable-Linux.AppImage` and a single `SHA256SUMS.txt`. The version is in the release title, its tag and its notes.
- The Tauri NSIS installer and the MSI package are no longer published. Celer Setup covers both (also silently, for deployments); copies installed with them keep working.
- **Updates only when you ask**: Celer still checks for new versions, but downloads and runs nothing until you press *Actualizar*. The installer is downloaded to Celer's local data folder (`%LOCALAPPDATA%\es.celer.app\updates`, no longer the temp folder), it must match the release's `SHA256SUMS.txt`, it is checked again right before it runs, and it runs directly, without a command interpreter. The portable copy no longer opens Celer Setup: it opens the release page, like macOS and Linux. A downloaded update installs on close only if you chose *Al cerrar Celer*.
- **DBeaver passwords only on request**: *Importar conexiones* has the option *Importar también las contraseñas guardadas*, off by default. Only with it ticked, and when you press *Importar*, Celer reads DBeaver's encrypted `credentials-config.json`; listing the connections never opens it.
- **Uninstalling no longer starts a hidden `cmd`** to delete `uninstall.exe` after it closes. The running `uninstall.exe` stays in its folder (Windows does not let a program delete itself), the last screen says so, and the next installation removes it.
- The Windows executables carry a complete version resource (company, description, product, copyright).
- `workspace.json` moves to version 2 (one entry per window); the main window's tabs stay where older versions read
  them. Settings are saved as the keys that changed, merged by the core, so two windows never undo each other.
- Drag and drop inside Celer no longer goes through the native file drop handler.
- The library file moves to version 2 (folders and tags); version 1 files are read as they are, nothing is lost, and older Celer versions can still read the new file.
- Gib remembers the tips you have seen and shows the others first; warnings come once per session and tips at most twice. "Gib: volver a contar los consejos desde el principio" resets that.
- A tip Gib volunteers closes when you type, stays while the pointer is over it, and offers "No más consejos".
- Progress bars and the busy overlay animate with transforms only, and Gib's endless loops pause while the window is in the background.

### Fixed
- **Upgrading Celer with the installer dropped the desktop shortcut and the `.sql` association**: running a newer Celer Setup over an installation (`--silent`, or "Instalar" in the window) went back to the default options. It now keeps the current installation's shortcuts and `.sql` association; new `--no-desktop`, `--start-menu` and `--no-associate-sql` flags change them in silent mode.
- **Exporting a console result ran the script again**: after running a script (Ctrl+Shift+Enter), exporting a result re-ran every statement, writes included and without the production confirmation, and exported the first result instead of the one on show. Export now reads only the SELECT behind the result on show, and refuses a statement that writes.
- **Unsaved consoles closed without asking**: closing a console with changes not saved to its library script or its `.sql` file (Ctrl+W, the tab's ×) dropped them, and closing a window treated any console opened from a file as saved. Both now ask first.
- **JSON lost columns that share a name**: "Copiar como JSON" and the JSON export kept only one of a join's two `id` columns. Repeated names now get `_2`, `_3`… so every column is there.
- **JSON export sorted the keys alphabetically** instead of keeping the result's column order. Each object now has its keys in column order.
- **Shortcuts stopped working after the palette or a dialog**: closing the palette (Esc) or a confirmation left the focus nowhere, so Ctrl+Enter in the editor or the arrow keys in the grid did nothing until you clicked. The focus now goes back to where it was.
- **Ctrl+Shift+N in console results** did nothing: read-only grids took the key (NULL) without using it. It now opens a new window there, and sets NULL only in grids you can edit.
- **Ctrl+F5 in the explorer** did nothing, although the menu shows it for "Actualizar". It now refreshes the selected connection or folder.
- **Toasts covered the table changes bar**: a message at the bottom right hid Revertir and "Revisar y guardar" while it showed. With pending changes the messages now sit above the bar.
- **MySQL / MariaDB: a failed save was reported as saved**: when a later statement of a table save failed (a NULL in a `NOT NULL` column), the statements before it were committed and the toast said "Cambios guardados". A statement that fails now fails the whole script, so the save is rolled back and the error is shown, as on PostgreSQL.
- **Read-only connections**: a `DO` block, `EXPLAIN ANALYZE` of an `INSERT`/`UPDATE`/`DELETE` (MariaDB: `ANALYZE DELETE …`), and statements that turn the server's read-only mode off (`SET default_transaction_read_only = off`, `BEGIN READ WRITE`, `RESET ALL`, `set_config(…)`) were let through. They are now refused with "La conexión es de solo lectura".
- **Scripts lost statements in silence** (PostgreSQL, MySQL / MariaDB, SQLite, Informix, SQL Server): in `SELECT * FROM big_table; UPDATE …`, the statements after a result bigger than one page run only when that result is read to the end, and running something else first dropped them without a word. The console now says how many statements are waiting, and says so again if they were dropped. On SQL Server, where the rest of the batch is cancelled with the result when the session has nothing of its own to keep, the console says that too.
- **SQLite: manual mode went back to autocommit after the first Confirmar or Deshacer**, while the console still showed "Manual", so the next statements were saved at once and a later Deshacer undid nothing. Manual mode now opens a transaction with each statement that runs outside one, also after a `COMMIT` or `ROLLBACK` typed in the console.
- **Tables with a binary primary key** (`BINARY(16)` UUIDs, `bytea`, `BLOB`): edits and deletes in the table viewer matched no row, since the key was compared as the text `0x…`, and still said "Cambios guardados". The key is now written as a binary literal of the engine, and a save whose `UPDATE` or `DELETE` finds no row is undone with an error.
- **Export as SQL INSERT did not give back the same data**: on MySQL / MariaDB a `\` in text was read as an escape (`C:\dir\new` came back with a line break), binary columns were written as the text `'0x…'`, and PostgreSQL `NaN` / `Infinity` were written bare, which does not run. Backslashes are now doubled for MySQL, binary values are written as the engine's binary literal, and `NaN` / `Infinity` are quoted.
- **Exports cut binary values at 4 KB** (`bytea`, `BLOB`, `varbinary`), in every format and without a word. Exports now write the whole value; the grid still shows a preview.
- **Detener did not stop an export**: on a big export the cancel only reached a statement still running, so the export usually went on to the end while Celer said "Exportación cancelada". The export now stops at the next page, and Celer says it was cancelled only when it was (an export already finishing reports its rows).
- **A failed or cancelled export emptied the file it replaced**: exporting over an existing `informe.csv` truncated it at once, so an error or Detener halfway left a half file in its place. The export is now written to `informe.csv.partial` and moved over the file only when it is complete; otherwise the old file stays as it was and the partial one is removed.
- **Excel export of a big result used a lot of memory** (the whole workbook was kept in RAM) and said that Excel takes at most 1,048,575 rows only after reading every row. Rows now go to disk as they are written, and the limit is reported as soon as it is reached.
- **MySQL / MariaDB, SQLite: a result cut short after DDL**: in `CREATE TABLE x(a int); SELECT * FROM big_table`, refreshing the autocompletion closed the open result, and scrolling down then showed the rows read so far as the whole result. The autocompletion now waits until the result is read, and reading more rows from a result that was closed says so instead of ending it in silence.
- **SQLite in memory ("Memoria")**: the explorer, each console and each table tab had a database of their own, so a table created in a console was not in the explorer or in another console. All the sessions of the connection now share one in-memory database, which lasts until you disconnect.
- **SQLite**: a `CREATE INDEX`, `BEGIN` or other statement that changes no rows repeated the count of the `INSERT` before it ("3 filas afectadas"). It now says "CREATE ejecutado", as on PostgreSQL.
- **Read-only connections**: Export ran the statement under the cursor without the read-only check, so `DELETE … RETURNING` or an `INSERT … SELECT` went through. Export now refuses it like the console, and on PostgreSQL the server also enforces it (`default_transaction_read_only`).
- **Running a statement got slow after a while** with long queries in the history: once the history file passed 8 MB, it was read and rewritten on every statement. It is now cut down to about half by size, a single statement keeps at most 100,000 characters in the history, and the history is read and written off the window's thread.
- **Opening Celer twice lost changes**: a second Celer (the shortcut clicked again) kept its own copy of the connections and the workspace and wrote it over the first one's changes. Opening Celer while it runs now brings the window you used last to the front.
- **Saved connections could be wiped**: when `connections.json` could not be read at start (locked by an antivirus or a backup, damaged, or with one entry of an engine this version does not know), the explorer was empty and the next change saved that empty list over it. A locked file is now retried and never written over, a damaged one is set aside as `connections.json.unreadable-…`, entries that are not understood are kept in the file, and Celer says what happened.
- **Partial commit after a failed reconnect**: if the connection dropped with a transaction open while the server could not be reached (the explorer refreshing, the PC waking up), the transaction was forgotten, and once the network was back the next statements and the COMMIT ran on a new connection. The next statement now fails with "se han perdido la transacción abierta", and a COMMIT says its changes were not saved.
- **SQL Server named instances**: the form kept the pre-filled port 1433 when an instance was given (typed, split from `servidor\instancia` or pasted in a JDBC URL), so Celer went to 1433 instead of asking SQL Server Browser for the instance's port. With an instance and the default port, the port is now left empty; a port you type stays, and 1433 typed back next to an instance gets a warning with a «Vaciar» fix.
- "Probar conexión" marked "Inicio de sesión" failed when only the database was wrong (PostgreSQL, MySQL, SQL Server): the login is now shown as correct and "Base de datos" as the step that failed.
- **SQL Server**: a JDBC URL with a bracketed IPv6 address (`jdbc:sqlserver://[2001:db8::5]:1500;…`) silently became `localhost:1433`. The address and port are now read, and a server part Celer cannot read says the URL was not understood.
- **Informix over DRDA**: a session ended by the server (`onmode -z`, a restart, the network) was reopened by IBM's CLI driver itself, in silence, so Celer could not say what was lost with it. Celer now turns that off (`enableACR` false in a `db2dsdriver.cfg` of its own, unless you have one) and reconnects and warns as on the other engines.
- **Gib no longer gave tips**: since he learnt to swat the cursor, a click only made him grumpy, and his first proactive tip waited 15 minutes. A click gives a tip again (four clicks in a row is pestering), and the first tip comes a few minutes into the session.
- Gib swatted at the cursor while showing a tip, and his "column does not exist" hint pointed at table names.
- "Animaciones: reducidas" in Celer's settings was ignored by the start-up animation and by Gib's blinking when the system did not ask for reduced motion.
- **MySQL / MariaDB**: a connection that dropped was reopened in silence on the next statement, losing an open transaction, temporary tables and session variables without a word.
- **SQL Server**: a connection that dropped with a transaction open was replaced on the next statement and the loss only showed in the timing line.
- "Probar conexión" on a saved connection with the password left as it was ("sin cambios") tried an empty password instead of the saved one.
- **Informix**: importing a DBeaver or DbVisualizer connection keeps its `informixserver` and the other URL properties ("Parámetros extra"), and uses "Automático" instead of DRDA.
- **Informix**: an empty database no longer sends `DATABASE=;` to the driver; DRDA asks for the database before connecting.
- Driver downloads use the system's proxy (Windows Internet settings or `HTTPS_PROXY`) and can be cancelled.
- **SQL Server**: running a statement after a big result left half read (the first page of 500) no longer waits up to 3 s for the rest of it and then reconnects, losing the session:
  - a session with nothing of its own goes on at once in its reserve connection, opened in the background while the result was open (same database, startup script applied); the old one is cut with the TDS `ATTENTION` signal and closed in the background;
  - a session with an open transaction, the manual transaction mode, `#temp` tables or `SET` options of its own keeps its connection: the rest is read, with its progress next to the running time, and "Detener" is the only way to cut it (then the session is lost).
- **SQL Server: a SELECT after an UPDATE without `;` showed no grid**: in `UPDATE t SET … ` + new line + `SELECT * FROM t`, the batch went as a single DML statement, so the SELECT's rows were dropped and added to the affected count. Only a batch of one statement is run that way now.
- **Informix schema sync dropped column defaults**: the `ALTER TABLE … MODIFY` written for a column whose type or `NULL` changed left out the column's `DEFAULT`, and Informix drops what `MODIFY` does not repeat. The `DEFAULT` is now kept, and a comment warns that the column's own constraints (`UNIQUE`, `REFERENCES`, `CHECK`, a one-column `PRIMARY KEY`) must be added again.
- **SQL Server: `EXECUTE AS` could be lost or leak to another console**: after `EXECUTE AS`, `SETUSER`, `OPEN SYMMETRIC KEY` / `OPEN MASTER KEY` or a global cursor, leaving a big result half read moved the session to another connection without them, and closing the console left that connection, still as the other user, for the next session. They now count as session state: the session keeps its connection and it is never reused by another one.
- **SQL Server: the DDL of a table left things out**: `IDENTITY` was always written `(1,1)`, `CHECK` constraints, `INCLUDE` columns, index filters (`WHERE …`) and `PERSISTED` were missing, and columnstore, XML and spatial indexes came out as plain indexes, so the DDL (and schema compare for a missing table) built a different table. They are now written as the server has them.
- **Informix: the DDL of a table had no foreign or unique keys**, and wrote the primary key's columns in table order (`PRIMARY KEY (a, b)` for a key on `(b, a)`). `UNIQUE (…)` and `FOREIGN KEY (…) REFERENCES … [ON DELETE CASCADE]` are now written, and every key in its own column order.
- **Informix: a script with a routine went as one statement**: when `CREATE PROCEDURE`, `CREATE FUNCTION` or `CREATE TRIGGER` appeared anywhere in a script, even in a comment or a string, the whole script was sent at once and failed. Only the routine itself, from `CREATE PROCEDURE` to its `END PROCEDURE` (or `END FUNCTION`), is now kept whole; the rest is split on `;` as usual, so a `dbschema` output runs.
- **SQL Server: `money` and `smallmoney` lost their decimals**: `12.5` showed instead of `12.5000`, and large amounts could show a rounded last digit. They now show exact with 4 decimals, as in SSMS (up to ±450,359,962,737; beyond that the driver library has already rounded the last digit).
- **Generic ODBC: a 32-bit driver was reported as missing**: "Probar conexión" with a driver or DSN installed only in 32 bits (the Access, Excel or dBase drivers that come with Windows) said it did not exist. It now says that it is 32-bit only and Celer needs the 64-bit one, and the "architecture mismatch" error (IM014) gets the same advice.
- **Informix: `INTERVAL DAY(5) TO HOUR` showed as `INTERVAL DAY TO HOUR`** in the columns and the DDL, losing the leading field's precision. It is now written when it is not the default.
- **SQL Server: scripts with `GO` failed**: the `GO` lines of a script (as SSMS writes them with "Generar script") went to the server, which refused them, so a `CREATE VIEW` or `CREATE PROCEDURE` after another statement could not run. Each batch between `GO` lines is now sent in turn, `GO n` sends it n times, an error says "Lote 2 de 5" and stops the script, and batches waiting behind a result of more than one page are told, as on the other engines.
- **SQL Server**: a query whose server took more than 30 s to answer failed with a time-out from the driver; it now runs until it ends or is cancelled.
- **Azure Synapse dedicated SQL pool**:
  - generated `SELECT`s use `TOP` (Synapse has no `OFFSET … FETCH`);
  - `USE` and changing the database of a console or of the explorer reconnect to that database, since Synapse has no `USE`;
  - the explorer's row counts come from `sys.dm_pdw_nodes_db_partition_stats` (`sys.partitions` lacks them there), and without permission to read it the tables are listed without counts;
  - primary and unique keys `NOT ENFORCED` are also read from `sys.key_constraints`, for the DDL, the explorer and the key columns;
  - if the server refuses the manual transaction mode, the console says so and stays in automatic mode.
- **SQL Server**: the DDL of a table failed on Azure Synapse dedicated SQL pool ("Parse error … Incorrect syntax near 'FOR'", code 103010). Index and key columns are no longer joined with `FOR XML PATH`, which Synapse, PDW and Fabric lack; the explorer's "Índices" and "Claves foráneas" too. Same result on SQL Server.
- **A console could run on the connection it had before**: changing a console's connection while its session was still opening attached the old connection's session, so statements ran on the wrong server. The old session is now closed when it arrives and the console opens its own on the new connection.
- **"Volver a ejecutar" lost a selection made while it ran**: text selected in the editor during a re-run (or an assistant's "Ejecutar") was replaced by the old selection when it finished, so the next Ctrl+Enter ran the statement at the cursor instead. The selection is now left alone.
- **Changing a console's connection rolled back its transaction without asking**: picking another connection with a transaction open (or a statement running) closed the session silently. It now asks first, as closing the console does.
- **Autocompletion could describe the previous database**: choosing a big database and then right away a small one could leave the console's completion, warnings and assistant context on the big one. An answer for a database no longer on show is now dropped.
- **The status bar kept the previous tab's figures**: the selection's sum, average and counts, and the editor's Ln/Col, stayed from the tab you left. They now describe the active tab.
- **The assistant's or library's window lost a console's tables** after you went to another window and back: the window you came back to did not send its completion again. It now sends everything again when it gets the focus back.
- **Slow editor on very long scripts**: moving the cursor or typing in a multi-megabyte `.sql` re-split the whole script each time to shade the current statement. Scripts over 200 KB no longer get the shading (as with the missing-`WHERE` warning), and shorter ones split only when the text changes.
- **AI assistants (MCP) could call blocked functions by quoting their name**: `"pg_read_file"(…)`, `"pg_terminate_backend"(…)`, `` `get_lock`(…) `` or `[xp_cmdshell]` got past the list of forbidden functions, even on read-level and production connections. Quoted, bracketed and schema-qualified names are now checked like plain ones, and PostgreSQL `U&"…"` identifiers are refused.
- **Read-only connections, SQL Server**: a bare procedure call at the start of a batch (`sp_executesql N'DELETE …'`, also after a `GO`), a write after another statement without `;` (`DECLARE … IF … DELETE …`) and pass-through queries (`OPENQUERY`) were let through. A batch or statement must now start with a reading word (`SELECT`, `WITH`, `SET`, `DECLARE`, …) and contain no write. PostgreSQL `REFRESH MATERIALIZED VIEW` and `CLUSTER` are refused too.
- **Production connections did not always confirm**: on MySQL / MariaDB a `#` comment line before `DROP`, `DELETE` or `UPDATE` hid it from the "confirm dangerous changes" dialog, and `EXPLAIN ANALYZE DELETE …` (PostgreSQL; MariaDB `ANALYZE DELETE …`), which runs the DELETE, never asked. Both now ask, and the missing-`WHERE` warning sees them too.
- **A password typed into the ODBC connection string was saved in clear**: `PWD=` in the string (as its example suggested) or `password=` in "Parámetros extra" went into `connections.json` and into "Exportar conexión (sin contraseña)". It is now moved to the credential store on save (and at start for connections saved before), the export leaves it out, the form warns and offers "Mover a «Contraseña»", and the password field no longer hides when the string has one.
- **AI assistants (MCP) could read protected columns** (`password_hash` and the like, shown as `[oculto]`) through a whole row (`SELECT t FROM users t`, `row_to_json(t)`), a column alias list (`WITH s(a, b) AS (SELECT * FROM users) …`), a `UNION` under another query's column names, or on MySQL / SQL Server a column of another database. These queries are now refused on tables with protected columns, and other databases' protected columns count. The documentation now says that masking works on names and is best-effort.
- **The AI assistants' log could hide the query that ran**: it kept the first 500 characters of the SQL, so a long leading comment left the real query out. The log now keeps the SQL without its comments, and a long one keeps its first and last 2,000 characters.
- **Moving a tab with a big loaded result to another window was slow**: the result was copied twice through the app's internal store before being sent. It is now sent as it is, and a tab with more than 100,000 loaded rows says the move may take a few seconds.
- **Faint syntax and object colours in "Alto contraste claro" and Sand**: type names, parameters, punctuation and the explorer/E-R object icons kept the dark theme's pale colours, about 2:1 on white. Both themes now have their own dark values (4.5:1 or better in Alto contraste claro, 3:1 or better for Sand's icons).
- **Hard-to-read "Ejecutar" button**: its white label on the green button was 1.5:1 in "Alto contraste oscuro" and below 4.5:1 in every theme but "Alto contraste claro". The dark themes now use a black label, and Celer Claro and Sand a slightly darker green.
- **Japanese, Chinese or emoji text spilled into the next columns** of a result: cells were cut by character count, as if every character were as wide as a Latin one. Text with such characters is now measured and ends in "…" inside its own column, and the column's automatic width uses the measured width.
- **White labels on the accent and on red buttons were hard to read**: "Guardar y conectar", "Empezar" and the other main buttons were white on the default accent (3.1:1), and "Eliminar"-style buttons and the PROD tag white on red, also in both high-contrast themes. The label is now black or white, whichever reaches 4.5:1 on the chosen accent, and each theme's red has its own label colour.
- **The editor's find/replace panel was in English** ("Find", "next", "match case"…), as were its folding and go-to-line texts. They are now in Spanish.
- **Pale secondary text in Sand**: the top bar's "Nuevo", the settings navigation, the status bar and the explorer counts were at 3.7:1 and 2.3:1. Sand's secondary and faint text are now darker, 4.5:1 or better.
- **Faint text that carries information was hard to read** in Celer Claro, Celer Oscuro, Darcula and Fjord: explorer row counts, headings such as "EMPEZAR" and the hints under fields were at 2.6–3.9:1. The faint text colour now reaches 4.5:1 on the panels and surfaces in every theme.
- **The start guide's appearance step left out the high-contrast themes** its welcome card mentions. "Alto contraste oscuro" and "Alto contraste claro" are now offered there too.
- **A console with no connection was titled "console"**, in English. It is now "consola", and still takes the connection's name when you pick one.
- **The table viewer hid its ORDER BY field in narrow panes** (under 760 px, e.g. a 1024-wide window with the explorer open), so an active ordering was out of sight. The field now stays, wrapping with the rest of the toolbar.
- **The "Ventana nueva" action had a long, cut-off name** that included notes about Ctrl+Mayús+N elsewhere. It is now just "Ventana nueva", with the note as a tooltip in the action search and the shortcut settings.

## [2.0.1] - 2026-10-08

### Fixed
- **SQL Server**: closing a result before reading it all could crash the session ("no reactor running").
- **SQL Server**: text values are written as `N'…'`, so accents and other Unicode characters survive filters, edits and scripts.
- **Informix** (IBM driver on macOS and Linux): database and object names came back cut or with garbage; the driver's 32-bit lengths are now read as such.
- **Informix**:
  - foreign keys appear in the explorer ("Claves foráneas"), with their columns and the table they point to;
  - DATETIME values are written with exactly their column's fields (YEAR TO MINUTE, FRACTION(3)…), so a value from the grid can be edited, filtered and compared;
  - fractions of seconds are shown with the column's digits;
  - BOOLEAN filters and edits use `'t'` / `'f'`;
  - a script with several statements now runs all of them, not just the first: table edits, data comparison and schema comparison scripts were partly lost;
  - generated scripts no longer quote names, which Informix took as text.
- Integration tests against real SQL Server 2022 and Informix servers cover filters, edits, dates and times, MERGE, foreign-key lookup, cancel, data comparison and the startup script; execution plans and schema comparison on SQL Server.

## [2.0.0] - 2026-10-08

### Added
- **Execution plans as a tree** for every engine (Ctrl+Mayús+E, and "Analizar" to run and measure):
  - PostgreSQL and MariaDB with real rows and times;
  - MySQL, SQLite and SQL Server;
  - warnings worth acting on: big full scans, estimates far from reality, sorts spilling to disk, missing indexes suggested by SQL Server.
- **Entity-relationship diagram** of a schema:
  - tables laid out by dependency, crow's-foot relations, search;
  - hover to light a table's relations, double-click to open it;
  - export to SVG.
- **Schema comparison**: mark a schema in the explorer, then "Comparar con…" on another one (same or another connection).
  - Lists the tables that exist on only one side, and columns with another type or nullability.
  - Writes a script that makes the target match the source, in a console of the target, to review before running it.
  - Anything that would delete data stays commented out.
- **Data comparison** of two tables: mark one, then "Comparar datos con…" on the other.
  - Rows are matched by the primary key; changed cells, rows only in one table and new rows are marked (hover a changed cell for its previous value).
  - A script makes the target's rows match: INSERT and UPDATE, with the DELETEs commented out.
- **Server activity**: sessions and running queries, with cancel and kill (PostgreSQL, MySQL/MariaDB, SQL Server, Informix).
- **Compare results**: pin a result, run again and compare. Changed cells, new rows and rows that are gone are marked, matched by a key that is guessed or chosen.
- **Pinned results** that survive new runs, and a **quick filter** over the loaded rows.
- **Script library** (Biblioteca): named scripts saved in the app (Ctrl+Alt+B), to open, rename, update and delete from the side panel.
- **Configurable keyboard shortcuts** (Ajustes › Atajos de teclado):
  - record new keys, remove keys, reset one command or all;
  - conflicts offer to move the key;
  - the editor's own keys are flagged;
  - AltGr characters (€, @, #) are never taken as shortcuts.
- **Live templates** (sel, selw, ins, upd, cte, …) with linked fields, editable in Ajustes › Plantillas.
- **Query parameters** (`:name`, `?`, `${name}`) asked before running.
- **Typed cell editors** in the table viewer:
  - booleans with t / f / space or a true–false picker;
  - dates with a calendar that keeps the time and the zone;
  - foreign keys with the referenced rows to pick from, searched by key or by a name-like column.
- **Import JSON and Excel / OpenDocument** (.xlsx, .xls, .ods, with a sheet chooser), next to CSV.
- **More generated scripts**: SELECT with JOINs of the foreign keys, UPSERT / MERGE, DROP, COUNT, `:name` parameters.
- **Startup script per connection** (SET search_path, SET LOCK MODE…). It runs on every connection the driver opens, reconnects included.
- Export and copy as **XML**; the value viewer indents XML as well as JSON.
- Scripts keep their **encoding** (UTF-8, UTF-8 with BOM, UTF-16, Windows-1252) and **line endings** when saved in place (Ctrl+S, "Guardar como…" Ctrl+Mayús+S).
- Undo a pending table edit per cell or per row.
- Table tabs, console cursors, autocommit mode and files are restored with the workspace.
- **Gib** has a life of his own when you are idle:
  - yawns, goes for a coffee, codes on his laptop, dozes, juggles, reads, dances…
  - swats the cursor like a fly if you poke him while he waits;
  - follows the system's reduced-motion setting, or Ajustes › Animaciones.

### Fixed
- **Desconectar** did nothing: the session stayed in the store. It now closes every session of the connection, cancels running exports and asks first when there is an open transaction or unsaved edits.
- The start-up guide was lost when its "import from DBeaver" step opened the import assistant.
- "Actualizar" in the explorer did not reload folders already expanded below the node: a table created elsewhere did not show up.
- A DELETE or UPDATE inside a CTE (`WITH d AS (DELETE …) SELECT …`) is now warned about and confirmed in production.
- Big integers in JSON imports are kept exactly (no rounding past 2^53).
- A settings, workspace or library file that cannot be read is set aside instead of being overwritten.
- The console toolbar no longer paints over the side panel in narrow windows; side panel tabs show icons only when narrow.
- Many smaller fixes from three review passes (explain cursors and transactions, SQL Server DML plans, MySQL subqueries in plans, PostgreSQL parallel times, Informix database switching…).

## [1.3.1] - 2026-10-08

### Added
- Drag connections between folders in the explorer (drop on a folder, on another connection to place it
  before it, or on "Sin carpeta" to take it out of its folder).

### Fixed
- The folder selector in a connection's properties only listed the current folder. It now lists every folder,
  "Sin carpeta" and "Nueva carpeta…".
- The guided tour's highlight ring was cut off at the window edges; it is now drawn inside the element.

### Changed
- New README (English and Spanish) with a screenshot gallery, and a social preview image for the repository.

## [1.3.0] - 2026-10-08

### Added
- **Import connections from DBeaver and DbVisualizer** ("Nuevo" menu, command palette or the start-up guide).
  - Shows a checklist of what was found and maps each driver to Celer's.
  - Flags connections that already exist and lists unsupported drivers explicitly.
  - Keeps folders, production flags and SQL Server instances.
  - Optionally imports DBeaver's saved passwords into the OS credential store.
  - Never modifies the source tools.
- **Ctrl+click / F4 / Ctrl+B on a table name** (or an alias) in the SQL opens the table. Holding Ctrl underlines it like a link.
- **Foreign keys you can follow**:
  - Ctrl+click on an FK value (or "Ir a la fila referenciada") opens the referenced row;
  - FK columns are marked with ↗ in the header;
  - the "Claves" tab opens the referenced table.
- Gib is sad while being uninstalled (and a tear falls).

### Fixed
- Completion offered only keywords and functions before a console's first run, and never unqualified
  columns. It now uses the real catalog from the moment the connection opens, with context:
  - tables after FROM/JOIN/UPDATE/INTO;
  - the statement's columns (with their table or alias) everywhere else;
  - alias./table. → columns, schema. → tables.
- Gib lost his shirt, sleeves and fur when another Gib was hidden in an inactive tab (shared SVG ids).
  His left arm is now drawn in front of the torso.
- Gib at the laptop (busy) was redrawn:
  - real arms and a big laptop;
  - a focused face instead of a cross one;
  - typing animation with a glint on the glasses.
- The start-up tour's bubble could be cut at the window edges, and the last step cropped Gib.
  The bubble now uses its real height and always fits; the spotlight covers Gib entirely.
- "1 filas" → "1 fila".

### Changed
- Dependencies: ureq 3 (update checks and driver downloads), sha2 0.11, mysql 26.
- macOS and Linux packages are built on demand (manual workflow) instead of on every release.

## [1.2.0] - 2026-10-08

### Added
- Busy overlay with Gib over the grid for long operations. It shows live progress and has **Cancelar**:
  - "Cargar todo" stops after the chunk in flight and keeps the rows loaded so far;
  - server reloads with filters or sorting are cancelled on the server.
- WHERE box help in the table viewer:
  - warns while you type when `"text"` would be read as a column name (PostgreSQL, SQL Server, Informix), with a one-click fix to `'text'`;
  - suggests `'%text%'` for `LIKE` without wildcards;
  - points engine errors at the right spot of your WHERE instead of the generated query.

### Fixed
- The window froze with 100k+ rows loaded: select all, copy, column selection and search did quadratic work
  (`unwrap` walked every row on each call). With 200k rows, select all now takes ~40 ms and copying ~250 ms.
- Local sorting of big console results is several times faster (sort keys are computed once).
- Release notes in the update dialog: wrapped list items were shown as loose paragraphs.

## [1.1.0] - 2026-10-07

### Added
- Native **PostgreSQL** driver: server-side cursors for paging, cancellation, manual/auto transactions,
  multi-database tree, full DDL reconstruction, dollar-quote aware splitter, error positions.
- Native **MySQL / MariaDB** driver: streaming reader with bounded memory, `KILL QUERY` cancellation,
  `DELIMITER`-aware splitter, TLS modes, `SHOW CREATE` DDL.
- Redesigned interface (warm palette, dense and quiet layout) with 8 themes, virtualised explorer, command
  palette, inspector (value, record, history), Output log, toasts and context menus.
- Custom window frame with Windows 11-style caption buttons in the theme's colours.
- **Gib**: startup splash (thinks → idea → hops to the status bar), reactions to queries, errors, connections and
  commits, contextual tips learned from use.
- **Start-up guide**: appearance, first connection or a sample SQLite database, an interactive spotlight tour of the
  interface and the essential shortcuts.
- Table viewer: per-column filter chips (incl. value checklists), server-side sorting, exact row count.
- Export to CSV, TSV, Excel, JSON, SQL INSERT (batched), Markdown and HTML with progress, cancel and
  "show in folder"; import from CSV/TSV with column mapping in a single transaction.
- **AI**: in-app SQL assistant with Claude (schema only, never row data; key in the OS credential store) and an
  **MCP server** (`celer.exe --mcp`) with per-connection permission levels, row limits, sensitive-column masking
  and an audit log.
- Official engine logos (PostgreSQL, MySQL, MariaDB, SQLite) and a redesigned app logo and icon.
- **Celer Setup**: a custom installer and uninstaller in the app's style (per-user, no admin), with a silent mode.
- **Automatic updates**: Celer looks for new releases on start-up, shows what's new and updates itself in one click.
  - The download is verified against the release's SHA-256 sums.
  - The installer keeps your options and reopens Celer.
  - Closing Celer with an update downloaded installs it quietly.
- Gib has articulated arms and full-body animations: hand on chin while thinking, finger up on an idea, a real wave.
- End-to-end test harness over CDP (`dev/e2e.mjs`) and live database integration tests.

### Fixed
- Desktop sessions could not open (Tauri 2 expects camelCase command arguments).
- Ctrl+Enter right after `;` ran the next statement; the formatter swallowed code after `--` comments.
- Manual transaction mode was lost after a reconnect; read-only connections could be bypassed with a batch.
- Saving table edits is now atomic; LIKE filters escape `%`/`_`; MySQL backslashes and dialect quoting.
- F5 no longer reloads the window; closing asks about open transactions and unsaved edits.
- Load-all of 200k rows went from 23 s to 1.3 s with an eighth of the memory.

## [1.0.0] - 2026-09-30

### Added
- Phase 1 client: SQL Server, Informix, SQLite and ODBC drivers, CodeMirror editor, canvas grid, table viewer,
  export, history and themes.

[Unreleased]: https://github.com/e-omunoz/celer/compare/v2.0.1...HEAD
[2.0.1]: https://github.com/e-omunoz/celer/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/e-omunoz/celer/compare/v1.3.1...v2.0.0
[1.3.1]: https://github.com/e-omunoz/celer/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/e-omunoz/celer/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/e-omunoz/celer/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/e-omunoz/celer/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/e-omunoz/celer/releases/tag/v1.0.0
