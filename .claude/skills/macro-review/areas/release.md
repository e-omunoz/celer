# Area: release, packaging and docs

Code: `.github/workflows/*.yml`, `dev/release.ps1`, `installer/`, `src-tauri/tauri.conf.json`, `Cargo.toml` files,
`package.json`; docs `README.md`, `README.es.md`, `docs/GUIA.md`, `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`,
`STATUS.md`.

## Check
- Latest runs: `gh run list -L 20`; read failures and warnings (deprecated actions, Node versions, cache misses).
- Release workflow: version check covers every manifest; expected file list matches what each OS builds; notes taken
  from the right CHANGELOG section; publish only after all assets exist; fixed names match README buttons and the
  in-app updater (`src-tauri/src/update.rs`, `src/update.ts`).
- Download the latest `celer-release` artifact of the last green run (`gh run download`) into `review-out/release/`
  and check: SHA256SUMS matches, Windows `.exe` version info, installer runs per user without admin (do not install
  over the user's copy — use the portable exe and read the installer code instead).
- Startup of the portable build: no console window, no missing DLLs (`dev/runtime-deps-check.mjs`), WebView2 absent.
- Docs vs behaviour: every shortcut, menu name and setting mentioned in GUIA/README exists with that exact Spanish
  label; screenshots in `docs/media` not outdated; broken links (relative and to releases).
- CHANGELOG `[Unreleased]` complete for what is on the branch since the last tag (`git log v2.0.1..HEAD`).
- CI covers the new checks (`dev/*-check.ts` all run in `ci.yml`).
