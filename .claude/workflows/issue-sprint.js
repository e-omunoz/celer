export const meta = {
  name: 'issue-sprint',
  description: 'Celer: read every open GitHub issue, implement them in parallel branches, test each live on every database engine, integrate, macro-review the latest work and fix it, then merge and release if every release gate passes',
  whenToUse: 'To turn the open GitHub issues into a tested integration branch and PR, followed by a review focused on the latest implementations. Run through the /issue-sprint skill (it does the preflight).',
  phases: [
    { title: 'Triage', detail: 'read all open issues, acceptance criteria, independent packages' },
    { title: 'Implement', detail: 'one implementer per package, each in its own worktree and branch' },
    { title: 'Test', detail: 'independent tester per package, live app + every engine, fix loop' },
    { title: 'Integrate', detail: 'merge passing branches, full checks, PR' },
    { title: 'Review', detail: 'macro review focused on the latest implementations, fixes on the integration branch' },
    { title: 'Close', detail: 'PR and issues updated with results, CI and package builds on the head' },
    { title: 'Gate', detail: 'docs/review/RELEASE_GATE.md checked on the head SHA by a skeptic' },
    { title: 'Release', detail: 'merge, tag, publish and verify the release (only when every gate passed)' },
  ],
}

// args: { branch: 'feat/integration-x.y' (required), base?: 'origin/main', since?: '<ref of the previous release>',
//         issues?: number[], review?: boolean (default true), reviewMode?: 'audit' | 'full', milestone?: string, tracking?: number,
//         release?: boolean (default true: merge and publish when every gate in docs/review/RELEASE_GATE.md passes) }
const A = args || {}
if (!A.branch) throw new Error('args.branch (the integration branch name) is required')
const BRANCH = A.branch
const BASE = A.base || 'origin/main'
const SINCE = A.since || BASE
const REVIEW = A.review !== false
const RELEASE = A.release !== false
const ROLE = role => `Read and follow your role file \`.claude/agents/${role}.md\`, the project notes in \`CLAUDE.md\` and the engine rule in \`docs/review/ENGINE_MATRIX.md\` (every engine, always).`

// The desktop app, the browser pane and the main checkout are single resources: testing and fixing take turns.
let lock = Promise.resolve()
function exclusive(fn) {
  const run = lock.then(fn, fn)
  lock = run.then(() => {}, () => {})
  return run
}

const TRIAGE = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' },
          title: { type: 'string' },
          kind: { type: 'string', enum: ['bug', 'feature', 'ux', 'visual', 'performance', 'security', 'docs'] },
          size: { type: 'string', enum: ['S', 'M', 'L'] },
          acceptance: { type: 'array', items: { type: 'string' }, description: 'Testable criteria; the definition of done' },
          engines: { type: 'array', items: { type: 'string' }, description: 'Engines from ENGINE_MATRIX.md the criteria must be tested on' },
          files: { type: 'array', items: { type: 'string' } },
          depends_on: { type: 'array', items: { type: 'integer' } },
          decision_needed: { type: 'string', description: 'Product decision the issue does not settle, or ""' },
        },
        required: ['number', 'title', 'kind', 'size', 'acceptance', 'engines', 'files', 'depends_on', 'decision_needed'],
      },
    },
    packages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'kebab-case, used in the branch name issue/<slug>' },
          issues: { type: 'array', items: { type: 'integer' } },
          rationale: { type: 'string' },
        },
        required: ['slug', 'issues', 'rationale'],
      },
    },
    skipped: { type: 'array', items: { type: 'object', properties: { number: { type: 'integer' }, reason: { type: 'string' } }, required: ['number', 'reason'] } },
  },
  required: ['issues', 'packages', 'skipped'],
}
const IMPLEMENTED = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    done: { type: 'array', items: { type: 'object', properties: { issue: { type: 'integer' }, commits: { type: 'array', items: { type: 'string' } } }, required: ['issue', 'commits'] } },
    blocked: { type: 'array', items: { type: 'object', properties: { issue: { type: 'integer' }, reason: { type: 'string' } }, required: ['issue', 'reason'] } },
    checks: { type: 'array', items: { type: 'string' } },
  },
  required: ['branch', 'done', 'blocked', 'checks'],
}
const TESTED = {
  type: 'object',
  properties: {
    pass: { type: 'boolean', description: 'Every criterion passes on every applicable engine, no regression' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue: { type: 'integer' },
          criterion: { type: 'string' },
          pass: { type: 'boolean' },
          engines: { type: 'string', description: 'e.g. "PG ✅ MySQL ✅ MariaDB ✅ MSSQL ❌ IFX-DRDA ✅ IFX-JDBC ✅ SQLite ✅ ODBC n/a"' },
          evidence: { type: 'string' },
        },
        required: ['issue', 'criterion', 'pass', 'engines', 'evidence'],
      },
    },
    regressions: { type: 'array', items: { type: 'string' } },
  },
  required: ['pass', 'results', 'regressions'],
}

