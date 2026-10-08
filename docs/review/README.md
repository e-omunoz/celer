# Macro review

A pre-release pass in which several Claude Code agents audit Celer area by area, a skeptic agent challenges every
finding, the confirmed ones become GitHub issues, fixers correct them on a review branch, and the branch is verified
again before a PR to `main`.

## Pieces
| Piece | Where |
|---|---|
| Entry point (`/macro-review [audit\|full] [areas…]`) | `.claude/skills/macro-review/SKILL.md` |
| Area checklists | `.claude/skills/macro-review/areas/*.md` |
| Agent roles | `.claude/agents/celer-auditor.md`, `celer-verifier.md`, `celer-fixer.md` |
| Orchestration | `.claude/workflows/macro-review.js` |
| GitHub labels, milestone, tracking issue | `dev/review-github.ps1` |
| Reports | `docs/review/REPORT.md` |
| Screenshots and scratch output (not committed) | `review-out/` |

## Areas
`ui-visual`, `ui-functional`, `drivers-open` (PostgreSQL, MySQL/MariaDB, SQLite), `drivers-enterprise` (SQL Server,
Informix, ODBC/JDBC), `connections`, `core-rust`, `frontend-state`, `security`, `release`.

## Record on GitHub
- One issue per finding: labels `review`, `area:*`, `sev:*`, `kind:*`, the review milestone, and a body with what
  happens, expected, steps, evidence (`file#Lline`, screenshots) and a fix hint.
- One tracking issue per review with a checklist of all findings.
- One commit per fix, `"<Area>: <what changed> (#<issue>)"`, on `review/<version>-<n>`.
- One PR to `main` whose body lists `Fixes #n` for every fixed issue, so merging closes them.
- Findings not fixed in this pass keep `review:deferred` with a comment saying why.

## Severity
`critical` data loss, security or crash on a common path · `high` main feature wrong or unusable ·
`medium` real defect with a workaround or a less common path · `low` cosmetic or rare.
