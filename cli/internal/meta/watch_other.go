//go:build !linux && !(darwin && cgo)

package meta

// No file-change notifications here (another OS, or a Mac build without
// cgo): the engine scans every Config.Poll.
func newWatcher(root string, _ *Rules) (watcher, error) { return nil, errNoWatcher }
