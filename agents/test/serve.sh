#!/usr/bin/env bash
# Runs the agents' local server for the end-to-end suites: the test driver,
# pando-agents and Pando's Worker in one wrangler dev, with its own state.
#
#   agents/test/serve.sh start | start-alone | stop | restart
#
# Environment: AGENTS_PORT (8863), AGENTS_INSPECTOR (9363), AGENTS_STATE
# (agents/.state), DOCKER_HOST (a Docker engine in a VM, for the containers
# and FUSE; this lane uses its own Colima profile, see BUILD-NOTES.md). The
# scripted model is on (SCRIPTED_MODEL=1, agents/.dev.vars). AGENTS_PANDO_VARS
# adds vars to Pando's Worker for one run (the gate's risk suite:
# "RISK_REVIEW=on RISK_TEST=1"): wrangler's --var reaches only the first
# config of a multi-config dev (the driver), so they go into
# worker/.dev.vars, kept as it was and put back on stop. The log is
# $AGENTS_STATE/wrangler.log. stop ends only this folder's processes.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
port="${AGENTS_PORT:-8863}"
inspector="${AGENTS_INSPECTOR:-9363}"
state="${AGENTS_STATE:-$here/.state}"
log="$state/wrangler.log"
vars="$here/../worker/.dev.vars"
kept="$state/worker.dev.vars.kept"

stop() {
  pkill -f "$here/node_modules" 2>/dev/null || true
  for _ in $(seq 1 20); do pgrep -f "$here/node_modules" >/dev/null || break; sleep 0.5; done
  pkill -9 -f "$here/node_modules" 2>/dev/null || true
  # Pando's Worker's vars as they were before AGENTS_PANDO_VARS.
  if [ -f "$kept" ]; then cp -p "$kept" "$vars" && rm -f "$kept"; fi
}

# start: the three together. start-alone: Pando's Worker by itself, without
# pando-agents (as Pando's web e2e runs it), for absent.mjs.
start() {
  local configs=(-c test/driver/wrangler.jsonc -c wrangler.jsonc -c ../worker/wrangler.jsonc)

  [ "${1:-}" = alone ] && configs=(-c ../worker/wrangler.jsonc)
  mkdir -p "$state"
  if [ -n "${AGENTS_PANDO_VARS:-}" ]; then
    [ -f "$kept" ] || cp -p "$vars" "$kept"
    for kv in $AGENTS_PANDO_VARS; do printf '%s\n' "$kv" >> "$vars"; done
  fi
  # The scripted model, for deterministic tests. Local only: .dev.vars is never deployed.
  grep -qs '^SCRIPTED_MODEL=1$' "$here/.dev.vars" || echo "SCRIPTED_MODEL=1" >> "$here/.dev.vars"
  (cd "$here/../worker" && npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to "$state" >/dev/null)
  [ -d "$here/../web/dist" ] || { mkdir -p "$here/../web/dist" && echo '<!doctype html>' > "$here/../web/dist/index.html"; }
  cd "$here"
  nohup "$here/node_modules/.bin/wrangler" dev "${configs[@]}" \
    --port "$port" --inspector-port "$inspector" --ip 127.0.0.1 --persist-to "$state" >"$log" 2>&1 &
  for _ in $(seq 1 200); do
    grep -q "Ready on" "$log" && { echo "agents: ready on http://127.0.0.1:$port (log $log)"; return 0; }
    # The remote bindings (Workers AI, Artifacts) could not reach Cloudflare: no use waiting.
    if grep -q "Failed to start the remote proxy session" "$log"; then
      echo "agents: wrangler could not reach Cloudflare for its remote bindings; see $log" >&2
      stop
      return 1
    fi
    sleep 3
  done
  echo "agents: not ready; see $log" >&2
  return 1
}

case "${1:-}" in
  start) start ;;
  start-alone) start alone ;;
  stop) stop ;;
  restart) stop; start ;;
  *) echo "usage: $0 start | start-alone | stop | restart" >&2; exit 2 ;;
esac
