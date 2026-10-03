#!/bin/sh
# Test 1 only: a slow fetch. Sleeps, then answers as `pando credential`.
[ "$1" = get ] && sleep "${PANDO_SLOW_FETCH:-10}"
exec /tmp/pando-mac-mount/bin/pando credential "$@"
