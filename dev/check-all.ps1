# Runs every automated check: unit checks (TypeScript and Rust), then the end-to-end checks against the desktop
# app (debug build, its own data folder, see dev/run-desktop.ps1). Needs the PostgreSQL test database
# (dev/testdb-postgres.ps1). Prints a summary and exits 1 if anything failed.
#   powershell -ExecutionPolicy Bypass -File dev\check-all.ps1 [-NoBuild] [-SkipRust]
param([switch]$NoBuild, [switch]$SkipRust)
$ErrorActionPreference = "Continue"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$node = "$env:LOCALAPPDATA\celer-tools\node-v22.20.0-win-x64\node.exe"
$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = "D:\celer-target" }
$results = @()
function Step($name, [scriptblock]$body) {
  Write-Host "`n== $name" -ForegroundColor DarkYellow
  & $body
  $ok = $LASTEXITCODE -eq 0
  $script:results += [pscustomobject]@{ Check = $name; Result = $(if ($ok) { "ok" } else { "FAIL" }) }
}
function Fresh-Workspace {
  # The checks expect no tabs from a previous run.
  [IO.File]::WriteAllText("D:\celer-devdata\workspace.json", "{}")
}
function Restart-App([switch]$Build) {
  $exe = "$env:CARGO_TARGET_DIR\debug\celer.exe"
  Get-Process celer -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | ForEach-Object { $_.CloseMainWindow() | Out-Null; $_ | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue }
  Fresh-Workspace
  if ($Build) { powershell -ExecutionPolicy Bypass -File "$root\dev\run-desktop.ps1" | Out-Host } else { powershell -ExecutionPolicy Bypass -File "$root\dev\run-desktop.ps1" -NoBuild | Out-Host }
}

Step "typescript" { & $node node_modules\typescript\bin\tsc --noEmit -p . }
Step "sql context" { & $node --experimental-strip-types --no-warnings dev\sqlcontext-check.ts }
Step "templates and parameters" { & $node --experimental-strip-types --no-warnings dev\snippets-check.ts }
Step "ER layout" { & $node --experimental-strip-types --no-warnings dev\erlayout-check.ts }
if (-not $SkipRust) { Step "rust unit tests" { Push-Location src-tauri; cargo test --lib --quiet; Pop-Location } }

Restart-App -Build:(-not $NoBuild)
Step "e2e" { & $node dev\e2e.mjs }
Restart-App
Step "disconnect" { & $node dev\disconnect-check.mjs }
Step "generated scripts" { & $node dev\generate-check.mjs }
Step "misc (startup script, pins, undo)" { & $node dev\misc-check.mjs }
Step "Gib companion" { & $node dev\gib-companion-check.mjs "$env:TEMP\gib-companion" }
Step "ER diagram" { & $node dev\er-check.mjs "$env:TEMP\celer-er" }
Restart-App
Step "restore (prepare)" { & $node dev\restore-check.mjs prepare }
$exe = "$env:CARGO_TARGET_DIR\debug\celer.exe"
Get-Process celer -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | ForEach-Object { $_.CloseMainWindow() | Out-Null; $_ | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue }
powershell -ExecutionPolicy Bypass -File "$root\dev\run-desktop.ps1" -NoBuild | Out-Host
Step "restore (verify)" { & $node dev\restore-check.mjs verify }

Write-Host ""
$results | Format-Table -AutoSize | Out-Host
if ($results.Result -contains "FAIL") { exit 1 }
