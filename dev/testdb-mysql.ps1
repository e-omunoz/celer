# Portable MariaDB test server for Celer's MySQL/MariaDB driver.
#
#   powershell -ExecutionPolicy Bypass -File dev\testdb-mysql.ps1 start   # (default) start if not running
#   powershell -ExecutionPolicy Bypass -File dev\testdb-mysql.ps1 stop
#   powershell -ExecutionPolicy Bypass -File dev\testdb-mysql.ps1 status
#   powershell -ExecutionPolicy Bypass -File dev\testdb-mysql.ps1 seed    # (re)load dev\seed-mysql.sql
#
# Layout: C:\Users\<you>\celer-testdb\mariadb\{bin,data}. Port 33069, root/celer, celer/celer.
# Integration tests: $env:CELER_MYSQL_TEST = "mysql://celer:celer@127.0.0.1:33069/celer"
# Everything is idempotent: start does nothing if the server already answers, the datadir is
# only initialized when missing, and the seed script drops/recreates its own databases.
param([ValidateSet("start", "stop", "status", "seed", "restart")][string]$Action = "start")

$ErrorActionPreference = "Stop"
$Root = Join-Path $env:USERPROFILE "celer-testdb\mariadb"
$Bin = Join-Path $Root "bin"
$Data = Join-Path $Root "data"
$Port = 33069
$RootPass = "celer"
$Seed = Join-Path $PSScriptRoot "seed-mysql.sql"
$Log = Join-Path $Root "mariadbd.log"

function Test-Up {
    $ErrorActionPreference = "Continue"   # native stderr must not abort the probe (PS 5.1)
    $out =& "$Bin\mariadb-admin.exe" --protocol=tcp -h 127.0.0.1 -P $Port -u root "-p$RootPass" ping 2>$null
    return ($LASTEXITCODE -eq 0 -and "$out" -match "alive")
}

function Invoke-Sql([string]$File) {
    $ErrorActionPreference = "Continue"
    # `source` reads the file as bytes (UTF-8); piping through PowerShell 5.1 would mangle non-ASCII text.
    $path = (Resolve-Path $File).Path -replace '\\', '/'
    & "$Bin\mariadb.exe" --protocol=tcp -h 127.0.0.1 -P $Port -u root "-p$RootPass" --default-character-set=utf8mb4 -e "source $path"
    if ($LASTEXITCODE -ne 0) { throw "Failed to run $File" }
}

function Start-Db {
    if (-not (Test-Path "$Bin\mariadbd.exe")) {
        throw "MariaDB not found in $Root. Download the winx64 ZIP (e.g. https://archive.mariadb.org/mariadb-11.4.8/winx64-packages/mariadb-11.4.8-winx64.zip) and extract it there."
    }
    $fresh = $false
    if (-not (Test-Path (Join-Path $Data "mysql"))) {
        & "$Bin\mariadb-install-db.exe" "--datadir=$Data" "--password=$RootPass" "--port=$Port" | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "mariadb-install-db failed" }
        $fresh = $true
    }
    if (Test-Up) { Write-Host "MariaDB already running on port $Port"; return }
    Start-Process -FilePath "$Bin\mariadbd.exe" `
        -ArgumentList "--defaults-file=`"$Data\my.ini`"", "--port=$Port", "--bind-address=127.0.0.1", "--log-error=`"$Log`"" `
        -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Up) { break }
    }
    if (-not (Test-Up)) { throw "MariaDB did not start; see $Log" }
    Write-Host "MariaDB running on 127.0.0.1:$Port"
    if ($fresh) { Invoke-Sql $Seed; Write-Host "Seed loaded" }
}

function Stop-Db {
    if (Test-Up) {
        $ErrorActionPreference = "Continue"
        & "$Bin\mariadb-admin.exe" --protocol=tcp -h 127.0.0.1 -P $Port -u root "-p$RootPass" shutdown
        Write-Host "MariaDB stopped"
    } else {
        Write-Host "MariaDB is not running"
    }
}

switch ($Action) {
    "start" { Start-Db }
    "stop" { Stop-Db }
    "restart" { Stop-Db; Start-Sleep -Seconds 2; Start-Db }
    "status" { if (Test-Up) { "running on 127.0.0.1:$Port" } else { "stopped" } }
    "seed" { if (-not (Test-Up)) { Start-Db }; Invoke-Sql $Seed; Write-Host "Seed loaded" }
}
