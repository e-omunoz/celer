#!/usr/bin/env bash
# Linux/WSL twin of dev/release.ps1 (keep them in step). Prepares a Celer release and pushes its tag; the tag starts
# .github/workflows/release-desktop.yml, which builds Windows, macOS and Linux and publishes the GitHub Release.
#   bash dev/release.sh patch|minor|major      # bump and release
#   bash dev/release.sh --version 1.2.3        # release that exact version
#   … --no-push (commit and tag locally only)  … --allow-branch (release from a branch other than an up-to-date main)
set -euo pipefail
cd "$(dirname "$0")/.."
BUMP="" VERSION="" NO_PUSH=0 ALLOW_BRANCH=0
while [ $# -gt 0 ]; do
  case "$1" in
    patch|minor|major) BUMP="$1" ;;
    --version) VERSION="$2"; shift ;;
    --no-push) NO_PUSH=1 ;;
    --allow-branch) ALLOW_BRANCH=1 ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
  shift
done
die() { echo "error: $*" >&2; exit 1; }

# Releases come from main as it is on origin (same reasons as release.ps1).
if [ "$ALLOW_BRANCH" = 0 ]; then
  branch=$(git rev-parse --abbrev-ref HEAD)
  [ "$branch" = main ] || die "on branch '$branch': releases are made from main (or --allow-branch)"
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main does not match origin/main: pull (or push) first"
fi

current=$(node -p "require('./package.json').version")
if [ -z "$VERSION" ]; then
  IFS=. read -r MA MI PA <<<"$current"
  case "$BUMP" in
    major) VERSION="$((MA + 1)).0.0" ;;
    minor) VERSION="$MA.$((MI + 1)).0" ;;
    patch) VERSION="$MA.$MI.$((PA + 1))" ;;
    *) VERSION="$current" ;;
  esac
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid version: $VERSION"
TAG="v$VERSION"
[ -z "$(git tag --list "$TAG")" ] || die "tag $TAG already exists"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "uncommitted changes: commit or stash them first"
echo "== Celer $current -> $VERSION"

# Manifests, lockfiles and CHANGELOG, with the same patterns as release.ps1.
NOTES_FILE=$(mktemp)
VERSION="$VERSION" CURRENT="$current" TAG="$TAG" NOTES_FILE="$NOTES_FILE" node <<'JS'
const fs = require('fs')
const { VERSION: v, CURRENT: cur, TAG: tag, NOTES_FILE } = process.env
const edit = (f, fn) => { if (fs.existsSync(f)) fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8'))) }
for (const f of ['package.json', 'src-tauri/tauri.conf.json', 'installer/src-tauri/tauri.conf.json'])
  edit(f, t => t.replace(/"version": "[^"]+"/, `"version": "${v}"`))
for (const f of ['src-tauri/Cargo.toml', 'installer/src-tauri/Cargo.toml'])
  edit(f, t => t.replace(/^version = "[^"]+"/m, `version = "${v}"`))
for (const [f, name] of [['src-tauri/Cargo.lock', 'celer'], ['installer/src-tauri/Cargo.lock', 'celer-setup']])
  edit(f, t => t.replace(new RegExp(`(^name = "${name}"\\r?\\nversion = ")[^"]+"`, 'm'), `$1${v}"`))
edit('package-lock.json', t => t
  .replace(/^(\{\s*"name": "celer",\s*"version": ")[^"]+"/, `$1${v}"`)
  .replace(/("": \{\s*"name": "celer",\s*"version": ")[^"]+"/, `$1${v}"`))
let cl = fs.readFileSync('CHANGELOG.md', 'utf8')
const esc = v.replace(/\./g, '\\.')
if (!new RegExp(`## \\[${esc}\\]`).test(cl)) {
  const d = new Date(), date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  cl = cl.replace('## [Unreleased]', `## [Unreleased]\n\n## [${v}] - ${date}`)
  cl = cl.replace(/\[Unreleased\]: (.+?)\/compare\/v[\d.]+\.\.\.HEAD/, `[Unreleased]: $1/compare/${tag}...HEAD\n[${v}]: $1/compare/v${cur}...${tag}`)
  fs.writeFileSync('CHANGELOG.md', cl)
}
const m = cl.match(new RegExp(`## \\[${esc}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[)`))
fs.writeFileSync(NOTES_FILE, `chore(release): ${tag}\n\n${(m && m[1].trim()) || `Celer ${v}`}\n`)
JS

echo "== Commit and tag $TAG"
git add package.json src-tauri/tauri.conf.json installer/src-tauri/tauri.conf.json src-tauri/Cargo.toml installer/src-tauri/Cargo.toml \
  src-tauri/Cargo.lock installer/src-tauri/Cargo.lock package-lock.json CHANGELOG.md
git commit -q -F "$NOTES_FILE"
rm -f "$NOTES_FILE"
git tag -a "$TAG" -m "Celer $VERSION"
if [ "$NO_PUSH" = 1 ]; then echo "Tagged locally. To publish: git push origin HEAD $TAG"; exit 0; fi
git push -q origin "$(git rev-parse --abbrev-ref HEAD)"
git push -q origin "$TAG"
echo "Tag $TAG pushed. GitHub Actions builds and publishes it: https://github.com/e-omunoz/celer/actions/workflows/release-desktop.yml"
