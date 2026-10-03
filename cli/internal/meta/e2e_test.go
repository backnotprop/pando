package meta

// End-to-end tests: two (or three) machines, each an Engine on its own temp
// folder, against a real meta layer object. They need a server:
//
//	worker/test/live/run-e2e.sh            starts wrangler dev and runs them
//	PANDO_META_TEST_URL=https://pando-dev... go test ./internal/meta -run E2E -v
//
// Each test uses its own monorepo name, so its own object.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func testServer(t *testing.T) string {
	u := os.Getenv("PANDO_META_TEST_URL")
	if u == "" {
		t.Skip("set PANDO_META_TEST_URL, or run worker/test/live/run-e2e.sh")
	}
	return strings.TrimRight(u, "/")
}

func newMonorepo(t *testing.T) string {
	b := make([]byte, 4)
	rand.Read(b)
	return "e2e-" + strings.ToLower(t.Name()[7:min(len(t.Name()), 27)]) + "-" + hex.EncodeToString(b)
}

type tlog struct {
	t    *testing.T
	mu   sync.Mutex
	done bool
}

func (w *tlog) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.done {
		w.t.Log(strings.TrimRight(string(p), "\n"))
	}
	return len(p), nil
}

type machine struct {
	t      *testing.T
	name   string
	root   string
	server string
	mono   string
	cancel context.CancelFunc
	done   chan error
	logw   *tlog
}

// newMachine makes a folder that is a Pando monorepo root (root.json) and
// starts its engine.
func newMachine(t *testing.T, name, server, mono string) *machine {
	m := &machine{t: t, name: name, root: t.TempDir(), server: server, mono: mono}
	rj := fmt.Sprintf(`{"version": 1, "kind": "monorepo", "name": %q, "server": %q, "repos": []}`, mono, server)
	m.write(".pando/local/root.json", rj)
	m.start()
	return m
}

func (m *machine) config() Config {
	m.logw = &tlog{t: m.t}
	return Config{
		Root: m.root, Server: m.server, Monorepo: m.mono,
		Author: strings.ToUpper(m.name[:1]) + m.name[1:] + " <" + m.name + "@example.com>", Machine: m.name,
		Poll: 100 * time.Millisecond, Backoff: []time.Duration{200 * time.Millisecond, 500 * time.Millisecond},
		Log: log.New(m.logw, m.name+": ", log.Lmicroseconds),
	}
}

