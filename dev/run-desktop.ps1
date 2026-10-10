# Builds the debug desktop app and launches it with the DevTools protocol on port 9333 + slot (see dev/cdp.mjs).
# It runs on its own data folder (CELER_DATA_DIR) and its own WebView2 profile, next to an installed Celer without
# touching it. -Fresh starts in a new empty folder (first-run experience).
#
# Slots run several apps side by side, one per tester or branch. Slot n has its own everything:
#   DevTools port 9333+n, build D:\celer-target-slot<n>, data D:\celer-devdata-slot<n>, with -Ref, a worktree
#   D:\celer-slots\<n> of this checkout at that ref, so this checkout is never switched.
# Slot 0 (the default) keeps the usual places: this checkout, D:\celer-target, D:\celer-devdata.
#   dev\run-desktop.ps1                                  this checkout, slot 0
#   dev\run-desktop.ps1 -Slot 2 -Ref origin/issue/gib    branch issue/gib in slot 2 (port 9335)
#   dev\run-desktop.ps1 -Slot 2 -Stop                    stops slot 2
# A new data folder gets one connection per engine (dev/devdata-connections.mjs); -Engines rewrites them in an
# existing one. Slot 0's first run copies the installed copy's connections.json instead, as before.
param([int]$Slot = 0, [string]$Ref = "", [switch]$NoBuild, [switch]$Fresh, [switch]$Engines, [switch]$Stop, [string]$DataDir = "")
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$tools = "$env:LOCALAPPDATA\celer-tools"
$env:Path = "$env:USERPROFILE\.cargo\bin;$tools\node-v22.20.0-win-x64;$tools\git\cmd;" + $env:Path
$port = 9333 + $Slot
if ($Slot -gt 0) { $env:CARGO_TARGET_DIR = "D:\celer-target-slot$Slot" }
elseif (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = "D:\celer-target" }
$exe = "$env:CARGO_TARGET_DIR\debug\celer.exe"
# Only this slot's build is stopped (each slot has its own exe): an installed Celer and other slots keep running.
Get-Process celer -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
if ($Stop) { Write-Host "slot $Slot stopped"; return }

# Without Java 21 build.rs leaves the JDBC bridge out (Informix JDBC then says the build has no bridge).
if (-not $env:JAVA_HOME -and (Test-Path "C:\Program Files\Java\jdk-21")) { $env:JAVA_HOME = "C:\Program Files\Java\jdk-21" }
if (-not $env:JAVA_HOME) { Write-Warning "JAVA_HOME is not set: this build will have no JDBC bridge (Informix JDBC untestable)" }

# Git on Windows when there is one; otherwise WSL's (this machine drives the Windows checkout from WSL), with the
# paths translated (C:\x -> /mnt/c/x).
$winGit = Get-Command git -ErrorAction SilentlyContinue
function Git([string]$dir) {
  if ($winGit) { & git -C $dir @args }
  else {
    $tr = { param($p) if ($p -match '^([A-Za-z]):\\(.*)$') { "/mnt/$($Matches[1].ToLower())/$($Matches[2] -replace '\\', '/')" } else { $p } }
    & wsl.exe -e git -C (& $tr $dir) @($args | ForEach-Object { & $tr $_ })
  }
}

$src = $root
if ($Ref) {
  if ($Slot -eq 0) { throw "-Ref needs -Slot 1 or more: slot 0 builds this checkout as it is" }
  $src = "D:\celer-slots\$Slot"
  Git $root fetch origin --quiet
  if (-not (Test-Path "$src\.git")) { Git $root worktree add --quiet --detach $src $Ref }
  Git $src checkout --detach --force $Ref --quiet
  if ($LASTEXITCODE -ne 0) { throw "could not check out $Ref in $src" }
  # Dependencies follow the branch: reinstalled when its package-lock.json changes.
  $lock = (Get-FileHash "$src\package-lock.json").Hash
  if (-not (Test-Path "$src\node_modules") -or (Get-Content "$src\.slot-lock" -ErrorAction SilentlyContinue) -ne $lock) {
    Push-Location $src; npm ci --no-audit --no-fund | Out-Null; $ok = $LASTEXITCODE -eq 0; Pop-Location
    if (-not $ok) { throw "npm ci failed in $src" }
    Set-Content "$src\.slot-lock" $lock
  }
  Write-Host "slot $Slot at $Ref ($(Git $src rev-parse --short HEAD))"
}
if (-not $NoBuild) {
  Push-Location $src
  node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "build failed" }
  Pop-Location
}

if (-not $DataDir) {
  $DataDir = if ($Slot -gt 0) { "D:\celer-devdata-slot$Slot" } elseif ($env:CELER_DATA_DIR) { $env:CELER_DATA_DIR } else { "D:\celer-devdata" }
}
# A fresh start gets a new, empty folder next to the usual one (nothing is deleted).
if ($Fresh) { $DataDir = "$DataDir-fresh-$(Get-Date -Format yyyyMMddHHmmss)" }
$new = -not (Test-Path "$DataDir\connections.json")
New-Item -ItemType Directory -Force $DataDir | Out-Null
$installed = "$env:APPDATA\es.celer.app\connections.json"
if ($Engines -or ($new -and -not $Fresh -and $Slot -gt 0)) {
  node "$root\dev\devdata-connections.mjs" $DataDir
} elseif ($new -and -not $Fresh -and (Test-Path $installed)) {
  Copy-Item $installed "$DataDir\connections.json"
}
$env:CELER_DATA_DIR = $DataDir
$env:WEBVIEW2_USER_DATA_FOLDER = "$DataDir\webview"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
Start-Process $exe
# Ready when DevTools answers with a page (the main window), not after a fixed wait.
$ready = $false
for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
  Start-Sleep -Milliseconds 500
  try { $ready = @((Invoke-RestMethod "http://127.0.0.1:$port/json" -TimeoutSec 2) | Where-Object { $_.type -eq "page" }).Count -gt 0 } catch { }
}
if (-not $ready) { throw "Celer slot $Slot started but DevTools on $port did not answer in 30 s" }
Write-Host "Celer running (slot $Slot, CDP on $port, data in $DataDir)"
