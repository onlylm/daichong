#!/bin/sh
# Verify the current SQLite application ledger by restoring a backup into an isolated temporary database.
set -eu
umask 077

base="/opt/recharge-platform"
project="${1:-$base/current}"
snapshot="${2:-}"
summary_dir="$base/monitoring"
health="$summary_dir/sqlite-restore-health.json"
health_tmp="$health.$$.tmp"
verified=0

ownership_reference="$base/state/production.sqlite"
if [ ! -e "$ownership_reference" ]; then ownership_reference="$base/state/prelaunch.sqlite"; fi
test -e "$ownership_reference"

prepare_summary_target() {
  install -d -m 750 "$summary_dir"
  chown --reference="$ownership_reference" "$summary_dir"
}

publish_summary_file() {
  chmod 640 "$health_tmp"
  chown --reference="$ownership_reference" "$health_tmp"
  mv "$health_tmp" "$health"
}

publish_failure() {
  code=$?
  trap - EXIT
  if [ "$verified" -ne 1 ]; then
    prepare_summary_target
    printf '{"status":"failed","checkedAt":"%s","failureCode":"restore_verification_failed"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$health_tmp"
    publish_summary_file
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
prepare_summary_target
node - "$report" "$health_tmp" <<'NODE'
const fs = require("node:fs");
const source = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const inspection = source && typeof source.inspection === "object" ? source.inspection : {};
const summary = {
  status: source.status,
  verifiedAt: source.verifiedAt,
  transferredPages: source.transferredPages,
  inspection: {
    integrity: inspection.integrity,
    recordCount: inspection.recordCount,
    schemaSha256: inspection.schemaSha256,
    logicalSha256: inspection.logicalSha256,
  },
};
fs.writeFileSync(process.argv[3], JSON.stringify(summary) + "\n", {encoding: "utf8", flag: "wx"});
NODE
publish_summary_file
verified=1
printf '%s\n' "sqlite_restore_test=ok backup=$snapshot report=$report"
