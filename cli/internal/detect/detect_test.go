package detect

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func run(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=T", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=T", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_CONFIG_GLOBAL=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
}

func repo(t *testing.T, dir, branch string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	run(t, dir, "init", "-q", "-b", branch)
	write(t, filepath.Join(dir, "README.md"), "# "+filepath.Base(dir))
	run(t, dir, "add", "-A")
	run(t, dir, "commit", "-q", "-m", "first")
}

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

// workspacesTree builds a folder shaped like ~/workspaces.
func workspacesTree(t *testing.T) string {
	root := t.TempDir()
	write(t, filepath.Join(root, "AGENTS.md"), "agents")
	write(t, filepath.Join(root, "decisions/RULINGS.md"), "rulings")
	write(t, filepath.Join(root, ".env"), "SECRET=1")
	repo(t, filepath.Join(root, "projects/app/worktrees/main"), "main")
	run(t, filepath.Join(root, "projects/app/worktrees/main"), "worktree", "add", "-q", "../feat-a", "-b", "feat-a")
	repo(t, filepath.Join(root, "projects/lib"), "master")
	write(t, filepath.Join(root, "projects/notes/todo.md"), "todo")
	ref := filepath.Join(root, "research/infra/cloudflare/oauth")
	repo(t, ref, "main")
	run(t, ref, "remote", "add", "origin", "https://user:secret-token@example.com/cloudflare/oauth.git")
	repo(t, filepath.Join(root, "research/scratch"), "main")
	repo(t, filepath.Join(root, "node_modules/pkg"), "main")
	repo(t, filepath.Join(root, "research/stress/run1"), "main")
	write(t, filepath.Join(root, ".pando/pando.toml"), "local_only = [\"research/stress/\"]\nmystery = 1\n")
	return root
}

func TestScanMonorepo(t *testing.T) {
	root := workspacesTree(t)
	p, err := Scan(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	if p.Kind != "monorepo" {
		t.Fatalf("kind %q", p.Kind)
	}
	var projects []string
	for _, pr := range p.Projects {
		projects = append(projects, pr.Path+"="+pr.MainBranch)
	}
	if got := strings.Join(projects, " "); got != "projects/app=main projects/lib=master" {
		t.Fatalf("projects: %s", got)
	}
	if !p.Projects[0].Layout || len(p.Projects[0].Others) != 1 {
		t.Fatalf("app should be in the worktrees layout with one other worktree: %+v", p.Projects[0])
	}
	if len(p.References) != 1 || p.References[0].Path != "research/infra/cloudflare/oauth" {
		t.Fatalf("references: %+v", p.References)
	}
	r := p.References[0]
	if r.URL != "https://example.com/cloudflare/oauth.git" {
		t.Fatalf("the pointer must not keep the token: %q", r.URL)
	}
	if r.Ref != "refs/heads/main" || len(r.Commit) != 40 {
		t.Fatalf("ref %q commit %q", r.Ref, r.Commit)
	}
	var qs []string
	for _, q := range p.Questions {
		qs = append(qs, q.Path+"="+q.Kind)
	}
	if got := strings.Join(qs, " "); got != "projects/notes=no-history research/scratch=no-remote" {
		t.Fatalf("questions: %s", got)
	}
	notes := strings.Join(p.Notes, "\n")
	for _, want := range []string{`unknown key "mystery"`, "pushing master as main", "holds a user or token"} {
		if !strings.Contains(notes, want) {
			t.Errorf("notes lack %q:\n%s", want, notes)
		}
	}
	if strings.Contains(notes, "secret-token") {
		t.Fatal("a note printed the token")
	}
}

func TestScanOverrides(t *testing.T) {
	root := workspacesTree(t)
	write(t, filepath.Join(root, ".pando/pando.toml"), "projects = [\"research/scratch\"]\nreferences = [\"projects/lib\"]\nlocal_only = [\"research/stress/\"]\n")
	run(t, filepath.Join(root, "projects/lib"), "remote", "add", "origin", "https://example.com/lib.git")
	p, err := Scan(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, pr := range p.Projects {
		got = append(got, pr.Path)
	}
	if strings.Join(got, " ") != "projects/app research/scratch" {
		t.Fatalf("projects: %v", got)
	}
	got = nil
	for _, r := range p.References {
		got = append(got, r.Path)
	}
	if strings.Join(got, " ") != "projects/lib research/infra/cloudflare/oauth" {
		t.Fatalf("references: %v", got)
	}
}

func TestScanPlainRepo(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "acme")
	repo(t, dir, "main")
	p, err := Scan(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if p.Kind != "repo" || len(p.Projects) != 1 || p.Projects[0].Path != "." {
		t.Fatalf("plan: %+v", p)
	}
	sub := filepath.Join(dir, "src")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Scan(context.Background(), sub); err == nil || !strings.Contains(err.Error(), "inside the git repo") {
		t.Fatalf("a folder inside a repo should be refused, got %v", err)
	}
}

func TestLocalOnly(t *testing.T) {
	cases := []struct {
		pats []string
		rel  string
		want bool
	}{
		{[]string{"research/stress/"}, "research/stress", true},
		{[]string{"research/stress/"}, "research/stress/run1", true},
		{[]string{"research/stress/"}, "other/research/stress", false},
		{[]string{"research/reviews/integration-*/"}, "research/reviews/integration-7", true},
		{[]string{".venv/"}, "tools/x/.venv", true},
		{[]string{"/build"}, "build", true},
		{[]string{"/build"}, "src/build", false},
	}
	for _, c := range cases {
		if got := localOnly(c.pats, c.rel); got != c.want {
			t.Errorf("localOnly(%v, %q) = %v", c.pats, c.rel, got)
		}
	}
}
