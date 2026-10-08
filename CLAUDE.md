# Celer — notes for Claude

Desktop SQL client: Tauri 2 + Rust core (`src-tauri/src`) + SolidJS UI (`src`). Installer in `installer/`.
Status and feature list: `STATUS.md`; design: `docs/ARCHITECTURE.md`, `docs/DESIGN.md`, `docs/DRIVERS.md`; user guide (Spanish): `docs/GUIA.md`.

## Tools on this machine
- git, gh and node are portable, not on PATH. Start shell commands with:
  `$env:PATH = "$env:LOCALAPPDATA\celer-tools\git\cmd;$env:LOCALAPPDATA\celer-tools\gh\bin;$env:LOCALAPPDATA\celer-tools\node-v22.20.0-win-x64;$env:USERPROFILE\.cargo\bin;$env:PATH"`
- Cargo builds go to `$env:CARGO_TARGET_DIR = "D:\celer-target"` (the scripts set it).
- Java 21 is needed for the JDBC bridge (`src-tauri/bridge`, compiled by `build.rs`).

## Local testing: everything is allowed
This is the owner's own Windows development machine, and testing here is fully authorised. Do whatever a check
needs, without asking:
- Start, stop, seed and reset local database servers: `dev\testdb-postgres.ps1` (port 54329) and `dev\testdb-mysql.ps1`
  (MariaDB, port 33069) under `C:\Users\oscar\celer-testdb`. You may install more (SQL Server Express/Developer via
  winget, Docker or containers in WSL for SQL Server/Informix, ODBC drivers) when a check needs them.
- Build and launch the desktop app (`dev\run-desktop.ps1`, own data folder `D:\celer-devdata`, `-Fresh` for a first
  run), the browser preview (`celer-web`), the installer UI (`celer-setup`) and the portable release builds.
- Look at it and drive it: screenshots, clicks and typing in the browser pane, DevTools on port 9333 via
  `dev/cdp-lib.mjs`, computer use on the real window, several windows, dialogs, kill and restart servers mid-session to
  test reconnection.
- Create, change or delete test data, test connections and files under the dev data folders and `review-out/`.
Limits: do not touch the installed Celer's data (`%APPDATA%\es.celer.app`) except to copy from it, and do not use
real/production database servers.

## Checks
- Fast (no app, no DB): `node --experimental-strip-types --no-warnings dev/<name>-check.ts` for each `dev/*-check.ts`; `npx tsc --noEmit -p .`; `npx tsc --noEmit -p installer`; `npm run build`.
- Rust: `cargo test --lib` in `src-tauri` (live PostgreSQL/MariaDB tests need `CELER_PG_TEST` / `CELER_MYSQL_TEST`; servers: `dev/testdb-postgres.ps1`, `dev/testdb-mysql.ps1`).
- Everything incl. end-to-end against the desktop app: `powershell -ExecutionPolicy Bypass -File dev\check-all.ps1` (debug build, data in `D:\celer-devdata`, DevTools on port 9333 driven by `dev/cdp-lib.mjs`).
- SQL Server and Informix run only on GitHub Actions: `gh workflow run engines.yml --ref <branch>`.
- Browser preview of the UI with the in-memory SQLite demo backend (`src/demo.ts`): launch config `celer-web` (port 1420).

## Conventions
- UI text is Spanish; code, comments, commit messages and docs (except GUIA/README.es) are English.
- Commit subjects are plain descriptive sentences ("Area: what changed and why it matters"), no conventional-commit prefix except `chore(release)` / `chore(auto)`.
- Add user-visible changes to `CHANGELOG.md` under `## [Unreleased]`.
- Match the surrounding code: comment density, naming, Solid signals/stores, Rust error types.

## Git and releases
- `main` is the release branch. Work goes on a branch and reaches `main` by PR.
- The Stop hook runs `dev/autocommit.ps1`, which commits **and pushes the current branch**. Create `.autocommit-pause` (gitignored) to hold it while work is half done; never leave work-in-progress on `main`.
- Releases: `dev/release.ps1 -Bump patch|minor|major` bumps every manifest, moves the Unreleased notes, tags `vX.Y.Z` and pushes; the tag runs `.github/workflows/release-desktop.yml`, which publishes. A manual run of that workflow only builds artifacts. Releasing needs the user's explicit go-ahead.

## Macro review
`/macro-review` (`.claude/skills/macro-review/`) runs the multi-agent audit-and-fix pass; ledger and rules in `docs/review/README.md`.
