#!/bin/sh
set -eu

base="/opt/recharge-platform"
project="${1:-$base/current}"
backup="${2:-}"

if [ -z "$backup" ]; then
  backup="$(find "$base/production-backups" -maxdepth 1 -type f -name 'quefa-*.dump' -printf '%T@ %p\n' \
    | sort -nr | head -n 1 | cut -d' ' -f2-)"
fi
if [ -z "$backup" ] || [ ! -s "$backup" ]; then
  printf '%s\n' 'No non-empty production backup was found.' >&2
  exit 1
fi

test_db="quefa_restore_$(date -u +%Y%m%d%H%M%S)"
cd "$project"

drop_test_database() {
  docker compose -f compose.production.infra.yaml exec -T postgres \
    sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_owner_password)"; dropdb --if-exists --username quefa_owner "$1"' sh "$test_db" >/dev/null 2>&1 || true
}
trap drop_test_database EXIT HUP INT TERM

docker compose -f compose.production.infra.yaml exec -T postgres \
  sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_owner_password)"; createdb --username quefa_owner "$1"' sh "$test_db"

docker compose -f compose.production.infra.yaml exec -T postgres \
  sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_owner_password)"; exec pg_restore --exit-on-error --no-owner --username quefa_owner --dbname "$1"' sh "$test_db" < "$backup"

migration_count="$(docker compose -f compose.production.infra.yaml exec -T postgres \
  sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_owner_password)"; exec psql --username quefa_owner --dbname "$1" --tuples-only --no-align --set ON_ERROR_STOP=1 --command="SELECT count(*) FROM schema_migrations"' sh "$test_db")"
if [ "$migration_count" != "5" ]; then
  printf '%s\n' "Restore verification failed: migration_count=$migration_count" >&2
  exit 1
fi

printf '%s\n' "restore_test=ok migration_count=$migration_count"
