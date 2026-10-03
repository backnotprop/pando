package app

import (
	"bytes"
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
	t        *testing.T
	bare     string
	hasHeads bool         // false: /heads answers 404, as an older server
	lists    atomic.Int32 // branch-list reads
	headsN   atomic.Int32 // heads reads
	seq      atomic.Int64 // the stream's newest seq, as heads reports it
	mu       sync.Mutex
	queries  []string
	send     chan string // frames for the open socket
	hangUp   chan struct{}
	deleted  chan struct{}
	hellos   []string // hello frames received, in order
	closes   atomic.Int32
	live     atomic.Int32 // socket handlers running
	opened   atomic.Int32 // socket handlers started, ever (counted after live)
	// The next refuseLeft upgrades are answered refuseStatus, as the Worker
	// answers for a deleted monorepo (404) or a removed member (403).
	refuseStatus, refuseLeft int
}

func (f *fakeStream) refuse(status, times int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refuseStatus, f.refuseLeft = status, times
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
	case strings.HasSuffix(r.URL.Path, "/heads"):
		if !f.hasHeads {
			w.WriteHeader(404)
			return
		}
		f.headsN.Add(1)
		json.NewEncoder(w).Encode(map[string]any{"seq": f.seq.Load(), "heads": []any{
			map[string]any{"repo": "acme", "path": ".", "default_branch": "main", "head": f.head()}}})
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
		status := 0
		if f.refuseLeft > 0 {
			f.refuseLeft--
			status = f.refuseStatus
		}
		f.mu.Unlock()
		switch status {
		case 404:
			w.WriteHeader(404)
			io.WriteString(w, `{"error":{"code":"not_found","message":"no monorepo pat/acme"}}`)
			return
		case 403:
			w.WriteHeader(403)
			io.WriteString(w, `{"error":{"code":"not_a_member","message":"pat is not a member of pat/acme"}}`)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		f.live.Add(1)
		f.opened.Add(1)
		defer f.live.Add(-1)
		defer c.CloseNow()
		ctx := r.Context()
		c.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"type":"caught_up","seq":%d}`, f.seq.Load())))
		gone := make(chan struct{})
		go func() { // answer pings; notice the client leaving
			defer close(gone)
			for {
				_, data, err := c.Read(ctx)
				if err != nil {
					return
				}
				if string(data) == "ping" {
					c.Write(ctx, websocket.MessageText, []byte("pong"))
					continue
				}
				if strings.Contains(string(data), `"type":"hello"`) {
					f.mu.Lock()
					f.hellos = append(f.hellos, string(data))
					f.mu.Unlock()
					c.Write(ctx, websocket.MessageText, []byte(`{"type":"hello_ok","machines_active":1}`))
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
			case <-f.deleted:
				c.Close(4404, "monorepo deleted")
				return
			case <-gone:
				f.closes.Add(1)
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

	fs := &fakeStream{t: t, bare: bare, hasHeads: true, send: make(chan string, 4), hangUp: make(chan struct{}, 1), deleted: make(chan struct{}, 1)}
	fs.seq.Store(5)
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
	// A branch worktree here too: this machine works in the repo, so it
	// follows each merge.
	root.SaveWorktrees([]config.Worktree{
		{ID: "wt_1", Repo: ".", Branch: "main", Path: "worktrees/main", Kind: "sparse", ReadOnly: true},
		{ID: "wt_2", Repo: ".", Branch: "feat", Path: "worktrees/feat", Kind: "sparse"},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e, _ := NewEnv(ctx, strings.NewReader(""), io.Discard, io.Discard)
	e.Cwd = rootDir
	f := &follower{e: e, root: root}
	stopped := make(chan struct{})
	go func() { f.run(ctx, time.Hour); close(stopped) }()

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
	queries := func(n int) func() bool {
		return func() bool { fs.mu.Lock(); defer fs.mu.Unlock(); return len(fs.queries) == n }
	}
	query := func(i int) string { fs.mu.Lock(); defer fs.mu.Unlock(); return fs.queries[i] }

	// Heads first, then the socket from heads' seq.
	waitFor("the first subscription", queries(1))
	if fs.headsN.Load() < 1 || query(0) != "since=5&topics=main%3Aacme" {
		t.Fatalf("heads reads %d, query %q: want a read, then since=5", fs.headsN.Load(), query(0))
	}
	reads := fs.headsN.Load()

	// A merge lands on the server: main moves, and the stream says so.
	os.WriteFile(filepath.Join(seed, "b.txt"), []byte("b\n"), 0o644)
	h.git(seed, "add", "-A")
	h.git(seed, "commit", "-q", "-m", "merged")
	h.git(seed, "push", "-q", bare, "main")
	newHead := fs.head()
	fs.seq.Store(6)
	// The frame as pando-dev sends it, top-level before and head (shas) included.
	fs.send <- fmt.Sprintf(`{"type":"event","seq":6,"at":"2026-10-03T14:29:39.578Z","kind":"default_head.updated","collection":"default_heads","key":"acme","op":"upsert","repo":"acme","actor":"pat","machine":"box","agent":null,"row":{"repo":"acme","default_branch":"main","default_head":%q},"before":"0000000000000000000000000000000000000000","head":%q}`, newHead, newHead)
	took := waitFor("main to move", func() bool { got, _ := gitOut(mainDir, "rev-parse", "HEAD"); return got == newHead })
	t.Logf("main moved %s after the frame", took.Round(time.Millisecond))
	if fs.headsN.Load() != reads || fs.lists.Load() != 0 {
		t.Fatal("an event should move main with no read")
	}
	// HEAD moves inside git pull; the refresh makes main read-only again
	// just after, in the background. Under load that comes later.
	waitFor("main to be read-only again", func() bool {
		st, err := os.Stat(mainDir)
		return err == nil && st.Mode().Perm()&0o222 == 0
	})
	if os.WriteFile(filepath.Join(mainDir, "x"), []byte("x"), 0o644) == nil {
		t.Fatal("main is writable after following")
	}

	// The socket drops: heads is read again, and the socket resumes from 6.
	fs.hangUp <- struct{}{}
	waitFor("the reconnect", queries(2))
	if fs.headsN.Load() != reads+1 || query(1) != "since=6&topics=main%3Aacme" {
		t.Fatalf("heads reads %d, query %q: want one more read, then since=6", fs.headsN.Load(), query(1))
	}

	// A resync: read heads once more and resume from its seq.
	fs.seq.Store(40)
	fs.send <- `{"type":"resync","seq":40,"oldest_seq":30}`
	waitFor("the subscription after the resync", queries(3))
	if fs.headsN.Load() != reads+2 || query(2) != "since=40&topics=main%3Aacme" {
		t.Fatalf("heads reads %d, query %q: want one more read, then since=40", fs.headsN.Load(), query(2))
	}

	// The monorepo is deleted (close 4404): the follower stops. Sent once
	// only the newest socket's handler is left to take it: the third has
	// started (opened is read first; it counts after live), and the older
	// two have ended. An older one still running could take the signal.
	waitFor("the old sockets' handlers to end", func() bool { return fs.opened.Load() == 3 && fs.live.Load() == 1 })
	fs.deleted <- struct{}{}
	select {
	case <-stopped:
	case <-time.After(10 * time.Second):
		t.Fatal("the follower did not stop on 4404")
	}
}

// A server without /heads (404): the follower reads the branch list.
func TestFollowMainsFallsBackToBranches(t *testing.T) {
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
	fs := &fakeStream{t: t, bare: bare}
	srv := httptest.NewServer(fs)
	defer srv.Close()
	rootDir := filepath.Join(h.base, "acme")
	root := &config.Root{Dir: rootDir, Kind: "repo", Name: "acme", Server: srv.URL,
		Repos: []config.RepoEntry{{Path: ".", Name: "acme", CloneURL: "file://" + bare}}}
	root.Save()
	spec := worktree.Spec{Root: rootDir, Repo: ".", Branch: "main", Path: "worktrees/main", CloneURL: "file://" + bare, ReadOnly: true,
		Identity: worktree.Identity{Root: rootDir, Worktree: "worktrees/main", Machine: "box", Kind: "sparse"}}
	if err := (worktree.Sparse{}).Add(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	root.SaveWorktrees([]config.Worktree{{ID: "wt_1", Repo: ".", Branch: "main", Path: "worktrees/main", Kind: "sparse", ReadOnly: true}})
	os.WriteFile(filepath.Join(seed, "b.txt"), []byte("b\n"), 0o644)
	h.git(seed, "add", "-A")
	h.git(seed, "commit", "-q", "-m", "two")
	h.git(seed, "push", "-q", bare, "main")
	e, _ := NewEnv(context.Background(), strings.NewReader(""), io.Discard, io.Discard)
	e.Cwd = rootDir
	if seq := followMains(e, root); seq != 0 || fs.lists.Load() != 1 {
		t.Fatalf("seq %d, branch-list reads %d", seq, fs.lists.Load())
	}
	if got, _ := gitOut(filepath.Join(rootDir, "worktrees", "main"), "rev-parse", "HEAD"); got != fs.head() {
		t.Fatal("main did not move through the branch list")
	}
}

func execGit(dir string, args ...string) *exec.Cmd {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	return cmd
}

func TestCaughtUpSeqAndOldName(t *testing.T) {
	f := &follower{}
	f.handle(frame{Type: "caught_up", Seq: 12}, nil)
	if f.last != 12 {
		t.Fatalf("seq: %d", f.last)
	}
	var old frame
	json.Unmarshal([]byte(`{"type":"caught_up","head":20}`), &old) // before 08afe089
	f.handle(old, nil)
	if f.last != 20 {
		t.Fatalf("old head: %d", f.last)
	}
	var ev frame
	if err := json.Unmarshal([]byte(`{"type":"event","seq":21,"head":"3beea1b0aa","before":"0000","collection":"default_heads","row":{"repo":"x","default_head":"3beea1b0aa"}}`), &ev); err != nil || ev.Seq != 21 {
		t.Fatalf("event frame: %v %+v", err, ev)
	}
}

func (f *fakeStream) helloList() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.hellos...)
}

// newFollowRoot makes a Pando folder on a fake stream server with the given
// worktrees recorded (no real mounts: the hello reads worktrees.json).
func newFollowRoot(t *testing.T, h *harness, fs *fakeStream, srvURL string, ws []config.Worktree) *config.Root {
	t.Helper()
	root := &config.Root{Dir: filepath.Join(h.base, "acme"), Kind: "repo", Name: "acme", Server: srvURL,
		Repos: []config.RepoEntry{{Path: ".", Name: "acme", CloneURL: "file://" + fs.bare}}}
	if err := root.Save(); err != nil {
		t.Fatal(err)
	}
	if err := root.SaveWorktrees(ws); err != nil {
		t.Fatal(err)
	}
	return root
}

func startFollower(t *testing.T, root *config.Root) context.CancelFunc {
	ctx, cancel := context.WithCancel(context.Background())
	e, _ := NewEnv(ctx, strings.NewReader(""), io.Discard, io.Discard)
	e.Cwd = root.Dir
	go (&follower{e: e, root: root}).run(ctx, time.Hour)
	return cancel
}

// C25: the follower says hello with its branch worktrees, again when they
// change and after a reconnect, and lets go of the socket when none is left.
func TestFollowerHello(t *testing.T) {
	h := newHarness(t)
	t.Setenv("PANDO_TOKEN", "tok")
	t.Setenv("PANDO_MACHINE", "box-1")
	bare := filepath.Join(h.base, "acme.git")
	h.git(h.base, "init", "-q", "--bare", "-b", "main", bare)
	fs := &fakeStream{t: t, bare: bare, hasHeads: true, send: make(chan string, 4), hangUp: make(chan struct{}, 1), deleted: make(chan struct{}, 1)}
	srv := httptest.NewServer(fs)
	defer srv.Close()
	root := newFollowRoot(t, h, fs, srv.URL, []config.Worktree{
		{ID: "wt_main", Repo: ".", Branch: "main", Path: "worktrees/main", Kind: "sparse", ReadOnly: true},
		{ID: "wt_a", Repo: ".", Branch: "feat-a", Path: "worktrees/feat-a", Kind: "sparse"},
	})
	defer startFollower(t, root)()

	waitUntil(t, "the first hello", func() bool { return len(fs.helloList()) == 1 })
	var hl struct {
		Type      string   `json:"type"`
		Machine   string   `json:"machine"`
		Worktrees []string `json:"worktrees"`
	}
	json.Unmarshal([]byte(fs.helloList()[0]), &hl)
	if hl.Type != "hello" || hl.Machine != "box-1" || strings.Join(hl.Worktrees, ",") != "wt_a" {
		t.Fatalf("hello %s: want machine box-1 and only the branch worktree wt_a", fs.helloList()[0])
	}

	// A worktree added on this machine: a new hello on the same socket.
	ws, _ := root.LoadWorktrees()
	root.SaveWorktrees(append(ws, config.Worktree{ID: "wt_b", Repo: ".", Branch: "feat-b", Path: "worktrees/feat-b", Kind: "sparse"}))
	waitUntil(t, "a hello after the worktree was added", func() bool { return len(fs.helloList()) == 2 })
	json.Unmarshal([]byte(fs.helloList()[1]), &hl)
	if strings.Join(hl.Worktrees, ",") != "wt_a,wt_b" {
		t.Fatalf("second hello: %s", fs.helloList()[1])
	}
	fs.mu.Lock()
	if len(fs.queries) != 1 {
		t.Fatalf("a worktree change should not reconnect: %d sockets", len(fs.queries))
	}
	fs.mu.Unlock()

	// A reconnect: presence lives with the socket, so hello again.
	fs.hangUp <- struct{}{}
	waitUntil(t, "a hello after the reconnect", func() bool { return len(fs.helloList()) == 3 })

	// The last branch worktree removed: the socket closes, and stays closed.
	root.SaveWorktrees([]config.Worktree{{ID: "wt_main", Repo: ".", Branch: "main", Path: "worktrees/main", Kind: "sparse", ReadOnly: true}})
	waitUntil(t, "the socket to close", func() bool { return fs.closes.Load() >= 1 })
	fs.mu.Lock()
	n := len(fs.queries)
	fs.mu.Unlock()
	time.Sleep(5 * time.Second)
	fs.mu.Lock()
	defer fs.mu.Unlock()
	if len(fs.queries) != n {
		t.Fatalf("with no branch worktree the follower opened another socket")
	}
}

// A machine with only branch worktrees (no read-only main here) holds the
// socket on topics=main and says hello; one with only mains holds none.
func TestFollowerBranchOnlyAndMainsOnly(t *testing.T) {
	h := newHarness(t)
	t.Setenv("PANDO_TOKEN", "tok")
	bare := filepath.Join(h.base, "acme.git")
	h.git(h.base, "init", "-q", "--bare", "-b", "main", bare)
	fs := &fakeStream{t: t, bare: bare, hasHeads: true, send: make(chan string, 4), hangUp: make(chan struct{}, 1), deleted: make(chan struct{}, 1)}
	srv := httptest.NewServer(fs)
	defer srv.Close()

	root := newFollowRoot(t, h, fs, srv.URL, []config.Worktree{
		{ID: "wt_main", Repo: ".", Branch: "main", Path: "worktrees/main", Kind: "sparse", ReadOnly: true},
	})
	stop := startFollower(t, root)
	time.Sleep(4 * time.Second)
	fs.mu.Lock()
	if len(fs.queries) != 0 || len(fs.hellos) != 0 {
		t.Fatalf("mains only: %d sockets, %d hellos; want none", len(fs.queries), len(fs.hellos))
	}
	fs.mu.Unlock()
	stop()

	root.SaveWorktrees([]config.Worktree{{ID: "wt_x", Repo: ".", Branch: "x", Path: "worktrees/x", Kind: "sparse"}})
	defer startFollower(t, root)()
	waitUntil(t, "a hello from a branch-only machine", func() bool { return len(fs.helloList()) == 1 })
	fs.mu.Lock()
	defer fs.mu.Unlock()
	if !strings.Contains(fs.queries[0], "topics=main") || strings.Contains(fs.queries[0], "main%3A") {
		t.Fatalf("branch-only query %q: want topics=main", fs.queries[0])
	}
}

// A server that closes the socket with 4404 as soon as it opens: the
// follower stops. Its hello may be written before the close arrives or
// fail after it (then only the read side knows why); both must stop. Tried
// a number of times, as the order varies.
func TestFollowerStopsOnAnEarly4404(t *testing.T) {
	h := newHarness(t)
	t.Setenv("PANDO_TOKEN", "tok")
	bare := filepath.Join(h.base, "acme.git")
	h.git(h.base, "init", "-q", "--bare", "-b", "main", bare)
	fs := &fakeStream{t: t, bare: bare, hasHeads: true, send: make(chan string, 4), hangUp: make(chan struct{}, 1), deleted: make(chan struct{}, 1)}
	srv := httptest.NewServer(fs)
	defer srv.Close()
	root := newFollowRoot(t, h, fs, srv.URL, []config.Worktree{
		{ID: "wt_a", Repo: ".", Branch: "feat-a", Path: "worktrees/feat-a", Kind: "sparse"},
	})
	for try := 1; try <= 20; try++ {
		fs.deleted <- struct{}{} // taken by the next socket as it opens
		ctx, cancel := context.WithCancel(context.Background())
		e, _ := NewEnv(ctx, strings.NewReader(""), io.Discard, io.Discard)
		e.Cwd = root.Dir
		stopped := make(chan struct{})
		go func() { (&follower{e: e, root: root}).run(ctx, time.Hour); close(stopped) }()
		select {
		case <-stopped:
			cancel()
		case <-time.After(10 * time.Second):
			cancel()
			t.Fatalf("try %d: the follower did not stop on a 4404 sent as the socket opened", try)
		}
	}
}

// The monorepo deleted, or this user removed from it, while the follower
// was between sockets: the Worker answers the reconnect 404 not_found or
// 403 not_a_member, and the follower stops instead of backing off for good.
// One such answer alone (a replica behind a new monorepo) is retried.
func TestFollowerStopsWhenRefusedAsGone(t *testing.T) {
	prev := followBackoff
	followBackoff = []time.Duration{50 * time.Millisecond, 100 * time.Millisecond}
	defer func() { followBackoff = prev }()
	for status, says := range map[int]string{
		404: "the monorepo pat/acme was deleted on the server; stopped following",
		403: "pat is not a member of pat/acme; stopped following",
	} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			h := newHarness(t)
			t.Setenv("PANDO_TOKEN", "tok")
			bare := filepath.Join(h.base, "acme.git")
			h.git(h.base, "init", "-q", "--bare", "-b", "main", bare)
			fs := &fakeStream{t: t, bare: bare, hasHeads: true, send: make(chan string, 4), hangUp: make(chan struct{}, 1), deleted: make(chan struct{}, 1)}
			srv := httptest.NewServer(fs)
			defer srv.Close()
			root := newFollowRoot(t, h, fs, srv.URL, []config.Worktree{
				{ID: "wt_a", Repo: ".", Branch: "feat-a", Path: "worktrees/feat-a", Kind: "sparse"},
			})
			root.Owner = "pat"
			root.Save()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var stderr bytes.Buffer
			e, _ := NewEnv(ctx, strings.NewReader(""), io.Discard, &stderr)
			e.Cwd = root.Dir
			stopped := make(chan struct{})
			go func() { (&follower{e: e, root: root}).run(ctx, time.Hour); close(stopped) }()
			waitUntil(t, "the first hello", func() bool { return len(fs.helloList()) == 1 })

			// One refusal, then the socket opens again: still following.
			fs.refuse(status, 1)
			fs.hangUp <- struct{}{}
			waitUntil(t, "a hello after one refusal", func() bool { return len(fs.helloList()) == 2 })

			// Refused from now on: the follower stops at the second.
			fs.refuse(status, 1000)
			fs.hangUp <- struct{}{}
			select {
			case <-stopped:
			case <-time.After(15 * time.Second):
				t.Fatalf("the follower kept trying after HTTP %d", status)
			}
			fs.mu.Lock()
			n := len(fs.queries)
			fs.mu.Unlock()
			if n != 5 {
				t.Fatalf("%d sockets asked for, want 5 (open, refused, open, refused twice)", n)
			}
			if !strings.Contains(stderr.String(), says) {
				t.Fatalf("stderr does not say %q:\n%s", says, stderr.String())
			}
		})
	}
}
