#!/bin/bash
# Test 7: a server change lands in the mount by write-through. Moves the
# mount's main the way `pando` refreshes a read-only main, then times
# (a) cat, (b) FSEvents, (c) kqueue on an open file.
source /private/tmp/pando-mac-mount/afsenv.sh
M=/private/tmp/pando-mac-mount/mnt/hand
G=/private/tmp/pando-mac-mount/afs/repos/hand/git
F=$M/${1:-README.md}
cat "$F" | head -3
git --git-dir=$G fetch -q origin main
old=$(git --git-dir=$G rev-parse HEAD); new=$(git --git-dir=$G rev-parse refs/remotes/origin/main)
echo "HEAD $old -> $new"
git --git-dir=$G read-tree -m $old $new
want=$(git --git-dir=$G show $new:${1:-README.md} | shasum | cut -c1-12)
exec 3> >(/private/tmp/pando-mac-mount/probe/watch $M $F 40 > /private/tmp/pando-mac-mount/logs/t7-watch.log)
sleep 1.5
t0=$(python3 -c 'import time; print(int(time.time()*1000))')
echo $t0 >&3
git --git-dir=$G update-ref refs/heads/main $new $old
python3 - "$F" "$want" "$t0" <<'PY'
import sys, time, hashlib
f, want, t0 = sys.argv[1], sys.argv[2], int(sys.argv[3])
while True:
    try:
        if hashlib.sha1(open(f, "rb").read()).hexdigest()[:12] == want:
            print(f"(a) cat shows the new content after {time.time()*1000 - t0:.0f} ms"); break
    except OSError:
        pass
    if time.time()*1000 - t0 > 60000:
        print("(a) cat: no change after 60 s"); break
    time.sleep(0.02)
PY
sleep 3
grep -v "^ready\|^start" /private/tmp/pando-mac-mount/logs/t7-watch.log | head -8
grep "written through" $(ls -t /private/tmp/pando-mac-mount/logs/daemon-*.log | head -1) | tail -1 | cut -c1-200
