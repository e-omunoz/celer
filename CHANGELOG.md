# Changelog

All notable changes to Celer are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/lang/es/).

## [Unreleased]

### Fixed
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

[Unreleased]: https://github.com/e-omunoz/celer/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/e-omunoz/celer/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/e-omunoz/celer/releases/tag/v1.0.0
