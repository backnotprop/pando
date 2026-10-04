#!/usr/bin/env bash
# The Mac mount learns file sizes from the server, never by downloading the
# files. A repo of 3,000 files the server has never sized is cloned as an
# FSKit worktree; then:
#   - every file's size through the mount is its real size, and listing the
#     whole tree (ls -lR, find -size) downloads nothing;
#   - reading a file downloads that file only;
#   - after a branch is merged, main's new snapshot has the new sizes and
#     listing still downloads nothing.
#
#   cli/testbed/mac-sizes.sh <server url>
#
# Needs: pando signed in to the server (PANDO_HOME), Pando.app with its
# extension on, pando and the fork's artifact-fs (PANDO_ARTIFACT_FS). Never
# FUSE. Deletes the monorepo it made and unmounts its worktrees.
set -euo pipefail
export GIT_CONFIG_NOSYSTEM=1           # no osxkeychain prompts
SERVER="$1"
P="${PANDO_BIN:-pando}"
HYD="$(cd "$(dirname "$0")/../../mac/Tests/diligence" && pwd)/hyd.sh"
FILES="${SIZES_FILES:-3000}"
work=$(cd "$(mktemp -d /tmp/pando-sizes.XXXXXX)" && pwd -P)   # the real path: the daemon's state is keyed by it
name="sizes-$(date +%s)"
owner=$("$P" auth status --server "$SERVER" 2>/dev/null | sed -n 's/.*signed in as: \([a-z0-9-]*\).*/\1/p' | head -1)
fails=0
ok() { echo "  ok   $*"; }
bad() { echo "  FAIL $*"; fails=$((fails + 1)); }
ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
downloads() { AFS="${PANDO_ARTIFACT_FS:-artifact-fs}" bash "$HYD" "$1"; }   # "files bytes"
sizes() { (cd "$1" && find . -type f -not -path './.git/*' -not -name .git -not -name .metadata_never_index -print0 | xargs -0 stat -f '%z %N' | sort -k2); }