func (m *machine) start() {
	e, err := New(m.config())
	if err != nil {
		m.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel, m.done = cancel, make(chan error, 1)
	go func() { m.done <- e.Run(ctx) }()
	m.t.Cleanup(m.stop)
}

func (m *machine) stop() {
	if m.cancel == nil {
		return
	}
	m.cancel()
	if err := <-m.done; err != nil {
		m.t.Errorf("%s: %v", m.name, err)
	}
	m.cancel = nil
	m.logw.mu.Lock()
	m.logw.done = true
	m.logw.mu.Unlock()
}

func (m *machine) path(rel string) string { return filepath.Join(m.root, filepath.FromSlash(rel)) }

func (m *machine) write(rel, body string) {
	m.t.Helper()
	if err := os.MkdirAll(filepath.Dir(m.path(rel)), 0o755); err != nil {
		m.t.Fatal(err)
	}
	if err := os.WriteFile(m.path(rel), []byte(body), 0o644); err != nil {
		m.t.Fatal(err)
	}
}

func (m *machine) read(rel string) (string, bool) {
	b, err := os.ReadFile(m.path(rel))
	return string(b), err == nil
}

func (m *machine) conflictCopies(rel string) []string {
	dir, base := filepath.Split(m.path(rel))
	ext := filepath.Ext(base)
	matches, _ := filepath.Glob(filepath.Join(dir, strings.TrimSuffix(base, ext)+".conflict-local-*"+ext))
	return matches
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func waitContent(t *testing.T, m *machine, rel, want string) time.Duration {
	t.Helper()
	start := time.Now()
	waitFor(t, fmt.Sprintf("%s on %s to read %q", rel, m.name, want), func() bool {
		got, ok := m.read(rel)
		return ok && got == want
	})
	return time.Since(start)
}

func waitGone(t *testing.T, m *machine, rel string) {
	t.Helper()
	waitFor(t, fmt.Sprintf("%s to be gone on %s", rel, m.name), func() bool {
		_, ok := m.read(rel)
		return !ok
	})
}

func client(server, mono string) *Client {
	return NewClient(Config{Server: server, Monorepo: mono})
}

// ---- tests ----

func TestE2ESaveReachesOtherMachine(t *testing.T) {
	server := testServer(t)
	mono := newMonorepo(t)
	a := newMachine(t, "ana", server, mono)
	b := newMachine(t, "ben", server, mono)

	a.write("decisions/HISTORY.md", "# History\n\nWe chose plain files.\n")
	d := waitContent(t, b, "decisions/HISTORY.md", "# History\n\nWe chose plain files.\n")
	t.Logf("a save on ana appeared on ben after %s", d.Round(time.Millisecond))

	b.write("decisions/HISTORY.md", "# History\n\nWe chose plain files.\nBen agrees.\n")
	d = waitContent(t, a, "decisions/HISTORY.md", "# History\n\nWe chose plain files.\nBen agrees.\n")
	t.Logf("ben's edit appeared on ana after %s", d.Round(time.Millisecond))

	a.write("research/notes/deep/a.md", "deep\n")
	waitContent(t, b, "research/notes/deep/a.md", "deep\n")
}

func TestE2EDeleteAndRename(t *testing.T) {
	server := testServer(t)
	mono := newMonorepo(t)
	a := newMachine(t, "ana", server, mono)
	b := newMachine(t, "ben", server, mono)

	a.write("notes/x.md", "x\n")
	a.write("notes/y.md", "y\n")
	waitContent(t, b, "notes/x.md", "x\n")
	waitContent(t, b, "notes/y.md", "y\n")

	os.Remove(a.path("notes/y.md"))
	waitGone(t, b, "notes/y.md")

	os.MkdirAll(a.path("archive"), 0o755)
	if err := os.Rename(a.path("notes/x.md"), a.path("archive/x2.md")); err != nil {
		t.Fatal(err)
	}
	waitContent(t, b, "archive/x2.md", "x\n")
	waitGone(t, b, "notes/x.md")
	if _, err := os.Stat(b.path("notes")); err == nil {
		t.Error("the emptied folder notes/ is still on ben")
	}
	h, err := client(server, mono).History(context.Background(), "archive/x2.md", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.Versions) != 1 || h.Versions[0].Op != "rename" || h.Versions[0].From != "notes/x.md" {
		t.Errorf("archive/x2.md history: %+v", h.Versions)
	}
}

func TestE2ELocalOnlyStays(t *testing.T) {
	server := testServer(t)
	mono := newMonorepo(t)
	a := newMachine(t, "ana", server, mono)
	b := newMachine(t, "ben", server, mono)

	local := []string{
		"web/node_modules/left-pad/index.js",
		".env",
		"app/.env.local",
		"logs/run.ndjson",
		".pando/pando.toml",
		".pando/local/mine.json",
		"research/infra/lib/README.md", // inside a folder with its own .git
		"projects/web/README.md",
	}
	for _, p := range local {
		a.write(p, "stays\n")
	}
	a.write("research/infra/lib/.git/HEAD", "ref: refs/heads/main\n")
	a.write("big.txt", strings.Repeat("a", MaxBytes+1))
	a.write("image.dat", "\x89PNG\x00\x01")
	a.write(".pando/references/research/infra/lib.toml", "url = \"https://example.com/lib.git\"\n")
	a.write("normal.md", "goes\n")

	waitContent(t, b, "normal.md", "goes\n")
	waitContent(t, b, ".pando/references/research/infra/lib.toml", "url = \"https://example.com/lib.git\"\n")
	time.Sleep(time.Second) // give anything wrong time to arrive
	for _, p := range append(local, "big.txt", "image.dat", "research/infra/lib/.git/HEAD") {
		if _, ok := b.read(p); ok {
			t.Errorf("%s reached ben", p)
		}
	}
	st, err := client(server, mono).Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st["files"].(float64) != 2 {
		t.Errorf("the server holds %v files, want 2", st["files"])
	}
}

// The object refuses what a client must not send, even from a client that
// does not check.
func TestE2EServerRefuses(t *testing.T) {
	server := testServer(t)
	mono := newMonorepo(t)
	ctx := context.Background()
	u := strings.Replace(server, "http", "ws", 1) + "/v1/monorepos/" + url.PathEscape(mono) + "/meta/socket"
	c, _, err := websocket.Dial(ctx, u, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	c.SetReadLimit(64 << 20)
	send := func(v any) {
		b, _ := json.Marshal(v)
		if err := c.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatal(err)
		}
	}
	next := func(typ string) serverMsg {
		for {
			_, b, err := c.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var m serverMsg
			json.Unmarshal(b, &m)
			if m.Type == typ || typ == "" {
				return m
			}
		}
	}
	send(helloMsg{Type: "hello", Author: "Raw <raw@example.com>", Machine: "raw"})
	next("caught_up")
	body := []byte("x = 1\n")
	for i, c := range []struct{ path, reason string }{
		{".pando/pando.toml", "protected"},
		{".pando/local/root.json", "local_only"},
		{"projects/web/a.md", "not_meta"},
		{"node_modules/a.js", "local_only"},
		{".env", "local_only"},
		{"../escape.md", "bad_path"},
	} {
		id := strconv.Itoa(i)
		send(saveMsg{Type: "save", ID: id, Path: c.path, SHA: gitSHA(body), Bytes: body})
		m := next("")
		if m.Type != "refused" || m.ID != id || m.Reason != c.reason {
			t.Errorf("save of %s: got %s %s, want refused %s", c.path, m.Type, m.Reason, c.reason)
		}
	}
	send(saveMsg{Type: "save", ID: "sha", Path: "a.md", SHA: gitSHA([]byte("other")), Bytes: body})
	if m := next(""); m.Reason != "bad_sha" {
		t.Errorf("a wrong sha: got %+v", m)
	}
	big := []byte(strings.Repeat("a", MaxBytes+1))
	send(saveMsg{Type: "save", ID: "big", Path: "big.md", SHA: gitSHA(big), Bytes: big})
	if m := next(""); m.Reason != "too_large" || m.Status != 413 {
		t.Errorf("a big file: got %+v", m)
	}
	send(saveMsg{Type: "save", ID: "ok", Path: "a.md", SHA: gitSHA(body), Bytes: body})
	if m := next(""); m.Type != "accepted" || m.Version != 1 {
		t.Errorf("a good save: got %+v", m)
	}
	send(saveMsg{Type: "save", ID: "stale", Path: "a.md", Base: 0, SHA: gitSHA([]byte("b\n")), Bytes: []byte("b\n")})
	if m := next(""); m.Type != "stale" || m.Status != 409 || m.Current == nil || string(m.Current.Bytes) != "x = 1\n" {
		t.Errorf("a stale base: got %+v", m)
	}
}

// A machine edits while it is off; the other machine saved the same file
// first. The late one keeps its bytes in a conflict copy and freezes the file
// until pando resolve.
func TestE2EConflictCopyAndResolve(t *testing.T) {
	server := testServer(t)
	mono := newMonorepo(t)
	a := newMachine(t, "ana", server, mono)
	b := newMachine(t, "ben", server, mono)

	a.write("plan.md", "v1\n")
	waitContent(t, b, "plan.md", "v1\n")

	b.stop()
	a.write("plan.md", "v2 from ana\n")
	waitFor(t, "ana's v2 on the server", func() bool {
		h, err := client(server, mono).History(context.Background(), "plan.md", 10)
		return err == nil && len(h.Versions) == 2
	})
	b.write("plan.md", "v2 from ben, written offline\n")
	b.start()

	waitContent(t, b, "plan.md", "v2 from ana\n")
	waitFor(t, "a conflict copy on ben", func() bool { return len(b.conflictCopies("plan.md")) == 1 })
	copyPath := b.conflictCopies("plan.md")[0]
	got, _ := os.ReadFile(copyPath)
	if string(got) != "v2 from ben, written offline\n" {
		t.Errorf("conflict copy holds %q", got)
	}
	t.Logf("conflict copy: %s", filepath.Base(copyPath))
	if got, _ := a.read("plan.md"); got != "v2 from ana\n" {
		t.Errorf("ana's file changed to %q", got)
	}
	frozen, _ := ListFrozen(b.root)
	if len(frozen) != 1 || frozen[0].Path != "plan.md" {
		t.Fatalf("frozen: %+v", frozen)
	}

	// Frozen: ben's edits do not go out.
	b.write("plan.md", "v3 merged by ben\n")
	time.Sleep(700 * time.Millisecond)
	if got, _ := a.read("plan.md"); got != "v2 from ana\n" {
		t.Errorf("a frozen file was sent: ana has %q", got)
	}

	// pando resolve plan.md
	var out strings.Builder
	if code := cmdResolve([]string{"--root", b.root, b.path("plan.md")}, &out, &out); code != 0 {
		t.Fatalf("resolve: %s", out.String())
	}
	t.Log(strings.TrimSpace(out.String()))
	waitContent(t, a, "plan.md", "v3 merged by ben\n")
	if len(a.conflictCopies("plan.md")) != 0 {
		t.Error("the conflict copy reached ana")
	}
}

// Both machines save the same file at the same moment. Exactly one loses,
// keeps its bytes in a conflict copy, and both end with the winner's bytes.
func TestE2ELiveRace(t *testing.T) {
	server := testServer(t)
	mono := newMonorepo(t)
	a := newMachine(t, "ana", server, mono)
	b := newMachine(t, "ben", server, mono)

	a.write("race.md", "start\n")
	waitContent(t, b, "race.md", "start\n")

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); a.write("race.md", "ana wins?\n") }()
	go func() { defer wg.Done(); b.write("race.md", "ben wins?\n") }()
	wg.Wait()

	waitFor(t, "one conflict copy and the same file on both", func() bool {
		ga, _ := a.read("race.md")
		gb, _ := b.read("race.md")
		return ga == gb && len(a.conflictCopies("race.md"))+len(b.conflictCopies("race.md")) == 1
	})
	winner, _ := a.read("race.md")
	loser, copies := a, a.conflictCopies("race.md")
	if len(copies) == 0 {
		loser, copies = b, b.conflictCopies("race.md")
	}
	kept, _ := os.ReadFile(copies[0])
	t.Logf("%s won with %q; %s kept %q in %s", map[bool]string{true: "ana", false: "ben"}[loser == b], winner, loser.name, kept, filepath.Base(copies[0]))
	if string(kept) == winner || (string(kept) != "ana wins?\n" && string(kept) != "ben wins?\n") {
		t.Errorf("conflict copy holds %q, winner %q", kept, winner)
	}
}

