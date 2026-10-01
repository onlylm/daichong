#!/bin/sh
set -eu

base="/opt/recharge-platform"
release="${1:?candidate release path is required}"
candidate_image="${2:-recharge-platform:candidate-20260927b}"
current="$base/current"
env_file="$base/config/prelaunch.env"

if [ ! -f "$release/compose.prelaunch.yaml" ]; then
  printf '%s\n' "Candidate release is incomplete: $release" >&2
  exit 1
fi

old_release="$(readlink -f "$current")"
old_image="$(docker inspect --format '{{.Image}}' recharge-prelaunch-api-1 2>/dev/null || true)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$env_file" "$base/config/prelaunch.env.$stamp.bak"

replace_env() {
  key="$1"
  value="$2"
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi
}

rollback=1
restore_previous_release() {
  if [ "$rollback" -ne 1 ]; then
    return
  fi
  printf '%s\n' 'Candidate failed; restoring the previous application release.' >&2
  ln -sfn "$old_release" "$base/current.rollback"
  mv -Tf "$base/current.rollback" "$current"
  cp -p "$base/config/prelaunch.env.$stamp.bak" "$env_file"
  if [ -n "$old_image" ]; then
    docker tag "$old_image" recharge-platform:prelaunch
    cd "$current"
    docker compose -p recharge-prelaunch -f compose.prelaunch.yaml up -d --no-build
  fi
}
trap restore_previous_release EXIT HUP INT TERM

replace_env PUBLIC_BASE_URL https://tibo.ink
replace_env ADMIN_BASE_URL https://admin.tibo.ink
replace_env TRUST_PROXY true
replace_env PAYMENT_PROVIDER mock
replace_env FULFILLMENT_PROVIDER mock
replace_env LIVE_TEST_ENABLED false
replace_env ENABLE_SANDBOX_ROUTES false

docker tag "$candidate_image" recharge-platform:prelaunch
ln -sfn "$release" "$base/current.next"
mv -Tf "$base/current.next" "$current"

cd "$current"
docker compose -p recharge-prelaunch -f compose.prelaunch.yaml up -d --no-build --remove-orphans

attempt=0
until curl -fsS http://127.0.0.1:3200/health/ready >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then
    printf '%s\n' 'Candidate API did not become ready within 60 seconds.' >&2
    exit 1
  fi
  sleep 3
done

curl -fsS http://127.0.0.1:3200/developers >/dev/null
curl -fsS http://127.0.0.1:3200/developers/openapi.yaml >/dev/null

rollback=0
trap - EXIT HUP INT TERM
printf '%s\n' "application_release=$release"
printf '%s\n' 'application_mode=prelaunch payment=mock fulfillment=mock live_test=false'