cleanup() {
  set +e
  for wt in "$work"/clone/projects/app/worktrees/*/; do
    [ -d "$wt" ] && (cd "$work/clone" && "$P" worktree remove "${wt%/}" >/dev/null 2>&1 || umount "${wt%/}" 2>/dev/null)
  done
  "$P" monorepo delete "$owner/$name" --yes >/dev/null 2>&1 && echo "  deleted $owner/$name"
  if [ -n "${state:-}" ]; then   # the repo folder's daemon, and its state
    st="${PANDO_HOME:-$HOME/.pando}/afs/app-$state"
    [ -f "$st/daemon.pid" ] && kill "$(cat "$st/daemon.pid")" 2>/dev/null
    rm -rf "$st"
  fi
  rm -rf "$work"
}
trap cleanup EXIT

echo "== a repo of $FILES files in 30 folders, pushed with pando init"
mkdir -p "$work/src/projects/app"
echo "# $name" > "$work/src/AGENTS.md"
python3 - "$work/src/projects/app" "$FILES" <<'PY'
import os, random, sys
root, n = sys.argv[1], int(sys.argv[2])
rnd = random.Random(7)
for i in range(n):
    d = os.path.join(root, f"d{i % 30:02d}")
    os.makedirs(d, exist_ok=True)
    size = rnd.choice([0, 1, 17, 512, 4096, 9000, 70000]) + i
    with open(os.path.join(d, f"f{i:05d}.txt"), "w") as f:
        f.write((f"{i} " * (size // 4 + 1))[:size])
with open(os.path.join(root, "big.bin"), "wb") as f:
    f.write(rnd.randbytes(3 << 20))
PY
git -C "$work/src/projects/app" init -q -b main
git -C "$work/src/projects/app" add -A
git -C "$work/src/projects/app" -c user.name=t -c user.email=t@t commit -qm files
(cd "$work/src" && "$P" init --yes --name "$name" --server "$SERVER" >/dev/null)
ok "pushed $owner/$name"

echo "== pando clone: an FSKit worktree of a repo the server has never sized"
t0=$(ms)
(cd "$work" && "$P" clone "$owner/$name" clone > "$work/clone.log" 2>&1)
t1=$(ms)
main="$work/clone/projects/app/worktrees/main"
grep -q 'fskit worktree' "$work/clone.log" && ok "main is an FSKit worktree, ready in $((t1 - t0)) ms" || { bad "not an FSKit worktree"; cat "$work/clone.log"; exit 1; }

echo "== a folder, not a drive: mounted nobrowse, so not on the Desktop or in Finder's sidebar"
mount | grep -F " on $main (" | grep -q nobrowse && ok "mounted nobrowse" || bad "no nobrowse: $(mount | grep -F " on $main (")"
# Finder's volume list: mountedVolumeURLs without hidden volumes.
finder=$(osascript -l JavaScript -e 'function run(a){ObjC.import("Foundation"); var l=$.NSFileManager.defaultManager.mountedVolumeURLsIncludingResourceValuesForKeysOptions($(), $.NSVolumeEnumerationSkipHiddenVolumes); for (var i=0;i<l.count;i++){ if (ObjC.unwrap(l.objectAtIndex(i).path)===a[0]) return "listed"; } return "hidden";}' "$main")
[ "$finder" = hidden ] && ok "not in Finder's volume list" || bad "Finder lists $main as a volume"

AFS="${PANDO_ARTIFACT_FS:-artifact-fs}" bash "$HYD" "$main" > /dev/null
state=$(cd "$main/../.." && printf '%s' "$PWD" | shasum -a 256 | cut -c1-10)
[ -d "${PANDO_HOME:-$HOME/.pando}/afs/app-$state" ] || { bad "no daemon state for $main; downloads cannot be counted"; exit 1; }

echo "== every size right, the whole tree listed, nothing downloaded"
sizes "$work/src/projects/app" > "$work/want"
ls -lR "$main" > /dev/null
sizes "$main" > "$work/got"
if diff -q "$work/want" "$work/got" > /dev/null; then ok "$(wc -l < "$work/want" | tr -d ' ') sizes match the source"; else bad "sizes differ: $(diff "$work/want" "$work/got" | head -5)"; fi
read -r files bytes < <(downloads "$main")
[ "$files" = 0 ] && ok "listing downloaded nothing" || bad "listing downloaded $files files, $bytes bytes"

echo "== reading downloads only what is read"
cmp -s "$work/src/projects/app/d03/f00003.txt" "$main/d03/f00003.txt" && cmp -s "$work/src/projects/app/big.bin" "$main/big.bin" && ok "two files read back whole" || bad "content differs"
read -r files bytes < <(downloads "$main")
[ "$files" = 2 ] && ok "2 files downloaded ($bytes bytes)" || bad "$files files downloaded after reading 2"

echo "== a branch merged: main's next snapshot keeps its sizes right"
(cd "$work/clone" && "$P" worktree add projects/app feat > "$work/add.log" 2>&1) || { bad "worktree add"; cat "$work/add.log"; }
feat="$work/clone/projects/app/worktrees/feat"
for k in 1 2 3 4 5; do printf 'changed %s\n' "$k" >> "$feat/d0$k/f0000$k.txt"; printf 'new file %s\n' "$k" > "$feat/d0$k/new$k.txt"; done
git -C "$feat" add -A && git -C "$feat" commit -qm "5 edits, 5 new files" && git -C "$feat" push -q 2>&1 | grep -v '^remote:' || true
(cd "$work/clone" && "$P" merge feat --force > "$work/merge.log" 2>&1) && ok "merged feat" || { bad "merge"; cat "$work/merge.log"; }
for _ in $(seq 1 90); do [ -e "$main/d05/new5.txt" ] && break; sleep 1; done
[ -e "$main/d05/new5.txt" ] && ok "main has the merge" || bad "main did not move within 90 s"
for k in 1 2 3 4 5; do printf 'changed %s\n' "$k" >> "$work/src/projects/app/d0$k/f0000$k.txt"; printf 'new file %s\n' "$k" > "$work/src/projects/app/d0$k/new$k.txt"; done
before=$(downloads "$main" | cut -d' ' -f1)
sizes "$work/src/projects/app" > "$work/want2"
sizes "$main" > "$work/got2"
if diff -q "$work/want2" "$work/got2" > /dev/null; then ok "all sizes right after the merge"; else bad "sizes differ after the merge: $(diff "$work/want2" "$work/got2" | head -5)"; fi
after=$(downloads "$main" | cut -d' ' -f1)
[ "$after" = "$before" ] && ok "listing after the merge downloaded nothing" || bad "listing after the merge downloaded $((after - before)) files"

echo "== $fails failures"
[ "$fails" = 0 ]
