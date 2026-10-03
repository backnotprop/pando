package meta

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

// MaxBytes is the largest file the meta layer carries live (1.5 MiB).
// Durable Object rows hold 2 MB. Larger files wait for the R2 step.
const MaxBytes = 1_572_864

// binarySniff is git's test for binary: a NUL in the first 8,000 bytes.
const binarySniff = 8000

// The local-by-default list (docs/contracts/meta-sync.md, "What may be
// saved"). The server object applies the same list (worker/src/live/rules.ts).
var localDirs = map[string]bool{
	"node_modules": true, ".pnpm-store": true, "dist": true, "build": true,
	".wrangler": true, ".next": true, ".cache": true, "__pycache__": true,
	".venv": true, ".secrets": true, ".git": true,
}

var localSuffixes = []string{
	".ndjson", ".jsonl", ".pem", ".key", ".p12", ".pfx", ".keystore",
	".mobileprovision", ".provisionprofile", ".swp", "~",
	// databases change under a running program; a copy of one is not a database
	".sqlite", ".sqlite3", ".sqlite-wal", ".sqlite-shm", ".sqlite-journal", ".db", ".db-wal", ".db-shm",
}

var localPrefixes = []string{".env", ".dev.vars", "id_rsa", "id_ed25519", "id_ecdsa", ".#"}

func localOnlyName(name string) bool {
	if name == ".DS_Store" {
		return true
	}
	for _, p := range localPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	for _, s := range localSuffixes {
		if strings.HasSuffix(name, s) {
			return true
		}
	}
	if strings.Contains(name, ".conflict-local-") {
		return true
	}
	if strings.HasPrefix(name, ".") && strings.Contains(name, ".pando-tmp-") {
		return true
	}
	return false
}

// Rules decide which paths of a meta layer sync. Paths are relative to the
// root, with / separators.
type Rules struct {
	root   string
	first  bool            // pando init's first upload: .pando/ (but not .pando/local/) goes too
	extra  []ignorePattern // local_only from .pando/pando.toml
	tomlMt int64           // mtime of pando.toml when read, to reload on change
}

// LoadRules reads the defaults plus local_only from <root>/.pando/pando.toml.
func LoadRules(root string) (*Rules, error) {
	r := &Rules{root: root}
	return r, r.reload()
}

func (r *Rules) tomlPath() string { return filepath.Join(r.root, ".pando", "pando.toml") }

func (r *Rules) reload() error {
	r.extra = nil
	r.tomlMt = 0
	info, err := os.Stat(r.tomlPath())
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	r.tomlMt = info.ModTime().UnixNano()
	var cfg struct {
		LocalOnly []string `toml:"local_only"`
	}
	if _, err := toml.DecodeFile(r.tomlPath(), &cfg); err != nil {
		return fmt.Errorf(".pando/pando.toml: %w", err)
	}
	for _, p := range cfg.LocalOnly {
		if pat, ok := parseIgnore(p); ok {
			r.extra = append(r.extra, pat)
		}
	}
	return nil
}

// Refresh reloads pando.toml when it changed. It reports whether it did.
func (r *Rules) Refresh() bool {
	var mt int64
	if info, err := os.Stat(r.tomlPath()); err == nil {
		mt = info.ModTime().UnixNano()
	}
	if mt == r.tomlMt {
		return false
	}
	_ = r.reload()
	return true
}

// SkipDir reports whether the scan should not enter the folder rel.
func (r *Rules) SkipDir(rel string) bool {
	if rel == "." || rel == "" {
		return false
	}
	parts := strings.Split(rel, "/")
	if parts[0] == "projects" {
		return true // code repos
	}
	if parts[0] == ".pando" {
		// Only reference pointers are live inside .pando/ (all of it but
		// .pando/local/ on the first upload).
		if r.first {
			return len(parts) >= 2 && parts[1] == "local"
		}
		return len(parts) >= 2 && parts[1] != "references"
	}
	if localDirs[parts[len(parts)-1]] {
		return true
	}
	if r.extraMatch(rel, true) {
		return true
	}
	// A folder with its own .git (a directory or a file) is a repo or a
	// reference: only its pointer syncs (formats.md, section 4).
	if _, err := os.Lstat(filepath.Join(r.root, filepath.FromSlash(rel), ".git")); err == nil {
		return true
	}
	return false
}

