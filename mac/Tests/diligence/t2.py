# Test 2: two processes race open(O_CREAT|O_EXCL) on the same name, N
# rounds; exactly one must win each round. Then mkdir on an existing folder
# (EEXIST) and plain O_CREAT on an existing file (opens it).
import os, sys, time, multiprocessing as mp

M = os.path.join(sys.argv[1], "t2")
N = int(sys.argv[2]) if len(sys.argv) > 2 else 1000


def racer(k, barrier, q):
    wins = []
    for r in range(N):
        barrier.wait()
        try:
            fd = os.open(os.path.join(M, f"r{r}"), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            os.write(fd, f"{k}\n".encode())
            os.close(fd)
            wins.append(r)
        except FileExistsError:
            pass
    q.put((k, wins))


if __name__ == "__main__":
    os.makedirs(M, exist_ok=True)
    b = mp.Barrier(2)
    q = mp.Queue()
    ps = [mp.Process(target=racer, args=(k, b, q)) for k in (1, 2)]
    t = time.perf_counter()
    [p.start() for p in ps]
    res = dict(q.get() for _ in ps)
    [p.join() for p in ps]
    secs = time.perf_counter() - t
    won = [0] * N
    for k, w in res.items():
        for r in w:
            won[r] += 1
    bad = [r for r in range(N) if won[r] != 1]
    print(f"O_EXCL race: {N} rounds in {secs:.1f}s, exactly one winner in {N - len(bad)}, bad rounds {bad[:10]}; wins p1 {len(res[1])} p2 {len(res[2])}")
    w1 = set(res[1])
    mism = [r for r in range(N) if open(os.path.join(M, f"r{r}")).read().strip() != ("1" if r in w1 else "2")]
    print(f"each file holds its winner's name: {not mism} (mismatches {mism[:5]})")
    try:
        os.mkdir(M)
        print("mkdir on an existing folder: no error (WRONG)")
    except FileExistsError:
        print("mkdir on an existing folder: EEXIST")
    p = os.path.join(M, "r0")
    before = open(p).read()
    fd = os.open(p, os.O_CREAT | os.O_RDWR, 0o644)
    data = os.read(fd, 10)
    os.close(fd)
    print(f"plain O_CREAT on an existing file opens it, content kept: {data.decode() == before}")
    for r in range(N):
        os.unlink(os.path.join(M, f"r{r}"))
    os.rmdir(M)
    print("cleaned up")
