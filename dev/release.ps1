# Prepares a Celer release and pushes its tag. Nothing is built here: the tag starts .github/workflows/release-desktop.yml,
# which builds Windows, macOS and Linux on GitHub Actions and publishes the GitHub Release with the packages.
#   powershell -ExecutionPolicy Bypass -File dev\release.ps1 -Bump minor        # 1.1.0 -> 1.2.0
#   powershell -ExecutionPolicy Bypass -File dev\release.ps1 -Version 1.1.0     # release the current version
#   … -NoPush  (commit and tag locally only; push them yourself later)
#   … -AllowBranch  (release from a branch other than an up-to-date main; the release is built from that branch)
param(
  [ValidateSet("", "patch", "minor", "major")][string]$Bump = "",
  [string]$Version = "",
  [switch]$NoPush,
  [switch]$AllowBranch
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$tools = "$env:LOCALAPPDATA\celer-tools"
$git = if (Test-Path "$tools\git\cmd\git.exe") { "$tools\git\cmd\git.exe" } else { "git" }
Set-Location $root

function Step($text) { Write-Host "`n== $text" -ForegroundColor DarkYellow }
function Check($ok, $text) { if (-not $ok) { throw $text } }

# ---------------------------------------------------------------- branch
# Releases come from main as it is on origin: a tag on a feature branch would publish unmerged code and leave main's
# manifests behind (the next release from main would compute the same version again).
if (-not $AllowBranch) {
  $branch = & $git rev-parse --abbrev-ref HEAD
  Check ($branch -eq "main") "Estás en la rama '$branch': las versiones se publican desde main (o usa -AllowBranch)"
  & $git fetch -q origin main; Check ($LASTEXITCODE -eq 0) "git fetch origin main falló"
  Check ((& $git rev-parse HEAD) -eq (& $git rev-parse origin/main)) "main no coincide con origin/main: haz pull (o push) antes de publicar"
}

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
Check (-not (& $git status --porcelain --untracked-files=no)) "Hay cambios sin confirmar: confírmalos o guárdalos antes de publicar"
Step "Celer $current -> $Version"

# Every manifest gets the release version (also when it is not a bump: keeps the installer in sync). The workflow
# refuses a tag that does not match them.
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
# The workflow takes the release notes from this section of CHANGELOG.md.
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

# ---------------------------------------------------------------- git
Step "Commit y etiqueta $tag"
& $git add package.json src-tauri/tauri.conf.json installer/src-tauri/tauri.conf.json src-tauri/Cargo.toml installer/src-tauri/Cargo.toml CHANGELOG.md
# Message through a file: PowerShell 5 mangles quotes in native arguments (the notes have them).
$msgFile = Join-Path ([IO.Path]::GetTempPath()) "celer-release-$Version.txt"
[IO.File]::WriteAllText($msgFile, "chore(release): $tag`n`n$notes`n", [Text.UTF8Encoding]::new($false))
& $git commit -q -F $msgFile; Check ($LASTEXITCODE -eq 0) "git commit falló"
Remove-Item $msgFile -ErrorAction SilentlyContinue
& $git tag -a $tag -m "Celer $Version"; Check ($LASTEXITCODE -eq 0) "git tag falló"
if ($NoPush) { Write-Host "Etiquetado localmente. Para publicar: git push origin HEAD $tag"; exit 0 }

$branch = & $git rev-parse --abbrev-ref HEAD
& $git push -q origin $branch; Check ($LASTEXITCODE -eq 0) "git push falló"
& $git push -q origin $tag; Check ($LASTEXITCODE -eq 0) "git push de la etiqueta falló"
Write-Host "`nEtiqueta $tag enviada. GitHub Actions compila y publica la versión:" -ForegroundColor Green
Write-Host "  https://github.com/e-omunoz/celer/actions/workflows/release-desktop.yml"
