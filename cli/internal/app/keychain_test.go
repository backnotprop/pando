package app

import (
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// No git that pando runs, and no git an agent runs in a Pando worktree,
// hands the Pando credential to a credential helper from the system or the
// person's git config (on a Mac, Apple's osxkeychain, which pops "A keychain
// cannot be found to store ..." when there is no keychain). A recorder helper
// stands in for those, in a fake global config; the system level stays off
// (GIT_CONFIG_NOSYSTEM=1, as everywhere Pando runs git), since Apple git's
// osxkeychain is there and only that setting keeps it from running. The git
// server needs the credential on every request, so credentials do flow. The
// recorder must never run.
func TestNoInheritedCredentialHelperRuns(t *testing.T) {
	h := newHarness(t)
	srvBase := strings.TrimPrefix(h.server, "file://")
	os.MkdirAll(srvBase, 0o755)

	calls := filepath.Join(h.base, "inherited-helper-calls")
	recorder := filepath.Join(h.base, "recorder.sh")
	os.WriteFile(recorder, []byte("#!/bin/sh\necho \"$@\" >> '"+calls+"'\ncat >/dev/null\n"), 0o755)
	global := filepath.Join(h.base, "global.gitconfig")
	os.WriteFile(global, []byte("[credential]\n\thelper = !'"+recorder+"'\n[user]\n\tname = Pat\n\temail = pat@example.com\n"), 0o644)
	t.Setenv("GIT_CONFIG_GLOBAL", global)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")

	// Pando's helper: answers get with the credential, as pando credential does.
	const secret = "pando_test_secret"
	helper := filepath.Join(h.base, "pando-helper.sh")
	os.WriteFile(helper, []byte("#!/bin/sh\ncat >/dev/null\n[ \"$2\" = get ] && printf 'username=pat\\npassword=%s\\n' '"+secret+"'\nexit 0\n"), 0o755)
	t.Setenv("PANDO_CREDENTIAL_EXE", helper)

	// The git door: git http-backend, credential required on every request.
	execPath, err := exec.Command("git", "--exec-path").Output()
	if err != nil {
		t.Fatal(err)
	}
	backend := &cgi.Handler{Path: filepath.Join(strings.TrimSpace(string(execPath)), "git-http-backend"),
		Env: []string{"GIT_PROJECT_ROOT=" + srvBase, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1"}}
	var authed, challenged atomic.Int32
	door := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pw, ok := r.BasicAuth(); !ok || pw != secret {
			challenged.Add(1)
			w.Header().Set("WWW-Authenticate", `Basic realm="pando"`)
			w.WriteHeader(401)
			return
		}
		authed.Add(1)
		backend.ServeHTTP(w, r)
	}))
	defer door.Close()
	t.Setenv("PANDO_TEST_CLONE_BASE", door.URL)

	gitAgent := func(dir string, args ...string) { // plain git, as an agent runs it
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	// A monorepo with one project: pando init pushes its main over HTTP.
	ws := filepath.Join(h.base, "ws")
	app := filepath.Join(ws, "projects", "app", "worktrees", "main")
	os.MkdirAll(app, 0o755)
	os.WriteFile(filepath.Join(app, "README.md"), []byte("app\n"), 0o644)
	gitAgent(app, "init", "-q", "-b", "main")
	gitAgent(app, "add", "-A")
	gitAgent(app, "commit", "-q", "-m", "first")
	if out, err := h.pando(h.base, "local-secret\n", "login", "--bootstrap", "--server", h.server, "--login", "pat"); err != nil {
		t.Fatalf("login: %v\n%s", err, out)
	}
	if out := h.ok(ws, "init", "--yes"); !strings.Contains(out, "pushed main") {
		t.Fatalf("init:\n%s", out)
	}
	// pando clone and pando worktree add clone over HTTP.
	clone := filepath.Join(h.base, "clone")
	h.ok(h.base, "clone", "pat/ws", clone, "--server", h.server)
	h.ok(clone, "worktree", "add", "projects/app", "feat")
	// An agent's own commit and git push in the worktree.
	wt := filepath.Join(clone, "projects", "app", "worktrees", "feat")
	os.WriteFile(filepath.Join(wt, "b.txt"), []byte("b\n"), 0o644)
	gitAgent(wt, "add", "-A")
	gitAgent(wt, "commit", "-q", "-m", "b")
	gitAgent(wt, "push", "-q")
	// A merge, and main following it (a fetch), in the background and by
	// pando worktree follow --once.
	h.ok(wt, "merge")
	mainDir := filepath.Join(clone, "projects", "app", "worktrees", "main")
	waitUntil(t, "main to follow the merge", func() bool { _, err := os.Stat(filepath.Join(mainDir, "b.txt")); return err == nil })
	h.ok(clone, "worktree", "follow", "--once")

	// No repo config pando wrote names osxkeychain, and every worktree's
	// helper list for the Pando host starts by clearing what it inherited.
	scope := "credential." + door.URL + ".helper"
	for _, d := range []string{app, filepath.Join(clone, "projects", "app", "worktrees", "main"), wt} {
		b, _ := os.ReadFile(gitConfigOf(t, d))
		if strings.Contains(string(b), "osxkeychain") {
			t.Fatalf("%s's git config names osxkeychain:\n%s", d, b)
		}
		cmd := exec.Command("git", "config", "--local", "--get-all", scope)
		cmd.Dir = d
		out, _ := cmd.Output()
		if lines := strings.Split(string(out), "\n"); len(lines) < 2 || lines[0] != "" || !strings.Contains(lines[1], "credential") {
			t.Fatalf("%s: the helpers for %s are %q; want the empty reset, then pando's", d, door.URL, out)
		}
	}
	if authed.Load() < 5 || challenged.Load() < 1 {
		t.Fatalf("credentials did not flow (authenticated requests %d, challenges %d)", authed.Load(), challenged.Load())
	}
	if b, err := os.ReadFile(calls); err == nil && len(b) > 0 {
		t.Fatalf("a helper from the system or global git config ran (it would be osxkeychain on a Mac):\n%s", b)
	}
	t.Logf("%d authenticated git requests, %d challenges; the inherited helper never ran", authed.Load(), challenged.Load())
}

// gitConfigOf is the config file of the repo at dir (a worktree shares its
// common git folder's).
func gitConfigOf(t *testing.T, dir string) string {
	t.Helper()
	cmd := exec.Command("git", "rev-parse", "--git-common-dir")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	gd := strings.TrimSpace(string(out))
	if !filepath.IsAbs(gd) {
		gd = filepath.Join(dir, gd)
	}
	return filepath.Join(gd, "config")
}
