//go:build linux || (darwin && cgo)

package meta

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// collect drains a watcher until want is seen or the time is up.
func collect(t *testing.T, w watcher, want ...string) map[string]time.Duration {
	t.Helper()
	got := map[string]time.Duration{}
	deadline := time.After(5 * time.Second)
	for {
		missing := false
		for _, p := range want {
			if _, ok := got[p]; !ok {
				missing = true
			}
		}
		if !missing {
			return got
		}
		select {
		case <-w.Notify():
			evs, rescan, err := w.Drain()
			if err != nil {
				t.Fatal(err)
			}
			if rescan != "" {
				t.Logf("rescan: %s", rescan)
			}
			for _, e := range evs {
				got[e.rel] = e.settle
			}
		case <-deadline:
			t.Fatalf("waited for %v, got %v", want, got)
		}
	}
}

func TestWatcherEvents(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "notes"), 0o755)
	os.MkdirAll(filepath.Join(root, "node_modules", "x"), 0o755)
	rules, _ := LoadRules(root)
	w, err := newWatcher(root, rules)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	t.Logf("watcher: %s", w.Name())
	time.Sleep(100 * time.Millisecond) // FSEvents starts from "now"

	start := time.Now()
	os.WriteFile(filepath.Join(root, "notes", "a.md"), []byte("a\n"), 0o644)
	got := collect(t, w, "notes/a.md")
	t.Logf("a write reported after %s", time.Since(start).Round(time.Millisecond))
	if runtime.GOOS == "linux" && got["notes/a.md"] != 0 {
		t.Errorf("a closed write should need no quiet time on Linux, got %s", got["notes/a.md"])
	}

	// A folder made after the watcher started, with a file in it.
	os.MkdirAll(filepath.Join(root, "new", "deeper"), 0o755)
	os.WriteFile(filepath.Join(root, "new", "deeper", "b.md"), []byte("b\n"), 0o644)
	collect(t, w, "new/deeper/b.md")

	// Rename and delete.
	os.Rename(filepath.Join(root, "notes", "a.md"), filepath.Join(root, "notes", "c.md"))
	collect(t, w, "notes/a.md", "notes/c.md")
	os.Remove(filepath.Join(root, "notes", "c.md"))
	collect(t, w, "notes/c.md")

	checkSkips(t, w, root)
}
