#!/bin/sh
# Application-only release. Never rewrites production.env or restores a live ledger.
set -eu
release="${1:?release required}"
image="${2:?candidate image required}"
commercial_migration="${3:-none}"
case "$commercial_migration" in none|subscription-pricing|confirmed-test-archive) ;; *) exit 2;; esac
case "$release" in /opt/recharge-platform/releases/audit-fixes-*) ;; *) exit 2;; esac
case "$image" in recharge-platform:audit-fixes-*) ;; *) exit 2;; esac
test "$(readlink -f "$release")" = "$release"
test -f "$release/compose.production.app.yaml"
docker image inspect "$image" >/dev/null
base=/opt/recharge-platform
old_release=$(readlink -f "$base/current")
case "$old_release" in /opt/recharge-platform/releases/*) ;; *) exit 2;; esac
old_image=$(docker inspect --format '{{.Image}}' quefa-app-api-1)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
rollback_tag="recharge-platform:before-audit-$stamp"
docker tag "$old_image" "$rollback_tag"
install -d -m 700 "$base/backups"
backup="$base/backups/before-audit-$stamp.sqlite"
sqlite3 "$base/state/production.sqlite" ".timeout 10000" ".backup '$backup'"
test "$(sqlite3 "$backup" 'PRAGMA integrity_check;')" = ok
chmod 600 "$backup"
rollback=1
restore_application() {
  if [ "$rollback" -ne 1 ]; then return; fi
  docker tag "$old_image" recharge-platform:production
  ln -sfn "$old_release" "$base/current.audit-rollback"
  mv -Tf "$base/current.audit-rollback" "$base/current"
  cd "$base/current"
  docker compose -p quefa-app -f compose.production.app.yaml up -d --no-build --force-recreate api worker || true
  printf '%s\n' 'Candidate failed; prior application restored. Live database was not rolled back.' >&2
}
trap restore_application EXIT HUP INT TERM
cd "$base/current"
docker compose -p quefa-app -f compose.production.app.yaml stop -t 60 worker
if [ "$commercial_migration" != none ]; then
  # Pause new orders while changing commercial configuration. No order or ledger is rewritten.
  docker compose -p quefa-app -f compose.production.app.yaml stop -t 20 api
  migration_cli=dist/cli/apply-subscription-pricing.js
  if [ "$commercial_migration" = confirmed-test-archive ]; then migration_cli=dist/cli/archive-confirmed-test-orders.js; fi
  docker run --rm --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges:true \
    --env-file "$base/config/production.env" -e NODE_ENV=production -e EXECUTION_MODE=production \
    -e STORAGE_DRIVER=sqlite -e SQLITE_PATH=/app/data/production.sqlite \
    -e CONFIRM_TEST_ARCHIVE=screenshot-seven-20260930 \
    -v "$base/state:/app/data" "$image" node "$migration_cli"
fi
docker tag "$image" recharge-platform:production
ln -sfn "$release" "$base/current.audit-next"
mv -Tf "$base/current.audit-next" "$base/current"
cd "$base/current"
docker compose -p quefa-app -f compose.production.app.yaml up -d --no-build --no-deps --force-recreate api
attempt=0
until curl -fsS http://127.0.0.1:3200/health/ready >/dev/null; do
  attempt=$((attempt+1));test "$attempt" -lt 20;sleep 3
done
curl -fsS http://127.0.0.1:3200/developers >/dev/null
curl -fsS http://127.0.0.1:3200/developers/openapi.yaml >/dev/null
docker compose -p quefa-app -f compose.production.app.yaml up -d --no-build --no-deps --force-recreate worker
test "$(docker inspect --format '{{.State.Running}}' quefa-app-worker-1)" = true
rollback=0
trap - EXIT HUP INT TERM
printf 'release=%s\nbackup=%s\nrollback_image=%s\nprevious_release=%s\n' "$release" "$backup" "$rollback_tag" "$old_release"
