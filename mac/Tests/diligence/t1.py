# Test 1: while one cold read waits on a slow fetch, metadata calls from a
# second "shell" must not stall. Prints the slowest call and a histogram.
import os, sys, time, threading, subprocess
M = sys.argv[1]
lat = []
stop = threading.Event()
def meta():
    i = 0
    while not stop.is_set():
        i += 1
        name = os.path.join(M, f"t1-{os.getpid()}-{i}")
        for what, fn in (
            ("stat", lambda: os.stat(os.path.join(M, "src", f"f{1 + i % 20}.go"))),
            ("lsdir", lambda: [os.lstat(os.path.join(M, "src", n)) for n in os.listdir(os.path.join(M, "src"))]),
            ("create", lambda: open(name, "w").close()),
            ("stat-new", lambda: os.stat(name)),
            ("unlink", lambda: os.unlink(name)),
        ):
            t = time.perf_counter(); fn(); lat.append((what, time.perf_counter() - t))
        time.sleep(0.02)
th = threading.Thread(target=meta); th.start()
t = time.perf_counter()
out = subprocess.run(["shasum", "-a", "256", os.path.join(M, "big", "blob.bin")], capture_output=True, text=True)
read_s = time.perf_counter() - t
time.sleep(0.5); stop.set(); th.join()
worst = sorted(lat, key=lambda x: -x[1])[:5]
ms = sorted(l for _, l in lat)
print(f"cold read of big/blob.bin (30,000,000 bytes): {read_s:.2f}s, {out.stdout.split()[0][:12] if out.stdout else out.stderr}")
print(f"metadata calls during it: {len(lat)}, median {ms[len(ms)//2]*1000:.1f} ms, p99 {ms[int(len(ms)*.99)]*1000:.1f} ms, max {ms[-1]*1000:.1f} ms")
print("slowest:", ", ".join(f"{w} {l*1000:.1f} ms" for w, l in worst))
