#!/usr/bin/env bash
# pando-agent-sync start | flush | conflicts
#
# The shared files (a monorepo's files outside projects/) in the agent's
# sandbox, kept live by pando sync the way they are on any machine:
#
#   start      starts pando sync in /workspace/repo in the background, once;
#              its log is /workspace/pando-sync.log. A plain repo has no
#              shared files: nothing starts.
#   flush      sends every save still waiting (pando sync --once), then starts
#              the live sync again. The session runs it at the end of each run
#              and before it stops the sandbox, so a save in the last seconds
#              is not lost.
#   conflicts  prints one line for each conflict copy the sync made since the
#              last time it was asked (after each bash command of the agent).
set -uo pipefail

root=/workspace/repo
log=/workspace/pando-sync.log
told=/workspace/.pando-sync-told

# The live daemon's command line; under emulation (an arm64 Mac's Colima) an
# interpreter's path comes first.
daemon='(^|[ /])pando sync$'

monorepo() { grep -qs '"kind": *"monorepo"' "$root/.pando/local/root.json"; }
running() { pgrep -f "$daemon" >/dev/null; }

start() {
  monorepo || return 0
  running && return 0
  (cd "$root" && exec setsid nohup pando sync >>"$log" 2>&1 </dev/null) &
  echo "shared files: pando sync started (log $log)" >&2
}

# Conflict lines the engine logged that were not told yet, as the agent reads them.
conflicts() {
  [ -f "$log" ] || return 0
  local all seen
  all=$(grep -c 'conflict on ' "$log")
  seen=$(cat "$told" 2>/dev/null || echo 0)
  [ "$all" -gt "$seen" ] || return 0
  grep 'conflict on ' "$log" | tail -n "$((all - seen))" |
    sed 's/^.*conflict on \([^:]*\): /[Pando] shared file \1 has a conflict copy: /'
  echo "$all" >"$told"
}

flush() {
  monorepo || return 0
  # The live sync holds the folder's lock: it stops first (killed if it hangs).
  pkill -TERM -f "$daemon" && pkill -CONT -f "$daemon"
  for _ in $(seq 1 50); do running || break; sleep 0.2; done
  running && pkill -KILL -f "$daemon" && sleep 0.5
  local status=0
  (cd "$root" && timeout --kill-after=5 60 pando sync --once >>"$log" 2>&1) || status=$?
  start 2>/dev/null
  conflicts
  return "$status"
}

case "${1:-}" in
  start) start ;;
  flush) flush ;;
  conflicts) conflicts ;;
  *) echo "usage: pando-agent-sync start | flush | conflicts" >&2; exit 2 ;;
esac
