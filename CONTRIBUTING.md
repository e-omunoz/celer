# Contributing to Celer

Thanks for helping make Celer better. This guide covers the workflow, the conventions and how to check your change.

## Before you start

- **Bugs:** open an issue with the *Bug report* template. Include the Celer version (Settings → About), the database
  engine and version, and the steps to reproduce.
- **Ideas:** open a *Feature request* first so we can agree on the shape before you write code.
- **Security problems:** do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Setup

You need [Rust](https://rustup.rs) (stable) and [Node.js](https://nodejs.org) 20+. On Windows you also need the Visual
Studio Build Tools with the C++ workload. A JDK 11+ (`JAVA_HOME` or `javac` in the `PATH`) compiles the JDBC bridge
(`src-tauri/bridge`): without one, debug builds leave it out and Informix over JDBC says so; release builds need it.

```bash
npm install
npm run tauri dev        # desktop app with hot reload
npm run dev              # the same UI in a browser, against an in-memory SQLite demo
```

Test databases with sample data:

```powershell
powershell -File dev\testdb-postgres.ps1   # portable PostgreSQL on port 54329 (celer / celer)
powershell -File dev\testdb-mysql.ps1      # MariaDB on port 33069
```

The SQL Server and Informix containers are listed in [docs/DRIVERS.md](docs/DRIVERS.md#test-environments).

## Checks

Run these before you open a pull request:

```bash
npx tsc --noEmit -p .              # app types
npx tsc --noEmit -p installer      # installer UI types
cd src-tauri && cargo test --lib   # Rust unit tests
```

End-to-end checks drive the real desktop app through the DevTools protocol:

```powershell
powershell -File dev\run-desktop.ps1     # builds and starts Celer with DevTools on port 9333
node dev/e2e.mjs
```

CI runs the type checks and the Rust tests on every push and pull request.

## Conventions

- **Design first.** Read [docs/DESIGN.md](docs/DESIGN.md):
  - Colours, spacing and motion come from tokens.
  - Every feature works from the keyboard.
  - The interface text is Spanish, friendly and short.
- **Performance is a feature.** Don't block the UI thread or copy result sets you don't need. Keep the grid on canvas.
  If a change touches a hot path, include before/after timings in the pull request.
- **Security.**
  - Secrets go to the OS credential store, never to files or logs.
  - Writes respect read-only and production connections.
  - AI features never send row data without the user's explicit permission.
- **Code style.** Match the surrounding code. TypeScript is strict. Rust has no `unwrap()` on user-reachable paths.
  Comment the *why*, not the *what*.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org): `feat(grid): …`, `fix(mysql): …`,
  `docs: …`, `chore: …`. Keep each commit focused.
- **Changelog.** Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.

## Releases

Versions follow [Semantic Versioning](https://semver.org):

- **patch:** fixes;
- **minor:** new features;
- **major:** incompatible changes to saved data or the MCP interface.

The maintainer publishes a release with one command:

```powershell
powershell -ExecutionPolicy Bypass -File dev\release.ps1 -Bump minor   # or -Version 1.2.0, -Draft, -NoPublish
```

The script then:

1. Bumps the version everywhere.
2. Moves the *Unreleased* notes into the new version.
3. Runs the checks.
4. Builds the app, the NSIS installer, the portable `.exe` and Celer Setup.
5. Tags `vX.Y.Z` and publishes a GitHub Release with the files and their SHA-256 sums.

Installed copies of Celer find the new release on their own.

## README media

The screenshots and the demo GIF in `docs/media` are produced by a script, so they always match the current interface:

```powershell
powershell -File dev\testdb-postgres.ps1
powershell -File dev\run-desktop.ps1 -NoBuild
node dev/readme-media.mjs docs/media
```

The banner (`docs/media/banner.svg`) is a hand-written animated SVG. `node dev/render-svg.mjs` renders it at given
times so you can review the animation frame by frame.
