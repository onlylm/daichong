#!/bin/sh
set -eu
base="${1:?preview directory required}"
image="${2:?candidate image required}"
mode="${3:-fresh}"
case "$mode" in fresh|resume-preparation) ;; *) exit 20;; esac
case "$base" in /opt/recharge-platform/previews/c8c3be3-20261002) ;; *) exit 20;; esac
test "$(realpath "$base")" = "$base"
test "$image" = quefa-preview:c8c3be3
# Reject host-side links before creating directories or exposing any bind mount.
for directory in data socket config snapshot tools; do
  target="$base/$directory"
  test ! -L "$target"
  if [ -e "$target" ]; then test -d "$target"; test "$(realpath "$target")" = "$target"; fi
done
for file in prepare-preview.mjs generate-env.mjs bridge.mjs; do
  target="$base/tools/$file"
  test -f "$target"; test ! -L "$target"; test "$(realpath "$target")" = "$target"
done
for file in data/preview.sqlite data/preview.sqlite-wal data/preview.sqlite-shm; do
  test ! -e "$base/$file"; test ! -L "$base/$file"
done
for file in snapshot/source.sqlite config/preview.env config/prepare.env config/access.txt snapshot/source.sha256; do
  test ! -L "$base/$file"
  if [ "$mode" = fresh ]; then test ! -e "$base/$file"; else test -s "$base/$file"; test -f "$base/$file"; test "$(realpath "$base/$file")" = "$base/$file"; fi
done
test ! -L "$base/preparation-report.json"
if [ -e "$base/preparation-report.json" ]; then test "$mode" = resume-preparation; test -f "$base/preparation-report.json"; test ! -s "$base/preparation-report.json"; fi
api=quefa-preview-c8c3be3-api
gateway=quefa-preview-c8c3be3-gateway
for container in "$api" "$gateway"; do
  if docker inspect "$container" >/dev/null 2>&1; then printf '%s\n' 'Existing preview container: refusing to replace it.' >&2; exit 21; fi
done
test ! -e "$base/data/preview.sqlite"
test -f "$base/tools/prepare-preview.mjs"
test -f "$base/tools/bridge.mjs"
test -f /opt/recharge-platform/state/production.sqlite
test -z "$(ss -H -ltn '( sport = :13200 )')"
old_api="$(docker inspect quefa-app-api-1 --format '{{.Id}} {{.Image}} {{.State.StartedAt}}')"
old_worker="$(docker inspect quefa-app-worker-1 --format '{{.Id}} {{.Image}} {{.State.StartedAt}}')"
old_release="$(readlink -f /opt/recharge-platform/current)"
install -d -o 1000 -g 1000 -m 700 "$base/data" "$base/socket" "$base/config" "$base/snapshot"

# Read-only connection and the SQLite backup API; never copy a live WAL database as an ordinary file.
if [ "$mode" = fresh ]; then
sqlite3 -readonly /opt/recharge-platform/state/production.sqlite '.timeout 10000' ".backup '$base/snapshot/source.sqlite'"
test "$(sqlite3 -readonly "$base/snapshot/source.sqlite" 'PRAGMA integrity_check;')" = ok
chown 1000:1000 "$base/snapshot/source.sqlite"
chmod 400 "$base/snapshot/source.sqlite"
sha256sum "$base/snapshot/source.sqlite" > "$base/snapshot/source.sha256"

docker run --rm --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --memory 128m --pids-limit 64 -e ISOLATED_PREVIEW=true \
  -v "$base/config:/preview-config" -v "$base/tools:/preview-tools:ro" \
  "$image" node /preview-tools/generate-env.mjs /preview-config
else
  # Resume only a failed, unpublished preparation; retain the original snapshot and secrets.
  sha256sum -c "$base/snapshot/source.sha256"
fi

docker run --rm --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --memory 768m --cpus 0.75 --pids-limit 128 --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --env-file "$base/config/prepare.env" -e SQLITE_PATH=/preview/data/preview.sqlite -e APP_ROOT=/app \
  -v "$base/snapshot/source.sqlite:/preview/source.sqlite:ro" -v "$base/data:/preview/data" \
  -v "$base/tools:/app/deploy/preview:ro" \
  "$image" node /app/deploy/preview/prepare-preview.mjs /preview/source.sqlite /preview/data/preview.sqlite > "$base/preparation-report.json"
sha256sum -c "$base/snapshot/source.sha256"

started=0
cleanup_failed_preview() {
  if [ "$started" -eq 1 ]; then docker rm -f "$gateway" "$api" >/dev/null 2>&1 || true; fi
}
trap cleanup_failed_preview EXIT HUP INT TERM
started=1
docker run -d --name "$api" --network none --read-only --user 1000:1000 --restart unless-stopped \
  --cap-drop ALL --security-opt no-new-privileges --memory 512m --cpus 0.75 --pids-limit 128 \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m --log-opt max-size=5m --log-opt max-file=2 \
  --env-file "$base/config/preview.env" -e APP_ROOT=/app \
  -v "$base/data:/app/data" -v "$base/socket:/run/quefa-preview" -v "$base/tools/bridge.mjs:/preview-tools/bridge.mjs:ro" \
  "$image" node /preview-tools/bridge.mjs api
docker run -d --name "$gateway" --network bridge --read-only --user 1000:1000 --restart unless-stopped \
  --cap-drop ALL --security-opt no-new-privileges --memory 128m --cpus 0.25 --pids-limit 64 \
  --log-opt max-size=5m --log-opt max-file=2 -p 127.0.0.1:13200:3200 \
  -v "$base/socket:/run/quefa-preview:ro" -v "$base/tools/bridge.mjs:/preview-tools/bridge.mjs:ro" \
  "$image" node /preview-tools/bridge.mjs gateway
attempt=0
until curl -fsS --connect-timeout 1 --max-time 3 http://127.0.0.1:13200/health/ready >/dev/null; do
  attempt=$((attempt+1)); if [ "$attempt" -ge 15 ]; then exit 22; fi
  sleep 2
done
test "$(docker inspect "$api" --format '{{.HostConfig.NetworkMode}}')" = none
docker exec "$api" node -e "const os=require('node:os');if(Object.keys(os.networkInterfaces()).some(x=>x!=='lo'))process.exit(1);const s=require('node:net').connect(80,'198.51.100.1');s.on('connect',()=>process.exit(2));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(3),2000);"
test "$(docker inspect quefa-app-api-1 --format '{{.Id}} {{.Image}} {{.State.StartedAt}}')" = "$old_api"
test "$(docker inspect quefa-app-worker-1 --format '{{.Id}} {{.Image}} {{.State.StartedAt}}')" = "$old_worker"
test "$(readlink -f /opt/recharge-platform/current)" = "$old_release"
sha256sum -c "$base/snapshot/source.sha256"
curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:3200/health/ready >/dev/null
started=0
trap - EXIT HUP INT TERM
printf '%s\n' 'preview_ready=127.0.0.1:13200 production_untouched=true worker_not_started=true real_channels_unreachable=true'
