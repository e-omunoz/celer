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
Step "plan readers" { & $node --experimental-strip-types --no-warnings dev\plan-check.ts }
Step "result comparison" { & $node --experimental-strip-types --no-warnings dev\compare-check.ts }
Step "foreign-key lookup SQL" { & $node --experimental-strip-types --no-warnings dev\fklookup-check.ts }
Step "schema comparison logic" { & $node --experimental-strip-types --no-warnings dev\schemacompare-check.ts }
Step "XML formatting" { & $node --experimental-strip-types --no-warnings dev\prettyxml-check.ts }
Step "keyboard shortcuts" { & $node --experimental-strip-types --no-warnings dev\keymap-check.ts }
Step "import formats" { & $node --experimental-strip-types --no-warnings dev\import-check.ts }
if (Get-NetTCPConnection -State Listen -LocalPort 1420 -ErrorAction SilentlyContinue) { Step "SQL Server plan reader" { & $node dev\plan-mssql-check.mjs } }
if (-not $SkipRust) { Step "rust unit tests" { Push-Location src-tauri; cargo test --lib --quiet; Pop-Location } }

Restart-App -Build:(-not $NoBuild)
Step "e2e" { & $node dev\e2e.mjs }
Restart-App
Step "disconnect" { & $node dev\disconnect-check.mjs }
Step "generated scripts" { & $node dev\generate-check.mjs }
Step "misc (startup script, pins, undo)" { & $node dev\misc-check.mjs }
Step "import (Excel, JSON)" { & $node dev\import-e2e-check.mjs }
Step "grid editors (bool, date, FK lookup) and explorer refresh" { & $node dev\grid-editors-check.mjs }
Step "schema comparison" { & $node dev\schema-compare-check.mjs }
Step "keyboard shortcuts (desktop)" { & $node dev\keymap-e2e-check.mjs }
Step "startup script (MariaDB, SQLite)" { & $node dev\startup-engines-check.mjs }
Step "Gib companion" { & $node dev\gib-companion-check.mjs "$env:TEMP\gib-companion" }
Step "ER diagram" { & $node dev\er-check.mjs "$env:TEMP\celer-er" }
Step "execution plans" { & $node dev\plan-view-check.mjs "$env:TEMP\celer-plan" }
Step "server activity" { & $node dev\activity-check.mjs "$env:TEMP\celer-activity" }
Restart-App
Step "restore (prepare)" { & $node dev\restore-check.mjs prepare }
$exe = "$env:CARGO_TARGET_DIR\debug\celer.exe"
Get-Process celer -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | ForEach-Object { $_.CloseMainWindow() | Out-Null; $_ | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue }
powershell -ExecutionPolicy Bypass -File "$root\dev\run-desktop.ps1" -NoBuild | Out-Host
Step "restore (verify)" { & $node dev\restore-check.mjs verify }

Write-Host ""
$results | Format-Table -AutoSize | Out-Host
if ($results.Result -contains "FAIL") { exit 1 }
