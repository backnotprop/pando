package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

const (
	KindMonorepo = "monorepo"
	KindRepo     = "repo"
)

// RepoEntry is one repo of a root, cached from the server.
type RepoEntry struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	CloneURL string `json:"clone_url"`
}

// Root is .pando/local/root.json plus where it was found.
type Root struct {
	Dir     string      `json:"-"`
	Version int         `json:"version"`
	Kind    string      `json:"kind"`
	Name    string      `json:"name"`
	Server  string      `json:"server"`
	Repos   []RepoEntry `json:"repos"`
}

// LocalDir is <root>/.pando/local.
func LocalDir(root string) string { return filepath.Join(root, ".pando", "local") }

// ErrNoRoot means no Pando root was found above a folder.
var ErrNoRoot = errors.New("not inside a Pando folder (no .pando/local/root.json above here); run `pando init` or `pando clone`")

// FindRoot walks up from dir to the nearest folder with .pando/local/root.json.
func FindRoot(dir string) (*Root, error) {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	for {
		p := filepath.Join(LocalDir(dir), "root.json")
		if _, err := os.Stat(p); err == nil {
			return LoadRoot(dir)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return nil, ErrNoRoot
		}
		dir = parent
	}
}

// LoadRoot reads <dir>/.pando/local/root.json.
func LoadRoot(dir string) (*Root, error) {
	p := filepath.Join(LocalDir(dir), "root.json")
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	r := &Root{}
	if err := json.Unmarshal(b, r); err != nil {
		return nil, fmt.Errorf("%s: %w", p, err)
	}
	r.Dir = dir
	return r, nil
}

// Save writes root.json.
func (r *Root) Save() error {
	r.Version = 1
	sort.Slice(r.Repos, func(i, j int) bool { return r.Repos[i].Path < r.Repos[j].Path })
	return writeJSON(filepath.Join(LocalDir(r.Dir), "root.json"), r)
}

// Repo returns the cached entry for a repo path.
func (r *Root) Repo(p string) (RepoEntry, bool) {
	for _, e := range r.Repos {
		if e.Path == p {
			return e, true
		}
	}
	return RepoEntry{}, false
}

// SetRepo adds or replaces a repo entry.
func (r *Root) SetRepo(e RepoEntry) {
	for i := range r.Repos {
		if r.Repos[i].Path == e.Path {
			r.Repos[i] = e
			return
		}
	}
	r.Repos = append(r.Repos, e)
}

// Rel turns an absolute path into a slash path from the root ("." for the
// root itself). It fails for paths outside the root.
func (r *Root) Rel(abs string) (string, error) {
	abs, err := filepath.Abs(abs)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(r.Dir, abs)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%s is outside the Pando folder %s", abs, r.Dir)
	}
	return filepath.ToSlash(rel), nil
}

// Abs turns a slash path from the root into an absolute path.
func (r *Root) Abs(rel string) string {
	return filepath.Join(r.Dir, filepath.FromSlash(rel))
}

// RepoFor finds the repo a slash path belongs to: the longest repo path that
// is a prefix of it. A plain repo's "." matches everything.
func (r *Root) RepoFor(rel string) (string, bool) {
	best, found := "", false
	for _, e := range r.Repos {
		if e.Path == "." || rel == e.Path || strings.HasPrefix(rel, e.Path+"/") {
			if !found || len(e.Path) > len(best) || best == "." {
				best, found = e.Path, true
			}
		}
	}
	return best, found
}

// WorktreeFolder is the folder name for a branch: each "/" becomes "-".
func WorktreeFolder(branch string) string {
	return strings.ReplaceAll(branch, "/", "-")
}

// WorktreePath is <repo path>/worktrees/<folder>, as a slash path.
func WorktreePath(repo, branch string) string {
	return path.Join(repo, "worktrees", WorktreeFolder(branch))
}

