#!/usr/bin/env bash
# pando-agent-workspace <owner/name> <repo path> <branch>
#
# Makes the session's workspace in /workspace/repo, the way pando does on any
# machine: pando clone, then the branch's worktree with pando worktree add.
# Through ArtifactFS (FUSE) where it works, else pando's sparse clone. After a
# start from a snapshot the files are there but the mounts and the daemon are
# not, so pando worktree mount brings them back. Prints one last line:
#   workspace <folder> <mount|clone>
set -uo pipefail

full=$1 repo=$2 branch=$3
root=/workspace/repo
folder=${branch//\//-}
if [ "$repo" = . ]; then wt="$root/worktrees/$folder"; else wt="$root/$repo/worktrees/$folder"; fi

works() { git -C "$wt" rev-parse --is-inside-work-tree >/dev/null 2>&1; }

say() {
  if [ "$(findmnt -no FSTYPE "$wt" 2>/dev/null)" = fuse.artifact-fs ]; then
    echo "workspace $wt mount"
  else
    echo "workspace $wt clone"
  fi
}

clear_mounts() {
  pkill -x artifact-fs 2>/dev/null
  awk '$3 ~ /artifact-fs/ {print $2}' /proc/mounts | while read -r m; do fusermount3 -uz "$m" 2>/dev/null; done
}

fresh() {
  clear_mounts
  rm -rf "$root"
  mkdir -p /workspace
  (cd /workspace && PANDO_WORKTREE_KIND=$1 pando clone "$full" repo) &&
    (cd "$root" && PANDO_WORKTREE_KIND=$1 pando worktree add "$repo" "$branch")
}

# Running already, or restored from a snapshot.
if [ -d "$root/.pando" ]; then
  works && { say; exit 0; }
  (cd "$root" && pando worktree mount) >&2
  works && { say; exit 0; }
  echo "the saved workspace did not come back; starting from the branch" >&2
fi

if [ -e /dev/fuse ] && fresh "" >&2 && works; then
  say
  exit 0
fi
echo "no mount here; using a clone" >&2
fresh sparse >&2 && works && { say; exit 0; }
echo "the workspace could not be made" >&2
exit 1
