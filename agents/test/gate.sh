#!/usr/bin/env bash
# The agents' suites in one run, for pando-ops' gate:
#
#   PORT=8780 INSPECTOR=9251 STATE=/tmp/gate-agents agents/test/gate.sh
#
# Starts the Colima profile cloud-agents when it is not running (a Docker
# engine in a VM, for the containers and FUSE; never FUSE on the Mac), runs
# the local server on PORT, INSPECTOR and STATE (defaults 8863, 9363,
# agents/.state), then session.mjs, the same session after a full restart,
# launch.mjs, existing-branch.mjs, tools.mjs, merge-on-merge.mjs, scope.mjs, issue.mjs, live.mjs, continue.mjs, review.mjs, assistant.mjs and sync.mjs; then Pando's Worker alone (serve.sh start-alone) for absent.mjs. Afterwards it stops the server, stops Colima only if it
# started it, and puts the Docker context back. One line per suite; exit 1
# when any failed. Logs: $STATE/gate-*.log and $STATE/wrangler.log.
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
export AGENTS_PORT="${PORT:-8863}" AGENTS_INSPECTOR="${INSPECTOR:-9363}" AGENTS_STATE="${STATE:-$here/.state}"
export AGENTS_URL="http://127.0.0.1:$AGENTS_PORT"
profile=cloud-agents
context="$(docker context show 2>/dev/null || echo default)"
started=0

finish() {
  "$here/test/serve.sh" stop >/dev/null 2>&1
  [ "$started" = 1 ] && colima stop -p "$profile" >/dev/null 2>&1
  docker context use "$context" >/dev/null 2>&1
}
trap finish EXIT

if ! colima status -p "$profile" >/dev/null 2>&1; then
  colima start -p "$profile" >/dev/null 2>&1 || { echo "gate: colima start -p $profile failed" >&2; exit 1; }
  started=1
fi
docker context use "$context" >/dev/null 2>&1
export DOCKER_HOST="unix://$HOME/.colima/$profile/docker.sock"
mkdir -p "$AGENTS_STATE"

"$here/test/serve.sh" start >/dev/null || { echo "gate: the server did not start ($AGENTS_STATE/wrangler.log)" >&2; exit 1; }

failed=0
suite() { # name, log, command...
  local name=$1 log="$AGENTS_STATE/gate-$2.log"
  shift 2
  if "$@" >"$log" 2>&1; then
    echo "PASS  $name: $(tail -1 "$log")"
  else
    echo "FAIL  $name: $(grep -c '^FAIL' "$log") failed, $(tail -1 "$log") ($log)"
    failed=1
  fi
}

suite "session (stage 1)" session node "$here/test/session.mjs"
if "$here/test/serve.sh" restart >/dev/null; then
  suite "session after a full restart" restart node "$here/test/session.mjs" --after-restart
else
  echo "FAIL  session after a full restart: the server did not restart"
  failed=1
fi
suite "launch (stage 2)" launch node "$here/test/launch.mjs"
suite "existing branch" existing node "$here/test/existing-branch.mjs"
suite "tools (stage 3)" tools node "$here/test/tools.mjs"
suite "merge when checks run on merge" on-merge node "$here/test/merge-on-merge.mjs"
suite "credential scope" scope node "$here/test/scope.mjs"
suite "address an issue (stage 4)" issue node "$here/test/issue.mjs"
suite "live view (stage 5)" live node "$here/test/live.mjs"
suite "continue (stage 6)" continue node "$here/test/continue.mjs"
suite "review with agent (stage 7)" review node "$here/test/review.mjs"
suite "the assistant (stage 8)" assistant node "$here/test/assistant.mjs"
suite "shared files live in the sandbox" sync node "$here/test/sync.mjs"
# Pando's Worker without pando-agents, as its web e2e runs it.
"$here/test/serve.sh" stop >/dev/null 2>&1
if "$here/test/serve.sh" start-alone >/dev/null; then
  suite "without pando-agents" absent node "$here/test/absent.mjs"
else
  echo "FAIL  without pando-agents: the server did not start ($AGENTS_STATE/wrangler.log)"
  failed=1
fi
exit "$failed"
