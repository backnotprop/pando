// Package refs reads and writes reference pointers (formats.md, section 4)
// and large-file pointers (section 5).
package refs

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/BurntSushi/toml"

	"pando/internal/gitx"
)

// Pointer is .pando/references/<path>.toml.
type Pointer struct {
	Path   string `toml:"-"`
	URL    string `toml:"url"`
	Ref    string `toml:"ref"`
	Commit string `toml:"commit"`
}

var commitRe = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)

// File is where the pointer for a reference path lives.
func File(root, path string) string {
	return filepath.Join(root, ".pando", "references", filepath.FromSlash(path)+".toml")
}

// Validate checks the three keys.
func (p Pointer) Validate() error {
	if p.URL == "" {
		return fmt.Errorf("%s: url is missing", p.Path)
	}
	if _, hasUser := gitx.StripUserinfo(p.URL); hasUser {
		return fmt.Errorf("%s: url must not carry a user or token", p.Path)
	}
	if !strings.HasPrefix(p.Ref, "refs/") {
		return fmt.Errorf("%s: ref %q must be a full ref like refs/heads/main", p.Path, p.Ref)
	}
	if !commitRe.MatchString(p.Commit) {
		return fmt.Errorf("%s: commit %q must be 40 or 64 lower-case hex characters", p.Path, p.Commit)
	}
	return nil
}

// Write stores a pointer.
func Write(root string, p Pointer) error {
	if err := p.Validate(); err != nil {
		return err
	}
	f := File(root, p.Path)
	if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
		return err
	}
	body := fmt.Sprintf(`# A reference: someone else's git repo, kept here to read.
# Pando syncs this pointer, never the files.
url = %q
ref = %q
commit = %q
`, p.URL, p.Ref, p.Commit)
	tmp := f + ".tmp"
	if err := os.WriteFile(tmp, []byte(body), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, f)
}

// Read loads the pointer for a reference path.
func Read(root, path string) (Pointer, error) {
	p := Pointer{Path: path}
	if _, err := toml.DecodeFile(File(root, path), &p); err != nil {
		return p, err
	}
	return p, p.Validate()
}

// List returns every pointer under .pando/references.
func List(root string) ([]Pointer, error) {
	base := filepath.Join(root, ".pando", "references")
	var out []Pointer
	err := filepath.WalkDir(base, func(f string, d fs.DirEntry, err error) error {
		if os.IsNotExist(err) && f == base {
			return filepath.SkipDir
		}
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(f, ".toml") {
			return nil
		}
		rel, _ := filepath.Rel(base, f)
		path := strings.TrimSuffix(filepath.ToSlash(rel), ".toml")
		p, err := Read(root, path)
		if err != nil {
			return err
		}
		out = append(out, p)
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, err
}