// A real network cut: ana's connection goes through a proxy that is cut.
// Her saves wait in the outbox and go out when the network returns.
func TestE2EOfflineSavesGoOutOnReconnect(t *testing.T) {
	server := testServer(t)
	mono := newMonorepo(t)
	p := newProxy(t, server)
	a := newMachine(t, "ana", p.url(), mono)
	b := newMachine(t, "ben", server, mono)

	a.write("base.md", "online\n")
	waitContent(t, b, "base.md", "online\n")

	p.cut()
	time.Sleep(300 * time.Millisecond)
	a.write("base.md", "edited offline\n")
	a.write("offline/new.md", "made offline\n")
	b.write("from-ben.md", "ben, while ana is offline\n")
	time.Sleep(time.Second)
	if _, ok := b.read("offline/new.md"); ok {
		t.Fatal("ana's offline save arrived while the network was cut")
	}
	if _, ok := a.read("from-ben.md"); ok {
		t.Fatal("ben's save reached ana while the network was cut")
	}

	p.restore()
	d := waitContent(t, b, "offline/new.md", "made offline\n")
	waitContent(t, b, "base.md", "edited offline\n")
	waitContent(t, a, "from-ben.md", "ben, while ana is offline\n")
	t.Logf("after the network returned, ana's saves reached ben in %s", d.Round(time.Millisecond))
}

