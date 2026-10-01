#!/bin/sh
set -eu

base="/opt/recharge-platform"
project="${1:-$base/current}"
backups="$base/production-backups"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backups/quefa-$stamp.dump"

install -d -m 700 "$backups"
cd "$project"
docker compose -f compose.production.infra.yaml exec -T postgres \
  sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_owner_password)"; exec pg_dump --username quefa_owner --dbname quefa --format=custom --no-password' > "$target"
chmod 600 "$target"
sha256sum "$target"

# 仅保留最近 14 天；不删除当天新备份。
find "$backups" -type f -name 'quefa-*.dump' -mtime +14 -delete
