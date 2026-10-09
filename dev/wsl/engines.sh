#!/usr/bin/env bash
# Runs inside the WSL distro (called by dev\wsl.ps1). Database engines in Docker and the Linux-side checks.
#   engines.sh up | down | status | seed | env
#   engines.sh test [cargo test filter]   logic checks, typecheck and cargo tests against EVERY engine
#   engines.sh build                      Linux packages (deb, rpm, AppImage) into ~/celer-out/linux
set -euo pipefail
cd "$(dirname "$0")/../.."          # repo root (~/celer)
export PATH="$HOME/.cargo/bin:$PATH"
C="docker compose -f dev/wsl/compose.yml"
D="$HOME/celer-drivers"
MSSQL_PASSWORD='Celer_Test_2026!'

# The SSH bastion's test key (compose.yml mounts its public half as authorized_keys).
ssh_key() {
  mkdir -p "$D/ssh"
  [ -f "$D/ssh/id_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -C celer-engines -f "$D/ssh/id_ed25519"
  cp "$D/ssh/id_ed25519.pub" "$D/ssh/authorized_keys"
  chmod 644 "$D/ssh/authorized_keys"
}

wait_all() {
  for i in $(seq 1 60); do docker exec celer-pg pg_isready -U celer >/dev/null 2>&1 && break; sleep 2; done
  for c in celer-mysql celer-mariadb; do
    for i in $(seq 1 60); do docker exec $c sh -c 'mysqladmin ping -uroot -pceler 2>/dev/null || mariadb-admin ping -uroot -pceler' >/dev/null 2>&1 && break; sleep 2; done
  done
  for i in $(seq 1 60); do docker exec celer-mssql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_PASSWORD" -Q "SELECT 1" >/dev/null 2>&1 && break; sleep 5; done
  for i in $(seq 1 90); do docker exec celer-ifx bash -lc "echo 'SELECT COUNT(*) FROM systables' | dbaccess sysmaster -" >/dev/null 2>&1 && break; sleep 5; done
}

seed() {
  docker exec -i celer-pg psql -q -U celer -d celer < dev/seed-postgres.sql
  # The seed is written for MariaDB; MySQL has no UUID type, so that column becomes CHAR(36) there.
  sed -E 's/\bUUID NULL\b/CHAR(36) NULL/' dev/seed-mysql.sql | docker exec -i celer-mysql mysql -uroot -pceler 2>&1 | grep -v 'Using a password' || true
  docker exec celer-mysql mysql -uroot -pceler -N -e "SELECT COUNT(*) FROM celer.type_zoo" 2>/dev/null | grep -q 3 || { echo "MySQL seed failed"; exit 1; }
  docker exec -i celer-mariadb mariadb -uroot -pceler < dev/seed-mysql.sql
  docker exec -i celer-mssql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_PASSWORD" -i /dev/stdin < dev/seed-mssql.sql
  docker exec celer-ifx bash -lc "echo 'CREATE DATABASE celer WITH LOG' | dbaccess sysmaster - 2>/dev/null || true"
  docker exec -i celer-ifx bash -lc "dbaccess - -" < dev/seed-informix.sql
}

engine_env() {
  local ifx_ip; ifx_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' celer-ifx)
  export CELER_PG_TEST="host=localhost port=15432 user=celer password=celer dbname=celer"
  export CELER_MSSQL_TEST="host=localhost port=1433 user=sa password=$MSSQL_PASSWORD"
  export CELER_INFORMIX_TEST="host=localhost port=9089 user=informix password=in4mix database=celer"
  export CELER_INFORMIX_JDBC_TEST="host=$ifx_ip port=9088 user=informix password=in4mix database=celer server=informix proxied=localhost"
  # compat: libraries the IBM CLI needs that newer distributions dropped (libxml2.so.2), when setup put them there.
  export CELER_IBM_LIB="$D/clidriver/lib/libdb2.so" LD_LIBRARY_PATH="$D/clidriver/lib:$D/compat"
  export CELER_JAVA="$(dirname "$(readlink -f "$(command -v java)")")/java"
  export CELER_JDBC_JARS="$D/jdbc/jdbc-15.0.1.4.jar:$D/jdbc/bson-3.8.0.jar"
  export CELER_REQUIRE_BRIDGE=1 CELER_NODE=node CELER_INFORMIX_CONTAINER=celer-ifx
  # SSH tunnels (engine_tests.rs ssh_tunnel_*): the bastion, and each engine as only the bastion sees it.
  export CELER_SSH_TEST="host=localhost port=2222 user=celer password=celer key=$D/ssh/id_ed25519 container=celer-sshd pg=celer-pg:5432 mysql=celer-mysql:3306 mariadb=celer-mariadb:3306 mssql=celer-mssql:1433 ifx=celer-ifx"
}

case "${1:-status}" in
  up) ssh_key; $C up -d --build; wait_all; echo "engines ready" ;;
  down) $C down ;;
  status) $C ps ;;
  seed) seed; echo "seeded" ;;
  env) engine_env; env | grep '^CELER_' ;;
  test)
    filter="${2:-}"
    [ -d node_modules ] && [ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-audit --no-fund
    for f in dev/*-check.ts; do node --experimental-strip-types --no-warnings "$f" >/dev/null || { echo "FAIL $f"; exit 1; }; done
    npx tsc --noEmit -p .
    engine_env
    cd src-tauri
    cargo test --lib --no-run -q   # build outside the lock
    # The engines are shared by every checkout: integration runs take turns.
    exec 9>/tmp/celer-engines.lock
    flock 9
    # MySQL and MariaDB are different engines for Celer: the MySQL tests run against both.
    CELER_MYSQL_TEST="mysql://celer:celer@127.0.0.1:33306/celer" cargo test --lib $filter -- --test-threads=1
    CELER_MYSQL_TEST="mysql://celer:celer@127.0.0.1:33307/celer" cargo test --lib mysql -- --test-threads=1
    ;;
  build)
    [ -d node_modules ] || npm ci --no-audit --no-fund
    npx tauri build
    mkdir -p "$HOME/celer-out/linux"
    cp src-tauri/target/release/bundle/{deb/*.deb,rpm/*.rpm,appimage/*.AppImage} "$HOME/celer-out/linux/" 2>/dev/null || true
    ls -la "$HOME/celer-out/linux"
    ;;
  *) echo "usage: engines.sh up|down|status|seed|env|test [filter]|build"; exit 2 ;;
esac
