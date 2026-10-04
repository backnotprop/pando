#!/bin/bash
# Restart the hand-made daemon; SLOW=1 uses the slow credential helper.
source /private/tmp/pando-mac-mount/afsenv.sh
[ -n "$SLOW" ] && export GIT_CONFIG_VALUE_1="!'/private/tmp/pando-mac-mount/slow-cred.sh'"
pkill -f "artifact-fs daemon --root /private/tmp/pando-mac-mount/mnt"
for i in $(seq 1 50); do pgrep -f "artifact-fs daemon --root /private/tmp/pando-mac-mount/mnt" >/dev/null || break; sleep 0.2; done
before=$(grep -c "speaks wire v3" /private/tmp/pando-mac-mount/logs/stream1.log)
log=/private/tmp/pando-mac-mount/logs/daemon-$(date +%H%M%S).log
cd /private/tmp/pando-mac-mount; nohup $AFS daemon --root /private/tmp/pando-mac-mount/mnt > "$log" 2>&1 &
echo $! > /private/tmp/pando-mac-mount/daemon.pid
for i in $(seq 1 100); do
  if grep -q "mount failed" "$log"; then echo "FAILED"; grep "mount failed" "$log" | cut -c1-400; exit 1; fi
  [ "$(grep -c 'speaks wire v3' /private/tmp/pando-mac-mount/logs/stream1.log)" -gt "$before" ] && break
  sleep 0.2
done
mount | grep -q pando-mac-mount/mnt/hand && echo "mounted; daemon $(cat /private/tmp/pando-mac-mount/daemon.pid), log $log" || echo "NOT mounted"
