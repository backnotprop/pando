#!/usr/bin/env bash
# M1 against a real Pando server, on this Mac (sparse worktrees, no FUSE).
# Uses this machine's stored credential (pando login); prints no secret.
#
#   PANDO_BIN=/tmp/pando cli/testbed/m1-live.sh [server]
set -euo pipefail
export GIT_CONFIG_NOSYSTEM=1           # no osxkeychain prompts
here="$(cd "$(dirname "$0")" && pwd)"
P="${PANDO_BIN:-pando}"
S="${1:-https://pando-dev.plannotator.workers.dev}"
T="$(mktemp -d /tmp/pando-m1.XXXXXX)"
name="cli-m1-$(date +%s)"
step() { echo; echo "== $*"; }
cleanup() {
  [ -n "${made:-}" ] && "$P" monorepo delete "$name" --yes --server "$S" | sed 's/^/  /' || true
  # Read-only mains have read-only folders.
  chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"
}
trap cleanup EXIT
ok() { echo "  ok   $*"; }
fail() { echo "  FAIL $*"; exit 1; }

"$P" auth status --server "$S" 2>/dev/null | sed 's/^/  /' || true

step "a plain git repo becomes a Pando repo ($name)"
mkdir -p "$T/src" && cd "$T/src" && git init -q -b main acme && cd acme
mkdir -p src && for i in 1 2 3; do echo "package src // $i" > "src/f$i.go"; done
echo "# acme" > README.md && git add -A && git -c user.name="M1 Test" -c user.email=m1@example.com commit -q -m "acme: first commit"
made=1
"$P" init --yes --name "$name" --server "$S" | sed 's/^/  /'

step "clone it, then a branch worktree"
"$P" clone "$name" "$T/acme" --server "$S" | sed 's/^/  /'
cd "$T/acme"
"$P" worktree add . feat-1 --agent agent-1 | sed 's/^/  /'
cd worktrees/feat-1
echo "package src // changed through Pando" >> src/f2.go && echo "notes" > NOTES.md
git add -A && git commit -q -m "Change f2 and add notes"
git log -1 --format='  author: %an <%ae>%n%(trailers:only)' 
git push -q && ok "git push through the git door"
if git push origin HEAD:main 2>"$T/main-push.err"; then fail "a push to main went through"; else ok "a push to main is refused: $(grep -o 'main is protected[^)]*' "$T/main-push.err" | head -1)"; fi

step "branch list, diff, review, merge"
cd "$T/acme"
"$P" branch list | sed 's/^/  /'
"$P" diff feat-1 | sed 's/^/  /'
"$P" diff feat-1 --patch | head -6 | sed 's/^/  /'
PANDO_PLANNOTATOR="$here/fake-plannotator.sh" FAKE_PLANNOTATOR_PATCH="$T/review.patch" "$P" review feat-1 | sed 's/^/  /'
grep -q '^diff --git a/src/f2.go' "$T/review.patch" && ok "plannotator got the branch patch on stdin"
PANDO_AGENT=agent-2 "$P" review feat-1 -m "An agent's comment." | sed 's/^/  /'
"$P" merge feat-1 | sed 's/^/  /' || echo "  (merge did not land; see above)"
"$P" worktree list | sed 's/^/  /'
"$P" worktree remove worktrees/feat-1 | sed 's/^/  /'
echo; echo "M1 run done; deleting $name"
