package session

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/BurntSushi/toml"
)

// Settings are this machine's own (~/.pando/sessions.toml): whether it records, and folders added by hand.
type Settings struct {
	// Record: nil until asked (pando login asks once), then the person's answer.
	Record *bool    `toml:"record,omitempty"`
	Paths  []Store  `toml:"paths,omitempty"`
	path   string   `toml:"-"`
	extra  []string `toml:"-"`
}

// Store is a place an agent keeps its sessions: a folder of JSONL files, or OpenCode's database file.
type Store struct {
	Program string `toml:"program" json:"program"`
	Path    string `toml:"path" json:"path"`
	// Found: "default", "environment", "commit hook" or "paths add".
	Found string `toml:"-" json:"found"`
}

// LoadSettings reads homeDir/sessions.toml; missing is fine.
func LoadSettings(homeDir string) (*Settings, error) {
	s := &Settings{path: filepath.Join(homeDir, "sessions.toml")}
	if _, err := os.Stat(s.path); err == nil {
		if _, err := toml.DecodeFile(s.path, s); err != nil {
			return nil, fmt.Errorf("%s: %w", s.path, err)
		}
	}
	return s, nil
}

// Recording reports whether this machine records sessions (never asked: no).
func (s *Settings) Recording() bool { return s.Record != nil && *s.Record }

// Save writes the settings back.
func (s *Settings) Save() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(s.path), ".sessions-*.toml")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := toml.NewEncoder(f).Encode(s); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), s.path)
}

// learnedFile holds the stores the commit hook saw in an agent's shell (a moved CLAUDE_CONFIG_DIR, CODEX_HOME, Pi's
// session file, OpenCode's database): one "program<TAB>path" a line.
func learnedFile(homeDir string) string { return filepath.Join(homeDir, "session-stores") }

// Learn adds a store the commit hook saw, once.
func Learn(homeDir string, st Store) error {
	for _, have := range learned(homeDir) {
		if have.Program == st.Program && have.Path == st.Path {
			return nil
		}
	}
	if err := os.MkdirAll(homeDir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(learnedFile(homeDir), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = fmt.Fprintf(f, "%s\t%s\n", st.Program, st.Path)
	return err
}

func learned(homeDir string) []Store {
	f, err := os.Open(learnedFile(homeDir))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []Store
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if p, path, ok := strings.Cut(sc.Text(), "\t"); ok {
			out = append(out, Store{Program: p, Path: path, Found: "commit hook"})
		}
	}
	return out
}

// Normalize turns a folder a person names into the folder that holds the sessions: Claude Code's config folder or
// its projects/, Codex's home or its sessions/, Pi's agent folder or its sessions/, or OpenCode's database file.
func Normalize(program, path string) Store {
	sub := map[string]string{ClaudeCode: "projects", Codex: "sessions", Pi: "sessions"}[program]
	if sub != "" && filepath.Base(path) != sub {
		if st, err := os.Stat(filepath.Join(path, sub)); err == nil && st.IsDir() {
			path = filepath.Join(path, sub)
		}
	}
	if program == OpenCode {
		if st, err := os.Stat(path); err == nil && st.IsDir() {
			path = filepath.Join(path, "opencode.db")
		}
	}
	return Store{Program: program, Path: filepath.Clean(path)}
}

// Stores lists every store to read, each once, with how it was found: the defaults, this program's environment,
// what the commit hook saw, and folders added with `pando session paths add`. Only stores that exist are listed.
func Stores(homeDir string, s *Settings, getenv func(string) string, userHome string) []Store {
	var all []Store
	add := func(program, path, found string) {
		if path != "" {
			st := Normalize(program, path)
			st.Found = found
			all = append(all, st)
		}
	}
	both := func(program, envVar, def string, sub ...string) {
		if v := getenv(envVar); v != "" {
			for _, s := range sub {
				add(program, filepath.Join(v, s), "environment")
			}
		}
		for _, s := range sub {
			add(program, filepath.Join(userHome, def, s), "default")
		}
	}
	both(ClaudeCode, "CLAUDE_CONFIG_DIR", ".claude", "projects")
	both(Codex, "CODEX_HOME", ".codex", "sessions", "archived_sessions")
	add(Pi, getenv("PI_CODING_AGENT_SESSION_DIR"), "environment")
	if v := getenv("PI_CODING_AGENT_DIR"); v != "" {
		add(Pi, filepath.Join(v, "sessions"), "environment")
	}
	add(Pi, filepath.Join(userHome, ".pi", "agent", "sessions"), "default")
	add(OpenCode, getenv("OPENCODE_DB"), "environment")
	if v := getenv("XDG_DATA_HOME"); v != "" {
		add(OpenCode, filepath.Join(v, "opencode", "opencode.db"), "environment")
	}
	add(OpenCode, filepath.Join(userHome, ".local", "share", "opencode", "opencode.db"), "default")
	all = append(all, learned(homeDir)...)
	for _, p := range s.Paths {
		add(p.Program, p.Path, "paths add")
	}
	seen := map[string]bool{}
	var out []Store
	for _, st := range all {
		key := st.Program + "\x00" + st.Path
		if seen[key] {
			continue
		}
		if _, err := os.Stat(st.Path); err != nil {
			continue
		}
		seen[key] = true
		out = append(out, st)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Program < out[j].Program })
	return out
}
