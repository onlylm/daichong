#!/bin/sh
set -eu

unit_raw="${1:-quefa-healthcheck.service}"
unit="$(printf '%s' "$unit_raw" | tr -cd 'A-Za-z0-9@_.:-')"
host="$(hostname | tr -cd 'A-Za-z0-9_.-')"
timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
message="Quefa production health check failed: unit=$unit host=$host at=$timestamp"

if command -v systemd-cat >/dev/null 2>&1; then
  printf '%s\n' "$message" | systemd-cat -t quefa-health-alert -p err
else
  printf '%s\n' "$message" >&2
fi

# Optional protected notification relay. The file must be root-owned and may
# not be readable/writable/executable by group or others. No probe response,
# order data or secrets are included in the outgoing message.
config="/opt/recharge-platform/config/health-alert.env"
if [ ! -f "$config" ]; then
  exit 0
fi
if [ "$(stat -c '%U' "$config")" != "root" ] || [ -n "$(find "$config" -prune -perm /077 -print -quit)" ]; then
  printf '%s\n' "Refusing insecure health alert configuration: $config must be root-owned mode 0600 or stricter" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$config"
case "${HEALTH_ALERT_WEBHOOK_URL:-}" in
  https://*) ;;
  "") exit 0 ;;
  *) printf '%s\n' 'HEALTH_ALERT_WEBHOOK_URL must use https' >&2; exit 1 ;;
esac
payload="{\"event\":\"quefa_healthcheck_failed\",\"unit\":\"$unit\",\"host\":\"$host\",\"timestamp\":\"$timestamp\"}"
curl --fail --silent --show-error --max-time 10 --retry 2 \
  -H 'content-type: application/json' --data "$payload" "$HEALTH_ALERT_WEBHOOK_URL" >/dev/null
