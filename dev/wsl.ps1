# Celer's WSL development environment: every database engine in Docker, and the Linux build and tests.
# Code is edited in the Windows checkout; WSL works on its own clone (~/celer), synced from here with `sync`.
#   powershell -ExecutionPolicy Bypass -File dev\wsl.ps1 setup            # install Ubuntu + toolchain + Docker (once)
#   â€¦ dev\wsl.ps1 db up | down | status | seed                            # PostgreSQL, MySQL, MariaDB, SQL Server, Informix
#   â€¦ dev\wsl.ps1 sync [-Ref <branch|sha>]                                # WSL clone at that commit (default: current HEAD)
#   â€¦ dev\wsl.ps1 test [-Ref <ref>] [-Filter <cargo filter>]              # Linux checks + cargo tests against every engine
#   â€¦ dev\wsl.ps1 build [-Ref <ref>]                                      # Linux packages, copied to review-out\linux
#   â€¦ dev\wsl.ps1 run "<bash command>"                                    # anything else, in ~/celer
# Ports seen from Windows: see dev/wsl/compose.yml (the Windows desktop app connects to them on localhost).
param(
  [Parameter(Position = 0)][ValidateSet("setup", "db", "sync", "test", "build", "run", "status")][string]$Command = "status",
  [Parameter(Position = 1)][string]$Arg = "",
  [string]$Ref = "",
  [string]$Filter = "",
  [string]$Distro = ""
)
$ErrorActionPreference = "Stop"
# Distro: -Distro, else $env:CELER_WSL_DISTRO, else the WSL default distro, else Ubuntu-24.04 (installed by setup).
if (-not $Distro) { $Distro = $env:CELER_WSL_DISTRO }
if (-not $Distro) {
  $line = (& wsl.exe -l 2>$null) -replace "`0", "" | Where-Object { $_ -match '\((Default|Predeterminad[oa])\)' } | Select-Object -First 1
  if ($line) { $Distro = ($line -replace '\s*\(.*\)\s*$', '').Trim() }
}
if (-not $Distro) { $Distro = "Ubuntu-24.04" }
$root = Split-Path $PSScriptRoot -Parent
$git = "$env:LOCALAPPDATA\celer-tools\git\cmd\git.exe"
function ToWsl([string]$p) { "/mnt/" + $p.Substring(0, 1).ToLower() + ($p.Substring(2) -replace '\\', '/') }
$winRepo = ToWsl $root
# ~/celer is the development clone used from inside WSL and is never touched from here. Runs started from Windows use
# their own detached WSL worktree per Windows checkout (~/celer-wt/win for the main one, one per agent worktree) and
# their own cargo target, so they never check out over each other or over work in progress.
$common = (& $git -C $root rev-parse --path-format=absolute --git-common-dir) -replace '/', '\'
$slot = if ((Split-Path $common -Parent) -ieq $root) { "win" } else { (Split-Path $root -Leaf) -replace '[^A-Za-z0-9_.-]', '-' }
$dir = "~/celer-wt/$slot"
$env_ = "export CARGO_TARGET_DIR=~/celer-target/$slot;"

function Wsl([string]$bash) {
  # As the distro's user (setup.sh made it the default): toolchain, drivers and ~/celer live in its home.
  # Through a script file: PowerShell 5 mangles quotes in native arguments, so bash -lc "<command>" is not reliable.
  $file = Join-Path $env:TEMP ("celer-wsl-" + [guid]::NewGuid().ToString("N") + ".sh")
  [IO.File]::WriteAllText($file, ($bash -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
  try { & wsl.exe -d $Distro -- bash -l (ToWsl $file) } finally { Remove-Item $file -ErrorAction SilentlyContinue }
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
    # setup.sh runs as root for the system packages and installs the rest for the distro's regular user.
    $out = & wsl.exe -d $Distro -u root -- bash "$winRepo/dev/wsl/setup.sh" $winRepo
    $out | Out-Host
    if ($out -match "RESTART_NEEDED") { & wsl.exe --terminate $Distro; & wsl.exe -d $Distro -u root -- systemctl enable --now docker }
    # A new login picks up the docker group.
    & wsl.exe --terminate $Distro
    Write-Host "WSL ready ($Distro). Next: dev\wsl.ps1 db up; dev\wsl.ps1 db seed" -ForegroundColor Green
  }
  "status" {
    if (-not (Installed)) { Write-Host "$Distro not installed: dev\wsl.ps1 setup"; exit 1 }
    Wsl "cd ~/celer && echo 'distro $Distro, slot $slot' && git -C $dir log -1 --oneline; docker compose -f dev/wsl/compose.yml ps"
  }
  "db" { Wsl "cd ~/celer && bash dev/wsl/engines.sh $(if ($Arg) { $Arg } else { 'status' })" }
  "sync" {
    $sha = if ($Ref) { & $git -C $root rev-parse $Ref } else { & $git -C $root rev-parse HEAD }
    # Objects are fetched into ~/celer as remote refs only (its branches and work tree stay as they are); the slot's
    # detached worktree moves to that commit.
    Wsl ("cd ~/celer && git fetch -q win '+refs/heads/*:refs/remotes/win/*' && (git cat-file -e $sha^{commit} 2>/dev/null || git fetch -q win $sha) " +
      "&& { [ -d $dir ] || git worktree add -q --detach $dir $sha; } && cd $dir && git checkout -q -f $sha && git clean -fdq -e node_modules && echo `"${slot}: `$(git log -1 --oneline)`"")
  }
  "test" {
    & $PSCommandPath sync -Ref $Ref -Distro $Distro
    Wsl "$env_ cd ~/celer && bash dev/wsl/engines.sh up >/dev/null && cd $dir && bash dev/wsl/engines.sh test '$Filter'"
  }
  "build" {
    & $PSCommandPath sync -Ref $Ref -Distro $Distro
    Wsl "$env_ cd $dir && bash dev/wsl/engines.sh build"
    New-Item -ItemType Directory -Force "$root\review-out\linux" | Out-Null
    Wsl "cp ~/celer-out/linux/* '$winRepo/review-out/linux/'"
  }
  "run" { Wsl "$env_ cd $dir && $Arg" }
}
