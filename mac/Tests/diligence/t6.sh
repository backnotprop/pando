#!/bin/bash
# Test 6: macOS's own files in a worktree. Finder browsing (open), a Finder
# tag (an xattr), a downloaded file (quarantine xattr, copied with cp -p), and
# an editor's save (write a temp file, rename over); then list ._*, .DS_Store
# and .fseventsd, run git status, and ask Spotlight.
W="$1"
export GIT_CONFIG_NOSYSTEM=1
cd "$W" || exit 1
open "$W"          # Finder browses it (no automation permission needed)
sleep 4
xattr -w com.apple.metadata:_kMDItemUserTags '("Red\n6")' README.md && echo "tag set: $(xattr -p com.apple.metadata:_kMDItemUserTags README.md)"
dl=/tmp/pando-mac-mount/downloaded.txt
echo "downloaded" > $dl
xattr -w com.apple.quarantine "0083;66fe0000;Safari;" $dl
cp -p $dl docs/downloaded.txt && echo "copied in, quarantine: $(xattr -p com.apple.quarantine docs/downloaded.txt 2>&1)"
python3 - <<'EOF'
import os
p = "src/f7.go"
data = open(p).read() + "// saved by an editor\n"
tmp = ".f7.go.sb-tmp"
with open(os.path.join("src", tmp), "w") as f:
    f.write(data); f.flush(); os.fsync(f.fileno())
os.rename(os.path.join("src", tmp), p)
print("editor-style save: done")
EOF
xattr -l README.md docs/downloaded.txt src/f7.go | head
sleep 2
echo "._ files: $(find . -name '._*' -not -path './node_modules/*' | wc -l | tr -d ' ')"
echo ".DS_Store: $(find . -name .DS_Store | wc -l | tr -d ' ')"
echo ".fseventsd: $(ls -d .fseventsd 2>/dev/null || echo none)"
echo "git status:"; git status --porcelain | sed 's/^/  /'
echo "Spotlight: $(mdutil -s "$W" 2>&1 | tail -1)"
