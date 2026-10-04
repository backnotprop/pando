package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"pando/internal/config"
	"pando/internal/server"
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
	t.Setenv("USER", "pat") // the file:// server's one user, so monorepos are pat/<name>
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
	// pando merge starts a one-off follower in the background; in tests,
	// a goroutine instead of a second process (which would be this test
	// binary). followed counts them.
	prev := startFollowOnce
	t.Cleanup(func() { startFollowOnce = prev })
	startFollowOnce = func(root *config.Root) error {
		refreshesRunning.Add(1) // counted from here, for the cleanup below
		go func() {
			defer refreshesRunning.Add(-1)
			e, err := NewEnv(context.Background(), strings.NewReader(""), io.Discard, io.Discard)
			if err == nil {
				followMains(e, root)
			}
		}()
		return nil
	}
	// A refresh of main still running in the background (one pando merge
	// started, or a follower's) makes main read-only again as it ends. Let
	// it end before the folders are made writable and removed (cleanups run
	// last first, so this runs before the chmod at the top).
	t.Cleanup(func() {
		for start := time.Now(); refreshesRunning.Load() > 0; time.Sleep(20 * time.Millisecond) {
			if time.Since(start) > 30*time.Second {
				t.Errorf("a refresh of main was still running 30 s after the test")
				return
			}
		}
	})
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
		"diff": Diff, "review": Review, "merge": Merge, "status": Status, "reference": Reference, "members": Members, "monorepo": Monorepo,
		"auth": Auth,
	}
	err = cmds[args[0]](e, args[1:])
	return out.String(), err
}

// pandoErr runs one command with stderr kept apart.
func (h *harness) pandoErr(dir string, stderr *strings.Builder, args ...string) (string, error) {
	h.t.Helper()
	var out bytes.Buffer
	e, err := NewEnv(context.Background(), strings.NewReader(""), &out, stderr)
	if err != nil {
		h.t.Fatal(err)
	}
	e.Cwd = dir
	cmds := map[string]func(*Env, []string) error{"status": Status, "worktree": Worktree, "clone": Clone}
	err = cmds[args[0]](e, args[1:])
	return out.String(), err
}

