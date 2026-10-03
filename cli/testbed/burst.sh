#!/usr/bin/env bash
# C23: a burst of merges costs each machine at most two fetches of main.
# Three machines (Pando folders) on one plain repo: A merges 20 branches in
# about 10 s with no follower running (pando merge starts background ones);
# B runs a follower and has a branch worktree in the repo; C runs a follower
# with only main there. Each machine's git fetches are counted with git's
# trace2 (lazy content fetches, which carry --stdin, are left out).
#   cli/testbed/burst.sh <server>      (PANDO_TOKEN or a pando login needed)
set -uo pipefail
S="$1"; P="${PANDO_BIN:-pando}"; W="$(mktemp -d /tmp/pando-burst.XXXXXX)"; name="cli-burst-$(date +%s)"
fpids=()
cleanup() { for p in "${fpids[@]}"; do kill "$p" 2>/dev/null; done; "$P" monorepo delete "$name" --yes --server "$S" >/dev/null 2>&1 && echo "deleted $name"; chmod -R u+w "$W" 2>/dev/null; rm -rf "$W" 2>/dev/null; }
trap cleanup EXIT
say() { [ -n "${BURST_DEBUG:-}" ] && echo "$(date +%T) $*" >&2; return 0; }
fetches() { local n=0; [ -f "$1" ] && n=$(grep '"event":"start"' "$1" | grep '"fetch"' | grep -vc '"--stdin"'); echo "${n:-0}"; }
cd "$W" && git init -q -b main src && cd src && echo hi > README.md && git add -A && git commit -qm one
say init; "$P" init --yes --name "$name" --server "$S" >/dev/null 2>&1 || { echo "init failed"; exit 1; }
say clone; for m in a b c; do "$P" clone "$name" "$W/$m" --server "$S" >/dev/null 2>&1 || { echo "clone $m failed"; exit 1; }; done
say worktrees; (cd "$W/a" && "$P" worktree add . wa >/dev/null 2>&1) && (cd "$W/b" && "$P" worktree add . wb >/dev/null 2>&1) || { echo "worktree add failed"; exit 1; }
# 20 branches, each one new file off main, pushed in one push.
say branches; url=$(git -C "$W/a/worktrees/main" remote get-url origin)
git -c credential.helper= -c "credential.helper=!$(command -v "$P") credential" clone -q "$url" "$W/plain" 2>/dev/null
cd "$W/plain" && for i in $(seq 1 20); do git checkout -q -b "b$i" main && echo "$i" > "f$i.txt" && git add -A && git commit -qm "b$i"; done
git -c credential.helper= -c "credential.helper=!$(command -v "$P") credential" push -q origin $(seq -f 'b%g' 1 20) 2>/dev/null || { echo "push failed"; exit 1; }
sleep 3
for m in b c; do (cd "$W/$m" && GIT_TRACE2_EVENT="$W/trace-$m.json" exec "$P" worktree follow >"$W/follow-$m.log" 2>&1) & fpids+=($!); done
sleep 4   # the followers start (and read heads once: main is current, so no fetch)
before_c=$(git -C "$W/c/worktrees/main" rev-parse HEAD)
say merges; t0=$(date +%s)
cd "$W/a"; mpids=(); par="${BURST_PARALLEL:-1}"
for i in $(seq 1 20); do
  GIT_TRACE2_EVENT="$W/trace-a.json" "$P" merge "b$i" >/dev/null 2>&1 & mpids+=($!)
  if [ $((i % par)) -eq 0 ]; then wait "${mpids[@]}"; mpids=(); fi   # never a bare wait: the followers run in the background
done
t1=$(date +%s)
sleep 10  # the burst goes quiet (3 s), then the second fetch
last=$(git -C "$W/a/worktrees/main" ls-remote origin refs/heads/main | cut -f1)
echo "20 merges in $((t1 - t0)) s; main is now ${last:0:7}"
for m in a b c; do
  at=$(git -C "$W/$m/worktrees/main" rev-parse HEAD)
  echo "machine $m: $(fetches "$W/trace-$m.json") fetches of main; main at ${at:0:7}"
done
echo "c_main_unchanged=$([ "$(git -C "$W/c/worktrees/main" rev-parse HEAD)" = "$before_c" ] && echo yes || echo no)"
echo "a_at_last=$([ "$(git -C "$W/a/worktrees/main" rev-parse HEAD)" = "$last" ] && echo yes || echo no) b_at_last=$([ "$(git -C "$W/b/worktrees/main" rev-parse HEAD)" = "$last" ] && echo yes || echo no)"
