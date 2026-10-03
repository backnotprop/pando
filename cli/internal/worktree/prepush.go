package worktree

// prePushScript refuses, before git sends anything, a push the Pando server
// cannot take:
//
//   - a file over 32 MB (32,000,000 bytes): Artifacts' limit for one blob;
//   - a push over 100 MB (100,000,000 bytes): Cloudflare's request body
//     limit on workers.dev. A larger push would go chunked over HTTP/1.1,
//     which hung against the Worker.
//
// It lists the objects the push adds (what the remote's branches do not
// already have) and sums their sizes. That uncompressed sum is an upper
// bound on the pack, so under the limit the push goes on at once. Over it,
// the script builds the pack git would send and measures it, so a large but
// compressible push is not refused for nothing. Nothing is fetched: in a
// blobless worktree, objects the remote already has are skipped.
//
// It is installed as each worktree's pre-push hook, and pando init runs it
// before the first push of main. $1 is the remote, $2 its URL, and stdin has
// git's pre-push lines. PANDO_PUSH_LIMIT and PANDO_BLOB_LIMIT change the
// limits (tests); git push --no-verify skips it.
const prePushScript = `#!/bin/sh
# Pando: refuse a push the server cannot take, before git sends it.
# See cli/internal/worktree/prepush.go.
remote="$1"
push_limit="${PANDO_PUSH_LIMIT:-100000000}"
blob_limit="${PANDO_BLOB_LIMIT:-32000000}"
export GIT_NO_LAZY_FETCH=1
revs=""
while read -r lref lsha rref rsha; do
  case "$lsha" in *[!0]*) ;; *) continue ;; esac   # a delete sends nothing
  revs="$revs $lsha"
  case "$rsha" in *[!0]*)
    git cat-file -e "$rsha^{commit}" 2>/dev/null && revs="$revs ^$rsha" ;;
  esac
done
[ -n "$revs" ] || exit 0
# shellcheck disable=SC2086
sizes=$(git rev-list --objects --missing=allow-promisor $revs --not --remotes="$remote" |
  git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' 2>/dev/null)
mb() { awk -v b="$1" 'BEGIN { printf "%.1f MB", b / 1000000 }'; }
big=$(printf '%s\n' "$sizes" | awk -v lim="$blob_limit" '$1 == "blob" && $2 + 0 > lim {
  p = substr($0, length($1) + length($2) + 3); printf "%s\t%s\n", $2, (p == "" ? "(a file)" : p) }')
if [ -n "$big" ]; then
  echo "pando: this push has a file Pando cannot store (Artifacts takes files up to $(mb "$blob_limit")):" >&2
  printf '%s\n' "$big" | while IFS="$(printf '\t')" read -r size path; do
    echo "  $path  $(mb "$size")" >&2
  done
  echo "pando: take it out of the commits being pushed (git rm --cached <file>, then amend or rebase), and push again." >&2
  exit 1
fi
total=$(printf '%s\n' "$sizes" | awk '{ t += $2 } END { printf "%.0f", t }')
[ "$total" -gt "$push_limit" ] || exit 0
# Over the limit uncompressed: measure the pack git would send.
# shellcheck disable=SC2086
packed=$( { printf '%s\n' $revs; echo --not; git for-each-ref --format='%(objectname)' "refs/remotes/$remote/"; } |
  git pack-objects --revs --stdout --quiet --missing=allow-promisor 2>/dev/null | wc -c | tr -d ' ')
[ "${packed:-0}" -gt "$push_limit" ] || exit 0
echo "pando: this push is $(mb "$packed"), over the $(mb "$push_limit") one push to Pando can carry (Cloudflare's request limit)." >&2
echo "pando: split it into several pushes, oldest commits first, for example:" >&2
echo "pando:   git push $remote <an older commit>:refs/heads/<this branch>   then   git push" >&2
exit 1
`

// PrePushScript is the pre-push check, for pando init's first push.
func PrePushScript() string { return prePushScript }
