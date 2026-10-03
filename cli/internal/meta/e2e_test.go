package meta

// End-to-end tests: two (or three) machines, each an Engine on its own temp
// folder, against a real meta layer object. They need a server:
//
//	worker/test/live/run-e2e.sh            starts wrangler dev and runs them
//	PANDO_META_TEST_URL=https://pando-dev.plannotator.workers.dev go test ./internal/meta -run E2E -v
//
// Against wrangler dev each test has its own monorepo, so its own object.
// Against a deployed Worker (https) a run makes one monorepo, e2e-live-<time>
// (there is no delete), and each test works in its own folder in it; the
// credential is this machine's pando login (config.LoadHome().Token), passed
// to the engines as PANDO_TOKEN and never printed.

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

	"pando/internal/config"
)

type testEnv struct {
	server string
	mono   string
	prefix string // the test's folder in a shared monorepo; "" when it has its own
	shared bool
}

var remote struct {
	sync.Mutex
	token string
	mono  string
	err   error
}

func remoteToken(t *testing.T, server string) string {
	remote.Lock()
	defer remote.Unlock()
	if remote.token == "" && remote.err == nil {
		home, err := config.LoadHome()
		if err == nil {
			remote.token, err = home.Token(server)
		}
		remote.err = err
	}
	if remote.err != nil {
		t.Skipf("no credential for %s: %v", server, remote.err)
	}
	return remote.token
}

// createMonorepo makes a monorepo on a deployed Worker (the caller owns it).
func createMonorepo(t *testing.T, server, token, name string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"name": name, "kind": "monorepo"})
	req, _ := http.NewRequest(http.MethodPost, server+"/v1/monorepos", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating monorepo %s: %d %s", name, resp.StatusCode, out)
	}
	t.Logf("made monorepo %s on %s", name, server)
}

func newEnv(t *testing.T) *testEnv {
	u := strings.TrimRight(os.Getenv("PANDO_META_TEST_URL"), "/")
	if u == "" {
		t.Skip("set PANDO_META_TEST_URL, or run worker/test/live/run-e2e.sh")
	}
	env := &testEnv{server: u}
	deployed := strings.HasPrefix(u, "https://")
	if deployed || os.Getenv("PANDO_META_TEST_SHARED") != "" {
		token := ""
		if deployed {
			token = remoteToken(t, u)
		}
		remote.Lock()
		if remote.mono == "" {
			remote.mono = fmt.Sprintf("e2e-live-%d", time.Now().Unix())
			if deployed {
				createMonorepo(t, u, token, remote.mono)
			}
		}
		env.mono, env.shared = remote.mono, true
		env.prefix = strings.ToLower(strings.TrimPrefix(t.Name(), "TestE2E")) + "/"
		remote.Unlock()
		t.Setenv("PANDO_TOKEN", token)
	} else {
		b := make([]byte, 4)
		rand.Read(b)
		env.mono = "e2e-" + strings.ToLower(t.Name()[7:min(len(t.Name()), 27)]) + "-" + hex.EncodeToString(b)
	}
	// Never this machine's own ~/.pando (its server, its credential).
	t.Setenv("PANDO_HOME", t.TempDir())
	t.Setenv("PANDO_SERVER", "")
	return env
}

// own gives the test a monorepo of its own, also on a deployed Worker.
func (env *testEnv) own(t *testing.T, suffix string) {
	if env.shared {
		env.mono = remote.mono + "-" + suffix
		if strings.HasPrefix(env.server, "https://") {
			createMonorepo(t, env.server, os.Getenv("PANDO_TOKEN"), env.mono)
		}
		env.prefix, env.shared = "", false
	}
}

func (env *testEnv) p(rel string) string { return env.prefix + rel }

func (env *testEnv) client() *Client {
	return NewClient(Config{Server: env.server, Monorepo: env.mono, Token: os.Getenv("PANDO_TOKEN")})
}

// machine makes and starts a machine; machineAt reaches the server through url.
func (env *testEnv) machine(t *testing.T, name string) *machine {
	return env.machineAt(t, name, env.server)
}

func (env *testEnv) machineAt(t *testing.T, name, url string) *machine {
	m := env.bare(t, name)
	m.server = url
	m.writeRoot(".pando/local/root.json", fmt.Sprintf(`{"version": 1, "kind": "monorepo", "name": %q, "server": %q, "repos": []}`, env.mono, url))
	m.start()
	return m
}

