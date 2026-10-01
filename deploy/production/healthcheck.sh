#!/bin/sh
set -eu

expect_status() {
  expected="$1"
  url="$2"
  actual="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 15 "$url")"
  if [ "$actual" != "$expected" ]; then
    printf '%s\n' "Health check failed for $url: expected $expected, got $actual" >&2
    exit 1
  fi
}

curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3200/health/ready >/dev/null
# Worker health is a separate readiness boundary. Never print its body: the
# detailed lane view remains local/protected and is not copied into alerts.
curl --fail --silent --show-error --output /dev/null --max-time 10 http://127.0.0.1:3200/health/worker
expect_status 200 https://tibo.ink/developers
expect_status 200 https://tibo.ink/developers/openapi.yaml
expect_status 404 https://tibo.ink/workspace
expect_status 404 https://tibo.ink/health/ready
expect_status 404 https://tibo.ink/health/worker
expect_status 302 https://admin.tibo.ink/
expect_status 200 https://admin.tibo.ink/workspace
expect_status 401 https://admin.tibo.ink/workspace/api/auth/me
expect_status 404 https://admin.tibo.ink/v1/products

app_container="${APP_CONTAINER:-quefa-app-api-1}"
worker_container="${WORKER_CONTAINER:-quefa-app-worker-1}"
for container in "$app_container" quefa-production-postgres-1 quefa-production-redis-1; do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
  if [ "$status" != "healthy" ]; then
    printf '%s\n' "Container is not healthy: $container=$status" >&2
    exit 1
  fi
done

# The worker image intentionally has no HTTP listener. Its durable heartbeat is
# verified above; here we additionally require the container process to run.
worker_status="$(docker inspect --format '{{.State.Status}}' "$worker_container")"
if [ "$worker_status" != "running" ]; then
  printf '%s\n' "Worker container is not running: $worker_container=$worker_status" >&2
  exit 1
fi

caddy_status="$(docker inspect --format '{{.State.Status}}' quefa-edge-caddy-1)"
if [ "$caddy_status" != "running" ]; then
  printf '%s\n' "Caddy is not running: $caddy_status" >&2
  exit 1
fi

printf '%s\n' 'healthcheck=ok'
