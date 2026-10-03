package app

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"pando/internal/config"
)

// The commands end to end against a file:// server with the sparse driver:
// real git, no FUSE, safe on a Mac.

type harness struct {
	t      *testing.T
	base   string
	server string
}

func newHarness(t *testing.T) *harness {
	base := t.TempDir()
	// A read-only main has read-only folders; make them writable so the
	// temp folder can be deleted (this runs before TempDir's cleanup).
	t.Cleanup(func() {
		filepath.Walk(base, func(p string, info os.FileInfo, err error) error {
			if err == nil && info.IsDir() {
				os.Chmod(p, 0o755)
			}
			return nil
		})
	})
	t.Setenv("PANDO_HOME", filepath.Join(base, "home"))
	t.Setenv("PANDO_MACHINE", "test-box")
	t.Setenv("PANDO_WORKTREE_KIND", "sparse")
	t.Setenv("PANDO_AGENT", "")
	t.Setenv("PANDO_TOKEN", "")
	t.Setenv("PANDO_SERVER", "")
	t.Setenv("GIT_CONFIG_GLOBAL", "/dev/null")
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1") // no osxkeychain prompts on a Mac
	for _, k := range []string{"GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"} {
		t.Setenv(k, "Pat Person")
	}
	for _, k := range []string{"GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"} {
		t.Setenv(k, "pat@example.com")
	}
	return &harness{t: t, base: base, server: "file://" + filepath.Join(base, "server")}
}

// pando runs one command in dir, with stdin, and returns its output.
func (h *harness) pando(dir, stdin string, args ...string) (string, error) {
	h.t.Helper()
	var out bytes.Buffer
	e, err := NewEnv(context.Background(), strings.NewReader(stdin), &out, &out)
	if err != nil {
		h.t.Fatal(err)
	}
	e.Cwd = dir
	cmds := map[string]func(*Env, []string) error{
		"login": Login, "init": Init, "clone": Clone, "worktree": Worktree, "branch": Branch,
		"diff": Diff, "review": Review, "merge": Merge, "status": Status, "reference": Reference,
	}
	err = cmds[args[0]](e, args[1:])
	return out.String(), err
}

func (h *harness) ok(dir string, args ...string) string {
	h.t.Helper()
	out, err := h.pando(dir, "", args...)
	if err != nil {
		h.t.Fatalf("pando %v: %v\n%s", args, err, out)
	}
	return out
}

func (h *harness) git(dir string, args ...string) string {
	h.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		h.t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// chmodTree adds or removes permission bits under dir, .git left alone.
func chmodTree(dir string, bits os.FileMode, add bool) {
	filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() && info.Name() == ".git" {
			return filepath.SkipDir
		}
		m := info.Mode().Perm()
		if add {
			m |= bits
		} else {
			m &^= bits
		}
		os.Chmod(p, m)
		return nil
	})
}

