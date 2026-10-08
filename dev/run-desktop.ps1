# Builds the debug desktop app and launches it with the DevTools protocol on port 9333 (see dev/cdp.mjs).
# It runs on its own data folder (CELER_DATA_DIR, default D:\celer-devdata) and its own WebView2 profile, next to
# an installed Celer without touching it. -Fresh starts in a new empty folder (first-run experience); otherwise the
# first run copies the installed copy's connections.json so the test connections are there.
param([switch]$NoBuild, [switch]$Fresh, [string]$DataDir = "")
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:LOCALAPPDATA\celer-tools\node-v22.20.0-win-x64;" + $env:Path
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = "D:\celer-target" }
$exe = "$env:CARGO_TARGET_DIR\debug\celer.exe"
# Only the debug build is stopped: an installed Celer keeps running.
Get-Process celer -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
if (-not $NoBuild) {
  Push-Location $root
  node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "build failed" }
  Pop-Location
}
if (-not $DataDir) { $DataDir = if ($env:CELER_DATA_DIR) { $env:CELER_DATA_DIR } else { "D:\celer-devdata" } }
# A fresh start gets a new, empty folder next to the usual one (nothing is deleted).
if ($Fresh) { $DataDir = "$DataDir-fresh-$(Get-Date -Format yyyyMMddHHmmss)" }
New-Item -ItemType Directory -Force $DataDir | Out-Null
$installed = "$env:APPDATA\es.celer.app\connections.json"
if (-not $Fresh -and -not (Test-Path "$DataDir\connections.json") -and (Test-Path $installed)) {
  Copy-Item $installed "$DataDir\connections.json"
}
$env:CELER_DATA_DIR = $DataDir
$env:WEBVIEW2_USER_DATA_FOLDER = "$DataDir\webview"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
Start-Process $exe
Start-Sleep 4
Write-Host "Celer running (CDP on 9333, data in $DataDir)"
