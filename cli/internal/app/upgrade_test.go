package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pando/internal/config"
)

// A version 1 folder (from before owner/name): its root.json has no owner,
// and every remote holds an old /<name>/<repo>.git address that no longer
// exists. The first command upgrades it to version 2 and points every
// remote at the server's clone_url; git works again; a second run changes
// nothing; a run that cannot reach the server leaves version 1 to try again.
func TestUpgradeVersion1Root(t *testing.T) {
	h := newHarness(t)
	ws := filepath.Join(h.base, "ws")
	app := filepath.Join(ws, "projects", "app", "worktrees", "main")
	os.MkdirAll(app, 0o755)
	os.WriteFile(filepath.Join(app, "README.md"), []byte("app\n"), 0o644)
	h.git(app, "init", "-q", "-b", "main")
	h.git(app, "add", "-A")
	h.git(app, "commit", "-q", "-m", "first")
	if out, err := h.pando(h.base, "local-secret\n", "login", "--bootstrap", "--server", h.server, "--login", "pat"); err != nil {
		t.Fatalf("login: %v\n%s", err, out)
	}
	h.ok(ws, "init", "--yes")
	clone := filepath.Join(h.base, "clone")
	h.ok(h.base, "clone", "pat/ws", clone, "--server", h.server)
	h.ok(clone, "worktree", "add", "projects/app", "feat", "--agent", "agent-1")

	newURL := "file://" + filepath.Join(strings.TrimPrefix(h.server, "file://"), "pat", "ws", "repos", "projects-app.git")
	oldURL := "file://" + filepath.Join(strings.TrimPrefix(h.server, "file://"), "ws", "repos", "projects-app.git") // the old 2-segment shape

	// Make both folders version 1, with old remotes everywhere.
	toV1 := func(dir string) {
		p := filepath.Join(dir, ".pando", "local", "root.json")
		b, _ := os.ReadFile(p)
		var raw map[string]any
		json.Unmarshal(b, &raw)
		delete(raw, "owner")
		delete(raw, "id")
		raw["version"] = 1
		for _, r := range raw["repos"].([]any) {
			r.(map[string]any)["clone_url"] = oldURL
		}
		b, _ = json.MarshalIndent(raw, "", "  ")
		os.WriteFile(p, b, 0o644)
	}
	toV1(clone)
	toV1(ws)
	wtMain := filepath.Join(clone, "projects", "app", "worktrees", "main")
	wtFeat := filepath.Join(clone, "projects", "app", "worktrees", "feat")
	for _, d := range []string{wtMain, wtFeat} {
		h.git(d, "config", "remote.origin.url", oldURL)
	}
	h.git(app, "config", "remote.pando.url", oldURL) // the checkout pando init pushed from

	// The server cannot be reached: the command fails and version 1 stays.
	srvDir := strings.TrimPrefix(h.server, "file://")
	os.Rename(srvDir, srvDir+".away")
	if _, err := h.pando(clone, "", "status"); err == nil || !strings.Contains(err.Error(), "needs its owner/name from the server") {
		t.Fatalf("an unreachable server must fail the upgrade: %v", err)
	}
	if r, _ := config.LoadRoot(clone); r.Owner != "" || r.Version != 1 {
		t.Fatalf("a failed upgrade must leave version 1: %+v", r)
	}
	os.Rename(srvDir+".away", srvDir)

	// The first command upgrades.
	var stderr strings.Builder
	out, err := h.pandoErr(clone, &stderr, "status")
	if err != nil {
		t.Fatalf("status: %v\n%s", err, out)
	}
	if !strings.Contains(stderr.String(), "now named pat/ws") || !strings.Contains(stderr.String(), "2 git remote(s)") {
		t.Fatalf("the upgrade says what it did (on stderr):\n%s", stderr.String())
	}
	if !strings.Contains(out, "monorepo pat/ws at") {
		t.Fatalf("status:\n%s", out)
	}
	r, _ := config.LoadRoot(clone)
	if r.Version != 2 || r.Owner != "pat" || r.ID == "" || r.Repos[0].CloneURL != newURL {
		t.Fatalf("root.json after the upgrade: %+v", r)
	}
	for _, d := range []string{wtMain, wtFeat} {
		if got := h.git(d, "remote", "get-url", "origin"); got != newURL {
			t.Fatalf("%s origin = %s, want %s", d, got, newURL)
		}
		h.git(d, "fetch", "-q", "origin") // git works again
	}

	// Running again changes nothing.
	stderr.Reset()
	if _, err := h.pandoErr(clone, &stderr, "status"); err != nil || strings.Contains(stderr.String(), "now named") {
		t.Fatalf("a second run must do nothing: %v %s", err, stderr.String())
	}
	if n, err := (&Env{Ctx: h.ctx(), Home: mustHome(t)}).repointRemotes(r, map[string]string{"projects/app": newURL}); err != nil || n != 0 {
		t.Fatalf("re-pointing again changed %d remotes (%v)", n, err)
	}

	// The folder that ran pando init: its pando remote is re-pointed too.
	stderr.Reset()
	if _, err := h.pandoErr(ws, &stderr, "status"); err != nil {
		t.Fatal(err)
	}
	if got := h.git(app, "remote", "get-url", "pando"); got != newURL {
		t.Fatalf("init checkout's pando remote = %s", got)
	}
}

func mustHome(t *testing.T) *config.Home {
	h, err := config.LoadHome()
	if err != nil {
		t.Fatal(err)
	}
	return h
}
