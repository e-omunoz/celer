---
name: macro-review
description: Full pre-release macro review of Celer with agents — visual bugs, interface behaviour, drivers, connections, Rust core, security, packaging — filed as GitHub issues, fixed on a review branch and re-verified, ending in a PR. Use when the user asks for a macro review / full audit / polish pass, or types /macro-review [audit|full] [area ...].
---

# Celer macro review

Arguments: `audit` (find and file only) or `full` (default: also fix and verify), then optional area keys:
`ui-visual ui-functional drivers-open drivers-enterprise connections core-rust frontend-state security release`.
Area checklists: `areas/<key>.md`. Agent roles: `.claude/agents/celer-{auditor,verifier,fixer}.md`.
Process and ledger: `docs/review/README.md`.

## 1. Preflight (inline, before any agent)
1. PATH for the portable tools (see CLAUDE.md). `gh auth status` must be logged in.
2. Branch: work on `review/<version>-<n>` cut from the newest green code (usually `origin/main`, or the integration
   branch if it is ahead and green: `gh run list -L 10`). Never on `main`.
3. Create `.autocommit-pause` so the Stop hook does not push half-done work; remove it at the end.
4. GitHub ledger: `powershell -ExecutionPolicy Bypass -File dev\review-github.ps1 -Milestone "<name>"`. It creates the
   labels and milestone if missing and prints the tracking issue number (creates one if none is open).
5. Baseline: `npx tsc --noEmit -p .`, the `dev/*-check.ts` checks and `cargo test --lib`. Note any failure that
   already exists; it becomes a finding, not a fixer surprise.
6. Test servers when available: `dev\testdb-postgres.ps1 start`, `dev\testdb-mysql.ps1 start`. Trigger the remote
   engines run for SQL Server/Informix on the branch so the auditor has fresh logs:
   `gh workflow run engines.yml --ref <branch>`.
7. Build the debug desktop app once (`dev\run-desktop.ps1`, then close it) so UI auditors start warm.

## 2. Run the workflow
`Workflow({ name: "macro-review", args: { mode, areas, base: "origin/main", milestone, tracking } })`.
It runs ~20–30 agents: the user opted in by invoking this skill; tell them the scale in one line before starting.
Visual and interface areas run one after another (shared app and browser pane); the rest in parallel.
To re-run after changing the script, resume with `resumeFromRunId`.

## 3. After it returns
1. Read the summary; spot-check two fixed issues by reading their commits.
2. Push the branch (`git push -u origin <branch>`), then `gh workflow run ci.yml --ref <branch>` and, when drivers
   or connections changed, `engines.yml`; for a full package build `release-desktop.yml` (artifacts only).
3. Open the PR to `main`: title "Macro review <date>", body = report section + "Fixes #n" line per fixed issue.
   Bind it with the ccd_pr tools and offer Auto-fix for CI.
4. Remove `.autocommit-pause`. Leave deferred issues open with `review:deferred`.
5. Release (only with the user's explicit OK after merge): `dev\release.ps1 -Bump patch|minor`.
