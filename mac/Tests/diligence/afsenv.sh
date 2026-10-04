# The FSKit diligence tests (research/plans/pando-2026-10-02/FSKIT-WIRE-DILIGENCE-2026-10-02.md,
# section 8.2), as run on 2026-10-03 against a hand-made mount. Paths are this
# Mac's: binaries in /tmp/pando-mac-mount/bin, the test repo's source in
# /private/tmp/pando-mac-mount/src, the mount at /private/tmp/pando-mac-mount/mnt/hand.
#
# Order: source afsenv.sh; $AFS add-repo --name hand --remote "$URL" --ref refs/heads/main
#   --mount-root /private/tmp/pando-mac-mount/mnt; restart-daemon.sh (SLOW=1 for test 1);
#   then t1.py <mount>, t2.py <mount> 1000, t3 by hand (see the lane report),
#   t5.py <mount> <daemon pid>, t6.sh <mount>, server-change.sh <file> then t7.sh <file>,
#   t8.py <mount>; watch.swift is built with `xcrun swiftc -O watch.swift -o watch`.
# restart-daemon.sh greps a running `log stream` into logs/stream1.log for the
# extension's "speaks wire v3" line.
#
# Environment for running the fork's artifact-fs by hand, as the cli's driver does.
export GIT_CONFIG_NOSYSTEM=1
export ARTIFACT_FS_ROOT=/private/tmp/pando-mac-mount/afs
S=https://pando-dev.plannotator.workers.dev
export GIT_CONFIG_COUNT=5
export GIT_CONFIG_KEY_0="credential.$S.helper" GIT_CONFIG_VALUE_0=""
export GIT_CONFIG_KEY_1="credential.$S.helper" GIT_CONFIG_VALUE_1="!'/tmp/pando-mac-mount/bin/pando' credential"
export GIT_CONFIG_KEY_2="credential.$S.useHttpPath" GIT_CONFIG_VALUE_2=true
export GIT_CONFIG_KEY_3="http.$S/.version" GIT_CONFIG_VALUE_3=HTTP/1.1
export GIT_CONFIG_KEY_4="http.$S/.postBuffer" GIT_CONFIG_VALUE_4=104857600
AFS=/tmp/pando-mac-mount/bin/artifact-fs
URL="$S/$(cat /private/tmp/pando-mac-mount/NAME)/projects-app.git"