func TestE2EHistoryAndRestore(t *testing.T) {
	server := testServer(t)
	mono := newMonorepo(t)
	a := newMachine(t, "ana", server, mono)
	b := newMachine(t, "ben", server, mono)
	ctx := context.Background()
	c := client(server, mono)

	for _, body := range []string{"one\n", "two\n", "three\n"} {
		a.write("h.md", body)
		waitContent(t, b, "h.md", body)
		time.Sleep(1100 * time.Millisecond) // one save per second, for --to by time
	}
	h, err := c.History(ctx, "h.md", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.Versions) != 3 || h.Versions[0].Author != "Ana <ana@example.com>" || h.Versions[0].Machine != "ana" {
		t.Fatalf("history: %+v", h.Versions)
	}
	var out strings.Builder
	cmdHistory([]string{"--root", a.root, a.path("h.md")}, &out, &out)
	t.Logf("pando history h.md:\n%s", out.String())

	// pando restore h.md --to <version of "one">
	t.Setenv("PANDO_MACHINE", "ana")
	t.Setenv("PANDO_AUTHOR", "Ana <ana@example.com>")
	one := h.Versions[2].Version
	out.Reset()
	if code := cmdRestore([]string{"--root", a.root, a.path("h.md"), "--to", strconv.FormatInt(one, 10)}, &out, &out); code != 0 {
		t.Fatalf("restore: %s", out.String())
	}
	t.Log(strings.TrimSpace(out.String()))
	waitContent(t, a, "h.md", "one\n")
	waitContent(t, b, "h.md", "one\n")

	// By time: the second "two" was saved in.
	two := h.Versions[1].Time().Local().Format("2006-01-02 15:04:05")
	out.Reset()
	if code := cmdRestore([]string{"--root", a.root, a.path("h.md"), "--to", two}, &out, &out); code != 0 {
		t.Fatalf("restore --to %s: %s", two, out.String())
	}
	waitContent(t, b, "h.md", "two\n")
	waitContent(t, a, "h.md", "two\n")

	h, _ = c.History(ctx, "h.md", 10)
	if len(h.Versions) != 5 || h.Versions[0].Source != "restore" || *h.Versions[0].RestoredFrom != h.Versions[3].Version {
		t.Errorf("history after restores: %+v", h.Versions[:2])
	}
	// Restoring what is already there changes nothing.
	r, err := c.Restore(ctx, "h.md", h.Versions[0].Version, "Ana", "ana", "")
	if err != nil || !r.Unchanged {
		t.Errorf("restore of the current version: %+v %v", r, err)
	}
}

