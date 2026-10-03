package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"pando/internal/config"
	"pando/internal/worktree"
)

// A fake stream server over a real repo: the branch list says where main
// is; the socket sends what the test tells it to.
type fakeStream struct {
	t       *testing.T
	bare    string
	lists   atomic.Int32
	mu      sync.Mutex
	queries []string
	send    chan string // frames for the open socket
	hangUp  chan struct{}
}

func (f *fakeStream) head() string {
	out, _ := gitOut(f.bare, "rev-parse", "main")
	return out
}

func gitOut(dir string, args ...string) (string, error) {
	cmd := execGit(dir, args...)
	b, err := cmd.Output()
	return strings.TrimSpace(string(b)), err
}

func (f *fakeStream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasSuffix(r.URL.Path, "/branches"):
		f.lists.Add(1)
		json.NewEncoder(w).Encode(map[string]any{"default_branch": "main", "default_head": f.head(), "branches": []any{}})
	case strings.HasSuffix(r.URL.Path, "/events"):
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		f.mu.Lock()
		f.queries = append(f.queries, r.URL.RawQuery)
		f.mu.Unlock()
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		c.Write(ctx, websocket.MessageText, []byte(`{"type":"caught_up","head":5}`))
		go func() { // answer pings
			for {
				_, data, err := c.Read(ctx)
				if err != nil {
					return
				}
				if string(data) == "ping" {
					c.Write(ctx, websocket.MessageText, []byte("pong"))
				}
			}
		}()
		for {
			select {
			case fr := <-f.send:
				c.Write(ctx, websocket.MessageText, []byte(fr))
			case <-f.hangUp:
				c.Close(websocket.StatusGoingAway, "bye")
				return
			case <-ctx.Done():
				return
			}
		}
	default:
		w.WriteHeader(404)
	}
}

func TestFollowerMovesMainOnAnEvent(t *testing.T) {
	h := newHarness(t)
	t.Setenv("PANDO_TOKEN", "tok")
	bare := filepath.Join(h.base, "acme.git")
	seed := filepath.Join(h.base, "seed")
	h.git(h.base, "init", "-q", "--bare", "-b", "main", bare)
	h.git(h.base, "init", "-q", "-b", "main", seed)
	os.WriteFile(filepath.Join(seed, "a.txt"), []byte("a\n"), 0o644)
	h.git(seed, "add", "-A")
	h.git(seed, "commit", "-q", "-m", "one")
	h.git(seed, "push", "-q", bare, "main")

	fs := &fakeStream{t: t, bare: bare, send: make(chan string, 4), hangUp: make(chan struct{}, 1)}
	srv := httptest.NewServer(fs)
	defer srv.Close()

	rootDir := filepath.Join(h.base, "acme")
	root := &config.Root{Dir: rootDir, Kind: "repo", Name: "acme", Server: srv.URL,
		Repos: []config.RepoEntry{{Path: ".", Name: "acme", CloneURL: "file://" + bare}}}
	if err := root.Save(); err != nil {
		t.Fatal(err)
	}
	spec := worktree.Spec{Root: rootDir, Repo: ".", Branch: "main", Path: "worktrees/main", CloneURL: "file://" + bare, ReadOnly: true,
		Identity: worktree.Identity{Root: rootDir, Worktree: "worktrees/main", Machine: "box", Kind: "sparse"}}
	if err := (worktree.Sparse{}).Add(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	root.SaveWorktrees([]config.Worktree{{ID: "wt_1", Repo: ".", Branch: "main", Path: "worktrees/main", Kind: "sparse", ReadOnly: true}})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e, _ := NewEnv(ctx, strings.NewReader(""), io.Discard, io.Discard)
	e.Cwd = rootDir
	f := &follower{e: e, root: root}
	go f.run(ctx, time.Hour)

	mainDir := filepath.Join(rootDir, "worktrees", "main")
	waitFor := func(what string, cond func() bool) time.Duration {
		t.Helper()
		start := time.Now()
		for time.Since(start) < 15*time.Second {
			if cond() {
				return time.Since(start)
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for %s", what)
		return 0
	}
	waitFor("the first subscription", func() bool { fs.mu.Lock(); defer fs.mu.Unlock(); return len(fs.queries) == 1 })
	if q := fs.queries[0]; q != "topics=main%3Aacme" {
		t.Fatalf("first query %q: want topics=main:acme and no since", q)
	}

	// A merge lands on the server: main moves, and the stream says so.
	os.WriteFile(filepath.Join(seed, "b.txt"), []byte("b\n"), 0o644)
	h.git(seed, "add", "-A")
	h.git(seed, "commit", "-q", "-m", "merged")
	h.git(seed, "push", "-q", bare, "main")
	newHead := fs.head()
	lists := fs.lists.Load()
	fs.send <- fmt.Sprintf(`{"type":"event","seq":6,"kind":"default_head.updated","collection":"default_heads","repo":"acme","row":{"repo":"acme","default_branch":"main","default_head":%q}}`, newHead)
	took := waitFor("main to move", func() bool { got, _ := gitOut(mainDir, "rev-parse", "HEAD"); return got == newHead })
	t.Logf("main moved %s after the frame", took.Round(time.Millisecond))
	if fs.lists.Load() != lists {
		t.Fatal("an event should move main with no branch-list read")
	}
	if os.WriteFile(filepath.Join(mainDir, "x"), []byte("x"), 0o644) == nil {
		t.Fatal("main is writable after following")
	}

	// The socket drops: the follower reconnects with since=6; the server
	// answers resync, and the follower reads the branch list once.
	fs.hangUp <- struct{}{}
	waitFor("the reconnect", func() bool { fs.mu.Lock(); defer fs.mu.Unlock(); return len(fs.queries) == 2 })
	if q := fs.queries[1]; q != "since=6&topics=main%3Aacme" {
		t.Fatalf("reconnect query %q: want since=6", q)
	}
	lists = fs.lists.Load()
	fs.send <- `{"type":"resync","head":40,"oldest":30}`
	waitFor("one branch-list read on resync", func() bool { return fs.lists.Load() == lists+1 })
	fs.hangUp <- struct{}{}
	waitFor("a reconnect after the resync", func() bool { fs.mu.Lock(); defer fs.mu.Unlock(); return len(fs.queries) == 3 })
	if q := fs.queries[2]; q != "since=40&topics=main%3Aacme" {
		t.Fatalf("after resync, query %q: want since=40", q)
	}
}

func execGit(dir string, args ...string) *exec.Cmd {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	return cmd
}
