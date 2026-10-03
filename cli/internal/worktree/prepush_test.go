package worktree

import (
	"context"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeRandom(t *testing.T, p string, n int) {
	t.Helper()
	b := make([]byte, n)
	rand.Read(b)
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// The settings ride with the credential helper, for the Pando host only,
// once each however often they are written.
func TestHTTPSettingsWritten(t *testing.T) {
	dir := t.TempDir()
	must(t, dir, nil, "init", "-q", "-b", "main")
	gd := filepath.Join(dir, ".git")
	for i := 0; i < 2; i++ {
		if err := WriteCredentialConfig(context.Background(), gd, "https://pando.example.com/ws/projects-app.git"); err != nil {
			t.Fatal(err)
		}
	}
	for key, want := range map[string]string{
		"http.https://pando.example.com/.version":          "HTTP/1.1",
		"http.https://pando.example.com/.postbuffer":       PostBuffer,
		"credential.https://pando.example.com.usehttppath": "true",
	} {
		if got := must(t, dir, nil, "config", "--get-all", key); got != want {
			t.Errorf("%s = %q, want %q (once)", key, got, want)
		}
	}
	// git applies them to the Pando URL and to no other.
	if got := must(t, dir, nil, "config", "--get-urlmatch", "http.version", "https://pando.example.com/ws/x.git"); got != "HTTP/1.1" {
		t.Errorf("urlmatch: %q", got)
	}
	if out, _ := gitIn(t, dir, nil, "config", "--get-urlmatch", "http.version", "https://github.com/x/y.git"); out != "" {
		t.Errorf("leaked to another host: %q", out)
	}
	args := strings.Join(CredentialArgs("https://pando.example.com/x.git"), " ")
	if !strings.Contains(args, "http.https://pando.example.com/.version=HTTP/1.1") || !strings.Contains(args, "postBuffer="+PostBuffer) {
		t.Errorf("clone args: %s", args)
	}
	if CredentialArgs("file:///srv/x.git") != nil {
		t.Error("a file:// remote gets no settings")
	}
}

func TestPrePushRefuses(t *testing.T) {
	base := t.TempDir()
	srv := filepath.Join(base, "srv.git")
	must(t, base, nil, "init", "-q", "--bare", "-b", "main", srv)
	must(t, srv, nil, "config", "uploadpack.allowFilter", "true")
	seed := filepath.Join(base, "seed")
	must(t, base, nil, "init", "-q", "-b", "main", seed)
	os.WriteFile(filepath.Join(seed, "a.txt"), []byte("a\n"), 0o644)
	writeRandom(t, filepath.Join(seed, "old.bin"), 300000) // already on the server
	must(t, seed, nil, "add", "-A")
	must(t, seed, nil, "commit", "-q", "-m", "seed")
	must(t, seed, nil, "push", "-q", srv, "main")

	wt := filepath.Join(base, "wt")
	must(t, base, nil, "clone", "-q", "--filter=blob:none", "file://"+srv, wt)
	if err := InstallHook(context.Background(), filepath.Join(wt, ".git"), Identity{Worktree: "w", Machine: "m"}); err != nil {
		t.Fatal(err)
	}
	limits := []string{"PANDO_PUSH_LIMIT=200000", "PANDO_BLOB_LIMIT=100000"}
	commit := func(msg string) { must(t, wt, nil, "add", "-A"); must(t, wt, nil, "commit", "-q", "-m", msg) }

	// A small change pushes; the 300 kB blob already on the server does not count.
	os.WriteFile(filepath.Join(wt, "a.txt"), []byte("b\n"), 0o644)
	commit("small")
	if out, err := gitIn(t, wt, limits, "push", "-q", "origin", "HEAD:refs/heads/b1"); err != nil {
		t.Fatalf("small push refused: %s", out)
	}
	// A file over the blob limit is named and refused.
	os.MkdirAll(filepath.Join(wt, "assets"), 0o755)
	writeRandom(t, filepath.Join(wt, "assets/big.bin"), 160000)
	commit("big")
	out, err := gitIn(t, wt, limits, "push", "-q", "origin", "HEAD:refs/heads/b1")
	if err == nil || !strings.Contains(out, "assets/big.bin  0.2 MB") || !strings.Contains(out, "git rm --cached") {
		t.Fatalf("big file: err=%v\n%s", err, out)
	}
	must(t, wt, nil, "reset", "-q", "--hard", "HEAD~1")
	// Over the push limit after compression: refused, with how to split.
	for i := 0; i < 3; i++ {
		writeRandom(t, filepath.Join(wt, "r"+string(rune('0'+i))+".bin"), 90000)
	}
	commit("random")
	out, err = gitIn(t, wt, limits, "push", "-q", "origin", "HEAD:refs/heads/b1")
	if err == nil || !strings.Contains(out, "over the 0.2 MB one push to Pando can carry") || !strings.Contains(out, "split it") {
		t.Fatalf("large push: err=%v\n%s", err, out)
	}
	must(t, wt, nil, "reset", "-q", "--hard", "HEAD~1")
	// Over the limit uncompressed but under it packed: it goes.
	for i := 0; i < 5; i++ { // 5 files of 80 kB: each under the file limit
		os.WriteFile(filepath.Join(wt, "text"+string(rune('0'+i))+".txt"), []byte(strings.Repeat("the same line again\n", 4000)), 0o644)
	}
	commit("text")
	if out, err := gitIn(t, wt, limits, "push", "-q", "origin", "HEAD:refs/heads/b1"); err != nil {
		t.Fatalf("400 kB of text that packs small was refused: %s", out)
	}
	// Deleting a branch sends nothing and passes.
	if out, err := gitIn(t, wt, limits, "push", "-q", "origin", ":refs/heads/b1"); err != nil {
		t.Fatalf("delete: %s", out)
	}
}