// Worktree is one entry of .pando/local/worktrees.json.
type Worktree struct {
	ID        string    `json:"id"`
	Repo      string    `json:"repo"`
	Branch    string    `json:"branch"`
	Path      string    `json:"path"`
	Kind      string    `json:"kind"`
	Agent     string    `json:"agent,omitempty"`
	ReadOnly  bool      `json:"read_only,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type worktreesFile struct {
	Version   int        `json:"version"`
	Worktrees []Worktree `json:"worktrees"`
}

// LoadWorktrees reads .pando/local/worktrees.json (missing is empty).
func (r *Root) LoadWorktrees() ([]Worktree, error) {
	b, err := os.ReadFile(filepath.Join(LocalDir(r.Dir), "worktrees.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var f worktreesFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	return f.Worktrees, nil
}

// SaveWorktrees writes .pando/local/worktrees.json.
func (r *Root) SaveWorktrees(ws []Worktree) error {
	sort.Slice(ws, func(i, j int) bool { return ws[i].Path < ws[j].Path })
	return writeJSON(filepath.Join(LocalDir(r.Dir), "worktrees.json"), worktreesFile{Version: 1, Worktrees: ws})
}

func writeJSON(p string, v any) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Settings is .pando/pando.toml. Every key is optional.
type Settings struct {
	LocalOnly  []string                `toml:"local_only"`
	Projects   []string                `toml:"projects"`
	References []string                `toml:"references"`
	Repos      map[string]RepoSettings `toml:"repos"`
	Unknown    []string                `toml:"-"`
}

// RepoSettings is one [repos."<path>"] table.
type RepoSettings struct {
	RequiredChecks []string `toml:"required_checks"`
}

// SettingsPath is <root>/.pando/pando.toml.
func SettingsPath(root string) string { return filepath.Join(root, ".pando", "pando.toml") }

// LoadSettings reads .pando/pando.toml; a missing file gives the defaults.
// Unknown keys are listed in Unknown so the caller can warn.
func LoadSettings(root string) (*Settings, error) {
	s := &Settings{}
	p := SettingsPath(root)
	if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	md, err := toml.DecodeFile(p, s)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", p, err)
	}
	for _, k := range md.Undecoded() {
		s.Unknown = append(s.Unknown, k.String())
	}
	for i, v := range s.Projects {
		s.Projects[i] = cleanRel(v)
	}
	for i, v := range s.References {
		s.References[i] = cleanRel(v)
	}
	return s, nil
}

func cleanRel(p string) string {
	p = path.Clean(strings.Trim(filepath.ToSlash(p), "/"))
	if p == "" {
		return "."
	}
	return p
}

// IsProjectOverride reports whether rel is named in projects = [...].
func (s *Settings) IsProjectOverride(rel string) bool { return contains(s.Projects, rel) }

// IsReferenceOverride reports whether rel is named in references = [...].
func (s *Settings) IsReferenceOverride(rel string) bool { return contains(s.References, rel) }

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// AppendSettingsLine adds `key = [..., value]` to pando.toml without
// rewriting what a person wrote: it appends a commented line pair at the
// end if the key is absent, or a fresh array if it is. Values are slash paths.
func AppendSettingsList(root, key string, values []string) error {
	if len(values) == 0 {
		return nil
	}
	s, err := LoadSettings(root)
	if err != nil {
		return err
	}
	var existing []string
	switch key {
	case "projects":
		existing = s.Projects
	case "references":
		existing = s.References
	case "local_only":
		existing = s.LocalOnly
	default:
		return fmt.Errorf("unknown settings list %q", key)
	}
	merged := append([]string{}, existing...)
	for _, v := range values {
		if !contains(merged, v) {
			merged = append(merged, v)
		}
	}
	p := SettingsPath(root)
	old, _ := os.ReadFile(p)
	lines := strings.Split(string(old), "\n")
	quoted := make([]string, len(merged))
	for i, v := range merged {
		quoted[i] = fmt.Sprintf("%q", v)
	}
	newLine := fmt.Sprintf("%s = [%s]", key, strings.Join(quoted, ", "))
	replaced := false
	if len(existing) > 0 {
		// Replace a single-line definition; leave multi-line ones and append.
		for i, l := range lines {
			t := strings.TrimSpace(l)
			if strings.HasPrefix(t, key) && strings.Contains(t, "=") && strings.HasSuffix(t, "]") &&
				strings.TrimSpace(strings.SplitN(t, "=", 2)[0]) == key {
				lines[i] = newLine
				replaced = true
				break
			}
		}
	}
	out := strings.Join(lines, "\n")
	if !replaced {
		if len(existing) > 0 {
			return fmt.Errorf("%s: %s spans several lines; add %v to it by hand", p, key, values)
		}
		head := ""
		if len(strings.TrimSpace(out)) == 0 {
			head = "# Only what differs from the defaults (docs/contracts/formats.md).\n"
			out = ""
		} else if !strings.HasSuffix(out, "\n") {
			out += "\n"
		}
		// Top-level keys must come before the first [table].
		if idx := strings.Index(out, "\n["); idx >= 0 || strings.HasPrefix(out, "[") {
			if strings.HasPrefix(out, "[") {
				idx = -1
			}
			out = out[:idx+1] + newLine + "\n" + out[idx+1:]
		} else {
			out = head + out + newLine + "\n"
		}
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, []byte(out), 0o644)
}
