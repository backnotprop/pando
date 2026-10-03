package app

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"pando/internal/config"
)

// Main refreshes, coalesced (load test C23). Each refresh of a read-only
// main is one fetch from the git door, and bursts of merges used to make one
// per merge per machine. Now, per machine and per repo, at most one refresh
// runs. The first request refreshes at once (a single merge still arrives in
// about 40 ms). The refresher then keeps the slot for burstQuiet; requests
// in that time only mark the repo dirty. When requests stop for burstQuiet,
// or burstMax after the refresh, it refreshes exactly once more, to the
// newest main, and keeps the slot again. So a burst of merges costs two
// fetches, and steady merging at most one fetch per burstMax, whatever the
// merge rate.
//
// The slot is a file lock with a dirty marker beside it in .pando/local, so
// the follower and the background `pando worktree follow --once` that pando
// merge starts share it.

const (
	burstQuiet = 3 * time.Second
	burstMax   = 10 * time.Second
)

// refreshMainFn is the refresh itself; tests count calls through it.
var refreshMainFn = refreshMainLocked

type refreshLock struct{ f *os.File }

func (l *refreshLock) release() {
	syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	l.f.Close()
}

func refreshPaths(root *config.Root, repo string) (lock, dirty string) {
	name := strings.NewReplacer("/", "-", ".", "_").Replace(repoName(root, repo))
	dir := config.LocalDir(root.Dir)
	return filepath.Join(dir, "refresh-"+name+".lock"), filepath.Join(dir, "refresh-"+name+".dirty")
}

var errBusy = errors.New("a refresh is running")

// lockRefresh takes a repo's refresh slot; with wait false it returns
// errBusy when another holds it.
func lockRefresh(root *config.Root, repo string, wait bool) (*refreshLock, error) {
	lp, _ := refreshPaths(root, repo)
	if err := os.MkdirAll(filepath.Dir(lp), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(lp, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	how := syscall.LOCK_EX
	if !wait {
		how |= syscall.LOCK_NB
	}
	if err := syscall.Flock(int(f.Fd()), how); err != nil {
		f.Close()
		if !wait {
			return nil, errBusy
		}
		return nil, err
	}
	return &refreshLock{f: f}, nil
}

// requestMainRefresh asks for a repo's read-only mains here to move to the
// server's main, coalescing with any refresh already running.
func requestMainRefresh(e *Env, root *config.Root, repo string) {
	_, dirty := refreshPaths(root, repo)
	for {
		lk, err := lockRefresh(root, repo, false)
		if err != nil {
			// The holder refreshes once more after the burst.
			_ = os.WriteFile(dirty, nil, 0o644)
			return
		}
		_ = os.Remove(dirty)
		for {
			refreshMainFn(e, root, repo)
			if !waitBurst(dirty) {
				break
			}
			_ = os.Remove(dirty)
		}
		lk.release()
		// A request that came between the last check and the release.
		if _, err := os.Stat(dirty); err != nil {
			return
		}
	}
}

// waitBurst keeps the slot after a refresh: it returns false when no
// request came within burstQuiet, and true once requests have stopped for
// burstQuiet (or burstMax passed), meaning one more refresh is due.
func waitBurst(dirty string) bool {
	start := time.Now()
	for {
		st, err := os.Stat(dirty)
		switch {
		case err != nil && time.Since(start) >= burstQuiet:
			return false
		case err == nil && (time.Since(st.ModTime()) >= burstQuiet || time.Since(start) >= burstMax):
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
}
