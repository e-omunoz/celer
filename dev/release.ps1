# Publishes a Celer release: version bump, changelog, checks, builds, tag and GitHub Release with installers.
#   powershell -ExecutionPolicy Bypass -File dev\release.ps1 -Bump minor        # 1.1.0 -> 1.2.0
#   powershell -ExecutionPolicy Bypass -File dev\release.ps1 -Version 1.1.0     # release the current version
#   … -Draft  (draft release)  -SkipTests  -NoPublish (build and tag locally only)
param(
  [ValidateSet("", "patch", "minor", "major")][string]$Bump = "",
  [string]$Version = "",
  [switch]$Draft,
  [switch]$SkipTests,
  [switch]$NoPublish
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$tools = "$env:LOCALAPPDATA\celer-tools"
$git = "$tools\git\cmd\git.exe"
$gh = "$tools\gh\bin\gh.exe"
# gh shells out to git, so the portable git must be on PATH too.
$env:Path = "$env:USERPROFILE\.cargo\bin;$tools\node-v22.20.0-win-x64;$tools\git\cmd;" + $env:Path
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = "D:\celer-target" }
Set-Location $root

function Step($text) { Write-Host "`n== $text" -ForegroundColor DarkYellow }
function Check($ok, $text) { if (-not $ok) { throw $text } }

# ---------------------------------------------------------------- version
$current = (Get-Content package.json -Raw | ConvertFrom-Json).version
if (-not $Version) {
  $parts = $current.Split(".") | ForEach-Object { [int]$_ }
  switch ($Bump) {
    "major" { $Version = "$($parts[0] + 1).0.0" }
    "minor" { $Version = "$($parts[0]).$($parts[1] + 1).0" }
    "patch" { $Version = "$($parts[0]).$($parts[1]).$($parts[2] + 1)" }
    default { $Version = $current }
  }
}
Check ($Version -match '^\d+\.\d+\.\d+$') "Versión no válida: $Version"
$tag = "v$Version"
Check (-not (& $git tag --list $tag)) "La etiqueta $tag ya existe"
Step "Celer $current -> $Version"

