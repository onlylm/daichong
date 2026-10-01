#!/bin/sh
set -eu

base="/opt/recharge-platform"
secrets="$base/secrets"
install -d -m 700 "$secrets" "$base/production-backups"

create_secret() {
  target="$1"
  if [ ! -e "$target" ]; then
    umask 077
    openssl rand -base64 36 | tr -d '\n' > "$target"
    printf '\n' >> "$target"
  fi

  # Compose mounts file-backed secrets without translating uid/gid/mode.
  # The parent directory remains root-only, while 0444 lets the unprivileged
  # database process read the individual bind-mounted secret in the container.
  chmod 444 "$target"
}

create_secret "$secrets/postgres-owner-password"
create_secret "$secrets/postgres-app-password"

if [ ! -e "$secrets/redis-production.acl" ]; then
  umask 077
  redis_password="$(openssl rand -base64 36 | tr -d '\n')"
  {
    printf 'user default on >%s ~* &* +@all\n' "$redis_password"
    printf 'user health on nopass -@all +ping\n'
  } > "$secrets/redis-production.acl"
  unset redis_password
fi

chmod 444 "$secrets/redis-production.acl"

printf '%s\n' 'Production database and Redis secrets are present; values were not printed.'
