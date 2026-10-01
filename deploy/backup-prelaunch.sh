#!/bin/sh
set -eu
umask 077
base=/opt/recharge-platform
database="$base/state/production.sqlite"
prefix="production-app"
if [ ! -f "$database" ]; then
  database="$base/state/prelaunch.sqlite"
  prefix="prelaunch"
fi
test -f "$database"
test -d "$base/backups"
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
snapshot="$base/backups/$prefix-$stamp.sqlite"
test ! -e "$snapshot"
sqlite3 "$database" ".timeout 10000" ".backup '$snapshot'"
test "$(sqlite3 "$snapshot" 'PRAGMA integrity_check;')" = ok
chmod 600 "$snapshot"
sha256sum "$snapshot" > "$snapshot.sha256"
chmod 600 "$snapshot.sha256"
cat "$snapshot.sha256"
# Deliberately keep encryption keys separate; never bundle config or credentials here.
# Local retention is bounded; encrypted off-site storage is still required before real-money use.
find "$base/backups" -type f \( -name 'prelaunch-*.sqlite' -o -name 'production-app-*.sqlite' \
  -o -name 'prelaunch-*.sqlite.sha256' -o -name 'production-app-*.sqlite.sha256' \
  -o -name 'prelaunch-*.sqlite.restore-report.json' -o -name 'production-app-*.sqlite.restore-report.json' \) -mtime +14 -delete
