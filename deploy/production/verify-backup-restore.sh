#!/bin/sh
# Verify the current SQLite application ledger by restoring a backup into an isolated temporary database.
set -eu
umask 077

base="/opt/recharge-platform"
project="${1:-$base/current}"
snapshot="${2:-}"
health="$base/state/sqlite-restore-health.json"
health_tmp="$health.$$.tmp"
verified=0

publish_failure() {
  code=$?
  trap - EXIT
  if [ "$verified" -ne 1 ]; then
    install -d -m 700 "$base/state"
    printf '{"status":"failed","checkedAt":"%s","failureCode":"restore_verification_failed"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$health_tmp"
    chmod 600 "$health_tmp"
    mv "$health_tmp" "$health"
  fi
  exit "$code"
}
trap publish_failure EXIT

if [ -z "$snapshot" ]; then
  snapshot="$(find "$base/backups" -maxdepth 1 -type f -name 'production-app-*.sqlite' -printf '%T@ %p\n' \
    | sort -nr | head -n 1 | cut -d' ' -f2-)"
fi
if [ -z "$snapshot" ] || [ ! -s "$snapshot" ]; then
  printf '%s\n' 'No non-empty SQLite application backup was found.' >&2
  exit 1
fi
test -f "$project/dist/cli/verify-sqlite-backup.js"

if [ -f "$snapshot.sha256" ]; then
  sha256sum -c "$snapshot.sha256"
fi
report="$snapshot.restore-report.json"
node "$project/dist/cli/verify-sqlite-backup.js" "$snapshot" --report "$report"
chmod 600 "$report"
cp "$report" "$health_tmp"
chmod 600 "$health_tmp"
mv "$health_tmp" "$health"
verified=1
printf '%s\n' "sqlite_restore_test=ok backup=$snapshot report=$report"
