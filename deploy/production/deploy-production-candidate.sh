#!/bin/sh
set -eu

base="/opt/recharge-platform"
release="${1:?candidate release path is required}"
candidate_image="${2:?candidate image tag is required}"
current="$base/current"
source_env="$base/config/prelaunch.env"
env_file="$base/config/production.env"
state="$base/state"

test -f "$release/compose.production.app.yaml"
test -f "$source_env"
docker image inspect "$candidate_image" >/dev/null

old_release="$(readlink -f "$current")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
old_mode="prelaunch"
old_project="recharge-prelaunch"
old_compose="compose.prelaunch.yaml"
old_container="recharge-prelaunch-api-1"
live_database="$state/prelaunch.sqlite"
if docker inspect quefa-app-api-1 >/dev/null 2>&1; then
  old_mode="production"
  old_project="quefa-app"
  old_compose="compose.production.app.yaml"
  old_container="quefa-app-api-1"
  live_database="$state/production.sqlite"
fi
old_image="$(docker inspect --format '{{.Image}}' "$old_container" 2>/dev/null || true)"
env_existed=0
if [ -f "$env_file" ]; then
  env_existed=1
  cp -p "$env_file" "$base/config/production.env.$stamp.bak"
else
  cp -p "$source_env" "$env_file"
fi
chmod 600 "$env_file"

replace_env() {
  key="$1"
  value="$2"
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi
}

replace_env NODE_ENV production
replace_env EXECUTION_MODE production
replace_env PUBLIC_BASE_URL https://tibo.ink
replace_env ADMIN_BASE_URL https://admin.tibo.ink
replace_env TRUST_PROXY true
replace_env TRUSTED_PROXY_CIDRS 127.0.0.0/8,::1/128,172.16.0.0/12
replace_env STORAGE_DRIVER sqlite
replace_env SQLITE_PATH /app/data/production.sqlite
replace_env BACKUP_HEALTH_REPORT_PATH /app/health/sqlite-restore-health.json
replace_env PAYMENT_PROVIDER managed
replace_env FULFILLMENT_PROVIDER zovocard
replace_env LIVE_TEST_ENABLED false
replace_env ENABLE_SANDBOX_ROUTES false
replace_env ZOVOCARD_API_BASE https://zovocard.com/openapi/v1
replace_env ZOVOCARD_CDK_BASE https://zovocard.com/api/v1/cdk

rollback=1
restore_previous_release() {
  if [ "$rollback" -ne 1 ]; then return; fi
  printf '%s\n' 'Production candidate failed; restoring the previous release.' >&2
  cd "$release" 2>/dev/null || true
  docker compose -p quefa-app -f compose.production.app.yaml down >/dev/null 2>&1 || true
  ln -sfn "$old_release" "$base/current.rollback"
  mv -Tf "$base/current.rollback" "$current"
  if [ "$env_existed" -eq 1 ]; then
    cp -p "$base/config/production.env.$stamp.bak" "$env_file"
  else
    rm -f "$env_file"
  fi
  if [ -n "$old_image" ]; then
    if [ "$old_mode" = production ]; then docker tag "$old_image" recharge-platform:production; fi
    cd "$old_release"
    docker compose -p "$old_project" -f "$old_compose" up -d --no-build >/dev/null 2>&1 || true
  fi
}
trap restore_previous_release EXIT HUP INT TERM

install -d -m 700 "$base/backups"
sqlite3 "$live_database" ".timeout 10000" ".backup '$base/backups/pre-production-$stamp.sqlite'"
test "$(sqlite3 "$base/backups/pre-production-$stamp.sqlite" 'PRAGMA integrity_check;')" = ok
chmod 600 "$base/backups/pre-production-$stamp.sqlite"

cd "$old_release"
docker compose -p "$old_project" -f "$old_compose" down

if [ "$old_mode" = prelaunch ] && [ ! -f "$state/production.sqlite" ]; then
  production_tmp="$state/production.sqlite.$stamp.tmp"
  sqlite3 "$state/prelaunch.sqlite" ".timeout 10000" ".backup '$production_tmp'"
  test "$(sqlite3 "$production_tmp" 'PRAGMA integrity_check;')" = ok
  chown --reference="$state/prelaunch.sqlite" "$production_tmp"
  chmod 600 "$production_tmp"
  mv "$production_tmp" "$state/production.sqlite"
fi
if [ "$old_mode" = prelaunch ]; then
  # A failed first switch may have left the copied database behind. Keep the
  # database owned by the same unprivileged account as the known-good source.
  chown --reference="$state/prelaunch.sqlite" "$state/production.sqlite"
  chmod 600 "$state/production.sqlite"
fi

docker tag "$candidate_image" recharge-platform:production
ln -sfn "$release" "$base/current.next"
mv -Tf "$base/current.next" "$current"

cd "$current"
release_started_at_ms="$(($(date -u +%s) * 1000))"
docker compose -p quefa-app -f compose.production.app.yaml up -d --no-build --remove-orphans

# Each HTTP call is bounded. Twenty attempts plus retry intervals can exceed
# 60 seconds; this is an attempt budget, not a 60-second wall-clock deadline.
attempt=0
until curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:3200/health/ready >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then
    printf '%s\n' 'Production API did not become ready after 20 attempts (HTTP connect timeout 2s, total timeout 5s per probe).' >&2
    exit 1
  fi
  sleep 3
done

attempt=0
worker_ready=0
while [ "$attempt" -lt 20 ]; do
  worker_snapshot="$(sqlite3 "$state/production.sqlite" "SELECT payload FROM sandbox_records WHERE kind='ops_worker_health' AND id='primary' LIMIT 1;" 2>/dev/null || true)"
  if [ -n "$worker_snapshot" ] \
      && printf '%s' "$worker_snapshot" | node deploy/production/check-worker-release-health.mjs "$release_started_at_ms" >/dev/null 2>&1 \
      && curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:3200/health/worker >/dev/null; then
    worker_ready=1
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -lt 20 ]; then sleep 3; fi
done
if [ "$worker_ready" -ne 1 ]; then
  printf '%s\n' 'Production Worker did not publish a fresh healthy heartbeat for every required lane after 20 attempts (HTTP connect timeout 2s, total timeout 5s per probe).' >&2
  exit 1
fi
worker_status="$(docker inspect --format '{{.State.Status}}' quefa-app-worker-1 2>/dev/null || true)"
if [ "$worker_status" != running ]; then
  printf '%s\n' "Production Worker container is not running: $worker_status" >&2
  exit 1
fi

curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:3200/developers >/dev/null
curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:3200/developers/openapi.yaml >/dev/null

rollback=0
trap - EXIT HUP INT TERM
printf '%s\n' "application_release=$release"
printf '%s\n' 'application_mode=production payment=managed fulfillment=zovocard channels=disabled_until_verified'
