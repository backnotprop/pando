//go:build darwin && cgo

package meta

import "testing"

// checkSkips: FSEvents watches the whole root (only projects/ and
// .pando/local/ are excluded at the source); the engine drops node_modules/
// and the rest by name.
func checkSkips(t *testing.T, w watcher, root string) {}
