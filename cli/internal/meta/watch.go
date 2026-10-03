package meta

// OS file-change notifications for the meta layer folder: inotify on Linux
// (watch_linux.go), FSEvents on macOS (watch_darwin.go, cgo). A watcher only
// says which paths changed; the engine stats each one after it has been
// quiet for its settle time and runs the same per-file step as a scan. A
// full scan every 30 s, and whenever the OS says events were lost, is the
// safety net. Without a watcher (another OS, a Mac build without cgo, or
// inotify out of watches) the engine scans every Config.Poll instead.

import (
	"errors"
	"sync"
	"time"
)

// fsEvent is one changed path, relative to the root ("" is the root), and
// how long it must be quiet before the engine reads it.
type fsEvent struct {
	rel    string
	settle time.Duration
}

// watcher reports changed paths under one root.
type watcher interface {
	// Notify has a value when Drain has something.
	Notify() <-chan struct{}
	// Drain returns the events since the last call; rescan is non-empty when
	// events were lost and the whole folder must be scanned. A non-nil err
	// means the watcher stopped working: the engine goes back to scanning.
	Drain() (events []fsEvent, rescan string, err error)
	Close() error
	Name() string
}

var errNoWatcher = errors.New("no file-change notifications on this system")

// startWatcher is newWatcher; tests replace it.
var startWatcher = newWatcher

const (
	fullScanEvery   = 30 * time.Second       // the safety net while a watcher runs
	walkSettle      = 100 * time.Millisecond // a path a walk found waits this long too, as if an event had said it
	maxQueuedEvents = 100_000                // more than this between two drains: scan everything instead
)

// eventQueue is where a watcher's goroutine (or FSEvents' thread) leaves
// events for the engine, without ever blocking on it.
type eventQueue struct {
	mu     sync.Mutex
	events []fsEvent
	rescan string
	err    error
	notify chan struct{}
}

func newEventQueue() *eventQueue { return &eventQueue{notify: make(chan struct{}, 1)} }

func (q *eventQueue) wake() {
	select {
	case q.notify <- struct{}{}:
	default:
	}
}

func (q *eventQueue) push(evs ...fsEvent) {
	if len(evs) == 0 {
		return
	}
	q.mu.Lock()
	if q.rescan == "" {
		q.events = append(q.events, evs...)
		if len(q.events) > maxQueuedEvents {
			q.events, q.rescan = nil, "more than 100,000 changes at once"
		}
	}
	q.mu.Unlock()
	q.wake()
}

func (q *eventQueue) needRescan(why string) {
	q.mu.Lock()
	q.events, q.rescan = nil, why
	q.mu.Unlock()
	q.wake()
}

func (q *eventQueue) fail(err error) {
	q.mu.Lock()
	if q.err == nil {
		q.err = err
	}
	q.mu.Unlock()
	q.wake()
}

func (q *eventQueue) drain() ([]fsEvent, string, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	evs, rescan, err := q.events, q.rescan, q.err
	q.events, q.rescan = nil, ""
	return evs, rescan, err
}