// SyncFile reports whether a file at rel, in a folder the scan entered, syncs.
func (r *Rules) SyncFile(rel string) bool {
	if why := refusal(rel); why != "" && !(why == "protected" && r.first) {
		return false
	}
	return !r.extraMatch(rel, false)
}

// Receivable reports whether a change from the server may be written at rel
// on this machine. .pando/ files arrive from main; nothing is written into
// projects/, .pando/local/, or a folder that is its own repo.
func (r *Rules) Receivable(rel string) bool {
	if badPath(rel) {
		return false
	}
	parts := strings.Split(rel, "/")
	if parts[0] == "projects" || (parts[0] == ".pando" && len(parts) > 1 && parts[1] == "local") {
		return false
	}
	dir := r.root
	for _, p := range parts[:len(parts)-1] {
		dir = filepath.Join(dir, p)
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
			return false
		}
	}
	return true
}

func badPath(p string) bool {
	if p == "" || len(p) > 1024 || strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00") {
		return true
	}
	for _, s := range strings.Split(p, "/") {
		if s == "" || s == "." || s == ".." {
			return true
		}
	}
	return false
}

// refusal is the server's path rule, applied before sending: "" when the path
// may be saved live, else the reason the server would give.
func refusal(rel string) string {
	if badPath(rel) {
		return "bad_path"
	}
	parts := strings.Split(rel, "/")
	switch parts[0] {
	case ".pando":
		if len(parts) > 1 && parts[1] == "local" {
			return "local_only"
		}
		if !(len(parts) > 2 && parts[1] == "references") {
			return "protected"
		}
	case "projects":
		return "not_meta"
	}
	for _, d := range parts[:len(parts)-1] {
		if localDirs[d] {
			return "local_only"
		}
	}
	if localOnlyName(parts[len(parts)-1]) {
		return "local_only"
	}
	return ""
}

// checkBytes is the server's content rule: "" when the bytes may be saved.
func checkBytes(b []byte) string {
	if len(b) > MaxBytes {
		return "too_large"
	}
	n := min(len(b), binarySniff)
	if bytes.IndexByte(b[:n], 0) >= 0 {
		return "binary"
	}
	return ""
}

func (r *Rules) extraMatch(rel string, isDir bool) bool {
	for _, p := range r.extra {
		if p.match(rel, isDir) {
			return true
		}
	}
	return false
}

// ignorePattern is one local_only line in .gitignore syntax (formats.md,
// section 2): a trailing / matches only a folder, * matches within one path
// part, a pattern with no / before its end matches at any depth, any other
// pattern is anchored at the root. ** matches any number of parts. A file
// inside a matched folder is matched too.
type ignorePattern struct {
	parts    []string
	dirOnly  bool
	anchored bool
}

func parseIgnore(s string) (ignorePattern, bool) {
	s = strings.TrimSpace(s)
	if s == "" || strings.HasPrefix(s, "#") || strings.HasPrefix(s, "!") {
		return ignorePattern{}, false // negation is not supported
	}
	p := ignorePattern{}
	if strings.HasSuffix(s, "/") {
		p.dirOnly = true
		s = strings.TrimRight(s, "/")
	}
	if strings.Contains(s, "/") {
		p.anchored = true
		s = strings.TrimPrefix(s, "/")
	}
	if s == "" {
		return ignorePattern{}, false
	}
	p.parts = strings.Split(s, "/")
	return p, true
}

// match checks rel (a file, or a folder when isDir) and every folder above it.
func (p ignorePattern) match(rel string, isDir bool) bool {
	parts := strings.Split(rel, "/")
	for n := 1; n <= len(parts); n++ {
		prefixIsDir := n < len(parts) || isDir
		if p.dirOnly && !prefixIsDir {
			continue
		}
		if p.matchPrefix(parts[:n]) {
			return true
		}
	}
	return false
}

func (p ignorePattern) matchPrefix(parts []string) bool {
	if !p.anchored {
		ok, _ := path.Match(p.parts[0], parts[len(parts)-1])
		return ok
	}
	return globParts(p.parts, parts)
}

func globParts(pat, parts []string) bool {
	if len(pat) == 0 {
		return len(parts) == 0
	}
	if pat[0] == "**" {
		for i := 0; i <= len(parts); i++ {
			if globParts(pat[1:], parts[i:]) {
				return true
			}
		}
		return false
	}
	if len(parts) == 0 {
		return false
	}
	ok, _ := path.Match(pat[0], parts[0])
	return ok && globParts(pat[1:], parts[1:])
}
