package meta

import (
	"errors"
	"testing"
	"time"
)

// deafWatcher hears nothing, as if the OS lost every event: only the
// safety-net scan can find changes. brokenWatcher fails at once.
type deafWatcher struct {
	notify chan struct{}
	err    error
}

func (w *deafWatcher) Notify() <-chan struct{} { return w.notify }
func (w *deafWatcher) Drain() ([]fsEvent, string, error) {
	return nil, "", w.err
}
func (w *deafWatcher) Close() error { return nil }
func (w *deafWatcher) Name() string { return "a watcher that hears nothing" }

func useWatcher(t *testing.T, w *deafWatcher) {
	t.Helper()
	old := startWatcher
	startWatcher = func(string, *Rules) (watcher, error) { return w, nil }
	t.Cleanup(func() { startWatcher = old })
}

func TestE2ESafetyNetScan(t *testing.T) {
	env := newEnv(t)
	useWatcher(t, &deafWatcher{notify: make(chan struct{})})
	a := env.bare(t, "ana")
	a.writeRoot(".pando/local/root.json", `{"version":1,"kind":"monorepo","name":"`+env.mono+`","server":"`+env.server+`","repos":[]}`)
	cfg := a.config()
	cfg.FullScan = 500 * time.Millisecond
	a.startWith(cfg)
	b := env.machine(t, "ben")

	a.write("missed.md", "no event came for this\n")
	d := waitContent(t, b, "missed.md", "no event came for this\n")
	t.Logf("found by the safety-net scan after %s", d.Round(time.Millisecond))
}

func TestE2EWatcherFailsBackToScanning(t *testing.T) {
	env := newEnv(t)
	w := &deafWatcher{notify: make(chan struct{}, 1), err: errors.New("the watch broke")}
	w.notify <- struct{}{}
	useWatcher(t, w)
	a := env.machine(t, "ana")
	b := env.machine(t, "ben")
	a.write("after-fallback.md", "scanned\n")
	waitContent(t, b, "after-fallback.md", "scanned\n")
}