func TestMonorepoEndToEnd(t *testing.T) {
	h := newHarness(t)
	ws := filepath.Join(h.base, "ws")
	app := filepath.Join(ws, "projects/app/worktrees/main")
	os.MkdirAll(filepath.Join(app, "src"), 0o755)
	os.WriteFile(filepath.Join(ws, "AGENTS.md"), []byte("agents"), 0o644)
	os.WriteFile(filepath.Join(app, "src/main.go"), []byte("package main\n"), 0o644)
	h.git(app, "init", "-q", "-b", "main")
	h.git(app, "add", "-A")
	h.git(app, "commit", "-q", "-m", "first")

	if out, err := h.pando(h.base, "local-secret\n", "login", "--bootstrap", "--server", h.server, "--login", "pat"); err != nil {
		t.Fatalf("login: %v\n%s", err, out)
	}
	out := h.ok(ws, "init", "--yes")
	if !strings.Contains(out, "pushed main") || !strings.Contains(out, "Pando monorepo ws is set up") {
		t.Fatalf("init:\n%s", out)
	}

	clone := filepath.Join(h.base, "clone")
	out = h.ok(h.base, "clone", "ws", clone, "--server", h.server)
	if !strings.Contains(out, "projects/app/worktrees/main: main (main, read-only), sparse worktree") {
		t.Fatalf("clone:\n%s", out)
	}
	mainDir := filepath.Join(clone, "projects/app/worktrees/main")
	if err := os.WriteFile(filepath.Join(mainDir, "x"), []byte("x"), 0o644); err == nil {
		t.Fatal("worktrees/main took a write")
	}

	out = h.ok(clone, "worktree", "add", "projects/app", "agent-1/oauth", "--agent", "agent-1")
	if !strings.Contains(out, "projects/app/worktrees/agent-1-oauth: agent-1/oauth (new branch off main)") {
		t.Fatalf("worktree add:\n%s", out)
	}
	wt := filepath.Join(clone, "projects/app/worktrees/agent-1-oauth")
	os.WriteFile(filepath.Join(wt, "src/oauth.go"), []byte("package main\n"), 0o644)
	h.git(wt, "add", "-A")
	h.git(wt, "commit", "-q", "-m", "Add oauth")
	msg := h.git(wt, "log", "-1", "--format=%B")
	for _, want := range []string{"Pando-Agent: agent-1", "Pando-Worktree: projects/app/worktrees/agent-1-oauth", "Pando-Machine: test-box"} {
		if !strings.Contains(msg, want) {
			t.Errorf("commit lacks %q:\n%s", want, msg)
		}
	}
	h.git(wt, "push", "-q")

	if _, err := h.pando(clone, "", "worktree", "remove", "projects/app/worktrees/agent-1-oauth"); err != nil {
		t.Fatalf("a clean, pushed worktree should be removable: %v", err)
	}
	h.ok(clone, "worktree", "add", "projects/app", "agent-1/oauth")

	out = h.ok(wt, "branch", "list")
	if !strings.Contains(out, "agent-1/oauth  1") {
		t.Fatalf("branch list:\n%s", out)
	}
	out = h.ok(wt, "diff")
	if !strings.Contains(out, "A  src/oauth.go") {
		t.Fatalf("diff:\n%s", out)
	}
	t.Setenv("PANDO_AGENT", "agent-2")
	out = h.ok(wt, "review", "--approve", "-m", "Reads well.")
	if !strings.Contains(out, "Posted an approval") {
		t.Fatalf("review:\n%s", out)
	}
	out = h.ok(wt, "merge")
	t.Setenv("PANDO_AGENT", "")
	if !strings.Contains(out, "Merged agent-1/oauth into main of projects/app") || !strings.Contains(out, "projects/app/worktrees/main now at") {
		t.Fatalf("merge:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(mainDir, "src/oauth.go")); err != nil {
		t.Fatal("worktrees/main did not follow the merge")
	}
	if parents := h.git(mainDir, "log", "-1", "--format=%p"); len(strings.Fields(parents)) != 2 {
		t.Fatalf("main's head is not a merge commit: %q", parents)
	}

	root, err := config.LoadRoot(clone)
	if err != nil {
		t.Fatal(err)
	}
	ws2, _ := root.LoadWorktrees()
	if len(ws2) != 2 {
		t.Fatalf("local worktrees: %+v", ws2)
	}
	// A second machine's read-only main follows the merge.
	other := filepath.Join(h.base, "other")
	h.ok(h.base, "clone", "ws", other, "--server", h.server)
	otherMain := filepath.Join(other, "projects/app/worktrees/main")
	// As if this machine cloned before the merge: main one commit back.
	chmodTree(otherMain, 0o200, true)
	h.git(otherMain, "reset", "-q", "--hard", "HEAD~1")
	chmodTree(otherMain, 0o222, false)
	if _, err := os.Stat(filepath.Join(otherMain, "src/oauth.go")); err == nil {
		t.Fatal("setup: main should be before the merge")
	}
	h.ok(other, "worktree", "follow", "--once")
	if _, err := os.Stat(filepath.Join(otherMain, "src/oauth.go")); err != nil {
		t.Fatal("the other machine's main did not follow the merge")
	}
	if st := h.git(otherMain, "status", "--porcelain"); st != "" {
		t.Fatalf("main after following: %q", st)
	}
	if os.WriteFile(filepath.Join(otherMain, "y"), []byte("y"), 0o644) == nil {
		t.Fatal("main is writable after following")
	}

	out = h.ok(clone, "status")
	if !strings.Contains(out, "projects/app/worktrees/agent-1-oauth") {
		t.Fatalf("status:\n%s", out)
	}
}

func TestPlainRepoInit(t *testing.T) {
	h := newHarness(t)
	acme := filepath.Join(h.base, "acme")
	os.MkdirAll(acme, 0o755)
	os.WriteFile(filepath.Join(acme, "README.md"), []byte("# acme\n"), 0o644)
	h.git(acme, "init", "-q", "-b", "main")
	h.git(acme, "add", "-A")
	h.git(acme, "commit", "-q", "-m", "first")
	if out, err := h.pando(h.base, "local-secret\n", "login", "--bootstrap", "--server", h.server, "--login", "pat"); err != nil {
		t.Fatalf("login: %v\n%s", err, out)
	}
	out := h.ok(acme, "init")
	if !strings.Contains(out, "it becomes a plain Pando repo") {
		t.Fatalf("init:\n%s", out)
	}
	h.ok(acme, "worktree", "add", ".", "fix-login")
	if st := h.git(acme, "status", "--porcelain"); st != "" {
		t.Fatalf("Pando's folders show in the plain repo's status: %q", st)
	}
	if _, err := os.Stat(filepath.Join(acme, "worktrees/fix-login/README.md")); err != nil {
		t.Fatal(err)
	}
}
