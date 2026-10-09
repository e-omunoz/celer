---
name: issue-sprint
description: Celer end-to-end delivery with agents — read every open GitHub issue, implement them in parallel branches, test each one live in the app on every database engine, integrate into one branch and PR, then run a multi-agent review of the whole program focused on the latest implementations and fix what it finds. Use when the user asks to work through the issues, implement the backlog, or "implement, test and review everything"; or types /issue-sprint [issue numbers] [--no-review] [--audit-review].
---

# Celer issue sprint

Order of priorities: (1) implement the open issues completely, (2) prove each one works in the running app on
every database engine, (3) review and fix the latest implementations, (4) review the rest of the program.

Rules that hold in every step:
- **Every database type, always**: `docs/review/ENGINE_MATRIX.md` (PostgreSQL, MySQL, MariaDB, SQL Server,
  Informix DRDA and JDBC, SQLite, ODBC). A result without the engine matrix is not a test.
- **WSL for development whenever possible**: the engines run in WSL Docker; Linux build and cargo tests run in WSL
  (`dev\wsl.ps1`). Windows is for editing, the Windows build and driving the desktop app.
- **GitHub is the record**: plan comment per issue, one branch per package, one commit per issue `(#n)`, a comment per
  issue with what was done and how it was tested, one PR that closes them.
- **Merge and release on its own only as a solid product**: the owner authorised the sprint to merge its PR and publish
  a release when every gate in `docs/review/RELEASE_GATE.md` passes on the PR's head SHA. One failed or unverifiable
  gate: no merge, no release, a gate report on the PR and a summary to the user.

## 1. Preflight (inline)
1. Tools on PATH (CLAUDE.md). `gh auth status`. Working tree clean; `git fetch --all --prune`.
2. WSL: `powershell -ExecutionPolicy Bypass -File dev\wsl.ps1 status`. If the distro or toolchain is missing, run
   `dev\wsl.ps1 setup` (takes a while; tell the user). Then `dev\wsl.ps1 db up` and `dev\wsl.ps1 db seed`; confirm
   all five containers are healthy. If WSL cannot be used at all, fall back to `dev\testdb-*.ps1` + `engines.yml` on
   Actions and say clearly which engines lose live coverage.
3. One debug build of the desktop app (`dev\run-desktop.ps1`, then close) and one connection per engine of the matrix
   in `D:\celer-devdata` (create them through the app or its connections file), so testers start warm.
4. Pick names: integration branch `feat/integration-<next minor>` (`gh release list -L 1`), `since` = the previous
   release tag (`git describe --tags --abbrev=0 origin/main^`) so the review covers the latest implementations.
5. `.autocommit-pause` on (the workflow commits deliberately). `dev\review-github.ps1 -Milestone "<sprint name>"` for
   labels/milestone/tracking issue.
6. List the open issues for the user in one short table (number, title, size guess) and the agent scale
   (~3 agents per package + review ≈ 40–70 agents), then start. Ask first only if an issue needs a product decision
   that blocks it entirely.

## 2. Run
`Workflow({ name: "issue-sprint", args: { branch, base: "origin/main", since, issues?, review: true, reviewMode: "full", milestone, tracking } })`

What it does (`.claude/workflows/issue-sprint.js`):
- **Triage**: one agent reads every open issue with comments, writes acceptance criteria and the engines each must
  pass on, groups issues into packages that do not share files, comments the plan on each issue.
- **Implement**: one `celer-implementer` per package in its own git worktree and branch `issue/<slug>`, in parallel.
- **Test**: one `celer-tester` per package, taking turns on the real app + all engines; failures go to a
  `celer-fixer` and are re-tested (two rounds max).
- **Integrate**: passing branches merged into the integration branch, full checks (`dev\wsl.ps1 test`,
  `dev\check-all.ps1`), draft PR with per-issue sections, "Closes #n" and engine results.
- **Review**: runs the `macro-review` workflow on the integration branch with `since`, so every area audits the
  latest implementations first, then the rest; confirmed findings become issues and are fixed on the branch.
- **Close**: PR updated with the review and the final engine matrix; CI, Engines and a package build (Release run
  without a tag) triggered on the head.
- **Gate**: a skeptical gatekeeper checks the 8 gates of `RELEASE_GATE.md` on the head SHA — waits for the Actions
  runs, re-runs the local checks on every engine, smoke-tests the built packages — and comments the gate table on the PR.
- **Release** (only if every gate passed): merge the PR, `dev/release.sh minor|patch` from main, follow the tag's build,
  verify the published release and its files, comment and close the tracking issue and milestone.

Resume after an interruption with `resumeFromRunId`. Run only part: `issues: [..]`, `review: false`, `release: false`
(stop at the gate report), or the review alone with `/macro-review full` and `since`.

## 3. After it returns
1. Check the returned summary against GitHub (PR body, issue comments, gate comment, release page).
2. Report to the user: implemented / left out (why) / decisions needed / review results / gate result / release link
   or why it was not released.
3. Remove `.autocommit-pause`.
