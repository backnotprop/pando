package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pando/internal/server"
)

// pando artifact end to end against a running Worker (wrangler dev, with real
// Durable Objects and R2): worker/test/artifacts.mjs makes the person, the
// monorepo and the branch, then runs this with
//
//	PANDO_LIVE_URL, PANDO_LIVE_SECRET (the person), PANDO_LIVE_PEER_SECRET (a
//	second member), PANDO_LIVE_MONOREPO (owner/name), PANDO_LIVE_BRANCH
//
// Skipped without them. Secrets stay in the environment; nothing prints them.
func TestArtifactLive(t *testing.T) {
	base, secret, peer, mono, branch := os.Getenv("PANDO_LIVE_URL"), os.Getenv("PANDO_LIVE_SECRET"), os.Getenv("PANDO_LIVE_PEER_SECRET"), os.Getenv("PANDO_LIVE_MONOREPO"), os.Getenv("PANDO_LIVE_BRANCH")
	if base == "" || secret == "" || peer == "" || mono == "" || branch == "" {
		t.Skip("set PANDO_LIVE_URL, PANDO_LIVE_SECRET, PANDO_LIVE_PEER_SECRET, PANDO_LIVE_MONOREPO and PANDO_LIVE_BRANCH (worker/test/artifacts.mjs does)")
	}
	dir := t.TempDir()
	t.Setenv("PANDO_HOME", filepath.Join(dir, "home"))
	t.Setenv("PANDO_SERVER", "")
	t.Setenv("PANDO_TOKEN", "")
	t.Setenv("PANDO_AGENT", "")
	t.Setenv("PANDO_NO_BROWSER", "1")
	work := filepath.Join(dir, "work")
	if err := os.MkdirAll(filepath.Join(work, "img"), 0o755); err != nil {
		t.Fatal(err)
	}

	run := func(stdin string, args ...string) (string, error) {
		t.Helper()
		var out bytes.Buffer
		e, err := NewEnv(context.Background(), strings.NewReader(stdin), &out, &out)
		if err != nil {
			t.Fatal(err)
		}
		e.Cwd = work
		if args[0] == "login" {
			err = Login(e, args[1:])
		} else {
			err = Artifact(e, append(args, "--monorepo", mono))
		}
		return out.String(), err
	}
	must := func(want string, args ...string) string {
		t.Helper()
		out, err := run("", args...)
		if err != nil || !strings.Contains(out, want) {
			t.Fatalf("pando artifact %s: want %q in\n%s\nerr: %v", strings.Join(args, " "), want, out, err)
		}
		return out
	}
	write := func(name, text string) {
		if err := os.WriteFile(filepath.Join(work, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if out, err := run(secret+"\n", "login", "--server", base, "--with-credential"); err != nil {
		t.Fatalf("pando login: %v\n%s", err, out)
	}

	// An agent uploads a plan with its image; the same name again is v2.
	write("plan.md", "# The plan\n\nFirst draft.\n\n![chart](img/chart.png)\n")
	write("img/chart.png", "not really a png, but bytes")
	must("Added plan.md v1 to "+branch, "add", branch, "plan.md", "img/chart.png")
	write("plan.md", "# The plan\n\nSecond draft: ship on Thursday.\n\n![chart](img/chart.png)\n")
	must("Uploaded plan.md v2 to "+branch, "add", branch, "plan.md", "img/chart.png")
	if out, err := run("", "add", branch, "plan.md", "../outside.png"); err == nil || !strings.Contains(err.Error(), "outside plan.md's folder") {
		t.Fatalf("an image outside the document's folder: want refused, got %v\n%s", err, out)
	}
	if out, err := run("", "add", branch, "notes.txt"); err == nil {
		t.Fatalf("a file that does not exist: want an error\n%s", out)
	}
	must("plan.md  markdown  v2", "list", branch)
	var l server.ArtifactList
	if out, err := run("", "list", branch, "--json"); err != nil || json.Unmarshal([]byte(out), &l) != nil || len(l.Artifacts) == 0 || l.Artifacts[0].Latest.Files[1].Path != "img/chart.png" {
		t.Fatalf("list --json: the API's answer, the image kept by its path: %v\n%s", err, out)
	}

	// A person marks it up (as the page does, through the API).
	h := server.NewHTTP(base, peer)
	ctx := context.Background()
	marked, err := h.AddArtifactComment(ctx, mono, l.Artifacts[0].ID, server.ArtifactCommentIn{Body: "Thursday is the freeze. Friday?", Quote: "ship on Thursday"}, newKey())
	if err != nil {
		t.Fatal(err)
	}

	// The agent reads the comments, replies and resolves.
	out := must(marked.ID, "comments", branch, "plan.md")
	if !strings.Contains(out, `on "ship on Thursday"`) || !strings.Contains(out, "Thursday is the freeze. Friday?") || !strings.Contains(out, "1 open, 0 resolved") {
		t.Fatalf("comments: the quote, the comment and the counts:\n%s", out)
	}
	if out, err := run("", "comment", branch, "plan.md", "--quote", "not in the plan", "-m", "Where is this?"); err != nil || !strings.Contains(out, `"not in the plan" is not in plan.md v2 as written`) || !strings.Contains(out, "Commented on plan.md v2") {
		t.Fatalf("a quote not in the file: posted, with a warning: %v\n%s", err, out)
	}
	must("Commented on plan.md v2", "comment", branch, "plan.md", "-m", "On the whole plan.")
	must("Replied in "+marked.ID, "reply", marked.ID, "-m", "Friday it is; see v3.")
	must("Resolved "+marked.ID, "resolve", marked.ID)
	out = must("2 open, 1 resolved", "comments", branch)
	if strings.Contains(out, marked.ID) {
		t.Fatalf("comments: a resolved thread is left out without --all:\n%s", out)
	}
	out = must("resolved by", "comments", branch, "--all")
	if !strings.Contains(out, "Friday it is; see v3.") {
		t.Fatalf("comments --all: the resolved thread with its reply:\n%s", out)
	}
	must("Reopened "+marked.ID, "resolve", marked.ID, "--reopen")

	// It downloads v1 to revise it, every file checked by SHA-256.
	got := filepath.Join(dir, "got")
	must(filepath.Join(got, "img", "chart.png"), "get", branch, "plan.md", "--version", "1", "-o", got)
	if b, _ := os.ReadFile(filepath.Join(got, "plan.md")); !strings.Contains(string(b), "First draft.") {
		t.Fatalf("get --version 1: v1's document, got %q", b)
	}
	if _, err := run("", "get", branch, "plan.md", "--version", "9"); err == nil {
		t.Fatal("get --version 9: want refused")
	}

	// Its page on the branch.
	parts := strings.Split(branch, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	must("/branches/"+strings.Join(parts, "/")+"?artifact=plan.md&tab=artifacts", "open", branch, "plan.md")
	if _, err := run("", "open", branch, "nothing.md"); err == nil || !strings.Contains(err.Error(), "no artifact nothing.md") {
		t.Fatalf("open: a name not on the branch: %v", err)
	}
}
