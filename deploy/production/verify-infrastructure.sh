#!/bin/sh
set -eu

base="/opt/recharge-platform"
release_dir="${1:-$base/current}"
cd "$release_dir"

docker compose -f compose.production.infra.yaml ps
docker compose -f compose.production.infra.yaml exec -T postgres \
  sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_owner_password)"; exec psql --username quefa_owner --dbname quefa --tuples-only --set ON_ERROR_STOP=1' <<'SQL'
SELECT 'migration=' || version FROM schema_migrations ORDER BY version;
SELECT 'app_role_super=' || rolsuper || ',bypass_rls=' || rolbypassrls
FROM pg_roles WHERE rolname = 'quefa_app';
SELECT 'forced_rls_tables=' || count(*)
FROM pg_class WHERE relrowsecurity AND relforcerowsecurity;
SQL

app_login="$(docker compose -f compose.production.infra.yaml exec -T postgres \
  sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_app_password)"; exec psql --username quefa_app --dbname quefa --tuples-only --no-align --set ON_ERROR_STOP=1 --command="SELECT current_user"')"
if [ "$app_login" != "quefa_app" ]; then
  printf '%s\n' "Application role login failed: $app_login" >&2
  exit 1
fi
printf '%s\n' 'app_login=quefa_app'

redis_result="$(docker compose -f compose.production.infra.yaml exec -T redis \
  redis-cli --user health --pass '' --no-auth-warning ping)"
if [ "$redis_result" != "PONG" ]; then
  printf '%s\n' "Redis health authentication failed: $redis_result" >&2
  exit 1
fi
printf '%s\n' 'redis_health=PONG'

postgres_container="$(docker compose -f compose.production.infra.yaml ps -q postgres)"
redis_container="$(docker compose -f compose.production.infra.yaml ps -q redis)"
if [ -n "$(docker port "$postgres_container")" ]; then
  printf '%s\n' 'PostgreSQL must not publish a host port.' >&2
  exit 1
fi
if [ -n "$(docker port "$redis_container")" ]; then
  printf '%s\n' 'Redis must not publish a host port.' >&2
  exit 1
fi
printf '%s\n' 'host_ports=private'
