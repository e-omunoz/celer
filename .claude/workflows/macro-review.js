export const meta = {
  name: 'macro-review',
  description: 'Celer macro review: audit every area with agents, verify findings, file GitHub issues, fix them on the review branch and re-verify',
  whenToUse: 'Before a Celer release, to find and fix visual, functional, driver and connection defects with a GitHub record. Run through the /macro-review skill (it does the preflight).',
  phases: [
    { title: 'Audit', detail: 'one auditor per area, each finding challenged by a skeptic' },
    { title: 'Record', detail: 'confirmed findings filed as GitHub issues' },
    { title: 'Fix', detail: 'one fixer per area, sequential, one commit per issue' },
    { title: 'Verify', detail: 'all checks + regression review of the branch diff, repair loop' },
    { title: 'Report', detail: 'report file, tracking issue updated' },
  ],
}

// args: { mode: 'audit' | 'full' (default 'full'), areas?: string[], base?: string, milestone?: string, tracking?: number }
const A = args || {}
const MODE = A.mode === 'audit' ? 'audit' : 'full'
const BASE = A.base || 'origin/main'
const MILESTONE = A.milestone || 'Macro review'
const TRACKING = A.tracking || null

// ui: true areas launch the app / browser pane, so they run one after another; the rest are static + CLI checks.
const ALL_AREAS = [
  { key: 'ui-visual', title: 'Visual', ui: true },
  { key: 'ui-functional', title: 'Interface behaviour', ui: true },
  { key: 'drivers-open', title: 'Drivers: PostgreSQL, MySQL/MariaDB, SQLite', ui: false },
  { key: 'drivers-enterprise', title: 'Drivers: SQL Server, Informix, ODBC/JDBC', ui: false },
  { key: 'connections', title: 'Connections', ui: false },
  { key: 'core-rust', title: 'Rust core', ui: false },
  { key: 'frontend-state', title: 'Frontend state and performance', ui: false },
  { key: 'security', title: 'Security and privacy', ui: false },
  { key: 'release', title: 'Release, packaging and docs', ui: false },
]
const AREAS = A.areas && A.areas.length ? ALL_AREAS.filter(a => A.areas.includes(a.key)) : ALL_AREAS
const skipped = ALL_AREAS.filter(a => !AREAS.includes(a)).map(a => a.key)
if (skipped.length) log(`Areas left out this run: ${skipped.join(', ')}`)

const SEV = { critical: 0, high: 1, medium: 2, low: 3 }

const FINDING = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'One line, what is wrong (English)' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    kind: { type: 'string', enum: ['bug', 'visual', 'ux', 'performance', 'security', 'docs'] },
    file: { type: 'string', description: 'Repo-relative path, or "" for purely visual findings' },
    line: { type: 'integer' },
    evidence: { type: 'string', description: 'Code path or screenshot path (review-out/...) that proves it' },
    repro: { type: 'string', description: 'Steps or inputs that trigger it' },
    expected: { type: 'string' },
    actual: { type: 'string' },
    fix_hint: { type: 'string' },
  },
  required: ['title', 'severity', 'kind', 'file', 'evidence', 'repro', 'expected', 'actual'],
}
const FINDINGS = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: FINDING },
    not_checked: { type: 'array', items: { type: 'string' }, description: 'What could not be checked and why' },
  },
  required: ['findings', 'not_checked'],
}
const VERDICTS = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          real: { type: 'boolean' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          reason: { type: 'string' },
          title: { type: 'string', description: 'Tightened title when real' },
          fix_hint: { type: 'string' },
        },
        required: ['index', 'real', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}
const RECORDED = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          number: { type: 'integer' },
          duplicate_of: { type: 'integer', description: 'Existing issue number when not created' },
        },
        required: ['index', 'number'],
      },
    },
  },
  required: ['issues'],
}
const FIXED = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'object', properties: { issue: { type: 'integer' }, commit: { type: 'string' } }, required: ['issue', 'commit'] } },
    deferred: { type: 'array', items: { type: 'object', properties: { issue: { type: 'integer' }, reason: { type: 'string' } }, required: ['issue', 'reason'] } },
    checks_run: { type: 'array', items: { type: 'string' } },
  },
  required: ['fixed', 'deferred', 'checks_run'],
}
const VERIFIED = {
  type: 'object',
  properties: {
    green: { type: 'boolean' },
    failures: { type: 'array', items: { type: 'string' }, description: 'Failing check names with the key error line' },
    regressions: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, description: { type: 'string' } }, required: ['file', 'description'] } },
  },
  required: ['green', 'failures', 'regressions'],
}

const ROLE = role => `Read and follow your role file \`.claude/agents/${role}.md\` and the project notes in \`CLAUDE.md\`.`