func (h *harness) ctx() context.Context { return context.Background() }

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
	if !strings.Contains(out, "pushed main") || !strings.Contains(out, "Pando monorepo pat/ws is set up") {
		t.Fatalf("init:\n%s", out)
	}
	// "Meta layer" is an internal word, never shown (decisions/RULINGS.md).
	if strings.Contains(strings.ToLower(out), "meta layer") {
		t.Errorf("init says meta layer:\n%s", out)
	}

	clone := filepath.Join(h.base, "clone")
	out = h.ok(h.base, "clone", "ws", clone, "--server", h.server)
	if !strings.Contains(out, "projects/app/worktrees/main: main (main, read-only), sparse worktree") {
		t.Fatalf("clone:\n%s", out)
	}
	if strings.Contains(strings.ToLower(out), "meta layer") {
		t.Errorf("clone says meta layer:\n%s", out)
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
	// The agent name stays hidden (decisions/RULINGS.md): the trailer is
	// written, but no list, status or help line names an agent.
	if strings.Contains(out, "Pando-Agent") {
		t.Errorf("worktree add names the agent:\n%s", out)
	}
	if out = h.ok(clone, "worktree", "list"); strings.Contains(out, "AGENT") || slices.Contains(strings.Fields(out), "agent-1") {
		t.Errorf("worktree list names the agent:\n%s", out)
	}
	t.Setenv("PANDO_AGENT", "agent-1")
	if out = h.ok(clone, "auth", "status"); !strings.Contains(out, "machine: test-box") || strings.Contains(out, "agent") {
		t.Errorf("auth status names the agent:\n%s", out)
	}
	t.Setenv("PANDO_AGENT", "")
	bin := filepath.Join(h.base, "pando")
	if b, err := exec.Command("go", "build", "-o", bin, "pando/cmd/pando").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, b)
	}
	// The daemon is pando sync; pando meta sync, its old name, works but is
	// not in the help, and the help never says "meta layer".
	if b, _ := exec.Command(bin, "help").CombinedOutput(); !strings.Contains(string(b), "pando sync [--once]") ||
		strings.Contains(string(b), "meta sync") || strings.Contains(strings.ToLower(string(b)), "meta layer") {
		t.Errorf("pando help:\n%s", b)
	}
	// The docs' CLI reference lists every command exactly as pando help does.
	help, _ := exec.Command(bin, "help").CombinedOutput()
	page, err := os.ReadFile("../../../site/docs/src/content/docs/cli.mdx")
	if err != nil {
		t.Fatal(err)
	}
	_, block, _ := strings.Cut(string(page), "## Every command\n\n```text\n")
	block, _, _ = strings.Cut(block, "\n```")
	if block != strings.TrimRight(string(help), "\n") {
		t.Errorf("site/docs/src/content/docs/cli.mdx, Every command, is not pando help. pando help prints:\n%s", help)
	}
	for _, args := range [][]string{{"help"}, {"worktree"}, {"worktree", "add", "-h"}} {
		b, _ := exec.Command(bin, args...).CombinedOutput()
		if !strings.Contains(string(b), "usage: pando") || strings.Contains(strings.ToLower(string(b)), "agent") {
			t.Errorf("pando %s names an agent:\n%s", strings.Join(args, " "), b)
		}
	}

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
	// Plannotator, through a stand-in that keeps the patch it is given.
	fake, _ := filepath.Abs("../../testbed/fake-plannotator.sh")
	patch := filepath.Join(h.base, "review.patch")
	t.Setenv("PANDO_PLANNOTATOR", fake)
	t.Setenv("FAKE_PLANNOTATOR_PATCH", patch)
	t.Setenv("FAKE_PLANNOTATOR_DECISION", "annotated")
	out = h.ok(wt, "review")
	if !strings.Contains(out, "Posted a request for changes") {
		t.Fatalf("review through plannotator:\n%s", out)
	}
	if b, _ := os.ReadFile(patch); !strings.Contains(string(b), "+++ b/src/oauth.go") {
		t.Fatalf("plannotator did not get the patch:\n%s", b)
	}
	t.Setenv("FAKE_PLANNOTATOR_DECISION", "dismissed")
	if out = h.ok(wt, "review"); !strings.Contains(out, "nothing posted") {
		t.Fatalf("dismissed review:\n%s", out)
	}
	t.Setenv("PANDO_AGENT", "agent-2")
	out = h.ok(wt, "review", "--approve", "-m", "Reads well.")
	if !strings.Contains(out, "Posted an approval") {
		t.Fatalf("review:\n%s", out)
	}
	out = h.ok(wt, "merge")
	t.Setenv("PANDO_AGENT", "")
	if !strings.Contains(out, "Merged agent-1/oauth into main of projects/app") || !strings.Contains(out, "worktrees/main follows within a moment") {
		t.Fatalf("merge:\n%s", out)
	}
	waitUntil(t, "worktrees/main to follow the merge", func() bool {
		_, err := os.Stat(filepath.Join(mainDir, "src/oauth.go"))
		return err == nil
	})
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

	out = h.ok(clone, "members", "invite", "ana@example.com")
	if !strings.Contains(out, "Invited ana@example.com to pat/ws as a member") {
		t.Fatalf("invite:\n%s", out)
	}
	if out = h.ok(clone, "members", "list"); !strings.Contains(out, "ana@example.com") || !strings.Contains(out, "owner") {
		t.Fatalf("members list:\n%s", out)
	}
	h.ok(clone, "members", "remove", "ws", "ana@example.com")
	if out = h.ok(clone, "members", "list", "ws"); strings.Contains(out, "ana@example.com") {
		t.Fatalf("the invite is still there:\n%s", out)
	}

	out = h.ok(clone, "status")
	if !strings.Contains(out, "projects/app/worktrees/agent-1-oauth") {
		t.Fatalf("status:\n%s", out)
	}
	if _, err := h.pando(clone, "", "monorepo", "delete", "ws"); err == nil {
		t.Fatal("delete without --yes and without a terminal must refuse")
	}
	if out = h.ok(clone, "monorepo", "list"); !strings.Contains(out, "ws") {
		t.Fatalf("monorepo list:\n%s", out)
	}
	h.ok(clone, "monorepo", "delete", "ws", "--yes")
	if out = h.ok(clone, "monorepo", "list"); strings.Contains(out, "ws ") {
		t.Fatalf("ws is still listed:\n%s", out)
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

func TestInitRefusesAnOversizedFirstPush(t *testing.T) {
	h := newHarness(t)
	acme := filepath.Join(h.base, "acme")
	os.MkdirAll(acme, 0o755)
	os.WriteFile(filepath.Join(acme, "README.md"), []byte(strings.Repeat("acme history\n", 1000)), 0o644)
	h.git(acme, "init", "-q", "-b", "main")
	h.git(acme, "add", "-A")
	h.git(acme, "commit", "-q", "-m", "first")
	if out, err := h.pando(h.base, "local-secret\n", "login", "--bootstrap", "--server", h.server, "--login", "pat"); err != nil {
		t.Fatalf("login: %v\n%s", err, out)
	}
	t.Setenv("PANDO_PUSH_LIMIT", "100")
	out, err := h.pando(acme, "", "init")
	if err == nil || !strings.Contains(out, "over the 0.0 MB one push to Pando can carry") || !strings.Contains(out, "main is not pushed") {
		t.Fatalf("init should refuse: %v\n%s", err, out)
	}
	t.Setenv("PANDO_PUSH_LIMIT", "")
	if out := h.ok(acme, "init"); !strings.Contains(out, "pushed main") {
		t.Fatalf("init again, under the limit:\n%s", out)
	}
}

// pando init's own push of main retries once when it breaks off in transit.
// The server's receive-pack is wrapped: the first push loses its pack after
// 200 bytes, as a dropped connection would; the second goes through.
func TestInitRetriesABrokenPush(t *testing.T) {
	h := newHarness(t)
	acme := filepath.Join(h.base, "acme")
	os.MkdirAll(acme, 0o755)
	os.WriteFile(filepath.Join(acme, "README.md"), []byte(strings.Repeat("acme history\n", 2000)), 0o644)
	h.git(acme, "init", "-q", "-b", "main")
	h.git(acme, "add", "-A")
	h.git(acme, "commit", "-q", "-m", "first")
	if out, err := h.pando(h.base, "local-secret\n", "login", "--bootstrap", "--server", h.server, "--login", "pat"); err != nil {
		t.Fatalf("login: %v\n%s", err, out)
	}
	tries := filepath.Join(h.base, "tries")
	wrap := filepath.Join(h.base, "flaky-receive-pack")
	os.WriteFile(wrap, []byte(`#!/bin/sh
echo x >> '`+tries+`'
if [ "$(wc -l < '`+tries+`')" -eq 1 ]; then
  head -c 200 | git-receive-pack "$@"
  exit 1
fi
exec git-receive-pack "$@"
`), 0o755)
	url := "file://" + filepath.Join(h.base, "server", "acme", "repos", "acme.git")
	h.git(acme, "remote", "add", "pando", url)
	h.git(acme, "config", "remote.pando.receivepack", wrap)

	out := h.ok(acme, "init", "--name", "acme")
	if !strings.Contains(out, "the push broke off") || !strings.Contains(out, "trying once more") || !strings.Contains(out, "pushed main") {
		t.Fatalf("init:\n%s", out)
	}
	if b, _ := os.ReadFile(tries); strings.Count(string(b), "x") != 2 {
		t.Fatalf("receive-pack ran %d times, want 2", strings.Count(string(b), "x"))
	}
	if got := h.git(acme, "ls-remote", "pando", "refs/heads/main"); !strings.HasPrefix(got, h.git(acme, "rev-parse", "HEAD")) {
		t.Fatalf("main on the server: %q", got)
	}
}

func TestTransportFailure(t *testing.T) {
	for msg, want := range map[string]bool{
		// Seen on pando-dev, 2026-10-03.
		"error: RPC failed; curl 56 LibreSSL SSL_read: LibreSSL/3.3.6: error:1404C3FC:SSL routines:ST_OK:sslv3 alert bad record mac, errno 0": true,
		"error: RPC failed; curl 56 GnuTLS recv error (-12): A TLS fatal alert has been received.":                                            true,
		"send-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly":                          true,
		" ! [remote rejected] main -> main (unpacker error)":                                                                                  true,
		// Refusals are not retried.
		" ! [remote rejected] main -> main (main is protected; push a branch and merge it)": false,
		" ! [remote rejected] HEAD -> main (pre-receive hook declined)":                     false,
		"fatal: repository 'https://x/y.git/' not found":                                    false,
	} {
		if got := transportFailure(errors.New(msg)); got != want {
			t.Errorf("%q: %v, want %v", msg, got, want)
		}
	}
}

func TestAgentFor(t *testing.T) {
	h := newHarness(t)
	root := &config.Root{Dir: h.base, Kind: "repo", Name: "acme", Server: "https://pando.example.com",
		Repos: []config.RepoEntry{{Path: ".", Name: "acme"}}}
	if err := root.Save(); err != nil {
		t.Fatal(err)
	}
	if err := root.SaveWorktrees([]config.Worktree{{ID: "wt_1", Repo: ".", Branch: "feat", Path: "worktrees/feat", Kind: "sparse", Agent: "agent-1"}}); err != nil {
		t.Fatal(err)
	}
	e, err := NewEnv(context.Background(), strings.NewReader(""), io.Discard, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	e.Cwd = filepath.Join(h.base, "worktrees", "feat", "src")
	if got := e.agentFor(root); got != "agent-1" {
		t.Fatalf("inside the worktree: %q", got)
	}
	t.Setenv("PANDO_AGENT", "agent-env")
	if got := e.agentFor(root); got != "agent-env" {
		t.Fatalf("PANDO_AGENT: %q", got)
	}
	e.Agent = "agent-flag"
	if got := e.agentFor(root); got != "agent-flag" {
		t.Fatalf("--agent: %q", got)
	}
	t.Setenv("PANDO_TOKEN", "pando_test")
	s, err := e.open(root)
	if err != nil {
		t.Fatal(err)
	}
	if hs, ok := s.(*server.HTTP); !ok || hs.Agent != "agent-flag" {
		t.Fatalf("the API client carries no agent: %#v", s)
	}
	e.Agent = ""
	t.Setenv("PANDO_AGENT", "")
	e.Cwd = h.base
	if got := e.agentFor(root); got != "" {
		t.Fatalf("outside any worktree, no agent: %q", got)
	}
}

func TestMergeWord(t *testing.T) {
	for _, c := range []struct {
		b    server.Branch
		want string
	}{
		{server.Branch{Mergeable: "clean"}, "clean"},
		{server.Branch{Mergeable: "pending", Stale: true, LastMergeable: "conflicts"}, "pending (was conflicts)"},
		{server.Branch{Mergeable: "pending", Stale: true}, "pending"},
		{server.Branch{}, "-"},
	} {
		if got := mergeWord(c.b); got != c.want {
			t.Errorf("%+v: %q, want %q", c.b, got, c.want)
		}
	}
	zero := 0
	if count(server.Branch{Stale: true}, &zero) != "?" || count(server.Branch{}, &zero) != "0" || count(server.Branch{}, nil) != "-" {
		t.Error("count: stale shows ?, known shows the number, unknown shows -")
	}
}

// pando clone mounts many repos' mains at once: all land, each once, in
// worktrees.json, with whole progress lines.
func TestCloneMountsMainsInParallel(t *testing.T) {
	h := newHarness(t)
	ws := filepath.Join(h.base, "ws")
	const n = 8
	for i := 0; i < n; i++ {
		d := filepath.Join(ws, "projects", fmt.Sprintf("p%d", i), "worktrees", "main")
		os.MkdirAll(d, 0o755)
		os.WriteFile(filepath.Join(d, "README.md"), []byte(fmt.Sprintf("p%d\n", i)), 0o644)
		h.git(d, "init", "-q", "-b", "main")
		h.git(d, "add", "-A")
		h.git(d, "commit", "-q", "-m", "first")
	}
	if out, err := h.pando(h.base, "local-secret\n", "login", "--bootstrap", "--server", h.server, "--login", "pat"); err != nil {
		t.Fatalf("login: %v\n%s", err, out)
	}
	h.ok(ws, "init", "--yes")
	clone := filepath.Join(h.base, "clone")
	out := h.ok(h.base, "clone", "ws", clone, "--server", h.server)
	if !strings.Contains(out, fmt.Sprintf("Mounting %d repos' main, 6 at a time", n)) || !strings.Contains(out, fmt.Sprintf("%d of %d mains ready", n, n)) {
		t.Fatalf("clone:\n%s", out)
	}
	ready := 0
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "(main, read-only), sparse worktree, ready in") {
			if !strings.HasPrefix(line, "projects/p") {
				t.Fatalf("a progress line was broken up: %q", line)
			}
			ready++
		}
	}
	if ready != n {
		t.Fatalf("%d ready lines, want %d:\n%s", ready, n, out)
	}
	root, _ := config.LoadRoot(clone)
	wts, _ := root.LoadWorktrees()
	seen := map[string]bool{}
	for _, w := range wts {
		seen[w.Path] = true
	}
	if len(wts) != n || len(seen) != n {
		t.Fatalf("worktrees.json has %d entries (%d distinct), want %d", len(wts), len(seen), n)
	}
	for i := 0; i < n; i++ {
		if _, err := os.Stat(filepath.Join(clone, "projects", fmt.Sprintf("p%d", i), "worktrees", "main", "README.md")); err != nil {
			t.Fatal(err)
		}
	}
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for start := time.Now(); time.Since(start) < 15*time.Second; time.Sleep(20 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

// pando merge: with a follower running it does not start another; --wait
// moves main before returning; a worktree that pushed one head refuses to
// merge a branch that moved since.
func TestMergeFollowerAndWait(t *testing.T) {
	h := newHarness(t)
	acme := filepath.Join(h.base, "acme")
	os.MkdirAll(acme, 0o755)
	os.WriteFile(filepath.Join(acme, "README.md"), []byte("acme\n"), 0o644)
	h.git(acme, "init", "-q", "-b", "main")
	h.git(acme, "add", "-A")
	h.git(acme, "commit", "-q", "-m", "first")
	if out, err := h.pando(h.base, "local-secret\n", "login", "--bootstrap", "--server", h.server, "--login", "pat"); err != nil {
		t.Fatalf("login: %v\n%s", err, out)
	}
	h.ok(acme, "init")
	clone := filepath.Join(h.base, "c")
	h.ok(h.base, "clone", "acme", clone, "--server", h.server)
	root, _ := config.LoadRoot(clone)
	started := 0
	startFollowOnce = func(*config.Root) error { started++; return nil }

	branch := func(name string) string {
		h.ok(clone, "worktree", "add", ".", name)
		wt := filepath.Join(clone, "worktrees", name)
		os.WriteFile(filepath.Join(wt, name+".txt"), []byte(name), 0o644)
		h.git(wt, "add", "-A")
		h.git(wt, "commit", "-q", "-m", name)
		h.git(wt, "push", "-q")
		return wt
	}
	mainHead := func() string { return h.git(filepath.Join(clone, "worktrees", "main"), "rev-parse", "HEAD") }

	// A follower holds the lock: merge starts nothing and says main follows.
	holdFollowerLock(root)
	if !followerRunning(root) {
		t.Fatal("the lock is not seen as held")
	}
	before := mainHead()
	out := h.ok(branch("b1"), "merge")
	if started != 0 || !strings.Contains(out, "follows within a moment (the follower is running)") || mainHead() != before {
		t.Fatalf("with a follower: started %d\n%s", started, out)
	}
	for _, f := range heldLocks {
		f.Close()
	}
	heldLocks = nil

	// --wait moves main before returning.
	out = h.ok(branch("b2"), "merge", "--wait")
	if !strings.Contains(out, "worktrees/main now at") || mainHead() == before {
		t.Fatalf("--wait:\n%s", out)
	}
	// No follower: one background follower is started.
	h.ok(branch("b3"), "merge")
	if started != 1 {
		t.Fatalf("background followers started: %d", started)
	}
	// The branch moved on the server after this worktree pushed: refused.
	wt4 := branch("b4")
	other := filepath.Join(h.base, "other")
	h.git(h.base, "clone", "-q", "--branch", "b4", root.Repos[0].CloneURL, other)
	os.WriteFile(filepath.Join(other, "late.txt"), []byte("late"), 0o644)
	h.git(other, "add", "-A")
	h.git(other, "commit", "-q", "-m", "late")
	h.git(other, "push", "-q")
	if out, err := h.pando(wt4, "", "merge"); err == nil || !strings.Contains(out+err.Error(), "is not what this worktree pushed") {
		t.Fatalf("a moved branch must be refused: %v\n%s", err, out)
	}
}