// bare makes a machine's folder without starting it.
func (env *testEnv) bare(t *testing.T, name string) *machine {
	return &machine{t: t, name: name, root: t.TempDir(), server: env.server, mono: env.mono, prefix: env.prefix}
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
	hooks  Hooks
	prefix string
}

func (m *machine) config() Config {
	m.logw = &tlog{t: m.t}
	return Config{
		Root: m.root, Server: m.server, Monorepo: m.mono,
		Author: strings.ToUpper(m.name[:1]) + m.name[1:] + " <" + m.name + "@example.com>", Machine: m.name,
		Token: os.Getenv("PANDO_TOKEN"),
		Poll:  100 * time.Millisecond, Backoff: []time.Duration{200 * time.Millisecond, 500 * time.Millisecond},
		Log: log.New(m.logw, m.name+": ", log.Lmicroseconds),
	}
}

func (m *machine) start() {
	e, err := New(m.config())
	if err != nil {
		m.t.Fatal(err)
	}
	e.hooks = m.hooks
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

// path is where rel sits in the test's folder; rootPath ignores the folder.
func (m *machine) path(rel string) string { return m.rootPath(m.prefix + rel) }

func (m *machine) rootPath(rel string) string { return filepath.Join(m.root, filepath.FromSlash(rel)) }

func (m *machine) write(rel, body string) { m.writeRoot(m.prefix+rel, body) }

func (m *machine) writeRoot(rel, body string) {
	m.t.Helper()
	if err := os.MkdirAll(filepath.Dir(m.rootPath(rel)), 0o755); err != nil {
		m.t.Fatal(err)
	}
	if err := os.WriteFile(m.rootPath(rel), []byte(body), 0o644); err != nil {
		m.t.Fatal(err)
	}
}

func (m *machine) read(rel string) (string, bool) { return m.readRoot(m.prefix + rel) }

func (m *machine) readRoot(rel string) (string, bool) {
	b, err := os.ReadFile(m.rootPath(rel))
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
	return NewClient(Config{Server: server, Monorepo: mono, Token: os.Getenv("PANDO_TOKEN")})
}

// ---- tests ----

func TestE2ESaveReachesOtherMachine(t *testing.T) {
	env := newEnv(t)
	a := env.machine(t, "ana")
	b := env.machine(t, "ben")

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
	env := newEnv(t)
	a := env.machine(t, "ana")
	b := env.machine(t, "ben")

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
	h, err := env.client().History(context.Background(), env.p("archive/x2.md"), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.Versions) != 1 || h.Versions[0].Op != "rename" || h.Versions[0].From != env.p("notes/x.md") {
		t.Errorf("archive/x2.md history: %+v", h.Versions)
	}
}

func TestE2ELocalOnlyStays(t *testing.T) {
	env := newEnv(t)
	a := env.machine(t, "ana")
	b := env.machine(t, "ben")

	local := []string{
		"web/node_modules/left-pad/index.js",
		"app/.env.local",
		"logs/run.ndjson",
		"research/infra/lib/README.md", // inside a folder with its own .git
		"data/cache.sqlite",
	}
	atRoot := []string{".env", ".pando/pando.toml", ".pando/local/mine.json", "projects/web/README.md"}
	for _, p := range local {
		a.write(p, "stays\n")
	}
	for _, p := range atRoot {
		a.writeRoot(p, "stays\n")
	}
	pointer := ".pando/references/" + env.p("research/infra/lib.toml")
	a.write("research/infra/lib/.git/HEAD", "ref: refs/heads/main\n")
	a.write("big.txt", strings.Repeat("a", MaxBytes+1))
	a.write("image.dat", "\x89PNG\x00\x01")
	a.writeRoot(pointer, "url = \"https://example.com/lib.git\"\n")
	a.write("normal.md", "goes\n")

	waitContent(t, b, "normal.md", "goes\n")
	waitFor(t, "the pointer on ben", func() bool {
		got, _ := b.readRoot(pointer)
		return got == "url = \"https://example.com/lib.git\"\n"
	})
	// Large files and binaries go too, through R2 (M7).
	waitContent(t, b, "big.txt", strings.Repeat("a", MaxBytes+1))
	waitContent(t, b, "image.dat", "\x89PNG\x00\x01")
	time.Sleep(time.Second) // give anything wrong time to arrive
	for _, p := range append(local, "research/infra/lib/.git/HEAD") {
		if _, ok := b.read(p); ok {
			t.Errorf("%s reached ben", p)
		}
	}
	for _, p := range atRoot {
		if _, ok := b.readRoot(p); ok {
			t.Errorf("%s reached ben", p)
		}
	}
	if !env.shared {
		st, err := env.client().Status(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if st["files"].(float64) != 4 {
			t.Errorf("the server holds %v files, want 4", st["files"])
		}
	}
}

// The object refuses what a client must not send, even from a client that
// does not check.
func TestE2EServerRefuses(t *testing.T) {
	env := newEnv(t)
	send, next := rawSocket(t, env.server, env.mono)
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
	send(saveMsg{Type: "save", ID: "sha", Path: env.p("a.md"), SHA: gitSHA([]byte("other")), Bytes: body})
	if m := next(""); m.Reason != "bad_sha" {
		t.Errorf("a wrong sha: got %+v", m)
	}
	big := []byte(strings.Repeat("a", MaxBytes+1))
	send(saveMsg{Type: "save", ID: "big", Path: env.p("big.md"), SHA: gitSHA(big), Bytes: big})
	if m := next(""); m.Reason != "too_large" || m.Status != 413 {
		t.Errorf("a big file: got %+v", m)
	}
	send(saveMsg{Type: "save", ID: "ok", Path: env.p("a.md"), SHA: gitSHA(body), Bytes: body})
	if m := next(""); m.Type != "accepted" || (!env.shared && m.Version != 1) {
		t.Errorf("a good save: got %+v", m)
	}
	send(saveMsg{Type: "save", ID: "stale", Path: env.p("a.md"), Base: 0, SHA: gitSHA([]byte("b\n")), Bytes: []byte("b\n")})
	if m := next(""); m.Type != "stale" || m.Status != 409 || m.Current == nil || string(m.Current.Bytes) != "x = 1\n" {
		t.Errorf("a stale base: got %+v", m)
	}
}

// A machine edits while it is off; the other machine saved the same file
// first. The late one keeps its bytes in a conflict copy and freezes the file
// until pando resolve.
func TestE2EConflictCopyAndResolve(t *testing.T) {
	env := newEnv(t)
	a := env.machine(t, "ana")
	b := env.machine(t, "ben")

	a.write("plan.md", "v1\n")
	waitContent(t, b, "plan.md", "v1\n")

	b.stop()
	a.write("plan.md", "v2 from ana\n")
	waitFor(t, "ana's v2 on the server", func() bool {
		h, err := env.client().History(context.Background(), env.p("plan.md"), 10)
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
	if len(frozen) != 1 || frozen[0].Path != env.p("plan.md") {
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
	env := newEnv(t)
	a := env.machine(t, "ana")
	b := env.machine(t, "ben")

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
	env := newEnv(t)
	p := newProxy(t, env.server)
	a := env.machineAt(t, "ana", p.url())
	b := env.machine(t, "ben")

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
	env := newEnv(t)
	a := env.machine(t, "ana")
	b := env.machine(t, "ben")
	ctx := context.Background()
	c := env.client()

	for _, body := range []string{"one\n", "two\n", "three\n"} {
		a.write("h.md", body)
		waitContent(t, b, "h.md", body)
		time.Sleep(1100 * time.Millisecond) // one save per second, for --to by time
	}
	h, err := c.History(ctx, env.p("h.md"), 10)
	if err != nil {
		t.Fatal(err)
	}
	// On a deployed Worker the author is the signed-in account, not the test's.
	if len(h.Versions) != 3 || (!env.shared && h.Versions[0].Author != "Ana <ana@example.com>") || h.Versions[0].Machine != "ana" {
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

	h, _ = c.History(ctx, env.p("h.md"), 10)
	if len(h.Versions) != 5 || h.Versions[0].Source != "restore" || *h.Versions[0].RestoredFrom != h.Versions[3].Version {
		t.Errorf("history after restores: %+v", h.Versions[:2])
	}
	// Restoring what is already there changes nothing.
	r, err := c.Restore(ctx, env.p("h.md"), h.Versions[0].Version, "Ana", "ana", "")
	if err != nil || !r.Unchanged {
		t.Errorf("restore of the current version: %+v %v", r, err)
	}
}

func TestE2ECloneDownload(t *testing.T) {
	env := newEnv(t)
	a := env.machine(t, "ana")
	files := map[string]string{"AGENTS.md": "agents\n", "decisions/RULINGS.md": "rulings\n", "research/a/b/c.md": "c\n", "gone.md": "soon gone\n"}
	for p, body := range files {
		a.write(p, body)
	}
	c := env.client()
	onServer := func(p string, deleted bool) func() bool {
		return func() bool {
			h, err := c.History(context.Background(), env.p(p), 1)
			return err == nil && len(h.Versions) == 1 && h.Versions[0].Deleted == deleted
		}
	}
	for p := range files {
		waitFor(t, p+" on the server", onServer(p, false))
	}
	os.Remove(a.path("gone.md"))
	delete(files, "gone.md")
	waitFor(t, "the delete on the server", onServer("gone.md", true))

	// pando clone on a new machine: root.json, then Clone.
	carl := env.bare(t, "carl")
	carl.writeRoot(".pando/local/root.json", fmt.Sprintf(`{"version":1,"kind":"monorepo","name":%q,"server":%q,"repos":[]}`, env.mono, env.server))
	t.Setenv("PANDO_MACHINE", "carl")
	t.Setenv("PANDO_AUTHOR", "Carl <carl@example.com>")
	if err := Clone(context.Background(), carl.root, CloneOptions{}); err != nil {
		t.Fatal(err)
	}
	for p, body := range files {
		if got, ok := carl.read(p); !ok || got != body {
			t.Errorf("%s on the clone: %q", p, got)
		}
	}
	if _, ok := carl.read("gone.md"); ok {
		t.Error("a deleted file came down")
	}
}

// rawSocket is a bare client of the object, with no client-side checks.
func rawSocket(t *testing.T, server, mono string) (send func(any), next func(string) serverMsg) {
	t.Helper()
	ctx := context.Background()
	u := strings.Replace(server, "http", "ws", 1) + "/v1/monorepos/" + url.PathEscape(mono) + "/meta/socket"
	opts := &websocket.DialOptions{HTTPHeader: http.Header{}}
	if tok := os.Getenv("PANDO_TOKEN"); tok != "" {
		opts.HTTPHeader.Set("Authorization", "Bearer "+tok)
	}
	c, _, err := websocket.Dial(ctx, u, opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	c.SetReadLimit(64 << 20)
	send = func(v any) {
		b, _ := json.Marshal(v)
		if err := c.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatal(err)
		}
	}
	next = func(typ string) serverMsg {
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
	return send, next
}

// pando init's first upload carries .pando/pando.toml and the pointers; after
// it, .pando/ is protected again and a second init is refused.
func TestE2EInitFirstUpload(t *testing.T) {
	env := newEnv(t)
	env.own(t, "init") // init needs an empty meta layer
	server, mono := env.server, env.mono
	t.Setenv("PANDO_MACHINE", "ana")
	t.Setenv("PANDO_AUTHOR", "Ana <ana@example.com>")
	root := t.TempDir()
	files := map[string]string{
		".pando/local/root.json":                    fmt.Sprintf(`{"version":1,"kind":"monorepo","name":%q,"server":%q,"repos":[]}`, mono, server),
		".pando/pando.toml":                         "local_only = [\"scratch/\"]\n",
		".pando/references/research/infra/lib.toml": "url = \"https://example.com/lib.git\"\n",
		"AGENTS.md":                                 "agents\n",
		"decisions/RULINGS.md":                      "rulings\n",
		"scratch/mine.md":                           "local by pando.toml\n",
		"web/node_modules/x.js":                     "local by default\n",
	}
	for p, body := range files {
		os.MkdirAll(filepath.Dir(filepath.Join(root, p)), 0o755)
		os.WriteFile(filepath.Join(root, p), []byte(body), 0o644)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := Init(ctx, root); err != nil {
		t.Fatal(err)
	}
	st, _ := env.client().Status(ctx)
	if st["files"].(float64) != 4 {
		t.Errorf("after init the server holds %v files, want 4", st["files"])
	}

	b := env.machine(t, "ben")
	for _, p := range []string{".pando/pando.toml", ".pando/references/research/infra/lib.toml", "AGENTS.md", "decisions/RULINGS.md"} {
		waitContent(t, b, p, files[p])
	}
	for _, p := range []string{"scratch/mine.md", "web/node_modules/x.js"} {
		if _, ok := b.read(p); ok {
			t.Errorf("%s reached ben", p)
		}
	}

	// The window is closed: .pando/pando.toml is protected again.
	send, next := rawSocket(t, env.server, env.mono)
	body := []byte("local_only = []\n")
	send(saveMsg{Type: "save", ID: "p", Path: ".pando/pando.toml", Base: 3, SHA: gitSHA(body), Bytes: body})
	if m := next(""); m.Reason != "protected" {
		t.Errorf("a live save of .pando/pando.toml after init: %+v", m)
	}
	// And a second init is refused.
	err := env.client().initAction(ctx, "start")
	if apiErr, ok := err.(*APIError); !ok || apiErr.Code != "not_empty" {
		t.Errorf("a second init: %v", err)
	}
}

func TestE2EReferencesHook(t *testing.T) {
	env := newEnv(t)
	var mu sync.Mutex
	var calls [][]string
	pointer := ".pando/references/" + env.p("research/infra/lib.toml")
	ours := func() int { // calls that named our pointer (a shared monorepo has others)
		mu.Lock()
		defer mu.Unlock()
		n := 0
		for _, c := range calls {
			for _, p := range c {
				if p == pointer {
					n++
				}
			}
		}
		return n
	}
	a := env.machine(t, "ana")
	b := env.bare(t, "ben")
	b.hooks.References = func(root string, pointers []string) {
		mu.Lock()
		defer mu.Unlock()
		if root != b.root {
			t.Errorf("hook root %s", root)
		}
		calls = append(calls, pointers)
	}
	b.start()

	a.writeRoot(pointer, "commit = \"aaaa\"\n")
	waitFor(t, "the hook for the new pointer", func() bool { return ours() == 1 })
	a.write("notes.md", "not a pointer\n")
	a.writeRoot(pointer, "commit = \"bbbb\"\n")
	waitContent(t, b, "notes.md", "not a pointer\n")
	waitFor(t, "the hook for the updated pointer", func() bool { return ours() == 2 })
	os.Remove(a.rootPath(pointer))
	waitFor(t, "the hook for the removed pointer", func() bool { return ours() == 3 })
	mu.Lock()
	for _, c := range calls {
		for _, p := range c {
			if !strings.HasPrefix(p, ".pando/references/") {
				t.Errorf("the hook got %s, not a pointer", p)
			}
		}
	}
	mu.Unlock()
}

func TestE2ESyncOnce(t *testing.T) {
	env := newEnv(t)
	a := env.machine(t, "ana")
	a.write("from-ana.md", "ana\n")
	waitFor(t, "ana's save on the server", func() bool {
		h, err := env.client().History(context.Background(), env.p("from-ana.md"), 1)
		return err == nil && len(h.Versions) == 1
	})

	// An agent's sandbox: no daemon, just pando meta sync --once.
	sb := env.bare(t, "sandbox")
	sb.write("from-sandbox.md", "sandbox\n")
	e, err := New(sb.config())
	if err != nil {
		t.Fatal(err)
	}
	e.untilSynced = true
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := e.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := sb.read("from-ana.md"); got != "ana\n" {
		t.Errorf("sandbox has from-ana.md %q", got)
	}
	waitContent(t, a, "from-sandbox.md", "sandbox\n")
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

// artifactsEnv is for the local test Worker with Artifacts only: its
// /test/meta-repo route makes and reads e2e-*--meta repos.
func artifactsEnv(t *testing.T, prefix string) *testEnv {
	if os.Getenv("PANDO_META_TEST_ARTIFACTS") == "" {
		t.Skip("needs the test Worker with Artifacts: worker/test/live/run-e2e.sh --artifacts")
	}
	env := newEnv(t)
	b := make([]byte, 4)
	rand.Read(b)
	env.mono = prefix + hex.EncodeToString(b)
	return env
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
	env := artifactsEnv(t, "e2e-commit-")
	server, mono := env.server, env.mono
	metaRepo(t, server, mono, "create", nil)
	t.Cleanup(func() { metaRepo(t, server, mono, "delete", nil) })
	c := env.client()
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

	a := env.machine(t, "ana")
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
	r, err := c.Restore(ctx, env.p("a.md"), 1, "Ana <ana@example.com>", "ana", "agent-7")
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

func TestE2EInitCommits(t *testing.T) {
	env := artifactsEnv(t, "e2e-init-")
	server, mono := env.server, env.mono
	metaRepo(t, server, mono, "create", nil)
	t.Cleanup(func() { metaRepo(t, server, mono, "delete", nil) })
	t.Setenv("PANDO_MACHINE", "ana")
	t.Setenv("PANDO_AUTHOR", "Ana <ana@example.com>")
	root := t.TempDir()
	for p, body := range map[string]string{
		".pando/local/root.json": fmt.Sprintf(`{"version":1,"kind":"monorepo","name":%q,"server":%q,"repos":[]}`, mono, server),
		".pando/pando.toml":      "local_only = []\n",
		"AGENTS.md":              "agents\n",
		"decisions/RULINGS.md":   "rulings\n",
	} {
		os.MkdirAll(filepath.Dir(filepath.Join(root, p)), 0o755)
		os.WriteFile(filepath.Join(root, p), []byte(body), 0o644)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := Init(ctx, root); err != nil {
		t.Fatal(err)
	}
	var l []gitCommit
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		json.Unmarshal(metaRepo(t, server, mono, "log", nil), &l)
		if len(l) > 0 {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if len(l) != 1 || !strings.HasPrefix(l[0].Message, "Start the meta layer\n") {
		t.Fatalf("log after init: %+v", l)
	}
	t.Logf("commit %s:\n%s", l[0].Hash[:10], l[0].Message)
	var r struct{ Content *string }
	json.Unmarshal(metaRepo(t, server, mono, "read", map[string]string{"path": ".pando/pando.toml"}), &r)
	if r.Content == nil || *r.Content != "local_only = []\n" {
		t.Errorf(".pando/pando.toml in git: %v", r.Content)
	}
}

// ---- large files and binaries through R2 (M7) ----

func randomBinary(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	b[0] = 0 // binary by git's test
	return string(b)
}

func TestE2ELargeFiles(t *testing.T) {
	env := newEnv(t)
	ctx := context.Background()
	a := env.machine(t, "ana")
	b := env.machine(t, "ben")

	render := randomBinary(300 << 10)
	big := strings.Repeat("a long text line\n", 2<<20/17+1) // just over 2 MiB
	a.write("design/render.png", render)
	a.write("research/big.txt", big)
	start := time.Now()
	waitContent(t, b, "design/render.png", render)
	waitContent(t, b, "research/big.txt", big)
	t.Logf("a 300 KB binary and a 2 MiB text reached ben through R2 in %s", time.Since(start).Round(time.Millisecond))

	// git and history hold a Git LFS pointer, not the bytes.
	ptrText, err := env.client().File(ctx, env.p("design/render.png"), 0)
	if err != nil {
		t.Fatal(err)
	}
	ptr, ok := parsePointer(ptrText)
	if !ok || ptr.Size != int64(len(render)) {
		t.Fatalf("design/render.png on the server is not its pointer: %q", ptrText)
	}
	t.Logf("pointer:\n%s", ptrText)
	h, err := env.client().History(ctx, env.p("design/render.png"), 1)
	if err != nil || h.Versions[0].Large == nil || h.Versions[0].Large.Size != int64(len(render)) || h.Versions[0].Large.Oid != ptr.Oid {
		t.Errorf("history of a large file: %+v %v", h, err)
	}
	t.Logf("pando history says: %s", describe(h.Versions[0]))

	render2 := randomBinary(200 << 10)
	a.write("design/render.png", render2)
	waitContent(t, b, "design/render.png", render2)

	// A large file over 100 MB stays here (a sparse file: no disk used).
	f, _ := os.Create(a.path("video/huge.mov"))
	f.Truncate(MaxLarge + 1)
	f.Close()

	// A text-only clone keeps pointers until pando fetch.
	carl := env.bare(t, "carl")
	carl.writeRoot(".pando/local/root.json", fmt.Sprintf(`{"version":1,"kind":"monorepo","name":%q,"server":%q,"repos":[]}`, env.mono, env.server))
	t.Setenv("PANDO_MACHINE", "carl")
	t.Setenv("PANDO_AUTHOR", "Carl <carl@example.com>")
	if err := Clone(ctx, carl.root, CloneOptions{TextOnly: true}); err != nil {
		t.Fatal(err)
	}
	if got, _ := carl.read("design/render.png"); !strings.HasPrefix(got, "version https://git-lfs.github.com/spec/v1\n") {
		t.Fatalf("text-only clone has %d bytes at design/render.png, want a pointer", len(got))
	}
	var out strings.Builder
	if err := Fetch(ctx, carl.root, []string{env.p("design/render.png")}, &out); err != nil {
		t.Fatal(err)
	}
	t.Log(strings.TrimSpace(out.String()))
	if got, _ := carl.read("design/render.png"); got != render2 {
		t.Fatal("pando fetch did not bring the bytes")
	}
	carl.start()
	render3 := randomBinary(100 << 10)
	big2 := big + "one more line\n"
	a.write("design/render.png", render3)
	a.write("research/big.txt", big2)
	waitContent(t, carl, "design/render.png", render3) // fetched: follows new versions
	waitContent(t, b, "research/big.txt", big2)
	waitFor(t, "carl's big.txt to be the new pointer", func() bool {
		got, _ := carl.read("research/big.txt")
		p, ok := parsePointer([]byte(got))
		return ok && p.Size == int64(len(big2))
	})
	if _, ok := b.read("video/huge.mov"); ok {
		t.Error("a file over 100 MB left ana")
	}
}

func TestE2ELargeFileConflict(t *testing.T) {
	env := newEnv(t)
	a := env.machine(t, "ana")
	b := env.machine(t, "ben")
	v1 := randomBinary(50 << 10)
	a.write("art/logo.bin", v1)
	waitContent(t, b, "art/logo.bin", v1)

	b.stop()
	fromAna := randomBinary(60 << 10)
	a.write("art/logo.bin", fromAna)
	waitFor(t, "ana's second version on the server", func() bool {
		h, err := env.client().History(context.Background(), env.p("art/logo.bin"), 10)
		return err == nil && len(h.Versions) == 2
	})
	fromBen := randomBinary(70 << 10)
	b.write("art/logo.bin", fromBen)
	b.start()

	waitContent(t, b, "art/logo.bin", fromAna)
	waitFor(t, "a conflict copy on ben", func() bool { return len(b.conflictCopies("art/logo.bin")) == 1 })
	kept, _ := os.ReadFile(b.conflictCopies("art/logo.bin")[0])
	if string(kept) != fromBen {
		t.Error("the conflict copy does not hold ben's bytes")
	}
	if got, _ := a.read("art/logo.bin"); got != fromAna {
		t.Error("ana's file changed")
	}
}

func TestE2EPointerNeedsItsBytes(t *testing.T) {
	env := newEnv(t)
	send, next := rawSocket(t, env.server, env.mono)
	b := make([]byte, 32)
	rand.Read(b)
	ptr := Pointer{Oid: hex.EncodeToString(b), Size: 1234}.text()
	send(saveMsg{Type: "save", ID: "p", Path: env.p("x.png"), SHA: gitSHA(ptr), Bytes: ptr})
	if m := next(""); m.Type != "refused" || m.Reason != "missing_blob" {
		t.Errorf("a pointer with no bytes in R2: %+v", m)
	}
}

// On a deployed Worker: saves become commits on <monorepo>--meta after quiet.
func TestE2ECommitsOnDeployed(t *testing.T) {
	env := newEnv(t)
	if !strings.HasPrefix(env.server, "https://") {
		t.Skip("for a deployed Worker (commits on real Artifacts locally: run-e2e.sh --artifacts)")
	}
	a := env.machine(t, "ana")
	a.write("committed.md", "a commit after quiet\n")
	start := time.Now()
	deadline := start.Add(60 * time.Second)
	for time.Now().Before(deadline) {
		h, err := env.client().History(context.Background(), env.p("committed.md"), 1)
		if err == nil && len(h.Versions) == 1 && h.Versions[0].Commit != "" {
			t.Logf("committed as %s after %s", h.Versions[0].Commit[:10], time.Since(start).Round(time.Second))
			return
		}
		time.Sleep(time.Second)
	}
	st, _ := env.client().Status(context.Background())
	t.Fatalf("no commit after 60 s; status %v", st)
}
