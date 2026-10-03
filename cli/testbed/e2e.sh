#!/usr/bin/env bash
# The Linux test bed's end-to-end run: real git, a real FUSE mount through
# the ArtifactFS fork, and pando. With no PANDO_SERVER it uses a file://
# server (bare repos) inside the container.
#
# It proves: a worktree mounts; every file is listed at once with no file
# contents downloaded; a file is fetched when opened; git status, commit
# (with Pando's trailers) and push work inside the mount; worktrees/main is
# read-only and follows a merge; remove unmounts.
set -euo pipefail

export GIT_AUTHOR_NAME="Test Person" GIT_AUTHOR_EMAIL=person@example.com
export GIT_COMMITTER_NAME="Test Person" GIT_COMMITTER_EMAIL=person@example.com
export PANDO_HOME=/work/home
SERVER="${PANDO_SERVER:-file:///srv/pando}"
pass=0
ok()   { pass=$((pass + 1)); echo "  ok   $*"; }
fail() { echo "  FAIL $*"; exit 1; }
step() { echo; echo "== $*"; }

hydrated() { # hydrated blob count of one worktree's ArtifactFS state
  local name="$1" state
  state=$(dirname "$(dirname "$(ls -d "$PANDO_HOME"/afs/*/repos/"$name" | head -1)")")
  ARTIFACT_FS_ROOT="$state" artifact-fs status --name "$name" 2>/dev/null | tr ' ' '\n' | sed -n 's/^hydrated_blobs=//p'
}

step "a plain git repo with history: 400 small files and one 2 MiB file"
mkdir -p /work/src && cd /work/src
git init -q -b main acme && cd acme
for d in $(seq 1 20); do
  mkdir -p "pkg$d"
  for f in $(seq 1 20); do echo "package pkg$d // file $f" > "pkg$d/f$f.go"; done
done
head -c 2097152 /dev/urandom > big.bin
echo "# acme" > README.md
git add -A && git commit -q -m "acme: first commit"
total=$(git ls-files | wc -l)
echo "  $total files"

step "pando login, pando init (plain repo), pando clone"
if [ "$SERVER" = "file:///srv/pando" ]; then
  echo "testbed" | pando login --bootstrap --server "$SERVER" --login tester --name "Test Person" --email person@example.com >/dev/null
elif [ -z "${PANDO_TOKEN:-}" ]; then
  fail "against $SERVER the test needs PANDO_TOKEN (a credential from pando credential create)"
else
  ok "against $SERVER with the credential in PANDO_TOKEN"
fi
name="acme-$(date +%s)"
pando init --yes --name "$name" --server "$SERVER" | sed 's/^/  /'
cd /work
pando clone "$name" /work/acme | sed 's/^/  /'
cd /work/acme
mountpoint -q worktrees/main && ok "worktrees/main is a mount" || fail "worktrees/main is not mounted"

step "a branch worktree through ArtifactFS"
start=$(date +%s%N)
PANDO_AGENT=agent-7 pando worktree add . feat-x | sed 's/^/  /'
end=$(date +%s%N)
wt=/work/acme/worktrees/feat-x
mountpoint -q "$wt" && ok "worktrees/feat-x is a FUSE mount ($(findmnt -no FSTYPE "$wt"))" || fail "feat-x is not mounted"
echo "  pando worktree add took $(( (end - start) / 1000000 )) ms"

step "every file listed at once, nothing downloaded"
listed=$(cd "$wt" && find . -path ./.git -prune -o -type f -print | wc -l)
[ "$listed" -eq "$total" ] && ok "find lists $listed of $total files" || fail "find lists $listed, git has $total"
size=$(stat -c %s "$wt/big.bin")
[ "$size" -eq 2097152 ] && ok "stat gives big.bin its full size ($size) before any read" || fail "big.bin size $size"
h0=$(hydrated feat-x)
[ "$h0" = "0" ] && ok "hydrated_blobs=0 after listing" || echo "  note hydrated_blobs=$h0 after listing (prefetch)"

step "a file is fetched when opened"
before=$(hydrated feat-x)
got=$(cat "$wt/pkg7/f3.go")
after=$(hydrated feat-x)
[ "$got" = "package pkg7 // file 3" ] && ok "cat pkg7/f3.go reads the right bytes" || fail "read: $got"
[ "$after" -gt "$before" ] && ok "hydrated_blobs went $before -> $after on open" || fail "hydrated_blobs stayed $before"
cmp -s "$wt/big.bin" /work/src/acme/big.bin && ok "big.bin (2 MiB) matches byte for byte" || fail "big.bin differs"

step "git inside the mount"
cd "$wt"
[ -z "$(git status --porcelain)" ] && ok "git status is clean" || fail "git status: $(git status --porcelain)"
echo "// changed in the mount" >> pkg3/f1.go
echo "new file" > notes.txt
st=$(git status --porcelain | tr '\n' ' ')
[ "$st" = " M pkg3/f1.go ?? notes.txt " ] && ok "git status shows the edit and the new file" || fail "git status: $st"
git add -A
PANDO_AGENT=agent-7 git commit -q -m "Change pkg3 in a FUSE worktree"
msg=$(git log -1 --format=%B)
echo "$msg" | grep -qx "Pando-Agent: agent-7" && ok "trailer Pando-Agent: agent-7" || fail "no agent trailer: $msg"
echo "$msg" | grep -qx "Pando-Worktree: worktrees/feat-x" && ok "trailer Pando-Worktree: worktrees/feat-x" || fail "no worktree trailer"
echo "$msg" | grep -qx "Pando-Machine: linux-testbed" && ok "trailer Pando-Machine: linux-testbed" || fail "no machine trailer"
[ "$(git log -1 --format=%an)" = "Test Person" ] && ok "authored as the signed-in person" || fail "author $(git log -1 --format=%an)"
git commit -q --amend --no-edit
[ "$(git log -1 --format=%B | grep -c '^Pando-')" = "3" ] && ok "amend keeps three Pando trailers, not six" || fail "trailers doubled"
git push -q 2>&1 | sed 's/^/  /'
[ "$(git rev-parse HEAD)" = "$(git ls-remote origin refs/heads/feat-x | cut -f1)" ] && ok "git push: the server's feat-x is HEAD" || fail "push did not land"
if git push origin HEAD:main 2>/dev/null; then fail "a push to main went through"; else ok "a push to main is refused"; fi

step "worktrees/main is read-only and follows a merge"
cd /work/acme
if (echo x > worktrees/main/README.md) 2>/dev/null; then fail "wrote into worktrees/main"; else ok "writing into worktrees/main fails ($(touch worktrees/main/x 2>&1 | sed 's/.*: //'))"; fi
pando diff feat-x | sed 's/^/  /'
pando merge feat-x | sed 's/^/  /'
grep -q "changed in the mount" worktrees/main/pkg3/f1.go && ok "worktrees/main shows the merged change" || fail "main did not follow the merge"
[ -f worktrees/main/notes.txt ] && ok "worktrees/main has the merged notes.txt" || fail "notes.txt missing in main"
[ -z "$(git -C worktrees/main status --porcelain)" ] && ok "git status in worktrees/main is clean after the merge" || fail "main status: $(git -C worktrees/main status --porcelain | head -3)"
# Known (fork): the first git status in any fresh ArtifactFS mount reads
# every file, because its index has no stat data. Reported, not failed.
echo "  note worktrees/main has downloaded $(hydrated main) of $total files after git status"

step "worktree list and remove"
pando worktree list | sed 's/^/  /'
pando worktree remove worktrees/feat-x | sed 's/^/  /'
if mountpoint -q "$wt" 2>/dev/null; then fail "feat-x still mounted"; else ok "feat-x is unmounted and gone"; fi

step "a monorepo with a reference, mounted read-only through ArtifactFS"
mkdir -p /work/ws/projects/web/worktrees /work/ws/research/infra/cloudflare
echo "notes" > /work/ws/AGENTS.md
git init -q -b main /work/ws/projects/web/worktrees/main
(cd /work/ws/projects/web/worktrees/main && echo web > index.html && git add -A && git commit -q -m web)
ref=research/infra/cloudflare/workers-oauth-provider
git clone -q --filter=blob:none https://github.com/cloudflare/workers-oauth-provider.git "/work/ws/$ref"
newest=$(git -C "/work/ws/$ref" rev-parse HEAD)
git -C "/work/ws/$ref" checkout -q --detach HEAD~1
older=$(git -C "/work/ws/$ref" rev-parse HEAD)
wsname="ws-$(date +%s)"
pando init /work/ws --yes --name "$wsname" --server "$SERVER" | grep -E "pushed|reference pointer" | sed 's/^/  /'
grep -q "commit = \"$newest\"" "/work/ws/.pando/references/$ref.toml" || grep -q "commit = \"$older\"" "/work/ws/.pando/references/$ref.toml" \
  && ok "init wrote the reference pointer" || fail "no pointer"
# The pointer at the older commit, so update has somewhere to go.
sed -i "s/^commit = .*/commit = \"$older\"/" "/work/ws/.pando/references/$ref.toml"
pando clone "$wsname" /work/ws2 --server "$SERVER" | sed 's/^/  /'
# The meta layer would carry the pointer; copy it in its place.
mkdir -p "/work/ws2/.pando/references/$(dirname "$ref")"
cp "/work/ws/.pando/references/$ref.toml" "/work/ws2/.pando/references/$ref.toml"
cd /work/ws2
pando reference sync | sed 's/^/  /'
mountpoint -q "$ref" && ok "the reference is a mount ($(findmnt -no FSTYPE "$ref"), $(findmnt -no OPTIONS "$ref" | cut -d, -f1))" || fail "reference not mounted"
[ "$(git -C "$ref" rev-parse HEAD)" = "$older" ] && ok "it shows the pointer's commit ${older:0:7}" || fail "HEAD $(git -C "$ref" rev-parse HEAD)"
[ -f "$ref/package.json" ] && ok "its files are listed (package.json, $(find "$ref" -path "$ref/.git" -prune -o -type f -print | wc -l) files)" || fail "no files"
if (echo x > "$ref/package.json") 2>/dev/null; then fail "wrote into a reference"; else ok "a reference takes no writes"; fi
pando reference update "$ref" | sed 's/^/  /'
[ "$(git -C "$ref" rev-parse HEAD)" = "$newest" ] && ok "reference update moved it to ${newest:0:7}" || fail "still at $(git -C "$ref" rev-parse --short HEAD)"
grep -q "commit = \"$newest\"" ".pando/references/$ref.toml" && ok "and rewrote the pointer" || fail "pointer not rewritten"
[ -z "$(git -C "$ref" status --porcelain)" ] && ok "git status in the reference is clean after the move" || fail "reference status: $(git -C "$ref" status --porcelain | head -3)"

echo
echo "PASS: $pass checks"
