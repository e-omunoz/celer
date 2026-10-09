# Release gate: when the agents merge and publish on their own

The owner authorises `/issue-sprint` (and `/macro-review` when asked to release) to **merge its PR into `main` and
publish a release without asking**, but only when every gate below passes on the exact commit being merged. One failed
or unverifiable gate = no merge, no release: the PR stays a draft with a gate report, and the user decides.
"Probably fine" is a failure. Evidence comes from runs on the PR's head SHA, not from earlier commits.

## Gates
| # | Gate | Evidence |
|---|---|---|
| 1 | Every issue the PR closes passed its acceptance criteria with the independent tester, on every applicable engine of `ENGINE_MATRIX.md`, in the latest test round | tester results per issue and engine |
| 2 | The macro review ran on this branch and its final verification is green | review summary, `verify.green` |
| 3 | No open issue labelled `review` with `sev:critical` or `sev:high`; anything deferred is medium/low with a written reason | `gh issue list --label review --state open` |
| 4 | Local checks green on the head SHA: logic checks, typecheck, `npm run build`, cargo tests against **every engine** (`dev/wsl/engines.sh test`), and the end-to-end suite on the Windows desktop app (`dev\check-all.ps1`) | command output |
| 5 | GitHub Actions green on the head SHA: `CI`, `Engines (SQL Server, Informix)` and a manual `Release` run (builds Windows, macOS and Linux packages) | `gh run list --commit <sha>` |
| 6 | Smoke test of the packages that run built: `SHA256SUMS.txt` matches; the Windows portable exe from the artifact starts, connects to every engine and runs a query; the installer installs per user into a throw-away folder and starts | tester report with screenshots |
| 7 | The PR is mergeable without conflicts, `CHANGELOG.md` `[Unreleased]` describes every user-visible change, `docs/GUIA.md` and READMEs match the behaviour | `gh pr view`, diff review |
| 8 | No open product decision on a merged issue (anything ambiguous was settled in the issue thread, not guessed) | triage `decision_needed` list |

## Procedure when all gates pass
1. Comment the gate table with its evidence on the PR ("Release gate: passed").
2. `gh pr ready <n>` and `gh pr merge <n> --merge` (merge commit, like the other integration PRs). Bring `main` up to date
   locally (`git switch main && git pull --ff-only origin main`).
3. Version: `minor` when the release contains any feature or enhancement, `patch` when only fixes. Never `major`
   automatically.
4. Release from up-to-date `main`: `bash dev/release.sh <bump>` in WSL (or `dev\release.ps1 -Bump <bump>` on Windows).
5. Follow the tag's `Release` run to the end (`gh run watch <id> --exit-status`). Then check the published release:
   title "Celer X.Y.Z", notes from the CHANGELOG, the seven files (`Celer-Setup-Windows.exe`, `Celer-Portable-Windows.exe`,
   `Celer-macOS.dmg`, `Celer-Linux.deb`, `Celer-Linux.rpm`, `Celer-Portable-Linux.AppImage`, `SHA256SUMS.txt`), and that
   `releases/latest/download/SHA256SUMS.txt` serves the new one.
6. Comment the release link on the tracking issue and on every closed issue's thread; close the tracking issue and the
   sprint milestone.

## When something fails after the merge
If the tag's `Release` run fails: do not delete or move the tag and do not retry blindly. Read the log, fix the cause on a
branch through a PR (same gates for what it touches), and publish a new `patch` release. Report it to the user.
