#!/usr/bin/env bash
# Times `pando merge` on a server: prepares N pushed branches in a plain repo,
# then merges each and prints how long the command took. Deletes the repo.
#   PANDO_BIN=/tmp/pando cli/testbed/merge-time.sh [server] [N] [merge flags...]
set -uo pipefail
export GIT_CONFIG_NOSYSTEM=1
P="${PANDO_BIN:-pando}"; S="${1:-https://pando-dev.plannotator.workers.dev}"; N="${2:-5}"; shift 2 2>/dev/null; FLAGS=("$@")
T="$(mktemp -d /tmp/pando-mt.XXXXXX)"; name="cli-mt-$(date +%s)"
ms() { if [ "$(uname)" = Linux ]; then echo $(( $(date +%s%N) / 1000000 )); else python3 -c 'import time; print(int(time.time()*1000))'; fi; }
cleanup() { "$P" monorepo delete "$name" --yes --server "$S" >/dev/null 2>&1 && echo "deleted $name"; sleep 3; pkill -f "worktree follow --once" 2>/dev/null; chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
cd "$T" && git init -q -b main src && cd src && echo hi > README.md && git add -A && git -c user.name=p -c user.email=p@p commit -qm one
"$P" init --yes --name "$name" --server "$S" >/dev/null 2>&1 && "$P" clone "$name" "$T/c" --server "$S" >/dev/null 2>&1 || { echo setup failed; exit 1; }
cd "$T/c"
for i in $(seq 1 "$N"); do
  "$P" worktree add . "b$i" >/dev/null 2>&1 && (cd "worktrees/b$i" && echo "$i" > "f$i.txt" && git add -A && git commit -qm "b$i" && git push -q 2>/dev/null)
done
sleep 5   # let the server compute branch facts, as after a normal push
times=()
for i in $(seq 1 "$N"); do
  cd "$T/c/worktrees/b$i"   # merge from inside the branch's worktree, as an agent does
  t0=$(ms); out=$("$P" merge "${FLAGS[@]}" 2>&1); t1=$(ms)
  echo "merge $i: $(( t1 - t0 )) ms   ($(echo "$out" | tr '\n' ' ' | cut -c1-110))"
  times+=($(( t1 - t0 )))
done
printf '%s\n' "${times[@]}" | sort -n | awk '{a[NR]=$1} END {print "p50 " a[int((NR+1)/2)] " ms, min " a[1] " ms, max " a[NR] " ms"}'
