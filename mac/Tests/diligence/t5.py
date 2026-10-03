# Test 5: open a file, remove it, keep reading; then check the daemon lets go
# of the bytes once the file is closed (FSKit reclaims, the extension forgets).
import os, sys, hashlib, subprocess, time
M, daemon = sys.argv[1], sys.argv[2]
def held():
    out = subprocess.run(["lsof", "-p", daemon], capture_output=True, text=True).stdout
    return [l for l in out.splitlines() if " REG " in l and "/overlays/hand/" in l and "sqlite" not in l]
p = os.path.join(M, "t5.bin")
data = os.urandom(20 * 1024 * 1024)
with open(p, "wb") as f: f.write(data)
want = hashlib.sha256(data).hexdigest()
fd = os.open(p, os.O_RDONLY)
os.unlink(p)
print(f"after rm: exists={os.path.exists(p)}")
got = hashlib.sha256()
while True:
    b = os.read(fd, 1 << 20)
    if not b: break
    got.update(b)
print(f"overlay file: read 20 MiB after rm, same bytes: {got.hexdigest() == want}")
os.lseek(fd, 0, 0)
print(f"fstat after rm: size {os.fstat(fd).st_size}")
print(f"daemon fds on the removed file while open: {len(held())}")
os.close(fd)
for i in range(40):
    time.sleep(0.25)
    if not held(): break
print(f"after close: daemon fds left {len(held())} (waited {0.25*(i+1):.2f}s)")
# A base file (from the repo, not changed locally).
q = os.path.join(M, "src", "f5.go")
before = open(q, "rb").read()
fd = os.open(q, os.O_RDONLY)
os.unlink(q)
after = os.read(fd, 4096)
os.close(fd)
print(f"base file: read after rm, same bytes: {after == before}")
