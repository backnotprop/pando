package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestAppendSettingsList(t *testing.T) {
	root := t.TempDir()
	if err := AppendSettingsList(root, "local_only", []string{"a/"}); err != nil {
		t.Fatal(err)
	}
	if err := AppendSettingsList(root, "local_only", []string{"b/", "a/"}); err != nil {
		t.Fatal(err)
	}
	// A table must stay after the top-level keys.
	p := SettingsPath(root)
	b, _ := os.ReadFile(p)
	os.WriteFile(p, append(b, []byte("\n[repos.\"projects/x\"]\nrequired_checks = [\"ci\"]\n")...), 0o644)
	if err := AppendSettingsList(root, "projects", []string{"tools/r"}); err != nil {
		t.Fatal(err)
	}
	s, err := LoadSettings(root)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(s.LocalOnly, ",") != "a/,b/" || strings.Join(s.Projects, ",") != "tools/r" ||
		strings.Join(s.Repos["projects/x"].RequiredChecks, ",") != "ci" {
		t.Fatalf("settings: %+v", s)
	}
}

func TestRepoFor(t *testing.T) {
	r := &Root{Dir: "/r", Repos: []RepoEntry{{Path: "projects/app"}, {Path: "projects/app-two"}}}
	for rel, want := range map[string]string{
		"projects/app":                    "projects/app",
		"projects/app/worktrees/x/src":    "projects/app",
		"projects/app-two/worktrees/main": "projects/app-two",
	} {
		if got, ok := r.RepoFor(rel); !ok || got != want {
			t.Errorf("RepoFor(%q) = %q, %v", rel, got, ok)
		}
	}
	if _, ok := r.RepoFor("research"); ok {
		t.Error("research is not in a repo")
	}
	plain := &Root{Dir: "/r", Repos: []RepoEntry{{Path: "."}}}
	if got, ok := plain.RepoFor("worktrees/x"); !ok || got != "." {
		t.Errorf("plain repo: %q %v", got, ok)
	}
}

func TestCredentialFileMode(t *testing.T) {
	h := &Home{Dir: filepath.Join(t.TempDir(), "pando")}
	t.Setenv("PANDO_TOKEN", "")
	if err := h.SaveCredential("https://pando.example.com", "pando_secret", Account{Login: "pat"}); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(h.CredentialPath("https://pando.example.com"))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v, %v", st.Mode().Perm(), err)
	}
	if tok, err := h.Token("https://pando.example.com"); err != nil || tok != "pando_secret" {
		t.Fatalf("token %v", err)
	}
	cfg, _ := os.ReadFile(filepath.Join(h.Dir, "config.toml"))
	if strings.Contains(string(cfg), "pando_secret") {
		t.Fatal("the credential leaked into config.toml")
	}
	if _, err := h.Logout("https://pando.example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Token("https://pando.example.com"); err != ErrNoToken {
		t.Fatalf("after logout: %v", err)
	}
}

// Five agents adding worktrees at once each saved their own copy of the list
// and the last one won (seen on the Mac, 2026-10-03). Under the lock every
// entry stays.
func TestUpdateWorktreesKeepsConcurrentAdds(t *testing.T) {
	r := &Root{Dir: t.TempDir()}
	const n = 20
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			err := r.UpdateWorktrees(func(ws []Worktree) ([]Worktree, error) {
				return append(ws, Worktree{Path: fmt.Sprintf("worktrees/a-%02d", i)}), nil
			})
			if err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	ws, err := r.LoadWorktrees()
	if err != nil || len(ws) != n {
		t.Fatalf("%d worktrees kept of %d (err %v)", len(ws), n, err)
	}
}
