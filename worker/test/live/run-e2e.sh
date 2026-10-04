#!/usr/bin/env bash
# Runs the live lane's end-to-end tests: starts the meta layer object under
# wrangler dev (port 8850, fresh state), runs the Go tests in
# cli/internal/meta against it with real engines in temp folders, stops it.
#
#   worker/test/live/run-e2e.sh                 # all tests
#   worker/test/live/run-e2e.sh -run Race       # extra go test flags
#   worker/test/live/run-e2e.sh --artifacts     # also commits, on real Artifacts
#                                               # (pando-spike, your wrangler login)
#   META_COMMIT_GROUPING=author worker/test/live/run-e2e.sh --artifacts -run Window
#                                               # one commit per person (the default
#                                               # is window: one per quiet window)
#
# Against a deployed Worker instead:
#   PANDO_META_TEST_URL=https://pando-dev... go test ./internal/meta -run E2E -v
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
worker="$(cd "$here/../.." && pwd)"
cli="$(cd "$worker/../cli" && pwd)"
port="${PANDO_LIVE_PORT:-8850}"
config=test/live/wrangler.jsonc
if [[ "${1:-}" == "--artifacts" ]]; then
  shift
  config=test/live/wrangler.artifacts.jsonc
  export PANDO_META_TEST_ARTIFACTS=1
fi
state="$(mktemp -d)"
log="$state/wrangler.log"

cd "$worker"
vars=()
if [[ -n "${META_COMMIT_GROUPING:-}" ]]; then
  vars=(--var "META_COMMIT_GROUPING:$META_COMMIT_GROUPING")
  export PANDO_META_TEST_SHAPE="$META_COMMIT_GROUPING" # the Go tests' own name for it
fi
npx wrangler dev -c "$config" "${vars[@]}" --port "$port" --inspector-port $((port + 500)) \
  --ip 127.0.0.1 --persist-to "$state/do" >"$log" 2>&1 &
pid=$!
# Exit with the script's own status (go test's), not the stopped server's (143).
trap 'code=$?; kill $pid 2>/dev/null; wait $pid 2>/dev/null || true; rm -rf "$state"; exit $code' EXIT

for _ in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$port/healthz" >/dev/null && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$port/healthz" >/dev/null || { cat "$log"; exit 1; }

cd "$cli"
PANDO_META_TEST_URL="http://127.0.0.1:$port" go test ./internal/meta/ -count=1 "${@:--v}"
