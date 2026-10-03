#!/usr/bin/env bash
# How long after a merge on the server does a second machine's read-only main
# move? Machine A merges; machine B runs `pando worktree follow` (the event
# stream). Prints each delay and deletes the monorepo it made.
#   PANDO_BIN=/tmp/pando cli/testbed/follow-latency.sh [server] [merges]
set -uo pipefail
export GIT_CONFIG_NOSYSTEM=1
P="${PANDO_BIN:-pando}"; S="${1:-https://pando-dev.plannotator.workers.dev}"; N="${2:-5}"
T="$(mktemp -d /tmp/pando-follow.XXXXXX)"; name="cli-follow-$(date +%s)"
ms() { if [ "$(uname)" = Linux ]; then echo $(( $(date +%s%N) / 1000000 )); else python3 -c 'import time; print(int(time.time()*1000))'; fi; }
cleanup() { [ -n "${fpid:-}" ] && kill "$fpid" 2>/dev/null; "$P" monorepo delete "$name" --yes --server "$S" >/dev/null 2>&1 && echo "deleted $name"; sleep 3; pkill -f "worktree follow --once" 2>/dev/null; chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
now() { if [ "$(uname)" = Linux ]; then date +%T.%3N; else python3 -c 'import datetime; print(datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3])'; fi; }
cd "$T" && git init -q -b main src && cd src && echo hi > README.md && git add -A && git -c user.name=p -c user.email=p@p commit -qm one
"$P" init --yes --name "$name" --server "$S" >/dev/null 2>&1 || { echo "init failed"; exit 1; }
"$P" clone "$name" "$T/a" --server "$S" >/dev/null 2>&1 && "$P" clone "$name" "$T/b" --server "$S" >/dev/null 2>&1
# B works in the repo (a branch worktree there), so it follows each merge.
(cd "$T/b" && "$P" worktree add . wb >/dev/null 2>&1)
(cd "$T/b" && PANDO_DEBUG=follow exec "$P" worktree follow >"$T/follow.log" 2>&1) & fpid=$!
sleep 3   # let B subscribe
for i in $(seq 1 "$N"); do
  cd "$T/a" && "$P" worktree add . "b$i" >/dev/null 2>&1 && cd "worktrees/b$i" && echo "$i" > "f$i.txt" && git add -A && git commit -qm "b$i" && git push -q 2>/dev/null
  cd "$T/a"; was=$(git -C "$T/b/worktrees/main" rev-parse HEAD); echo "$(now) merge $i starts" >> "$T/follow.log"
  t0=$(ms); out=$("$P" merge ${MERGE_FLAGS:-} "b$i" 2>&1); t1=$(ms); echo "$(now) merge $i returned" >> "$T/follow.log"
  until [ "$(git -C "$T/b/worktrees/main" rev-parse HEAD 2>/dev/null)" != "$was" ]; do
    [ $(( $(ms) - t1 )) -gt 60000 ] && { echo "merge $i: B did not follow within 60 s"; break; }
    sleep 0.05
  done
  t2=$(ms); echo "$(now) merge $i: B moved" >> "$T/follow.log"
  sha=$(git -C "$T/a/worktrees/main" ls-remote origin refs/heads/main | cut -f1)
  [ "$(git -C "$T/b/worktrees/main" rev-parse HEAD)" = "$sha" ] || echo "merge $i: B's main is not the merge commit"
  echo "merge $i: merge call $(( t1 - t0 )) ms; B's main moved $(( t2 - t1 )) ms after the merge returned, $(( t2 - t0 )) ms after it started"
  "$P" worktree remove "worktrees/b$i" --force >/dev/null 2>&1
done
echo "follower log:"; sed -e 's/\(follow: frame {"type":"event","seq":[0-9]*\).*/\1/' "$T/follow.log" | grep -v 'caught_up\|subscribe' | sed 's/^/  /' | head -${FOLLOW_LOG_LINES:-20}
