#!/usr/bin/env bash
# Builds the Linux test bed and runs it privileged for FUSE, on Colima.
# Never run FUSE on the Mac host (macFUSE there is not approved).
#
#   cli/testbed/run.sh                 the end-to-end test (testbed/e2e.sh)
#   cli/testbed/run.sh bash            a shell in the test bed
#
# PANDO_SERVER and PANDO_TOKEN, when set, are passed through to test against a
# real server; the token goes in by name only and is never printed.
# PANDO_TOKEN_FILE names a file to read the token from (for example
# ~/.pando/credentials/<host>), so it never appears on a command line.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cli="$(dirname "$here")"
afs="${ARTIFACT_FS_SRC:-$(cd "$cli/../../../../artifact-fs/worktrees/main" && pwd)}"
ctx="${DOCKER_CONTEXT_NAME:-colima}"
image=pando-testbed

docker --context "$ctx" build -q -t "$image" --build-context afs-src="$afs" -f "$here/Dockerfile" "$cli" >/dev/null
echo "testbed: built $image (artifact-fs from $afs)"

if [ -n "${PANDO_TOKEN_FILE:-}" ]; then
  PANDO_TOKEN="$(cat "$PANDO_TOKEN_FILE")"
  export PANDO_TOKEN
fi
envs=()
[ -n "${PANDO_SERVER:-}" ] && envs+=(-e PANDO_SERVER)
[ -n "${PANDO_TOKEN:-}" ] && envs+=(-e PANDO_TOKEN)
tty=()
[ -t 0 ] && [ -t 1 ] && tty=(-it)

exec docker --context "$ctx" run --rm "${tty[@]}" \
  --device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
  "${envs[@]}" "$image" "$@"
