#!/bin/bash
# hyd.sh <worktree folder>: what the worktree's daemon has downloaded so far,
# as "files bytes" (hydrated_blobs, hydrated_bytes from artifact-fs status).
# The state root is the cli's: ~/.pando/afs/<repo folder>-<first 10 hex of
# sha256(repo folder path)>, with the worktree's folder name as repo name.
wt=$(cd "$1" 2>/dev/null && pwd -P || echo "$1")
wt=${wt%/}
repo=$(dirname "$(dirname "$wt")")
hash=$(printf '%s' "$repo" | shasum -a 256 | cut -c1-10)
state="${PANDO_HOME:-$HOME/.pando}/afs/$(basename "$repo")-$hash"
ARTIFACT_FS_ROOT="$state" "${AFS:-artifact-fs}" status --name "$(basename "$wt")" 2>/dev/null |
  tr ' ' '\n' | awk -F= '$1=="hydrated_blobs"{b=$2} $1=="hydrated_bytes"{y=$2} END{print b+0, y+0}'
