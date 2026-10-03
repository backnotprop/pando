#!/usr/bin/env bash
# Runs the live lane's end-to-end tests: starts the meta layer object under
# wrangler dev (port 8850, fresh state), runs the Go tests in
# cli/internal/meta against it with real engines in temp folders, stops it.
#
#   worker/test/live/run-e2e.sh            # all tests
#   worker/test/live/run-e2e.sh -run Race  # extra go test flags
#
# Against a deployed Worker instead:
#   PANDO_META_TEST_URL=https://pando-dev... go test ./internal/meta -run E2E -v
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
worker="$(cd "$here/../.." && pwd)"
cli="$(cd "$worker/../cli" && pwd)"
port="${PANDO_LIVE_PORT:-8850}"
state="$(mktemp -d)"
log="$state/wrangler.log"

cd "$worker"
npx wrangler dev -c test/live/wrangler.jsonc --port "$port" --inspector-port $((port + 500)) \
  --ip 127.0.0.1 --persist-to "$state/do" >"$log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null; rm -rf "$state"' EXIT

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$port/healthz" >/dev/null && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$port/healthz" >/dev/null || { cat "$log"; exit 1; }

cd "$cli"
PANDO_META_TEST_URL="http://127.0.0.1:$port" go test ./internal/meta/ -count=1 "${@:--v}"