function auditPrompt(area) {
  const appRule = area.ui
    ? 'You may launch the desktop app (dev/run-desktop.ps1) and the browser pane preview `celer-web`; you are the only agent using them right now. Stop the app when done.'
    : 'Test everything live that you can: start, seed and kill test databases, build, run cargo/node checks and probes (CLAUDE.md "Local testing"). Only the desktop app and the browser pane are off-limits in this phase, because the UI auditors are using them (dev/run-desktop.ps1 would kill their instance).'
  return `${ROLE('celer-auditor')}

Area: **${area.title}** — checklist in \`.claude/skills/macro-review/areas/${area.key}.md\`. Read it first.
${appRule}
Put any screenshot or output under \`review-out/${area.key}/\`.
Skip anything already filed: \`gh issue list --label review --state all -L 200\`.
Return every real defect you can prove, most severe first, plus what you could not check.`
}

function verifyPrompt(area, findings) {
  return `${ROLE('celer-verifier')}

Area: ${area.title}. Try to refute each finding below (index = position in the list). Default to real=false when unsure.
Also mark real=false for duplicates of each other or of existing issues (\`gh issue list --label review --state all -L 200\`).
${area.ui ? 'Re-check live in the browser pane / desktop app (the auditor has finished with them).' : 'Re-check live with test databases and CLI checks where cheap; the desktop app and browser pane belong to the UI auditors in this phase.'}

${JSON.stringify(findings.map((f, index) => ({ index, ...f })), null, 1)}`
}

async function auditArea(area) {
  const found = await agent(auditPrompt(area), { label: `audit:${area.key}`, phase: 'Audit', schema: FINDINGS })
  if (!found) return { area, confirmed: [], not_checked: ['auditor failed'] }
  log(`${area.key}: ${found.findings.length} candidate findings`)
  if (!found.findings.length) return { area, confirmed: [], not_checked: found.not_checked }
  const judged = await agent(verifyPrompt(area, found.findings), { label: `verify:${area.key}`, phase: 'Audit', schema: VERDICTS })
  const byIndex = new Map((judged ? judged.verdicts : []).map(v => [v.index, v]))
  const confirmed = found.findings
    .map((f, i) => ({ f, v: byIndex.get(i) }))
    .filter(x => x.v && x.v.real)
    .map(x => ({ ...x.f, area: area.key, severity: x.v.severity || x.f.severity, title: x.v.title || x.f.title, fix_hint: x.v.fix_hint || x.f.fix_hint || '' }))
  log(`${area.key}: ${confirmed.length}/${found.findings.length} confirmed`)
  return { area, confirmed, not_checked: found.not_checked }
}

// ---------------------------------------------------------------- Audit
phase('Audit')
const uiAreas = AREAS.filter(a => a.ui)
const codeAreas = AREAS.filter(a => !a.ui)
const [uiResults, codeResults] = await parallel([
  async () => {
    const out = []
    for (const area of uiAreas) out.push(await auditArea(area)) // one at a time: shared app and browser pane
    return out
  },
  () => pipeline(codeAreas, auditArea),
])
const audited = [...(uiResults || []), ...(codeResults || [])].filter(Boolean)

// Cross-area dedup: same file and line, or same title.
const seen = new Set()
const confirmed = []
for (const f of audited.flatMap(r => r.confirmed)) {
  const k1 = f.file && f.line ? `${f.file}:${f.line}` : null
  const k2 = f.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if ((k1 && seen.has(k1)) || seen.has(k2)) continue
  if (k1) seen.add(k1)
  seen.add(k2)
  confirmed.push(f)
}
confirmed.sort((a, b) => SEV[a.severity] - SEV[b.severity])
const notChecked = audited.flatMap(r => r.not_checked.map(n => `${r.area.key}: ${n}`))
log(`Confirmed after dedup: ${confirmed.length}`)
if (!confirmed.length) return { mode: MODE, confirmed: [], notChecked }

