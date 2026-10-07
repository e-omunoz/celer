# Builds the debug desktop app and launches it with the DevTools protocol on port 9333 (see dev/cdp.mjs).
param([switch]$NoBuild)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:LOCALAPPDATA\celer-tools\node-v22.20.0-win-x64;" + $env:Path
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = "D:\celer-target" }
Get-Process celer -ErrorAction SilentlyContinue | Stop-Process -Force
if (-not $NoBuild) {
  Push-Location $root
  node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "build failed" }
  Pop-Location
}
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
Start-Process "$env:CARGO_TARGET_DIR\debug\celer.exe"
Start-Sleep 4
Write-Host "Celer running (CDP on 9333)"
