package refs

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"regexp"
	"strconv"
)

// LFSPointer is a Git LFS v1 pointer (formats.md, section 5).
type LFSPointer struct {
	OID  string // 64 lower-case hex characters of SHA-256
	Size int64
}

const lfsVersion = "version https://git-lfs.github.com/spec/v1\n"

var lfsRe = regexp.MustCompile(`\Aversion https://git-lfs\.github\.com/spec/v1\noid sha256:([0-9a-f]{64})\nsize (0|[1-9][0-9]*)\n\z`)

// String is the pointer's exact bytes.
func (p LFSPointer) String() string {
	return fmt.Sprintf("%soid sha256:%s\nsize %d\n", lfsVersion, p.OID, p.Size)
}

// ParseLFS reports whether b is exactly a pointer, and which.
func ParseLFS(b []byte) (LFSPointer, bool) {
	if len(b) >= 1024 {
		return LFSPointer{}, false
	}
	m := lfsRe.FindSubmatch(b)
	if m == nil {
		return LFSPointer{}, false
	}
	n, err := strconv.ParseInt(string(m[2]), 10, 64)
	if err != nil {
		return LFSPointer{}, false
	}
	return LFSPointer{OID: string(m[1]), Size: n}, true
}

// NewLFS hashes r into a pointer.
func NewLFS(r io.Reader) (LFSPointer, error) {
	h := sha256.New()
	n, err := io.Copy(h, r)
	if err != nil {
		return LFSPointer{}, err
	}
	return LFSPointer{OID: hex.EncodeToString(h.Sum(nil)), Size: n}, nil
}
