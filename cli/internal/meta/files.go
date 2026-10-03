package meta

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// gitSHA is git's blob id: SHA-1 of "blob <size>\0<bytes>".
func gitSHA(b []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", len(b))
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil))
}

// readSyncable reads a file the meta layer may carry. It returns the reason
// ("too_large", "binary") when it may not, without reading a large file.
func readSyncable(abs string) (data []byte, info os.FileInfo, why string, err error) {
	f, err := os.Open(abs)
	if err != nil {
		return nil, nil, "", err
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil {
		return nil, nil, "", err
	}
	if !info.Mode().IsRegular() {
		return nil, info, "not_regular", nil
	}
	if info.Size() > MaxBytes {
		return nil, info, "too_large", nil
	}
	data, err = io.ReadAll(io.LimitReader(f, MaxBytes+1))
	if err != nil {
		return nil, nil, "", err
	}
	if why := checkBytes(data); why != "" {
		return nil, info, why, nil
	}
	return data, info, "", nil
}

// writeAtomic writes data the way an editor saves: a temporary file in the
// same folder, renamed over the target. It keeps an existing file's mode.
func writeAtomic(abs string, data []byte) (os.FileInfo, error) {
	dir := filepath.Dir(abs)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	mode := fs.FileMode(0o644)
	if info, err := os.Lstat(abs); err == nil {
		if info.IsDir() {
			return nil, fmt.Errorf("%s is a folder here", abs)
		}
		mode = info.Mode().Perm()
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(abs)+".pando-tmp-*")
	if err != nil {
		return nil, err
	}
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Chmod(tmp.Name(), mode)
	}
	if werr == nil {
		werr = os.Rename(tmp.Name(), abs)
	}
	if werr != nil {
		os.Remove(tmp.Name())
		return nil, werr
	}
	return os.Lstat(abs)
}

// removeFile deletes a file and any folders it leaves empty, up to root.
func removeFile(root, abs string) error {
	if err := os.Remove(abs); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	for dir := filepath.Dir(abs); dir != root && strings.HasPrefix(dir, root); dir = filepath.Dir(dir) {
		if os.Remove(dir) != nil {
			break // not empty, or gone
		}
	}
	return nil
}

// conflictName is where a machine keeps its own bytes after losing a race:
// HISTORY.md becomes HISTORY.conflict-local-20261003T104200Z.md.
func conflictName(rel string, at time.Time) string {
	dir, base := filepathSplit(rel)
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	if stem == "" { // ".gitignore": the whole name is the stem
		stem, ext = base, ""
	}
	return dir + stem + ".conflict-local-" + at.UTC().Format("20060102T150405Z") + ext
}

func filepathSplit(rel string) (dir, base string) {
	i := strings.LastIndex(rel, "/")
	return rel[:i+1], rel[i+1:]
}
