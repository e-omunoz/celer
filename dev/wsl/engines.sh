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
  # A second database (postgres.rs pg_metadata), as dev/testdb-postgres.ps1 makes for the portable server.
  docker exec celer-pg psql -q -U celer -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'analytics'" | grep -q 1 ||
    docker exec celer-pg psql -q -U celer -d postgres -c 'CREATE DATABASE analytics'
  docker exec celer-pg psql -q -U celer -d analytics -c "CREATE SCHEMA IF NOT EXISTS reporting; CREATE TABLE IF NOT EXISTS reporting.daily_visits (day date PRIMARY KEY, visits int NOT NULL); INSERT INTO reporting.daily_visits SELECT d::date, (random()*1000)::int FROM generate_series(date '2026-01-01', date '2026-03-31', interval '1 day') d ON CONFLICT DO NOTHING;"
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
  # IBM's CLI driver links libxml2.so.2; Ubuntu 26.04 ships only libxml2.so.16 (a different ABI). $D/compat gets the
  # real 2.9 library from the Informix container (same x86_64 glibc), once.
  if ! ldconfig -p | grep -q 'libxml2.so.2 ' && { [ ! -f "$D/compat/libxml2.so.2" ] || [ -L "$D/compat/libxml2.so.2" ]; }; then
    mkdir -p "$D/compat" && rm -f "$D/compat/libxml2.so.2" && docker cp -L celer-ifx:/usr/lib64/libxml2.so.2 "$D/compat/libxml2.so.2" >/dev/null
  fi
  export CELER_IBM_LIB="$D/clidriver/lib/libdb2.so" LD_LIBRARY_PATH="$D/clidriver/lib:$D/compat"
  # Generic ODBC: PostgreSQL through unixODBC and psqlODBC (setup.sh installs odbc-postgresql).
  if odbcinst -q -d 2>/dev/null | grep -q 'PostgreSQL Unicode'; then
    export CELER_ODBC_TEST="Driver={PostgreSQL Unicode};Server=localhost;Port=15432;Database=celer;Uid=celer;Pwd=celer;"
  fi
  export CELER_JAVA="$(dirname "$(readlink -f "$(command -v java)")")/java"
  export CELER_JDBC_JARS="$D/jdbc/jdbc-15.0.1.4.jar:$D/jdbc/bson-3.8.0.jar"
  export CELER_REQUIRE_BRIDGE=1 CELER_NODE=node CELER_INFORMIX_CONTAINER=celer-ifx
}

case "${1:-status}" in
  up) $C up -d; wait_all; echo "engines ready" ;;
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
    # MySQL and MariaDB are different engines for Celer: the MySQL tests run against both. Both runs always go to
    # the end (a failure in the first must not hide the second); the summary counts per module, i.e. per engine.
    logs=$(mktemp -d); status=0
    CELER_MYSQL_TEST="mysql://celer:celer@127.0.0.1:33306/celer" cargo test --lib $filter -- --test-threads=1 2>&1 | tee "$logs/all.log" || status=1
    CELER_MYSQL_TEST="mysql://celer:celer@127.0.0.1:33307/celer" cargo test --lib mysql -- --test-threads=1 2>&1 | tee "$logs/mariadb.log" || status=1
    echo; echo "== engine summary (first run: every test, mysql::* on MySQL 8.4; second run: mysql::* on MariaDB 11.4)"
    for run in all mariadb; do
      awk -v run="$run" '/^test .* \.\.\. (ok|FAILED|ignored)$/ { split($2, p, "::"); m = (run == "mariadb" ? "mariadb (" p[1] ")" : p[1]); n[m]++; if ($NF == "FAILED") { f[m]++; bad[m] = bad[m] " " $2 } else if ($NF == "ignored") i[m]++ }
        END { for (m in n) printf "  %-22s %3d ok  %2d failed  %2d ignored%s\n", m, n[m] - f[m] - i[m], f[m], i[m], (f[m] ? "  ->" bad[m] : "") }' "$logs/$run.log" | sort
    done
    rm -rf "$logs"
    [ $status -eq 0 ] && echo "ALL ENGINES PASS" || { echo "SOME ENGINE FAILED (see summary)"; exit 1; }
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
