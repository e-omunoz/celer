#!/usr/bin/env bash
# Provisions the Celer WSL development distro (run as root by dev\wsl.ps1 setup; safe to run again).
# Installs the Linux toolchain the CI uses (Rust, Node 22, Java 21, Tauri's WebKitGTK deps), Docker for the database
# engines (dev/wsl/compose.yml), the IBM CLI driver and the Informix JDBC jars, and clones the Windows repo to
# ~/celer (fast Linux file system; synced with `dev\wsl.ps1 sync`).
set -euo pipefail
WIN_REPO="${1:?path of the Windows repo as /mnt/c/...}"
export DEBIAN_FRONTEND=noninteractive

# systemd, so Docker runs as a service; Windows PATH out of the way of Linux tools.
if ! grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null; then
  printf '[boot]\nsystemd=true\n[interop]\nappendWindowsPath=false\n' > /etc/wsl.conf
  echo "RESTART_NEEDED"
fi

apt-get update -q
apt-get install -y -q build-essential curl wget git pkg-config file unzip jq ca-certificates \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libdbus-1-dev libssl-dev rpm \
  openjdk-21-jdk-headless unixodbc unixodbc-dev docker.io docker-compose-v2 \
  postgresql-client mariadb-client xvfb

# Node 22 (same major as CI).
if ! node --version 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

# Rust stable.
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

# Linux-side clone; the Windows repo is its "win" remote, so any local branch or worktree commit can be checked out.
if [ ! -d "$HOME/celer/.git" ]; then
  git config --global --add safe.directory "$WIN_REPO"
  git clone "$WIN_REPO" "$HOME/celer"
  git -C "$HOME/celer" remote rename origin win
fi

systemctl enable --now docker 2>/dev/null || service docker start || true
echo "SETUP_OK"
