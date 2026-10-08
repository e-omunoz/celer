# Prepares the GitHub ledger for a macro review: labels, milestone and one open tracking issue. Safe to run again.
#   powershell -ExecutionPolicy Bypass -File dev\review-github.ps1 [-Milestone "Macro review 2.1"]
param([string]$Milestone = "Macro review")
$ErrorActionPreference = "Stop"
$tools = "$env:LOCALAPPDATA\celer-tools"
$env:PATH = "$tools\git\cmd;$tools\gh\bin;$env:PATH"
$repo = "e-omunoz/celer"

$labels = @(
  @("review", "5319e7", "Found by the macro review"),
  @("review:deferred", "bfd4f2", "Macro review finding left for a later pass"),
  @("sev:critical", "b60205", "Data loss, security or crash on a common path"),
  @("sev:high", "d93f0b", "Main feature wrong or unusable"),
  @("sev:medium", "fbca04", "Real defect with a workaround or on a less common path"),
  @("sev:low", "c2e0c6", "Cosmetic or rare"),
  @("kind:bug", "d73a4a", "Wrong behaviour"),
  @("kind:visual", "f9d0c4", "Layout, theme or rendering"),
  @("kind:ux", "fef2c0", "Confusing or inconsistent interaction"),
  @("kind:performance", "0e8a16", "Slow, heavy or blocking"),
  @("kind:security", "000000", "Security or privacy"),
  @("kind:docs", "0075ca", "Docs contradict behaviour")
)
foreach ($a in "ui-visual", "ui-functional", "drivers-open", "drivers-enterprise", "connections", "core-rust", "frontend-state", "security", "release") {
  $labels += , @("area:$a", "1d76db", "Macro review area $a")
}
foreach ($l in $labels) {
  gh label create $l[0] --repo $repo --color $l[1] --description $l[2] --force | Out-Null
}
Write-Host "labels: $($labels.Count)"

# Filtered here, not in --jq: PowerShell 5 splits a jq filter with embedded quotes into several arguments.
$existing = (gh api "repos/$repo/milestones?state=all" | ConvertFrom-Json) | Where-Object { $_.title -eq $Milestone } | Select-Object -ExpandProperty number -First 1
if (-not $existing) {
  gh api "repos/$repo/milestones" -f title="$Milestone" -f description="Issues found and fixed by the macro review" | Out-Null
  Write-Host "milestone created: $Milestone"
} else { Write-Host "milestone: $Milestone (#$existing)" }

$tracking = gh issue list --repo $repo --label review --state open --search "Macro review tracking in:title" --json number --jq ".[0].number"
if (-not $tracking) {
  $body = "Tracking issue for **$Milestone**.`n`nEach finding is its own issue (label ``review``); fixes land on the review branch and close them through the PR.`nProcess: [docs/review/README.md](../blob/main/docs/review/README.md).`n`n## Findings`n"
  $url = gh issue create --repo $repo --title "Macro review tracking: $Milestone" --label review --milestone "$Milestone" --body $body
  $tracking = ($url -split "/")[-1]
}
Write-Host "tracking issue: #$tracking"
