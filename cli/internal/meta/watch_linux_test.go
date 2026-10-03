package meta

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// checkSkips: inotify puts no watch inside node_modules/, so nothing from
// there is ever reported.
func checkSkips(t *testing.T, w watcher, root string) {
	os.WriteFile(filepath.Join(root, "node_modules", "x", "i.js"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(root, "notes", "after.md"), []byte("x"), 0o644)
	got := collect(t, w, "notes/after.md")
	if _, ok := got["node_modules/x/i.js"]; ok {
		t.Error("inotify watched node_modules/")
	}
	n := w.(*inotifyWatcher)
	dirs := []string{}
	for d := range n.byDir {
		dirs = append(dirs, d)
	}
	slices.Sort(dirs)
	if !slices.Equal(dirs, []string{"", "new", "new/deeper", "notes"}) {
		t.Errorf("watched folders: %q", dirs)
	}
}