func TestE2ECloneDownload(t *testing.T) {
	server := testServer(t)
	mono := newMonorepo(t)
	a := newMachine(t, "ana", server, mono)
	files := map[string]string{"AGENTS.md": "agents\n", "decisions/RULINGS.md": "rulings\n", "research/a/b/c.md": "c\n", "gone.md": "soon gone\n"}
	for p, body := range files {
		a.write(p, body)
	}
	c := client(server, mono)
	waitFor(t, "four files on the server", func() bool {
		s, err := c.Status(context.Background())
		return err == nil && s["files"].(float64) == 4
	})
	os.Remove(a.path("gone.md"))
	delete(files, "gone.md")
	waitFor(t, "the delete on the server", func() bool {
		s, err := c.Status(context.Background())
		return err == nil && s["files"].(float64) == 3
	})

	// pando clone on a new machine: root.json, then Download.
	carl := t.TempDir()
	os.MkdirAll(filepath.Join(carl, ".pando", "local"), 0o755)
	os.WriteFile(filepath.Join(carl, ".pando", "local", "root.json"),
		[]byte(fmt.Sprintf(`{"version":1,"kind":"monorepo","name":%q,"server":%q,"repos":[]}`, mono, server)), 0o644)
	t.Setenv("PANDO_MACHINE", "carl")
	t.Setenv("PANDO_AUTHOR", "Carl <carl@example.com>")
	if err := Download(context.Background(), carl); err != nil {
		t.Fatal(err)
	}
	for p, body := range files {
		got, err := os.ReadFile(filepath.Join(carl, filepath.FromSlash(p)))
		if err != nil || string(got) != body {
			t.Errorf("%s on the clone: %q %v", p, got, err)
		}
	}
	if _, err := os.Stat(filepath.Join(carl, "gone.md")); err == nil {
		t.Error("a deleted file came down")
	}
}

// ---- a TCP proxy that can be cut ----

type proxy struct {
	t      *testing.T
	ln     net.Listener
	target string
	mu     sync.Mutex
	down   bool
	conns  []net.Conn
}

func newProxy(t *testing.T, server string) *proxy {
	u, err := url.Parse(server)
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme != "http" {
		t.Skip("the proxy test needs a plain http server (wrangler dev)")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &proxy{t: t, ln: ln, target: u.Host}
	t.Cleanup(func() { ln.Close(); p.cut() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			p.mu.Lock()
			down := p.down
			p.mu.Unlock()
			if down {
				c.Close()
				continue
			}
			up, err := net.Dial("tcp", p.target)
			if err != nil {
				c.Close()
				continue
			}
			p.mu.Lock()
			p.conns = append(p.conns, c, up)
			p.mu.Unlock()
			go func() { io.Copy(up, c); up.Close() }()
			go func() { io.Copy(c, up); c.Close() }()
		}
	}()
	return p
}

func (p *proxy) url() string { return "http://" + p.ln.Addr().String() }

func (p *proxy) cut() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.down = true
	for _, c := range p.conns {
		c.Close()
	}
	p.conns = nil
}

func (p *proxy) restore() {
	p.mu.Lock()
	p.down = false
	p.mu.Unlock()
}

// ---- commits after quiet, on real Artifacts (run-e2e.sh --artifacts) ----

func artifactsServer(t *testing.T) string {
	server := testServer(t)
	if os.Getenv("PANDO_META_TEST_ARTIFACTS") == "" {
		t.Skip("needs the test Worker with Artifacts: worker/test/live/run-e2e.sh --artifacts")
	}
	return server
}

