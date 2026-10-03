//go:build linux

package meta

// inotify, through golang.org/x/sys/unix: one watch per folder the meta
// layer syncs (never node_modules/, projects/, a nested repo, ...), added as
// folders appear. A file closed after writing (IN_CLOSE_WRITE) is read at
// once; other changes wait 50 ms of quiet, which also keeps a rename's two
// halves together. (fsnotify was the plan, but it does not expose
// IN_CLOSE_WRITE.)

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	inotifyMask = unix.IN_CLOSE_WRITE | unix.IN_MOVED_TO | unix.IN_MOVED_FROM | unix.IN_CREATE |
		unix.IN_DELETE | unix.IN_MODIFY | unix.IN_DELETE_SELF | unix.IN_MOVE_SELF |
		unix.IN_ONLYDIR | unix.IN_DONT_FOLLOW | unix.IN_EXCL_UNLINK
	inotifySettle = 50 * time.Millisecond
)

type inotifyWatcher struct {
	root  string
	rules *Rules
	file  *os.File
	fd    int
	q     *eventQueue

	mu    sync.Mutex
	byWD  map[int]string // watch -> folder, relative ("" is the root)
	byDir map[string]int
}

func newWatcher(root string, rules *Rules) (watcher, error) {
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
	if err != nil {
		return nil, fmt.Errorf("inotify: %w", err)
	}
	w := &inotifyWatcher{
		root: root, rules: rules, fd: fd, q: newEventQueue(),
		file:  os.NewFile(uintptr(fd), "inotify"), // non-blocking: Close wakes a pending Read
		byWD:  map[int]string{},
		byDir: map[string]int{},
	}
	if _, err := w.addTree("", false); err != nil {
		w.file.Close()
		return nil, err
	}
	go w.read()
	return w, nil
}

func (w *inotifyWatcher) Notify() <-chan struct{}           { return w.q.notify }
func (w *inotifyWatcher) Drain() ([]fsEvent, string, error) { return w.q.drain() }
func (w *inotifyWatcher) Close() error                      { return w.file.Close() }

func (w *inotifyWatcher) Name() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return fmt.Sprintf("inotify, %d folders", len(w.byDir))
}

// watchLimitError names the limit a person can raise.
func watchLimitError(watching int) error {
	limit := "unknown"
	if b, err := os.ReadFile("/proc/sys/fs/inotify/max_user_watches"); err == nil {
		limit = strings.TrimSpace(string(b))
	}
	return fmt.Errorf("inotify is out of watches after %d folders (fs.inotify.max_user_watches = %s, shared by every program of this user; "+
		"raise it with: sysctl fs.inotify.max_user_watches=524288)", watching, limit)
}

// addTree watches a folder and every folder under it that syncs. With files
// set it also returns the files it found: a folder that just appeared may
// have been written into before its watch existed.
func (w *inotifyWatcher) addTree(rel string, files bool) ([]fsEvent, error) {
	var found []fsEvent
	start := filepath.Join(w.root, filepath.FromSlash(rel))
	err := filepath.WalkDir(start, func(abs string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // gone already
		}
		if !d.IsDir() {
			if files {
				if r, rerr := filepath.Rel(w.root, abs); rerr == nil {
					found = append(found, fsEvent{rel: filepath.ToSlash(r), settle: inotifySettle})
				}
			}
			return nil
		}
		r, rerr := filepath.Rel(w.root, abs)
		if rerr != nil {
			return nil
		}
		r = filepath.ToSlash(r)
		if r == "." {
			r = ""
		}
		if r != "" && w.rules.SkipDir(r) {
			return filepath.SkipDir
		}
		wd, err := unix.InotifyAddWatch(w.fd, abs, inotifyMask)
		if errors.Is(err, unix.ENOSPC) {
			w.mu.Lock()
			n := len(w.byDir)
			w.mu.Unlock()
			return watchLimitError(n)
		}
		if err != nil {
			return nil // vanished or not readable
		}
		w.mu.Lock()
		if old, ok := w.byWD[wd]; ok && old != r {
			delete(w.byDir, old) // the same folder under a new name (moved)
		}
		w.byWD[wd] = r
		w.byDir[r] = wd
		w.mu.Unlock()
		return nil
	})
	return found, err
}

// removeTree forgets a folder moved away (a deleted one gets IN_IGNORED).
func (w *inotifyWatcher) removeTree(rel string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for dir, wd := range w.byDir {
		if dir == rel || strings.HasPrefix(dir, rel+"/") {
			unix.InotifyRmWatch(w.fd, uint32(wd))
			delete(w.byDir, dir)
			delete(w.byWD, wd)
		}
	}
}

func (w *inotifyWatcher) read() {
	buf := make([]byte, 256<<10)
	for {
		n, err := w.file.Read(buf)
		if err != nil {
			if !errors.Is(err, os.ErrClosed) {
				w.q.fail(fmt.Errorf("inotify: %w", err))
			}
			return
		}
		var evs []fsEvent
		for off := 0; off+unix.SizeofInotifyEvent <= n; {
			raw := (*unix.InotifyEvent)(unsafe.Pointer(&buf[off]))
			name := ""
			if raw.Len > 0 {
				b := buf[off+unix.SizeofInotifyEvent : off+unix.SizeofInotifyEvent+int(raw.Len)]
				name = strings.TrimRight(string(b), "\x00")
			}
			off += unix.SizeofInotifyEvent + int(raw.Len)
			mask := raw.Mask
			if mask&unix.IN_Q_OVERFLOW != 0 {
				w.q.needRescan("inotify dropped events (fs.inotify.max_queued_events)")
				continue
			}
			w.mu.Lock()
			dir, ok := w.byWD[int(raw.Wd)]
			if mask&unix.IN_IGNORED != 0 && ok {
				delete(w.byWD, int(raw.Wd))
				if w.byDir[dir] == int(raw.Wd) {
					delete(w.byDir, dir)
				}
			}
			w.mu.Unlock()
			if !ok || mask&unix.IN_IGNORED != 0 {
				continue
			}
			if name == "" { // about the watched folder itself
				if dir == "" && mask&(unix.IN_DELETE_SELF|unix.IN_MOVE_SELF) != 0 {
					w.q.needRescan("the meta layer folder itself was moved or deleted")
				}
				continue // its parent reports it
			}
			rel := name
			if dir != "" {
				rel = dir + "/" + name
			}
			if mask&unix.IN_ISDIR != 0 {
				if mask&(unix.IN_CREATE|unix.IN_MOVED_TO) != 0 {
					found, err := w.addTree(rel, true)
					if err != nil {
						w.q.fail(err)
						return
					}
					evs = append(evs, found...)
				}
				if mask&unix.IN_MOVED_FROM != 0 {
					w.removeTree(rel)
				}
			}
			settle := inotifySettle
			if mask&unix.IN_CLOSE_WRITE != 0 {
				settle = 0 // the writer is done
			}
			evs = append(evs, fsEvent{rel: rel, settle: settle})
		}
		w.q.push(evs...)
	}
}
