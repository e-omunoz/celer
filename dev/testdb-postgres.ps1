<#
  Servidor PostgreSQL portable para pruebas de Celer (sin instalacion ni permisos de administrador).

  Uso:
    .\dev\testdb-postgres.ps1            # = start
    .\dev\testdb-postgres.ps1 start      # initdb si hace falta, arranca en el puerto 54329 y carga la semilla la primera vez
    .\dev\testdb-postgres.ps1 stop
    .\dev\testdb-postgres.ps1 status
    .\dev\testdb-postgres.ps1 seed       # (re)carga dev/seed-postgres.sql en la base 'celer'

  Binarios: C:\Users\oscar\celer-testdb\postgres  (zip oficial EDB "windows-x64-binaries")
  Datos:    C:\Users\oscar\celer-testdb\postgres-data
  Usuario/contrasena: celer / celer. Bases: celer (con datos de ejemplo) y analytics.

  Tests de integracion:
    $env:CELER_PG_TEST = "host=localhost port=54329 user=celer password=celer dbname=celer"
    cd src-tauri; cargo test --lib postgres
#>
param([ValidateSet('start', 'stop', 'status', 'seed', 'restart')][string]$Action = 'start')

$ErrorActionPreference = 'Stop'
$Root = if ($env:CELER_PG_ROOT) { $env:CELER_PG_ROOT } else { Join-Path $env:USERPROFILE 'celer-testdb' }
$Bin = Join-Path $Root 'postgres\bin'
$Data = Join-Path $Root 'postgres-data'
$Log = Join-Path $Root 'postgres.log'
$Port = 54329
$Seed = Join-Path $PSScriptRoot 'seed-postgres.sql'

if (-not (Test-Path (Join-Path $Bin 'pg_ctl.exe'))) {
    throw "No se encuentran los binarios de PostgreSQL en $Bin. Descarga postgresql-17.x-1-windows-x64-binaries.zip de EDB y extrae la carpeta pgsql como $Root\postgres."
}

$env:PGPASSWORD = 'celer'
$env:PGCLIENTENCODING = 'UTF8'
function Pg([string]$exe) { Join-Path $Bin $exe }

function Test-Running {
    & (Pg 'pg_ctl.exe') status -D $Data *> $null
    return ($LASTEXITCODE -eq 0)
}

function Invoke-Psql([string]$db, [string[]]$more) {
    & (Pg 'psql.exe') -h localhost -p $Port -U celer -d $db -v ON_ERROR_STOP=1 -q @more
    if ($LASTEXITCODE -ne 0) { throw "psql fallo ($LASTEXITCODE)" }
}

function Initialize-Cluster {
    if (Test-Path (Join-Path $Data 'PG_VERSION')) { return $false }
    New-Item -ItemType Directory -Force $Data | Out-Null
    $pw = Join-Path $Root 'pwfile.txt'
    Set-Content -Path $pw -Value 'celer' -Encoding ascii -NoNewline
    & (Pg 'initdb.exe') -D $Data -U celer --auth=scram-sha-256 --pwfile=$pw -E UTF8 --locale=C
    $code = $LASTEXITCODE
    Remove-Item $pw -Force
    if ($code -ne 0) { throw "initdb fallo ($code)" }
    return $true
}

function Start-Server {
    $fresh = Initialize-Cluster
    if (Test-Running) {
        Write-Host "PostgreSQL ya esta en marcha (puerto $Port)."
    } else {
        & (Pg 'pg_ctl.exe') start -D $Data -l $Log -w -t 60 -o "-p $Port -c listen_addresses=localhost"
        if ($LASTEXITCODE -ne 0) { throw "pg_ctl start fallo; revisa $Log" }
    }
    $dbs = & (Pg 'psql.exe') -h localhost -p $Port -U celer -d postgres -tAc "SELECT datname FROM pg_database"
    if ($dbs -notcontains 'celer') { Invoke-Psql 'postgres' @('-c', 'CREATE DATABASE celer'); $fresh = $true }
    if ($dbs -notcontains 'analytics') {
        Invoke-Psql 'postgres' @('-c', 'CREATE DATABASE analytics')
        Invoke-Psql 'analytics' @('-c', "CREATE SCHEMA IF NOT EXISTS reporting; CREATE TABLE IF NOT EXISTS reporting.daily_visits (day date PRIMARY KEY, visits int NOT NULL); INSERT INTO reporting.daily_visits SELECT d::date, (random()*1000)::int FROM generate_series(date '2026-01-01', date '2026-03-31', interval '1 day') d ON CONFLICT DO NOTHING;")
    }
    if ($fresh) { Import-Seed }
    Write-Host "PostgreSQL listo: host=localhost port=$Port user=celer password=celer dbname=celer"
}

function Import-Seed {
    Write-Host "Cargando $Seed ..."
    Invoke-Psql 'celer' @('-f', $Seed)
}

switch ($Action) {
    'start' { Start-Server }
    'restart' { if (Test-Running) { & (Pg 'pg_ctl.exe') stop -D $Data -m fast -w }; Start-Server }
    'stop' {
        if (Test-Running) { & (Pg 'pg_ctl.exe') stop -D $Data -m fast -w } else { Write-Host 'PostgreSQL no esta en marcha.' }
    }
    'status' { if (Test-Running) { Write-Host "En marcha (puerto $Port)" } else { Write-Host 'Parado' } }
    'seed' { if (-not (Test-Running)) { Start-Server } else { Import-Seed } }
}
