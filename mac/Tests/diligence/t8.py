# Test 8: change a file behind the kernel (in the daemon's overlay only, not
# through the mount) and time how long the mount shows the old state.
#   A: stat size and cat of an existing file
#   B: ls of its folder for a new name; after 20 s, a change through the
#      mount elsewhere bumps the directory verifier.
import os, sys, time, sqlite3, subprocess
M = sys.argv[1]
DB = "/private/tmp/pando-mac-mount/afs/overlays/hand/meta.sqlite"
D = os.path.join(M, "t8")
os.makedirs(D, exist_ok=True)
p = os.path.join(D, "a.txt")
with open(p, "w") as f:
    f.write("hello\n")
time.sleep(1)
os.stat(p); open(p).read(); os.listdir(D)  # the kernel now holds attrs, data, listing

db = sqlite3.connect(DB, timeout=10)
backing = db.execute("select backing_path from overlay_entries where path='t8/a.txt'").fetchone()[0]
with open(backing, "a") as f:
    f.write("changed behind the kernel\n")
now = time.time_ns()
db.execute("update overlay_entries set size_bytes=?, mtime_unix_ns=?, ctime_unix_ns=? where path='t8/a.txt'",
           (os.path.getsize(backing), now, now))
# B: a new name in the folder.
nb = os.path.join(os.path.dirname(backing), ".artifact-fs-entry-t8new")
with open(nb, "w") as f:
    f.write("new\n")
db.execute("insert into overlay_entries(path, kind, backing_path, mode, size_bytes, mtime_unix_ns, ctime_unix_ns, source_oid, source_mode, target_path) values (?,?,?,?,?,?,?,?,?,?)",
           ("t8/new.txt", "create", nb, 0o100644, 4, now, now, "", 0, ""))
db.commit()
t0 = time.time()
seen = {}
bumped = False
while time.time() - t0 < 90 and len(seen) < 3:
    el = time.time() - t0
    if "stat" not in seen and os.stat(p).st_size != 6:
        seen["stat"] = el
    if "cat" not in seen and "behind" in open(p).read():
        seen["cat"] = el
    if "ls" not in seen and "new.txt" in os.listdir(D):
        seen["ls"] = el
    if not bumped and el > 20:
        open(os.path.join(M, "t8-bump.txt"), "w").close()  # bumps the verifier
        bumped = True
        seen.setdefault("bump_at", el)
    time.sleep(0.1)
for k in ("stat", "cat", "ls"):
    print(f"{k}: " + (f"fresh after {seen[k]:.1f} s" if k in seen else "still stale after 90 s"))
print(f"verifier bumped at {seen.get('bump_at', 0):.1f} s")
os.unlink(os.path.join(M, "t8-bump.txt"))