# Every manifest gets the release version (also when it is not a bump: keeps the installer in sync).
foreach ($file in "package.json", "src-tauri\tauri.conf.json", "installer\src-tauri\tauri.conf.json") {
  $text = [IO.File]::ReadAllText("$root\$file")
  [IO.File]::WriteAllText("$root\$file", [regex]::Replace($text, '"version": "[^"]+"', "`"version`": `"$Version`"", 1))
}
foreach ($file in "src-tauri\Cargo.toml", "installer\src-tauri\Cargo.toml") {
  if (Test-Path "$root\$file") {
    $text = [IO.File]::ReadAllText("$root\$file")
    [IO.File]::WriteAllText("$root\$file", [regex]::Replace($text, '(?m)^version = "[^"]+"', "version = `"$Version`"", 1))
  }
}

# ---------------------------------------------------------------- changelog
$changelog = [IO.File]::ReadAllText("$root\CHANGELOG.md")
$date = Get-Date -Format "yyyy-MM-dd"
if ($changelog -notmatch "## \[$([regex]::Escape($Version))\]") {
  # Move the Unreleased notes under the new version heading.
  $changelog = $changelog.Replace("## [Unreleased]", "## [Unreleased]`n`n## [$Version] - $date")
  $changelog = [regex]::Replace($changelog, '\[Unreleased\]: (.+?)/compare/v[\d.]+\.\.\.HEAD', "[Unreleased]: `$1/compare/$tag...HEAD`n[$Version]: `$1/compare/v$current...$tag")
  [IO.File]::WriteAllText("$root\CHANGELOG.md", $changelog)
}
$notes = [regex]::Match($changelog, "(?s)## \[$([regex]::Escape($Version))\][^\n]*\n(.*?)(?=\n## \[)").Groups[1].Value.Trim()
if (-not $notes) { $notes = "Celer $Version" }

# ---------------------------------------------------------------- checks
if (-not $SkipTests) {
  Step "Comprobaciones"
  node node_modules/typescript/bin/tsc --noEmit -p .; Check ($LASTEXITCODE -eq 0) "tsc (app) falló"
  node node_modules/typescript/bin/tsc --noEmit -p installer; Check ($LASTEXITCODE -eq 0) "tsc (instalador) falló"
  Push-Location src-tauri; cargo test --lib -q; $ok = $LASTEXITCODE -eq 0; Pop-Location; Check $ok "cargo test falló"
}

# ---------------------------------------------------------------- builds
Step "Compilando Celer"
# The release embeds the JDBC bridge (src-tauri/build.rs compiles it with javac): a JDK 11+ is needed.
$javac = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME "bin\javac.exe" } else { "" }
Check ($env:CELER_BRIDGE_JAR -or ($javac -and (Test-Path $javac)) -or (Get-Command javac -ErrorAction SilentlyContinue)) "Falta un JDK 11+ (JAVA_HOME o javac en el PATH) para el puente JDBC"
Get-Process celer -ErrorAction SilentlyContinue | Stop-Process -Force
node node_modules/@tauri-apps/cli/tauri.js build; Check ($LASTEXITCODE -eq 0) "tauri build falló"

Step "Compilando Celer Setup"
node node_modules/vite/bin/vite.js build --config installer/vite.config.ts; Check ($LASTEXITCODE -eq 0) "vite build del instalador falló"
$env:CELER_PAYLOAD = "$env:CARGO_TARGET_DIR\release\celer.exe"
cargo build --release --manifest-path installer/src-tauri/Cargo.toml; Check ($LASTEXITCODE -eq 0) "build del instalador falló"

$out = "$root\release\$tag"
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item "$env:CARGO_TARGET_DIR\release\celer-setup.exe" "$out\Celer-Setup-$Version.exe" -Force
Copy-Item "$env:CARGO_TARGET_DIR\release\bundle\nsis\Celer_$($Version)_x64-setup.exe" "$out\Celer-$Version-nsis-setup.exe" -Force
Copy-Item "$env:CARGO_TARGET_DIR\release\celer.exe" "$out\Celer-$Version-portable.exe" -Force
# MSI (per machine, for IT deployments / GPO): name carries the WiX language, e.g. Celer_1.2.0_x64_es-ES.msi.
$msi = Get-ChildItem "$env:CARGO_TARGET_DIR\release\bundle\msi" -Filter "Celer_$($Version)_x64_*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
Check ($null -ne $msi) "No se generó el paquete MSI"
Copy-Item $msi.FullName "$out\Celer-$Version-x64.msi" -Force
$sums = Get-ChildItem $out -File | Where-Object { $_.Extension -in ".exe", ".msi" } | ForEach-Object { "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower())  $($_.Name)" }
Set-Content "$out\SHA256SUMS.txt" $sums -Encoding ascii
Get-ChildItem $out | ForEach-Object { "{0,-34} {1,8:N1} MB" -f $_.Name, ($_.Length / 1MB) }

# ---------------------------------------------------------------- git + GitHub
Step "Commit y etiqueta $tag"
& $git add -A
# Message through a file: PowerShell 5 mangles quotes in native arguments (the notes have them).
$msgFile = "$out\COMMIT_MSG.txt"
[IO.File]::WriteAllText($msgFile, "chore(release): $tag`n`n$notes`n", [Text.UTF8Encoding]::new($false))
& $git commit -q -F $msgFile; Check ($LASTEXITCODE -eq 0) "git commit falló"
& $git tag -a $tag -m "Celer $Version"; Check ($LASTEXITCODE -eq 0) "git tag falló"
if ($NoPublish) { Write-Host "Etiquetado localmente (sin publicar)."; exit 0 }

$branch = & $git rev-parse --abbrev-ref HEAD
& $git push -q origin $branch; Check ($LASTEXITCODE -eq 0) "git push falló"
& $git push -q origin $tag; Check ($LASTEXITCODE -eq 0) "git push de la etiqueta falló"

Step "GitHub Release"
$notesFile = "$out\NOTES.md"
[IO.File]::WriteAllText($notesFile, "$notes`n`n---`n**Install**`n" +
  "- **Windows:** ``Celer-Setup-$Version.exe`` (per user, no administrator rights, updates itself). Also ``Celer-$Version-x64.msi`` (per machine, for IT deployments), ``Celer-$Version-nsis-setup.exe`` and ``Celer-$Version-portable.exe``.`n" +
  "- **macOS / Linux:** packages are built on demand and attached here when available.`n`n" +
  "Verify the downloads with ``SHA256SUMS.txt``.", [Text.UTF8Encoding]::new($false))
$assets = Get-ChildItem $out -File | Where-Object { $_.Name -notin "NOTES.md", "COMMIT_MSG.txt" } | ForEach-Object { $_.FullName }
$args = @("release", "create", $tag) + $assets + @("--title", "Celer $Version", "--notes-file", $notesFile, "--target", $branch)
if ($Draft) { $args += "--draft" }
& $gh @args; Check ($LASTEXITCODE -eq 0) "gh release create falló"
Write-Host "`nPublicado: Celer $Version" -ForegroundColor Green
