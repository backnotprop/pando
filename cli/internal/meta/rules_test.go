package meta

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRefusal(t *testing.T) {
	cases := map[string]string{
		"decisions/HISTORY.md":                       "",
		"research/notes.txt":                         "",
		".pando/references/research/x.toml":          "",
		".pando/pando.toml":                          "protected",
		".pando/other/file.md":                       "protected",
		".pando/references/x.md":                     "protected",
		".pando/local/root.json":                     "local_only",
		"projects/web/README.md":                     "not_meta",
		"a/node_modules/x/index.js":                  "local_only",
		"dist/out.js":                                "local_only",
		"logs/run.ndjson":                            "local_only",
		"logs/run.jsonl":                             "local_only",
		".env":                                       "local_only",
		"app/.env.local":                             "local_only",
		".secrets/token":                             "local_only",
		"keys/server.pem":                            "local_only",
		"id_ed25519":                                 "local_only",
		".DS_Store":                                  "local_only",
		"notes/.HISTORY.md.swp":                      "local_only",
		"HISTORY.conflict-local-20261003T104200Z.md": "local_only",
		"notes/.a.md.pando-tmp-123":                  "local_only",
		"a/../b.md":                                  "bad_path",
		"/abs.md":                                    "bad_path",
		"a//b.md":                                    "bad_path",
	}
	for p, want := range cases {
		if got := refusal(p); got != want {
			t.Errorf("refusal(%q) = %q, want %q", p, got, want)
		}
	}
}

func TestCheckBytes(t *testing.T) {
	if checkBytes([]byte("# hi\n")) != "" {
		t.Error("text refused")
	}
	if checkBytes([]byte{1, 0, 2}) != "binary" {
		t.Error("NUL not binary")
	}
	if checkBytes(make([]byte, MaxBytes+1)) != "too_large" {
		t.Error("large not refused")
	}
	big := []byte(strings.Repeat("a", MaxBytes))
	if checkBytes(big) != "" {
		t.Error("exactly 1.5 MiB refused")
	}
}

func TestIgnorePatterns(t *testing.T) {
	cases := []struct {
		pat, path string
		dir, want bool
	}{
		{"research/operational/stress-runs/", "research/operational/stress-runs", true, true},
		{"research/operational/stress-runs/", "research/operational/stress-runs/a/b.json", false, true},
		{"research/operational/stress-runs/", "other/research/operational/stress-runs/x", false, false},
		{"research/reviews/integration-*/", "research/reviews/integration-12/page.html", false, true},
		{"research/reviews/integration-*/", "research/reviews/integration-12", false, false}, // a file, not a folder
		{"*.sqlite", "data/x.sqlite", false, true},
		{"*.sqlite", "x.sqlite", false, true},
		{"tmp/", "a/tmp/x.md", false, true},
		{"tmp/", "a/tmp", false, false},
		{"/top.md", "top.md", false, true},
		{"/top.md", "a/top.md", false, false},
		{"docs/**/draft.md", "docs/a/b/draft.md", false, true},
		{"docs/**/draft.md", "docs/draft.md", false, true},
	}
	for _, c := range cases {
		p, ok := parseIgnore(c.pat)
		if !ok {
			t.Fatalf("parseIgnore(%q) failed", c.pat)
		}
		if got := p.match(c.path, c.dir); got != c.want {
			t.Errorf("%q matching %q (dir %v) = %v, want %v", c.pat, c.path, c.dir, got, c.want)
		}
	}
}

func TestRulesFromFolder(t *testing.T) {
	root := t.TempDir()
	write := func(rel, body string) {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(abs), 0o755)
		os.WriteFile(abs, []byte(body), 0o644)
	}
	write(".pando/pando.toml", "local_only = [\"research/operational/stress-runs/\", \"*.sqlite\"]\n")
	write("research/infra/lib/.git/HEAD", "ref: refs/heads/main\n")
	r, err := LoadRules(root)
	if err != nil {
		t.Fatal(err)
	}
	for rel, want := range map[string]bool{
		"research/infra/lib":               true, // its own .git: a reference
		"research/infra":                   false,
		"research/operational/stress-runs": true,
		"projects":                         true,
		".pando":                           false,
		".pando/local":                     true,
		".pando/references":                false,
		"node_modules":                     true,
	} {
		if got := r.SkipDir(rel); got != want {
			t.Errorf("SkipDir(%q) = %v, want %v", rel, got, want)
		}
	}
	if r.SyncFile("data/x.sqlite") || !r.SyncFile("data/x.json") {
		t.Error("local_only from pando.toml not applied")
	}
	if r.Receivable("research/infra/lib/README.md") || r.Receivable("projects/web/a.md") || !r.Receivable(".pando/pando.toml") {
		t.Error("Receivable wrong")
	}
	// A changed pando.toml is read again.
	time.Sleep(10 * time.Millisecond)
	write(".pando/pando.toml", "local_only = []\n")
	os.Chtimes(filepath.Join(root, ".pando/pando.toml"), time.Now(), time.Now().Add(time.Second))
	if !r.Refresh() || !r.SyncFile("data/x.sqlite") {
		t.Error("pando.toml not reloaded")
	}
}

func TestGitSHA(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	for _, body := range []string{"", "# Hello\n", strings.Repeat("line\n", 1000)} {
		cmd := exec.Command("git", "hash-object", "--stdin")
		cmd.Stdin = strings.NewReader(body)
		out, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		if got, want := gitSHA([]byte(body)), strings.TrimSpace(string(out)); got != want {
			t.Errorf("gitSHA = %s, git says %s", got, want)
		}
	}
}

func TestConflictName(t *testing.T) {
	at := time.Date(2026, 10, 3, 10, 42, 0, 0, time.UTC)
	for in, want := range map[string]string{
		"decisions/HISTORY.md": "decisions/HISTORY.conflict-local-20261003T104200Z.md",
		"Makefile":             "Makefile.conflict-local-20261003T104200Z",
		"a/.gitignore":         "a/.gitignore.conflict-local-20261003T104200Z",
		"a/b.tar.gz":           "a/b.tar.conflict-local-20261003T104200Z.gz",
	} {
		if got := conflictName(in, at); got != want {
			t.Errorf("conflictName(%q) = %q, want %q", in, got, want)
		}
		if refusal(conflictName(in, at)) != "local_only" {
			t.Errorf("conflict copy of %q would sync", in)
		}
	}
}

func TestWriteAtomicKeepsMode(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "run.sh")
	os.WriteFile(p, []byte("old"), 0o755)
	if _, err := writeAtomic(p, []byte("new")); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(p)
	b, _ := os.ReadFile(p)
	if string(b) != "new" || info.Mode().Perm() != 0o755 {
		t.Errorf("got %q mode %v", b, info.Mode())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("temporary file left behind: %v", entries)
	}
}
