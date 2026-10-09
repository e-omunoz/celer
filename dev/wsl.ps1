# Celer's WSL development environment: every database engine in Docker, and the Linux build and tests.
# Code is edited in the Windows checkout; WSL works on its own clone (~/celer), synced from here with `sync`.
#   powershell -ExecutionPolicy Bypass -File dev\wsl.ps1 setup            # install Ubuntu + toolchain + Docker (once)
#   … dev\wsl.ps1 db up | down | status | seed                            # PostgreSQL, MySQL, MariaDB, SQL Server, Informix
#   … dev\wsl.ps1 sync [-Ref <branch|sha>]                                # WSL clone at that commit (default: current HEAD)
#   … dev\wsl.ps1 test [-Ref <ref>] [-Filter <cargo filter>]              # Linux checks + cargo tests against every engine
#   … dev\wsl.ps1 build [-Ref <ref>]                                      # Linux packages, copied to review-out\linux
#   … dev\wsl.ps1 run "<bash command>"                                    # anything else, in ~/celer
# Ports seen from Windows: see dev/wsl/compose.yml (the Windows desktop app connects to them on localhost).
param(
  [Parameter(Position = 0)][ValidateSet("setup", "db", "sync", "test", "build", "run", "status")][string]$Command = "status",
  [Parameter(Position = 1)][string]$Arg = "",
  [string]$Ref = "",
  [string]$Filter = "",
  [string]$Distro = "Ubuntu-24.04"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$git = "$env:LOCALAPPDATA\celer-tools\git\cmd\git.exe"
$winRepo = "/mnt/" + $root.Substring(0, 1).ToLower() + ($root.Substring(2) -replace '\\', '/')

function Wsl([string]$bash, [switch]$Root) {
  $user = if ($Root) { @("-u", "root") } else { @() }
  & wsl.exe -d $Distro @user -- bash -lc $bash
  if ($LASTEXITCODE -ne 0) { throw "WSL command failed ($LASTEXITCODE): $bash" }
}
function Installed { (& wsl.exe -l -q) -replace "`0", "" | Where-Object { $_.Trim() -eq $Distro } }

switch ($Command) {
  "setup" {
    if (-not (Installed)) {
      Write-Host "Installing $Distro (may ask for approval or a restart the first time)..."
      & wsl.exe --install -d $Distro --no-launch
      & wsl.exe -d $Distro -u root -- true   # registers the distro
    }
    # Everything runs as root in this dev distro: one toolchain, no sudo prompts.
    & wsl.exe --manage $Distro --set-default-user root 2>$null
    $out = & wsl.exe -d $Distro -u root -- bash "$winRepo/dev/wsl/setup.sh" $winRepo
    $out | Out-Host
    if ($out -match "RESTART_NEEDED") { & wsl.exe --terminate $Distro; Wsl "systemctl enable --now docker" -Root }
    Write-Host "WSL ready. Next: dev\wsl.ps1 db up; dev\wsl.ps1 db seed" -ForegroundColor Green
  }
  "status" {
    if (-not (Installed)) { Write-Host "$Distro not installed: dev\wsl.ps1 setup"; exit 1 }
    Wsl "cd ~/celer && git log -1 --oneline && docker compose -f dev/wsl/compose.yml ps"
  }
  "db" { Wsl "cd ~/celer && bash dev/wsl/engines.sh $(if ($Arg) { $Arg } else { 'status' })" }
  "sync" {
    $sha = if ($Ref) { & $git -C $root rev-parse $Ref } else { & $git -C $root rev-parse HEAD }
    Wsl "cd ~/celer && git fetch -q win '+refs/heads/*:refs/remotes/win/*' && git fetch -q win $sha && git checkout -q -f $sha && git clean -fdq -e node_modules && git log -1 --oneline"
  }
  "test" {
    & $PSCommandPath sync -Ref $Ref -Distro $Distro
    Wsl "cd ~/celer && bash dev/wsl/engines.sh up >/dev/null && bash dev/wsl/engines.sh test '$Filter'"
  }
  "build" {
    & $PSCommandPath sync -Ref $Ref -Distro $Distro
    Wsl "cd ~/celer && bash dev/wsl/engines.sh build"
    New-Item -ItemType Directory -Force "$root\review-out\linux" | Out-Null
    Wsl "cp ~/celer-out/linux/* '$winRepo/review-out/linux/'"
  }
  "run" { Wsl "cd ~/celer && $Arg" }
}
