package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pando/internal/config"
	"pando/internal/server"
)

func TestMonorepoPath(t *testing.T) {
	for in, want := range map[string]string{
		"pat/ws":      "/v1/monorepos/pat/ws",
		"pat/a b":     "/v1/monorepos/pat/a%20b",
		"acme/web.v2": "/v1/monorepos/acme/web.v2",
	} {
		if got := server.MonorepoPath(in); got != want {
			t.Errorf("MonorepoPath(%q) = %q, want %q", in, got, want)
		}
	}
	if server.RepoName("pat/ws", ".") != "ws" || server.RepoName("pat/ws", "projects/web") != "projects-web" {
		t.Error("RepoName: a plain repo is named after the monorepo's name, without its owner")
	}
}

// Two owners with a monorepo named ws: a bare name takes your own; owner/name
// takes that one; a name only someone else has resolves to theirs; and
// with two others and none of yours, it stops and lists them.
func TestShortNames(t *testing.T) {
	h := newHarness(t)
	srv := &server.Local{Base: strings.TrimPrefix(h.server, "file://")}
	ctx := context.Background()
	make := func(owner, name string) {
		t.Setenv("USER", owner)
		if _, err := srv.CreateMonorepo(ctx, name, "repo"); err != nil {
			t.Fatal(err)
		}
	}
	make("ana", "ws")
	make("pat", "ws")
	make("ana", "tools")
	make("bob", "shared")
	make("ana", "shared")
	t.Setenv("USER", "pat")
	e, _ := NewEnv(ctx, strings.NewReader(""), os.Stdout, os.Stderr)
	for arg, want := range map[string]string{"ws": "pat/ws", "ana/ws": "ana/ws", "tools": "ana/tools", "ANA/tools": "ana/tools"} {
		m, err := resolveMonorepo(e, srv, arg)
		if err != nil || m.Full() != want {
			t.Errorf("%s: %v %v, want %s", arg, m, err, want)
		}
	}
	if _, err := resolveMonorepo(e, srv, "shared"); err == nil || !strings.Contains(err.Error(), "more than one monorepo is named shared; use one of: ") ||
		!strings.Contains(err.Error(), "ana/shared") || !strings.Contains(err.Error(), "bob/shared") {
		t.Fatalf("shared: %v", err)
	}
	if _, err := resolveMonorepo(e, srv, "nope"); err == nil {
		t.Fatal("a name nobody has must fail")
	}
}

// pando clone owner/name and pando clone name: the folder is the name;
// root.json is version 2 with the owner and the id; output says owner/name.
func TestCloneFolderIsTheName(t *testing.T) {
	h := newHarness(t)
	srv := &server.Local{Base: strings.TrimPrefix(h.server, "file://")}
	t.Setenv("USER", "ana")
	if _, err := srv.CreateMonorepo(context.Background(), "tools", "monorepo"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("USER", "pat")
	out := h.ok(h.base, "clone", "ana/tools", "--server", h.server)
	if !strings.Contains(out, "ana/tools") {
		t.Fatalf("clone output names the monorepo owner/name:\n%s", out)
	}
	r, err := config.LoadRoot(filepath.Join(h.base, "tools"))
	if err != nil {
		t.Fatalf("the folder is the name (tools): %v", err)
	}
	if r.Version != 2 || r.Owner != "ana" || r.Name != "tools" || !strings.HasPrefix(r.ID, "m_") || r.FullName() != "ana/tools" {
		t.Fatalf("root.json: %+v", r)
	}
	b, _ := os.ReadFile(filepath.Join(h.base, "tools", ".pando", "local", "root.json"))
	var raw map[string]any
	json.Unmarshal(b, &raw)
	if raw["owner"] != "ana" || raw["version"] != float64(2) {
		t.Fatalf("root.json on disk: %s", b)
	}
	out = h.ok(filepath.Join(h.base, "tools"), "status")
	if !strings.Contains(out, "monorepo ana/tools at") {
		t.Fatalf("status:\n%s", out)
	}
}
