//go:build darwin && cgo

package meta

// FSEvents (CoreServices), through cgo: one stream on the whole root, with
// projects/ and .pando/local/ excluded at the source. Paths arrive per file
// (kFSEventStreamCreateFlagFileEvents) about 50 ms after a change and wait
// 100 ms of quiet before the engine reads them. When FSEvents says it lost
// events (a subfolder to rescan, a dropped queue, the root moved), the
// engine scans everything.

/*
#cgo LDFLAGS: -framework CoreServices
#include <stdint.h>
#include <stdlib.h>
typedef struct pando_fsevents pando_fsevents;
pando_fsevents *pando_fsevents_start(uintptr_t handle, const char *root, const char **excl, int nexcl, double latency);
void pando_fsevents_stop(pando_fsevents *w);
*/
import "C"

import (
	"errors"
	"path/filepath"
	"runtime/cgo"
	"strings"
	"sync"
	"time"
	"unsafe"
)

const (
	fseventsLatency = 0.05 // seconds FSEvents gathers changes before calling
	fseventsSettle  = 100 * time.Millisecond

	fsMustScanSubDirs = 0x00000001
	fsUserDropped     = 0x00000002
	fsKernelDropped   = 0x00000004
	fsRootChanged     = 0x00000020
	fsMount           = 0x00000040
	fsUnmount         = 0x00000080
)

type fseventsWatcher struct {
	real   string // the root with symlinks resolved, as FSEvents reports paths
	q      *eventQueue
	handle cgo.Handle
	mu     sync.Mutex
	stream *C.pando_fsevents
}

func newWatcher(root string, _ *Rules) (watcher, error) {
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	w := &fseventsWatcher{real: real, q: newEventQueue()}
	w.handle = cgo.NewHandle(w)
	croot := C.CString(real)
	defer C.free(unsafe.Pointer(croot))
	excl := []string{filepath.Join(real, "projects"), filepath.Join(real, ".pando", "local")}
	cexcl := make([]*C.char, len(excl))
	for i, p := range excl {
		cexcl[i] = C.CString(p)
		defer C.free(unsafe.Pointer(cexcl[i]))
	}
	s := C.pando_fsevents_start(C.uintptr_t(w.handle), croot, (**C.char)(unsafe.Pointer(&cexcl[0])), C.int(len(cexcl)), C.double(fseventsLatency))
	if s == nil {
		w.handle.Delete()
		return nil, errors.New("FSEvents would not start a stream")
	}
	w.stream = s
	return w, nil
}

func (w *fseventsWatcher) Notify() <-chan struct{}           { return w.q.notify }
func (w *fseventsWatcher) Drain() ([]fsEvent, string, error) { return w.q.drain() }
func (w *fseventsWatcher) Name() string                      { return "FSEvents" }

func (w *fseventsWatcher) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stream != nil {
		C.pando_fsevents_stop(w.stream) // no callback runs after this returns
		w.stream = nil
		w.handle.Delete()
	}
	return nil
}

//export pandoFSEvents
func pandoFSEvents(handle C.uintptr_t, n C.size_t, paths **C.char, flags *C.uint32_t) {
	w := cgo.Handle(handle).Value().(*fseventsWatcher)
	ps := unsafe.Slice(paths, int(n))
	fs := unsafe.Slice(flags, int(n))
	evs := make([]fsEvent, 0, len(ps))
	for i := range ps {
		f := uint32(fs[i])
		if f&(fsMustScanSubDirs|fsUserDropped|fsKernelDropped|fsRootChanged|fsMount|fsUnmount) != 0 {
			w.q.needRescan("FSEvents asked for a rescan")
			return
		}
		p := C.GoString(ps[i])
		var rel string
		switch {
		case p == w.real:
			rel = ""
		case strings.HasPrefix(p, w.real+"/"):
			rel = p[len(w.real)+1:]
		default:
			continue
		}
		evs = append(evs, fsEvent{rel: rel, settle: fseventsSettle})
	}
	w.q.push(evs...)
}
