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
made=()
cleanup() {
  for m in "${made[@]}"; do pando monorepo delete "$m" --yes --server "$SERVER" | sed 's/^/  /' || true; done
}
trap cleanup EXIT

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
made+=("$name")
pando init --yes --name "$name" --server "$SERVER" | sed 's/^/  /'
cd /work
pando clone "$name" /work/acme | sed 's/^/  /'
cd /work/acme
mountpoint -q worktrees/main && ok "worktrees/main is a mount" || fail "worktrees/main is not mounted"
findmnt -no OPTIONS worktrees/main | tr ',' '\n' | grep -qx ro && ok "worktrees/main is mounted ro by ArtifactFS itself (no bind)" || fail "main mount options: $(findmnt -no OPTIONS worktrees/main)"
[ "$(findmnt -no FSTYPE worktrees/main)" = "fuse.artifact-fs" ] && ok "and it is the fuse.artifact-fs mount" || fail "main fstype: $(findmnt -no FSTYPE worktrees/main)"

step "a branch worktree through ArtifactFS"
start=$(date +%s%N)
PANDO_AGENT=agent-7 pando worktree add . feat-x | sed 's/^/  /'
end=$(date +%s%N)
wt=/work/acme/worktrees/feat-x
mountpoint -q "$wt" && ok "worktrees/feat-x is a FUSE mount ($(findmnt -no FSTYPE "$wt"))" || fail "feat-x is not mounted"
echo "  pando worktree add took $(( (end - start) / 1000000 )) ms"