func metaRepo(t *testing.T, server, mono, action string, extra map[string]string) []byte {
	t.Helper()
	body := map[string]string{"monorepo": mono, "action": action}
	for k, v := range extra {
		body[k] = v
	}
	b, _ := json.Marshal(body)
	resp, err := http.Post(server+"/test/meta-repo", "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("%s: %d %s", action, resp.StatusCode, out)
	}
	return out
}

type gitCommit struct {
	Hash    string `json:"hash"`
	Message string `json:"message"`
	Author  struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"author"`
}

func TestE2ECommitsAfterQuiet(t *testing.T) {
	server := artifactsServer(t)
	b := make([]byte, 4)
	rand.Read(b)
	mono := "e2e-commit-" + hex.EncodeToString(b)
	metaRepo(t, server, mono, "create", nil)
	t.Cleanup(func() { metaRepo(t, server, mono, "delete", nil) })
	c := client(server, mono)
	ctx := context.Background()

	logOf := func() []gitCommit {
		var l []gitCommit
		json.Unmarshal(metaRepo(t, server, mono, "log", nil), &l)
		return l
	}
	readGit := func(p string) string {
		var r struct{ Content *string }
		json.Unmarshal(metaRepo(t, server, mono, "read", map[string]string{"path": p}), &r)
		if r.Content == nil {
			return "<missing>"
		}
		return *r.Content
	}
	committed := func(p string, n int) func() bool {
		return func() bool {
			h, err := c.History(ctx, p, 1)
			return err == nil && len(h.Versions) == 1 && h.Versions[0].Commit != "" && len(logOf()) == n
		}
	}
	waitLong := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(45 * time.Second)
		for time.Now().Before(deadline) {
			if cond() {
				return
			}
			time.Sleep(500 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for %s", what)
	}

	a := newMachine(t, "ana", server, mono)
	a.write("a.md", "a1\n")
	a.write("notes/b.md", "b1\n")
	start := time.Now()
	waitLong("the first commit", committed("notes/b.md", 1))
	t.Logf("two saves became one commit after %s", time.Since(start).Round(time.Second))
	l := logOf()
	if !strings.HasPrefix(l[0].Message, "Save 2 files\n") || !strings.Contains(l[0].Message, "Pando-Machine: ana") ||
		l[0].Author.Name != "Ana" || l[0].Author.Email != "ana@example.com" {
		t.Errorf("first commit: %+v", l[0])
	}
	t.Logf("commit %s:\n%s", l[0].Hash[:10], l[0].Message)
	if got := readGit("notes/b.md"); got != "b1\n" {
		t.Errorf("notes/b.md in git: %q", got)
	}

	// main moves under the object (a reviewed merge); the next commit must
	// land on top of it, not overwrite it.
	metaRepo(t, server, mono, "move-main", map[string]string{"path": "elsewhere.md", "content": "moved\n"})
	a.write("a.md", "a2\n")
	waitLong("the commit after main moved", committed("a.md", 3))
	l = logOf()
	if !strings.HasPrefix(l[0].Message, "Save a.md\n") || !strings.Contains(l[0].Message, "Pando-Version: 3") {
		t.Errorf("second save commit: %q", l[0].Message)
	}
	if readGit("a.md") != "a2\n" || readGit("elsewhere.md") != "moved\n" {
		t.Errorf("git has a.md %q, elsewhere.md %q", readGit("a.md"), readGit("elsewhere.md"))
	}

	// A restore is a commit too.
	r, err := c.Restore(ctx, "a.md", 1, "Ana <ana@example.com>", "ana", "agent-7")
	if err != nil {
		t.Fatal(err)
	}
	waitContent(t, a, "a.md", "a1\n")
	waitLong("the restore commit", committed("a.md", 4))
	l = logOf()
	if !strings.HasPrefix(l[0].Message, fmt.Sprintf("Restore a.md to version %d\n", r.RestoredFrom)) || !strings.Contains(l[0].Message, "Pando-Agent: agent-7") {
		t.Errorf("restore commit: %q", l[0].Message)
	}
	if readGit("a.md") != "a1\n" {
		t.Errorf("a.md in git after restore: %q", readGit("a.md"))
	}
	st, _ := c.Status(ctx)
	if st["uncommitted"].(float64) != 0 || st["commit_error"] != nil {
		t.Errorf("status: %v", st)
	}
}