// ---------------------------------------------------------------- Triage
phase('Triage')
const only = A.issues && A.issues.length ? `Only these issues: ${A.issues.map(n => '#' + n).join(', ')}.` : 'Every open issue except tracking issues (title starting "Macro review tracking"); include review:deferred ones.'
const triage = await agent(`${ROLE('celer-implementer')} For this step you only plan; you change no code.

Read the open GitHub issues of e-omunoz/celer with their comments (\`gh issue list --state open -L 200\`, \`gh issue view <n> --comments\`). ${only}
For each: kind, size, testable acceptance criteria (what a tester will check in the running app), the engines from ENGINE_MATRIX.md they must pass on (all of them whenever a connection is involved), the files likely touched, dependencies, and any product decision the issue leaves open.
Group issues into packages that can be built in parallel without touching the same files (dependent or file-sharing issues go together; keep packages balanced, at most ~4 issues each).
Skip an issue only if it is already done on ${BASE} (say where) or blocked by an open decision.
Post one comment per planned issue with its acceptance criteria and package ("Plan for the issue sprint: …"), so GitHub keeps the record.`,
  { label: 'triage', phase: 'Triage', schema: TRIAGE })
if (!triage) throw new Error('triage failed')
const decisions = triage.issues.filter(i => i.decision_needed)
if (decisions.length) log(`Open decisions (implemented as far as unambiguous): ${decisions.map(i => `#${i.number}`).join(', ')}`)
if (triage.skipped.length) log(`Skipped: ${triage.skipped.map(s => `#${s.number} (${s.reason})`).join('; ')}`)
const issueInfo = new Map(triage.issues.map(i => [i.number, i]))
log(`${triage.issues.length} issues in ${triage.packages.length} packages`)

// ---------------------------------------------------------------- Implement → Test (pipeline; tests take turns)
const testPrompt = (pkg, branch) => `${ROLE('celer-tester')}

Branch: \`${branch}\` (package ${pkg.slug}). Test these issues against their acceptance criteria, on every listed engine:
${JSON.stringify(pkg.issues.map(n => issueInfo.get(n)).filter(Boolean).map(i => ({ issue: i.number, title: i.title, acceptance: i.acceptance, engines: i.engines })), null, 1)}`

const results = await pipeline(
  triage.packages,
  pkg => agent(`${ROLE('celer-implementer')}

Create branch \`issue/${pkg.slug}\` from \`${BASE}\` in this worktree and implement package "${pkg.slug}" (${pkg.rationale}).
When done and pushed, run \`git switch --detach\` so the branch is free for the tester to check out in the main checkout.
Use your own cargo target dir (\`$env:CARGO_TARGET_DIR = "D:\\celer-target-${pkg.slug}"\`) so parallel builds do not block each other.
${JSON.stringify(pkg.issues.map(n => issueInfo.get(n)).filter(Boolean), null, 1)}`,
    { label: `implement:${pkg.slug}`, phase: 'Implement', schema: IMPLEMENTED, isolation: 'worktree' }),

  (impl, pkg) => exclusive(async () => {
    if (!impl || !impl.done.length) return { pkg, impl, test: null }
    const branch = impl.branch || `issue/${pkg.slug}`
    let test = await agent(testPrompt(pkg, branch), { label: `test:${pkg.slug}`, phase: 'Test', schema: TESTED })
    for (let round = 1; test && !test.pass && round <= 2; round++) {
      log(`${pkg.slug}: ${test.results.filter(r => !r.pass).length} failing criteria, ${test.regressions.length} regressions — fix round ${round}`)
      await agent(`${ROLE('celer-fixer')}

You are on branch \`${branch}\` in the main checkout (\`git switch ${branch}\`). The independent tester found these failures; fix every one (commit per cause, "(#<issue>)" in the message), re-run the checks and \`dev\\wsl.ps1 test -Ref HEAD\`, push the branch.
${JSON.stringify({ failing: test.results.filter(r => !r.pass), regressions: test.regressions }, null, 1)}`,
        { label: `fix:${pkg.slug}:${round}`, phase: 'Test' })
      test = await agent(testPrompt(pkg, branch), { label: `retest:${pkg.slug}:${round}`, phase: 'Test', schema: TESTED })
    }
    log(`${pkg.slug}: ${test && test.pass ? 'PASS' : 'still failing'}`)
    return { pkg, impl, test, branch }
  }),
)

const packs = results.filter(Boolean)
const passing = packs.filter(p => p.test && p.test.pass)
const failing = packs.filter(p => !(p.test && p.test.pass))
if (failing.length) log(`Not integrated (failing or not implemented): ${failing.map(p => p.pkg.slug).join(', ')}`)

// ---------------------------------------------------------------- Integrate
phase('Integrate')
const integration = await exclusive(() => agent(`${ROLE('celer-fixer')} For this step you are the integrator.

1. In the main checkout: \`git fetch origin\`, create \`${BRANCH}\` from \`${BASE}\` (or switch to it if it exists) and merge these tested branches one by one with \`--no-ff\` ("Merge <branch>: <summary>"), resolving conflicts so both sides keep working:
${JSON.stringify(passing.map(p => ({ branch: p.branch, issues: p.impl.done.map(d => d.issue) })), null, 1)}
2. Run the fast checks, \`dev\\wsl.ps1 test -Ref HEAD\` (every engine) and \`dev\\check-all.ps1\`. Fix what the merge broke (commit "Integration: …").
3. Push and open a DRAFT PR to main: title "Issue sprint: <short list>", body with one section per issue (what changed, per-engine test results below) and a "Closes #n" line per implemented issue; also list issues left out and why.
Test results per package:
${JSON.stringify(passing.map(p => ({ branch: p.branch, results: p.test.results })), null, 1)}
Left out: ${JSON.stringify(failing.map(p => ({ slug: p.pkg.slug, blocked: p.impl ? p.impl.blocked : 'implementer failed', failing: p.test ? p.test.results.filter(r => !r.pass) : [] })))}
4. Comment on every implemented issue with the PR link. Return the PR number and whether everything is green.`,
  { label: 'integrate', phase: 'Integrate', schema: { type: 'object', properties: { pr: { type: 'integer' }, green: { type: 'boolean' }, notes: { type: 'string' } }, required: ['pr', 'green', 'notes'] } }))
log(`PR #${integration ? integration.pr : '?'} — ${integration && integration.green ? 'green' : 'needs attention'}`)

// ---------------------------------------------------------------- Review (latest implementations first)
let review = null
if (REVIEW && integration) {
  phase('Review')
  try {
    review = await workflow('macro-review', {
      mode: A.reviewMode || 'full',
      since: SINCE,
      base: BASE,
      milestone: A.milestone || `Issue sprint ${BRANCH}`,
      tracking: A.tracking || null,
    })
  } catch (e) {
    log(`macro-review could not run: ${e && e.message}`)
  }
}

// ---------------------------------------------------------------- Close
phase('Close')
await agent(`${ROLE('celer-fixer')} Final step, in the main checkout on \`${BRANCH}\`.
Push the branch. Update PR #${integration ? integration.pr : '?'}: append a "Review" section (issues found/fixed by the macro review, with links) and a final engine matrix table for the whole branch from the latest \`dev\\wsl.ps1 test\` run. On the pushed head, trigger \`ci.yml\`, \`engines.yml\` and \`release-desktop.yml\` (a manual run only builds the Windows/macOS/Linux packages as the \`celer-release\` artifact; nothing is published): \`gh workflow run <file> --ref ${BRANCH}\`. Leave the PR as a draft. Do not merge and do not release in this step.

Review summary: ${JSON.stringify(review ? { issues: review.issues, verify: review.verify, notChecked: review.notChecked } : 'not run')}`,
  { label: 'close', phase: 'Close' })

// ---------------------------------------------------------------- Gate (docs/review/RELEASE_GATE.md)
// The owner authorised merging and releasing without asking, but only when every gate passes on the exact head SHA.
let gate = null
let released = null
if (RELEASE && integration && integration.pr) {
  phase('Gate')
  const GATE = {
    type: 'object',
    properties: {
      sha: { type: 'string', description: 'The PR head SHA every gate was checked on' },
      solid: { type: 'boolean', description: 'true only if every gate passed with evidence' },
      bump: { type: 'string', enum: ['minor', 'patch'], description: 'minor if the PR holds any feature or enhancement, patch if only fixes' },
      gates: {
        type: 'array',
        items: { type: 'object', properties: { gate: { type: 'integer' }, name: { type: 'string' }, pass: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['gate', 'name', 'pass', 'evidence'] },
      },
    },
    required: ['sha', 'solid', 'bump', 'gates'],
  }
  gate = await exclusive(() => agent(`${ROLE('celer-verifier')}

You are the release gatekeeper for PR #${integration.pr} (branch \`${BRANCH}\`). Read \`docs/review/RELEASE_GATE.md\` and check every gate (1–8) on the PR's current head SHA (\`gh pr view ${integration.pr} --json headRefOid\`). Read-only on the code: you may build, test, download artifacts and run the app, but not commit.
- Gates 1, 2, 8 from the data below; re-check anything that looks thin.
- Gate 3: \`gh issue list --label review --state open -L 200\`.
- Gate 4: run the checks yourself on that SHA (\`dev\\wsl.ps1 test -Ref <sha>\` for every engine, the fast checks, \`dev\\check-all.ps1\`).
- Gate 5: wait for the CI, Engines and Release runs of that SHA to finish (\`gh run list --commit <sha>\`, \`gh run watch <id> --exit-status\`); all must be green.
- Gate 6: \`gh run download <release run id> -n celer-release -D review-out/gate\`, verify SHA256SUMS.txt, start Celer-Portable-Windows.exe from there (its own data folder via CELER_DATA_DIR), connect to every engine of ENGINE_MATRIX.md and run a query; run the installer into a throw-away per-user folder and start the installed app. Screenshots to review-out/gate/.
- Gate 7: \`gh pr view ${integration.pr} --json mergeable,mergeStateStatus\`, CHANGELOG [Unreleased] and docs against the diff.
solid = every gate passed with evidence. When unsure, the gate fails. Comment the gate table on the PR ("Release gate: passed" or "Release gate: not passed" with what failed).

Tester results: ${JSON.stringify(passing.map(p => ({ branch: p.branch, results: p.test.results })))}
Review: ${JSON.stringify(review ? { verify: review.verify, issues: review.issues, notChecked: review.notChecked } : 'not run — gate 2 fails')}
Open decisions: ${JSON.stringify(decisions.filter(i => passing.some(p => p.pkg.issues.includes(i.number))).map(i => ({ issue: i.number, decision: i.decision_needed })))}`,
    { label: 'gate', phase: 'Gate', schema: GATE }))
  const failed = gate ? gate.gates.filter(g => !g.pass) : []
  log(gate && gate.solid && !failed.length ? `Release gate passed on ${gate.sha}` : `Release gate NOT passed: ${gate ? failed.map(g => g.gate + ' ' + g.name).join('; ') : 'gatekeeper failed'}`)

  // ---------------------------------------------------------------- Release
  if (gate && gate.solid && !failed.length) {
    phase('Release')
    released = await exclusive(() => agent(`${ROLE('celer-fixer')} You publish the release; the owner authorised it for when the gate passes, and it did on ${gate.sha}.
Follow "Procedure when all gates pass" in \`docs/review/RELEASE_GATE.md\` exactly:
1. Confirm the PR head is still ${gate.sha} (if it moved, stop and report: the gate must be re-run). \`gh pr ready ${integration.pr}\`, then \`gh pr merge ${integration.pr} --merge\`.
2. \`git switch main && git pull --ff-only origin main\`, clean tree.
3. Release with bump "${gate.bump}": in WSL \`bash dev/release.sh ${gate.bump}\` (from ~/celer on main) or on Windows \`dev\\release.ps1 -Bump ${gate.bump}\`.
4. Follow the tag's Release run to the end (\`gh run watch <id> --exit-status\`) and verify the published release: title, notes, the seven files, SHA256SUMS.txt matching, releases/latest pointing to it.
5. Comment the release link on the tracking issue${A.tracking ? ` #${A.tracking}` : ''} and on each closed issue; close the tracking issue and the milestone.
If the Release run fails, do not touch the tag: report the cause (see "When something fails after the merge").`,
      { label: 'release', phase: 'Release', schema: { type: 'object', properties: { merged: { type: 'boolean' }, version: { type: 'string' }, url: { type: 'string' }, verified: { type: 'boolean' }, notes: { type: 'string' } }, required: ['merged', 'version', 'url', 'verified', 'notes'] } }))
    log(released ? `Release ${released.version}: ${released.verified ? 'published and verified' : 'needs attention'} — ${released.url}` : 'release step failed')
  }
}

return {
  branch: BRANCH,
  pr: integration ? integration.pr : null,
  gate: gate ? { solid: gate.solid, sha: gate.sha, failed: gate.gates.filter(g => !g.pass) } : null,
  release: released,
  integrated: passing.map(p => ({ slug: p.pkg.slug, issues: p.impl.done.map(d => d.issue) })),
  leftOut: failing.map(p => ({ slug: p.pkg.slug, issues: p.pkg.issues, blocked: p.impl ? p.impl.blocked : [], failing: p.test ? p.test.results.filter(r => !r.pass).length : null })),
  decisions: decisions.map(i => ({ issue: i.number, decision: i.decision_needed })),
  skipped: triage.skipped,
  review: review ? { issues: review.issues ? review.issues.length : 0, verify: review.verify } : null,
}
