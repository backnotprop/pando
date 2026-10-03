#!/usr/bin/env bash
# M6 on a Mac: five agents at once, each in its own FSKit worktree of one
# repo. Each agent edits 20 files, writes 200 new ones, runs npm install and
# a build, checks git status, commits and pushes through the git door. Then
# the branches are checked on the server.
#
#   cli/testbed/m6-mac.sh <pando root> [repo] [agents]
#
# Needs: Pando.app with its extension on, pando and artifact-fs built
# (artifact-fs next to pando, or PANDO_ARTIFACT_FS), node and npm, and a
# repo with a package.json workspace (the lane's test repo has one). Uses
# this machine's credential; prints no secret. Never FUSE: on a Mac the
# worktrees are FSKit mounts.
set -euo pipefail
export GIT_CONFIG_NOSYSTEM=1           # no osxkeychain prompts
P="${PANDO_BIN:-pando}"
ROOT="$1"; REPO="${2:-projects/app}"; N="${3:-5}"
cd "$ROOT"
run=$(date +%H%M%S)
out=$(mktemp -d /tmp/pando-m6.XXXXXX)
ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

echo "== $N worktrees at once ($REPO)"
t0=$(ms)
for i in $(seq 1 "$N"); do
  ( set +e; PANDO_AGENT="agent-$i" "$P" worktree add "$REPO" "m6-$run-$i" > "$out/add-$i.log" 2>&1; echo $? > "$out/add-$i.rc" ) &
done
wait
t1=$(ms)
for i in $(seq 1 "$N"); do
  rc=$(cat "$out/add-$i.rc"); kind=$(grep -o '[a-z]* worktree, ready in [0-9.]*s' "$out/add-$i.log" || true)
  echo "  agent-$i: exit $rc, $kind"
  [ "$rc" = 0 ] || { cat "$out/add-$i.log"; exit 1; }
done
echo "  all $N ready in $(( t1 - t0 )) ms"

agent() {
  local i=$1 wt="$REPO/worktrees/m6-$run-$i" t a b c d e f
  cd "$ROOT/$wt"
  t=$(ms)
  for k in $(seq 1 20); do echo "// agent-$i edit $k" >> "src/f$k.go"; done
  mkdir -p "gen-$i"
  for k in $(seq 1 200); do echo "export const v$k = $k; // agent-$i" > "gen-$i/m$k.js"; done
  a=$(ms)
  npm install --no-audit --no-fund --prefer-offline --loglevel=error >/dev/null
  b=$(ms)
  npm run build -w @mm/a --silent >/dev/null
  node -e "process.exit(typeof require('@mm/a')() === 'number' ? 0 : 1)"
  ./node_modules/.bin/mm-b >/dev/null
  c=$(ms)
  local changed; changed=$(git status --porcelain | wc -l | tr -d ' ')
  d=$(ms)
  git add -A && git commit -q -m "agent-$i: 20 edits, 200 new files"
  e=$(ms)
  git push -q 2>&1 | grep -v '^remote:' || true
  f=$(ms)
  echo "agent-$i: edit+write $((a-t)) ms | npm install $((b-a)) ms | build+run $((c-b)) ms | git status $((d-c)) ms ($changed paths) | commit $((e-d)) ms | push $((f-e)) ms | total $((f-t)) ms"
}

echo "== $N agents at once: edit, write, npm install, build, status, commit, push"
t2=$(ms)
for i in $(seq 1 "$N"); do ( set +e; ( set -e; agent "$i" ) > "$out/agent-$i.log" 2>&1; echo $? > "$out/agent-$i.rc" ) & done
wait
t3=$(ms)
fails=0
for i in $(seq 1 "$N"); do
  rc=$(cat "$out/agent-$i.rc")
  if [ "$rc" = 0 ]; then
    tail -1 "$out/agent-$i.log" | sed 's/^/  /'
  else
    fails=$((fails + 1)); echo "  agent-$i FAILED:"; sed 's/^/    /' "$out/agent-$i.log" | tail -15
  fi
done
echo "  wall time for all $N: $(( t3 - t2 )) ms; failures: $fails"

echo "== on the server"
"$P" branch list --repo "$REPO" 2>&1 | grep "m6-$run" | sed 's/^/  /'
for i in $(seq 1 "$N"); do
  wt="$REPO/worktrees/m6-$run-$i"
  st=$(git -C "$wt" status -sb | head -1)
  echo "  $wt: $st; ._ files in the mount: $(find "$wt" -name '._*' -not -path '*/.git/*' | wc -l | tr -d ' ')"
done
echo "logs: $out"
[ "$fails" = 0 ]