step "the daemon fetches on its own only for main (every 10 min), never for a branch"
gitdir_of() { ls -d "$PANDO_HOME"/afs/*/repos/"$1"/git | head -1; }
state_of() { dirname "$(dirname "$(dirname "$(gitdir_of "$1")")")"; }
afs_status() { ARTIFACT_FS_ROOT="$(state_of "$1")" artifact-fs status --name "$1" | tr ' ' '\n' | sed -n "s/^$2=//p"; }
[ "$(afs_status feat-x remote_refresh)" = disabled ] && ok "feat-x: the daemon's remote refresh is off (--refresh never)" || fail "feat-x remote_refresh=$(afs_status feat-x remote_refresh)"
[ "$(afs_status main remote_refresh)" = enabled ] && ok "main: the daemon's remote refresh is on, as a safety net (--refresh 10m)" || fail "main remote_refresh=$(afs_status main remote_refresh)"
# A control mount with a 20 s refresh, to show the count sees fetches.
PANDO_AGENT=ctl pando worktree add . ctl >/dev/null
ARTIFACT_FS_ROOT="$(state_of ctl)" artifact-fs set-refresh --name ctl --interval 20s >/dev/null
fetch_count() { # distinct FETCH_HEAD times per mount, sampled every 2 s for $1 s
  local secs="$1"; shift; declare -A last cnt
  for n in "$@"; do last[$n]=$(stat -c %Y "$(gitdir_of "$n")/FETCH_HEAD" 2>/dev/null || echo none); cnt[$n]=0; done
  for _ in $(seq 1 $((secs / 2))); do
    sleep 2
    for n in "$@"; do
      t=$(stat -c %Y "$(gitdir_of "$n")/FETCH_HEAD" 2>/dev/null || echo none)
      [ "$t" != "${last[$n]}" ] && cnt[$n]=$((cnt[$n] + 1)) && last[$n]=$t
    done
  done
  for n in "$@"; do echo "$n=${cnt[$n]}"; done
}
counts=$(fetch_count 70 feat-x main ctl | tr '\n' ' ')
echo "  fetches in 70 s with no pushes: $counts"
echo "$counts" | grep -q "feat-x=0 " && ok "feat-x (a branch): 0 fetches in 70 s" || fail "branch fetches: $counts"
echo "$counts" | grep -q "main=0 " && ok "main: 0 fetches in 70 s (next one within 10 min)" || fail "main fetches: $counts"
echo "$counts" | grep -Eq "ctl=[2-9]" && ok "control at a 20 s refresh: the count does see fetches" || fail "control: $counts"
pando worktree remove worktrees/ctl --force >/dev/null

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

step "git settings for the Pando host, and pushes Pando cannot take"
url=$(git -C /work/acme/worktrees/main remote get-url origin)
case "$url" in
  http*)
    for w in /work/acme/worktrees/main "$wt"; do
      v=$(git -C "$w" config --get-urlmatch http.version "$url")
      b=$(git -C "$w" config --get-urlmatch http.postbuffer "$url")
      [ "$v" = "HTTP/1.1" ] && [ "$b" = "104857600" ] && ok "$(basename "$w"): http.version HTTP/1.1, http.postBuffer 104857600 for the Pando host" || fail "$(basename "$w"): version=$v postBuffer=$b"
    done
    [ -z "$(git -C "$wt" config --get-urlmatch http.version https://github.com/x/y.git)" ] && ok "other hosts keep git's defaults" || fail "settings leaked to other hosts"
    [ "$(git -C "$wt" config --get-urlmatch http.extraheader "$url")" = "X-Pando-Agent: agent-7" ] && ok "feat-x pushes carry X-Pando-Agent: agent-7, to the Pando host only" || fail "agent header: $(git -C "$wt" config --get-urlmatch http.extraheader "$url")"
    [ -z "$(git -C "$wt" config --get-urlmatch http.extraheader https://github.com/x/y.git)" ] || fail "agent header leaked to another host"
    [ -z "$(git -C /work/acme/worktrees/main config --get-urlmatch http.extraheader "$url")" ] && ok "main, made with no agent, sends none" || fail "main has an agent header"
    ;;
  *) echo "  note the HTTP settings apply to http(s) servers; this run uses $url" ;;
esac
cd "$wt"
head -c 33000000 /dev/urandom > huge.bin && git add huge.bin && git commit -q -m "a 33 MB file"
if out=$(git push -q 2>&1); then fail "a 33 MB file was pushed"; else
  echo "$out" | grep -q "huge.bin  33.0 MB" && ok "a 33 MB file is refused before sending, by name" || fail "33 MB: $out"; fi
git reset -q --hard HEAD~1
head -c 6000000 /dev/urandom > r.bin && git add r.bin && git commit -q -m "6 MB"
if out=$(PANDO_PUSH_LIMIT=5000000 git push -q 2>&1); then fail "a push over the (lowered) limit went"; else
  echo "$out" | grep -q "split it into several pushes" && ok "a push over the push limit is refused, with how to split (limit lowered to 5 MB)" || fail "push limit: $out"; fi
git reset -q --hard HEAD~1
cd /work/acme

step "worktrees/main is read-only and follows a merge"
cd /work/acme
if (echo x > worktrees/main/README.md) 2>/dev/null; then fail "wrote into worktrees/main"; else ok "writing into worktrees/main fails ($(touch worktrees/main/x 2>&1 | sed 's/.*: //'))"; fi
pando diff feat-x | sed 's/^/  /'
merged=$(pando merge feat-x) && echo "$merged" | sed 's/^/  /'
echo "$merged" | grep -q "follows within a moment" && ok "pando merge returns once the server merged; main follows on its own" || fail "merge: $merged"
for _ in $(seq 1 150); do grep -q "changed in the mount" worktrees/main/pkg3/f1.go 2>/dev/null && break; sleep 0.1; done
grep -q "changed in the mount" worktrees/main/pkg3/f1.go && ok "worktrees/main shows the merged change" || fail "main did not follow the merge"
[ -f worktrees/main/notes.txt ] && ok "worktrees/main has the merged notes.txt" || fail "notes.txt missing in main"
[ -z "$(git -C worktrees/main status --porcelain)" ] && ok "git status in worktrees/main is clean after the merge" || fail "main status: $(git -C worktrees/main status --porcelain | head -3)"
hm=$(hydrated main)
[ "$hm" -lt 20 ] && ok "git status in worktrees/main downloaded $hm of $total files (index-stat)" || fail "worktrees/main hydrated $hm blobs after git status"

step "the daemon stops (as at a reboot); pando worktree mount brings the mounts back"
pkill -9 -f "artifact-fs daemon" || true
sleep 1
pando worktree mount | sed 's/^/  /'
grep -q "changed in the mount" worktrees/main/pkg3/f1.go && ok "worktrees/main reads again after pando worktree mount" || fail "worktrees/main did not come back"
[ -z "$(git -C "$wt" status --porcelain)" ] && ok "git status in feat-x works again" || fail "feat-x after mount: $(git -C "$wt" status --porcelain 2>&1 | head -3)"
out=$(pando worktree mount) && echo "$out" | grep -qx "Every worktree here is mounted." && ok "a second pando worktree mount has nothing to do" || fail "second mount: $out"

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
made+=("$wsname")
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

case "$SERVER" in http*)
  step "a second machine's main follows merges through the event stream"
  out=$(PANDO_BIN=pando /testbed/follow-latency.sh "$SERVER" 3 2>&1)
  echo "$out" | grep -E '^merge ' | sed 's/^/  /'
  slow=$(echo "$out" | sed -n 's/.*moved \([0-9]*\) ms after.*/\1/p' | awk '$1 > 5000' | wc -l)
  [ "$(echo "$out" | grep -c 'moved [0-9]* ms after')" = 3 ] && [ "$slow" = 0 ] \
    && ok "3 merges: the follower's main moved within 5 s of each (was up to 15 s by polling)" || fail "follow: $out"
  ;;
esac

step "as a person without root: read-only main by ArtifactFS --read-only"
useradd -m dev >/dev/null 2>&1 || true
chmod 666 /dev/fuse
out=$(su dev -c '
set -e
unset PANDO_SERVER PANDO_TOKEN
export HOME=/home/dev PANDO_HOME=/home/dev/.pando PANDO_MACHINE=linux-dev
export GIT_AUTHOR_NAME=D GIT_AUTHOR_EMAIL=d@d GIT_COMMITTER_NAME=D GIT_COMMITTER_EMAIL=d@d
cd ~ && git init -q -b main src && cd src && echo hi > a.txt && git add -A && git commit -qm one
echo x | pando login --bootstrap --server file:///home/dev/srv --login dev >/dev/null
pando init --yes --name acme --server file:///home/dev/srv >/dev/null && pando clone acme ~/acme --server file:///home/dev/srv >/dev/null && cd ~/acme
echo "uid=$(id -u) main=$(findmnt -no OPTIONS worktrees/main | cut -d, -f1)"
(echo y > worktrees/main/a.txt) 2>/dev/null && echo "main=writable" || echo "main=refused"
pando worktree add . feat >/dev/null && echo "feat=$(findmnt -no OPTIONS worktrees/feat | cut -d, -f1)"
cd worktrees/feat
# A file created 0444 and written through its open descriptor, as git writes
# its packs: a daemon that is not root must still write its backing file.
(umask 0222 && printf "ro-data\n" > ro.txt) && echo "ro0444=$(stat -c %a ro.txt):$(cat ro.txt)" && rm -f ro.txt
git clone -q --no-local "file://$HOME/src" clone-in && git -C clone-in fsck --no-progress && echo "clone-in=ok" && rm -rf clone-in
echo two >> a.txt && git commit -qam two && git push -q && cd ~/acme && pando merge --wait feat >/dev/null
echo "main-content=$(tr "\n" " " < worktrees/main/a.txt)"
pando worktree remove worktrees/feat >/dev/null && echo "removed=yes"
' 2>&1) || true
echo "$out" | grep -q "uid=1000 main=ro" && ok "uid 1000: worktrees/main mounts ro with no root" || fail "non-root: $out"
echo "$out" | grep -q "main=refused" && ok "uid 1000: writing into main is refused" || fail "non-root: $out"
echo "$out" | grep -q "feat=rw" && ok "uid 1000: a branch worktree mounts rw" || fail "non-root: $out"
echo "$out" | grep -q "ro0444=444:ro-data" && ok "uid 1000: a file created 0444 is written through its open descriptor" || fail "non-root: $out"
echo "$out" | grep -q "clone-in=ok" && ok "uid 1000: git clone into a worktree (packs written 0444), fsck clean" || fail "non-root: $out"
echo "$out" | grep -q "main-content=hi two" && ok "uid 1000: main follows the merge" || fail "non-root: $out"
echo "$out" | grep -q "removed=yes" && ok "uid 1000: worktree remove unmounts" || fail "non-root: $out"

echo
echo "PASS: $pass checks"
