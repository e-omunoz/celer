#!/usr/bin/env bash
# Provisions the Celer WSL development distro. Run as root (dev\wsl.ps1 setup does it); safe to run again.
#   setup.sh <windows repo as /mnt/c/...> [user]
# System part (root): Linux toolchain the CI uses (WebKitGTK deps, Java 21, Node 22), Docker for the database engines
# (dev/wsl/compose.yml), GitHub CLI. User part: Rust, the IBM CLI driver and Informix JDBC jars in ~/celer-drivers,
# and the repo in ~/celer (origin = GitHub, win = the Windows checkout).
set -euo pipefail
WIN_REPO="${1:?path of the Windows repo as /mnt/c/...}"
U="${2:-$(getent passwd 1000 | cut -d: -f1)}"
[ -n "$U" ] || { echo "no regular user in the distro"; exit 1; }
H="$(getent passwd "$U" | cut -d: -f6)"
export DEBIAN_FRONTEND=noninteractive

# systemd, so Docker runs as a service; Windows PATH out of the way of the Linux toolchain.
if ! grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null; then
  printf '[boot]\nsystemd=true\n[interop]\nappendWindowsPath=false\n[user]\ndefault=%s\n' "$U" > /etc/wsl.conf
  echo "RESTART_NEEDED"
fi

apt-get update -q
apt-get install -y -q build-essential curl wget git pkg-config file unzip jq ca-certificates gnupg \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libdbus-1-dev libssl-dev rpm \
  openjdk-21-jdk-headless unixodbc unixodbc-dev odbc-postgresql docker.io docker-compose-v2 \
  postgresql-client mariadb-client xvfb

if ! node --version 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if ! command -v gh >/dev/null; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -q && apt-get install -y -q gh
fi

usermod -aG docker "$U"
systemctl enable --now docker 2>/dev/null || service docker start || true

# ---------------------------------------------------------------- user part
su - "$U" -s /bin/bash -c "WIN_REPO='$WIN_REPO' bash -s" <<'USER'
set -euo pipefail
if [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --component clippy,rustfmt
fi

# Drivers exactly as Celer downloads them (same URLs and SHA-256 as .github/workflows/engines.yml).
D="$HOME/celer-drivers"
mkdir -p "$D/jdbc"
[ -d "$D/clidriver" ] || curl -fsSL https://public.dhe.ibm.com/ibmdl/export/pub/software/data/db2/drivers/odbc_cli/linuxx64_odbc_cli.tar.gz | tar xz -C "$D"
cd "$D/jdbc"
[ -f jdbc-15.0.1.4.jar ] || curl -fsSLO https://repo1.maven.org/maven2/com/ibm/informix/jdbc/15.0.1.4/jdbc-15.0.1.4.jar
[ -f bson-3.8.0.jar ] || curl -fsSLO https://repo1.maven.org/maven2/org/mongodb/bson/3.8.0/bson-3.8.0.jar
echo "152fe3380e414261266d7bde6bacae348c94b6db0cf16f969d1094368449cec7  jdbc-15.0.1.4.jar" | sha256sum -c
echo "d30b5aeba3ae9b7c68c8a6103b41918c5f7318972007b9b92033ee861762d87e  bson-3.8.0.jar" | sha256sum -c

# The repo on the Linux file system. Cloned from the Windows checkout (no credentials needed); origin is GitHub.
git config --global --add safe.directory "$WIN_REPO"
git config --global --get user.name >/dev/null || git config --global user.name "$(git -C "$WIN_REPO" config user.name)"
git config --global --get user.email >/dev/null || git config --global user.email "$(git -C "$WIN_REPO" config user.email)"
if [ ! -d "$HOME/celer/.git" ]; then
  git clone -q "$WIN_REPO" "$HOME/celer"
  git -C "$HOME/celer" remote rename origin win
  git -C "$HOME/celer" remote add origin https://github.com/e-omunoz/celer.git
fi
git -C "$HOME/celer" config credential.https://github.com.helper '!gh auth git-credential'
cd "$HOME/celer" && npm ci --no-audit --no-fund >/dev/null
# Claude Code, to work from inside WSL (sign in on first run).
command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ] || curl -fsSL https://claude.ai/install.sh | bash
USER

echo "SETUP_OK user=$U repo=$H/celer"
