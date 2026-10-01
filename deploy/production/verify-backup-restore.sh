#!/bin/sh
# Verify the current SQLite application ledger by restoring a backup into an isolated temporary database.
set -eu
umask 077

base="/opt/recharge-platform"
project="${1:-$base/current}"
snapshot="${2:-}"

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
printf '%s\n' "sqlite_restore_test=ok backup=$snapshot report=$report"