// ---------------------------------------------------------------- Record
phase('Record')
const recorded = await agent(`Read the project notes in \`CLAUDE.md\` (tool PATH). You are the recorder: you create GitHub issues and change nothing else.

File each finding below as a GitHub issue in e-omunoz/celer, in order. For each:
- First search for an existing issue on the same defect (\`gh issue list --label review --state all -S "<keywords>"\`); if one exists, return it as duplicate_of and number = that issue.
- Otherwise \`gh issue create\` with title "[<area>] <title>", labels \`review\`, \`area:<area>\`, \`sev:<severity>\`, \`kind:<kind>\` (and \`bug\` for kind bug/visual), milestone "${MILESTONE}", and this body (write it to a temp file and use --body-file):
  ## What happens / ## Expected / ## Steps to reproduce / ## Evidence (file:line links as \`path#Lline\`, screenshot paths) / ## Fix hint / footer "Found by the macro review (.claude/workflows/macro-review.js)".
${TRACKING ? `Then add a checklist line "- [ ] #<n> <title>" per new issue to tracking issue #${TRACKING} (edit its body, keep existing lines).` : ''}
Return index → issue number for every finding.

${JSON.stringify(confirmed.map((f, index) => ({ index, ...f })), null, 1)}`, { label: 'record:github', phase: 'Record', schema: RECORDED })

const issueOf = new Map((recorded ? recorded.issues : []).map(r => [r.index, r.number]))
const tracked = confirmed.map((f, i) => ({ ...f, issue: issueOf.get(i) })).filter(f => f.issue)
log(`Issues on GitHub: ${tracked.length}`)
if (MODE === 'audit') return { mode: MODE, issues: tracked.map(f => ({ issue: f.issue, area: f.area, severity: f.severity, title: f.title })), notChecked }

// ---------------------------------------------------------------- Fix
phase('Fix')
// Sequential on the same branch: fixers touch overlapping files (state.ts, lib.rs) and share the app and build dir.
const byArea = AREAS.map(a => ({ area: a, items: tracked.filter(f => f.area === a.key) })).filter(g => g.items.length)
byArea.sort((x, y) => Math.min(...x.items.map(f => SEV[f.severity])) - Math.min(...y.items.map(f => SEV[f.severity])))
const fixResults = []
for (const g of byArea) {
  const r = await agent(`${ROLE('celer-fixer')}

Area: ${g.area.title} (checklist for context: \`.claude/skills/macro-review/areas/${g.area.key}.md\`).
You are the only agent running now: use the desktop app, the browser pane, test databases and anything local to reproduce each issue before the fix and to confirm it after.
Fix these issues, most severe first, one commit each, on the current branch. Do not push.

${JSON.stringify(g.items.map(f => ({ issue: f.issue, severity: f.severity, title: f.title, file: f.file, line: f.line, repro: f.repro, expected: f.expected, fix_hint: f.fix_hint })), null, 1)}`,
    { label: `fix:${g.area.key}`, phase: 'Fix', schema: FIXED })
  if (r) {
    fixResults.push({ area: g.area.key, ...r })
    log(`${g.area.key}: ${r.fixed.length} fixed, ${r.deferred.length} deferred`)
  } else log(`${g.area.key}: fixer failed — its issues stay open`)
}

// ---------------------------------------------------------------- Verify
phase('Verify')
const VERIFY_PROMPT = `${ROLE('celer-verifier')}

Verify the review branch as a whole (diff: \`git diff ${BASE}...HEAD\`).
1. Run: \`npx tsc --noEmit -p .\`, \`npx tsc --noEmit -p installer\`, every \`dev/*-check.ts\`, \`npm run build\`, and \`cargo test --lib\` in src-tauri with CELER_PG_TEST / CELER_MYSQL_TEST (start the servers with dev/testdb-*.ps1), then the full end-to-end suite \`powershell -ExecutionPolicy Bypass -File dev\\check-all.ps1\` against the desktop app.
2. Review the fix commits since the audit for regressions: wrong fix, behaviour changed elsewhere, missing CHANGELOG line, style that does not match the file.
green = every check passes and no regression found. Read-only.`
let verdict = await agent(VERIFY_PROMPT, { label: 'verify:branch', phase: 'Verify', schema: VERIFIED })
for (let round = 1; verdict && !verdict.green && round <= 2; round++) {
  log(`Verify round ${round}: ${verdict.failures.length} failing checks, ${verdict.regressions.length} regressions — repairing`)
  await agent(`${ROLE('celer-fixer')}

The branch verification failed. Fix exactly these problems (one commit per cause, message "<Area>: <fix> (review follow-up)"), rerun the failing checks, do not push.
${JSON.stringify(verdict, null, 1)}`, { label: `repair:${round}`, phase: 'Verify' })
  verdict = await agent(VERIFY_PROMPT, { label: `verify:branch:${round}`, phase: 'Verify', schema: VERIFIED })
}

// ---------------------------------------------------------------- Report
phase('Report')
const summary = {
  mode: MODE,
  base: BASE,
  issues: tracked.map(f => ({ issue: f.issue, area: f.area, severity: f.severity, title: f.title })),
  fixes: fixResults,
  verify: verdict,
  notChecked,
}
await agent(`You write the macro review report. Append a new dated section (use \`git log -1 --format=%cs\`) to \`docs/review/REPORT.md\` (create it with a "# Macro review reports" heading if missing):
counts by area and severity, a table issue → status (fixed with commit / deferred with reason / open), checks run and their result, and "Not checked" list. Commit it: "Docs: macro review report". Do not push.
${TRACKING ? `Then comment the same summary on tracking issue #${TRACKING} and tick the checklist lines of fixed issues ("fixed in <sha>, closes on merge").` : ''}

${JSON.stringify(summary, null, 1)}`, { label: 'report', phase: 'Report' })

return summary
