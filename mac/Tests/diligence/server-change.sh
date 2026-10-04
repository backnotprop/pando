#!/bin/bash
# Lands one change to $1 on the server's main of the test repo (branch, push, pando merge).
export GIT_CONFIG_NOSYSTEM=1
cd /private/tmp/pando-mac-mount/src/mm/projects/app/worktrees/main || exit 1
git checkout -q main && git pull -q pando main
b=sc-$(date +%s)
git checkout -q -b $b
echo "// server change $(date -u +%T.%N)" >> "$1"
git -c user.name="Mac Mount Lane" -c user.email=ramos@plannotator.ai commit -q -am "server change to $1"
git push -q pando $b 2>&1 | grep -v "^remote" | tail -1
cd /private/tmp/pando-mac-mount/src/mm && /tmp/pando-mac-mount/bin/pando merge $b 2>&1 | tail -1
