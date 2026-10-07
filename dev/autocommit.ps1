# Auto-commit: stages every change, writes a descriptive message and pushes the current branch.
# Run by the Claude Code "Stop" hook after each working session, or by hand:
#   powershell -ExecutionPolicy Bypass -File dev\autocommit.ps1 [-Message "feat: …"] [-NoPush]
param([string]$Message = "", [switch]$NoPush)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$git = "$env:LOCALAPPDATA\celer-tools\git\cmd\git.exe"
if (-not (Test-Path $git)) { $git = "git" }
Set-Location $root
if (-not (Test-Path "$root\.git")) { exit 0 }

& $git add -A
$changed = @(& $git diff --cached --name-only)
if ($changed.Count -eq 0) { exit 0 }

if (-not $Message) {
  # Group by area so the subject says what moved: "chore(auto): grid, state, mcp (+5)".
  $areas = $changed | ForEach-Object {
    $p = $_ -replace '\\', '/'
    if ($p -match '^src/components/([^/.]+)') { $Matches[1].ToLower() }
    elseif ($p -match '^src/([^/.]+)') { $Matches[1].ToLower() }
    elseif ($p -match '^src-tauri/src/([^/.]+)') { $Matches[1].ToLower() }
    elseif ($p -match '^installer/') { 'installer' }
    elseif ($p -match '^docs/') { 'docs' }
    elseif ($p -match '^dev/') { 'dev' }
    else { ($p -split '/')[0] }
  } | Group-Object | Sort-Object Count -Descending | Select-Object -ExpandProperty Name
  $head = ($areas | Select-Object -First 4) -join ', '
  $more = if ($areas.Count -gt 4) { " (+$($areas.Count - 4))" } else { "" }
  $Message = "chore(auto): $head$more"
}
$body = "Archivos ($($changed.Count)):`n" + (($changed | Select-Object -First 40 | ForEach-Object { "- $_" }) -join "`n")
if ($changed.Count -gt 40) { $body += "`n- … y $($changed.Count - 40) más" }

& $git commit -q -m $Message -m $body
Write-Host "commit: $Message ($($changed.Count) archivos)"

if (-not $NoPush -and (& $git remote)) {
  $branch = & $git rev-parse --abbrev-ref HEAD
  & $git push -q origin $branch 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "push: origin/$branch" } else { Write-Host "push pendiente (sin red o sin permisos)" }
}
