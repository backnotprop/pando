package meta

// End-to-end tests: two (or three) machines, each an Engine on its own temp
// folder, against a real meta layer object. They need a server:
//
//	worker/test/live/run-e2e.sh            starts wrangler dev and runs them
//	PANDO_META_TEST_URL=https://pando-dev.plannotator.workers.dev go test ./internal/meta -run E2E -v
//
// Against wrangler dev each test has its own monorepo, so its own object.
// Against a deployed Worker (https) a run makes one monorepo, e2e-live-<time>,
// and each test works in its own folder in it (the init test makes
// e2e-live-<time>-init); both are deleted when the run ends. The
// credential is this machine's pando login (config.Credential), passed
// to the engines as PANDO_TOKEN and never printed.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"

	"pando/internal/config"
	srvapi "pando/internal/server"
)

type testEnv struct {
	server string
	mono   string
	prefix string // the test's folder in a shared monorepo; "" when it has its own
	shared bool
}

var remote struct {
	sync.Mutex
	server  string
	token   string
	mono    string
	err     error
	created []string // deleted when the run ends (TestMain)
}

// withAccounts: the server checks credentials and has monorepos to make and
// delete: a deployed Worker (https), or a full Worker under wrangler dev
// (PANDO_META_TEST_ACCOUNTS=1). Otherwise it is the cut-down test Worker
// (worker/test/live), which keys its object on the name alone.
func withAccounts(server string) bool {
	return strings.HasPrefix(server, "https://") || os.Getenv("PANDO_META_TEST_ACCOUNTS") != ""
}

// Test monorepos are named owner/name. On the test Worker the owner is e2e.
func nameOf(full string) string { return full[strings.LastIndexByte(full, '/')+1:] }

// rootJSON is a machine's .pando/local/root.json (version 2: owner/name).
func rootJSON(full, server string) string {
	owner, name, _ := strings.Cut(full, "/")
	return fmt.Sprintf(`{"version":2,"kind":"monorepo","owner":%q,"name":%q,"server":%q,"repos":[]}`, owner, name, server)
}

// TestMain deletes the monorepos a run made on a deployed Worker
// (DELETE /v1/monorepos/{owner}/{name}?confirm={owner}/{name}, owner only).
func TestMain(m *testing.M) {
	code := m.Run()
	remote.Lock()
	for _, name := range remote.created {
		u := remote.server + srvapi.MonorepoPath(name) + "?confirm=" + url.QueryEscape(name)
		req, _ := http.NewRequest(http.MethodDelete, u, nil)
		req.Header.Set("Authorization", "Bearer "+remote.token)
		resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
		if err != nil {
			fmt.Fprintf(os.Stderr, "deleting monorepo %s: %v\n", name, err)
			continue
		}
		resp.Body.Close()
		fmt.Fprintf(os.Stderr, "deleted monorepo %s: %d\n", name, resp.StatusCode)
	}
	remote.Unlock()
	os.Exit(code)
}

func remoteToken(t *testing.T, server string) string {
	remote.Lock()
	defer remote.Unlock()
	if remote.token == "" && remote.err == nil {
		remote.token, remote.err = config.Credential(server)
	}
	if remote.err != nil {
		t.Skipf("no credential for %s: %v", server, remote.err)
	}
	return remote.token
}

// deleteMonorepo deletes a monorepo (owner/name) on a Worker with accounts
// (owner only).
func deleteMonorepo(t *testing.T, server, token, name string) {
	t.Helper()
	u := server + srvapi.MonorepoPath(name) + "?confirm=" + url.QueryEscape(name)
	req, _ := http.NewRequest(http.MethodDelete, u, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	out, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		t.Fatalf("deleting monorepo %s: %d %s", name, resp.StatusCode, out)
	}
	t.Logf("deleted monorepo %s: %d", name, resp.StatusCode)
}

// createMonorepo makes a monorepo on a Worker with accounts (the caller owns
// it) and returns its full name, owner/name.
func createMonorepo(t *testing.T, server, token, name string) string {
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
	var made struct {
		Monorepo struct {
			FullName string `json:"full_name"`
		} `json:"monorepo"`
	}
	if json.Unmarshal(out, &made) != nil || made.Monorepo.FullName == "" {
		t.Fatalf("creating monorepo %s: no full_name in %s", name, out)
	}
	full := made.Monorepo.FullName
	remote.server = server
	if !slices.Contains(remote.created, full) {
		remote.created = append(remote.created, full)
	}
	t.Logf("made monorepo %s on %s", full, server)
	return full
}

func newEnv(t *testing.T) *testEnv {
	u := strings.TrimRight(os.Getenv("PANDO_META_TEST_URL"), "/")
	if u == "" {
		t.Skip("set PANDO_META_TEST_URL, or run worker/test/live/run-e2e.sh")
	}
	env := &testEnv{server: u}
	deployed := withAccounts(u)
	if deployed || os.Getenv("PANDO_META_TEST_SHARED") != "" {
		token := ""
		if deployed {
			token = remoteToken(t, u)
		}
		func() {
			remote.Lock()
			defer remote.Unlock() // createMonorepo may t.Fatal
			if remote.mono == "" {
				remote.mono = fmt.Sprintf("e2e/e2e-live-%d", time.Now().Unix())
				if deployed {
					remote.mono = createMonorepo(t, u, token, nameOf(remote.mono))
				}
			}
			env.mono, env.shared = remote.mono, true
			env.prefix = strings.ToLower(strings.TrimPrefix(t.Name(), "TestE2E")) + "/"
		}()
		t.Setenv("PANDO_TOKEN", token)
	} else {
		b := make([]byte, 4)
		rand.Read(b)
		env.mono = "e2e/e2e-" + strings.ToLower(t.Name()[7:min(len(t.Name()), 27)]) + "-" + hex.EncodeToString(b)
	}
	// Never this machine's own ~/.pando (its server, its credential).
	t.Setenv("PANDO_HOME", t.TempDir())
	t.Setenv("PANDO_SERVER", "")
	return env
}

// own gives the test a monorepo of its own, also on a deployed Worker.
func (env *testEnv) own(t *testing.T, suffix string) {
	if env.shared {
		remote.Lock()
		defer remote.Unlock()
		env.mono = remote.mono + "-" + suffix
		if withAccounts(env.server) {
			env.mono = createMonorepo(t, env.server, os.Getenv("PANDO_TOKEN"), nameOf(env.mono))
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
	m.writeRoot(".pando/local/root.json", rootJSON(env.mono, url))
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

func (m *machine) start() { m.startWith(m.config()) }

func (m *machine) startWith(cfg Config) {
	e, err := New(cfg)
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
	// A nested repo's .git comes first, as git clone makes it.
	a.write("research/infra/lib/.git/HEAD", "ref: refs/heads/main\n")
	for _, p := range local {
		a.write(p, "stays\n")
	}
	for _, p := range atRoot {
		a.writeRoot(p, "stays\n")
	}
	pointer := ".pando/references/" + env.p("research/infra/lib.toml")
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

// The server accepts ana's save, but the answer is lost with the socket, and
// ana edits the file again before she reconnects. The catch-up brings her own
// version back: that is the lost answer, not a conflict, and her newer edit
// goes out on top of it (CODE-VS-MODEL M3).
func TestE2EOwnSaveAfterLostAnswer(t *testing.T) {
	env := newEnv(t)
	p := newProxy(t, env.server)
	a := env.machineAt(t, "ana", p.url())
	b := env.machine(t, "ben")
	ctx := context.Background()
	a.write("warm.md", "online\n")
	waitContent(t, b, "warm.md", "online\n")

	p.drop() // from here the server's answers to ana are lost
	a.write("x.md", "first\n")
	waitContent(t, b, "x.md", "first\n") // accepted on the server
	p.cut()
	time.Sleep(300 * time.Millisecond) // ana is offline; her save is back in the outbox
	a.write("x.md", "second\n")
	time.Sleep(500 * time.Millisecond) // her watcher sees the edit
	p.restore()

	waitFor(t, "ana's second edit on ben, or a conflict copy on ana", func() bool {
		got, _ := b.read("x.md")
		return got == "second\n" || len(a.conflictCopies("x.md")) > 0
	})
	time.Sleep(500 * time.Millisecond)
	if copies := a.conflictCopies("x.md"); len(copies) != 0 {
		kept, _ := os.ReadFile(copies[0])
		t.Errorf("a conflict copy on ana, holding %q", kept)
	}
	if frozen, _ := ListFrozen(a.root); len(frozen) != 0 {
		t.Errorf("frozen on ana: %+v", frozen)
	}
	if got, _ := a.read("x.md"); got != "second\n" {
		t.Errorf("ana's x.md reads %q, want her newest edit", got)
	}
	if got, _ := b.read("x.md"); got != "second\n" {
		t.Errorf("ben's x.md reads %q, want ana's newest edit", got)
	}
	h, err := env.client().History(ctx, env.p("x.md"), 10)
	if err != nil || len(h.Versions) != 2 || h.Versions[0].Machine != "ana" || h.Versions[1].Machine != "ana" {
		t.Errorf("x.md's history: %+v %v, want two versions by ana", h, err)
	}
}

// Ben's save lands before ana's delete, and ana makes the file again before
// the answer comes back. Her delete lost, but her new bytes are not lost:
// they go to a conflict copy, as a losing save's would (CODE-VS-MODEL M4).
func TestE2ELosingDeleteKeepsNewFile(t *testing.T) {
	env := newEnv(t)
	p := newProxy(t, env.server)
	a := env.machineAt(t, "ana", p.url())
	b := env.machine(t, "ben")
	a.write("out.md", "v1\n")
	waitContent(t, b, "out.md", "v1\n")

	p.hold() // what the server sends ana waits in the proxy
	b.write("out.md", "v2 from ben\n")
	waitFor(t, "ben's save on the server", func() bool {
		h, err := env.client().History(context.Background(), env.p("out.md"), 10)
		return err == nil && len(h.Versions) == 2
	})
	os.Remove(a.path("out.md"))
	time.Sleep(time.Second) // ana sends the delete on version 1; its stale answer waits in the proxy
	a.write("out.md", "made again by ana\n")
	time.Sleep(500 * time.Millisecond) // her watcher sees the new file
	p.release()

	waitContent(t, a, "out.md", "v2 from ben\n")
	time.Sleep(500 * time.Millisecond)
	copies := a.conflictCopies("out.md")
	if len(copies) != 1 {
		t.Errorf("%d conflict copies on ana, want 1", len(copies))
	} else if kept, _ := os.ReadFile(copies[0]); string(kept) != "made again by ana\n" {
		t.Errorf("the conflict copy holds %q", kept)
	}
	if frozen, _ := ListFrozen(a.root); len(frozen) != 1 || frozen[0].Path != env.p("out.md") {
		t.Errorf("frozen on ana: %+v, want out.md", frozen)
	}
	if got, _ := b.read("out.md"); got != "v2 from ben\n" {
		t.Errorf("ben's out.md reads %q", got)
	}
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
	carl.writeRoot(".pando/local/root.json", rootJSON(env.mono, env.server))
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
	u := strings.Replace(server, "http", "ws", 1) + srvapi.MonorepoPath(mono) + "/meta/socket"
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
		".pando/local/root.json":                    rootJSON(mono, server),
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

	// An agent's sandbox: no daemon, just pando sync --once.
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

// TestE2ESyncCommand runs the pando binary itself. pando sync is the daemon:
// the live sync and the follower of read-only mains, until SIGTERM. With
// --once it sends and receives what is waiting, then exits. pando meta sync,
// its old name, still works for scripts and installed services.
func TestE2ESyncCommand(t *testing.T) {
	env := newEnv(t)
	bin := filepath.Join(t.TempDir(), "pando")
	if b, err := exec.Command("go", "build", "-o", bin, "pando/cmd/pando").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, b)
	}
	pando := func(ctx context.Context, m *machine, args ...string) *exec.Cmd {
		m.writeRoot(".pando/local/root.json", rootJSON(env.mono, env.server))
		cmd := exec.CommandContext(ctx, bin, append(args, "--root", m.root)...)
		cmd.Env = append(os.Environ(), "PANDO_MACHINE="+m.name, "PANDO_AUTHOR="+m.name+" <"+m.name+"@example.com>")
		return cmd
	}
	a := env.machine(t, "ana")

	d := env.bare(t, "dana")
	var out bytes.Buffer
	daemon := pando(context.Background(), d, "sync")
	daemon.Stdout, daemon.Stderr = &out, &out
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- daemon.Wait() }()
	t.Cleanup(func() { daemon.Process.Kill() })
	a.write("to-dana.md", "ana\n")
	waitContent(t, d, "to-dana.md", "ana\n")
	d.write("from-dana.md", "dana\n")
	waitContent(t, a, "from-dana.md", "dana\n")
	// The follower runs in the same process: it holds the folder's lock.
	lock, err := os.OpenFile(filepath.Join(config.LocalDir(d.root), "follower.lock"), os.O_RDWR, 0)
	if err != nil {
		t.Fatalf("pando sync started no follower: %v", err)
	}
	if syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil {
		t.Error("pando sync does not hold the follower lock")
	}
	lock.Close()
	daemon.Process.Signal(syscall.SIGTERM)
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("pando sync after SIGTERM: %v\n%s", err, out.String())
		}
	case <-time.After(15 * time.Second):
		daemon.Process.Kill()
		<-exited
		t.Fatalf("pando sync did not stop on SIGTERM\n%s", out.String())
	}
	if log := out.String(); !strings.HasPrefix(log, "pando sync: ") || !strings.Contains(log, " syncing ") || strings.Contains(log, "meta layer") {
		t.Errorf("pando sync's log:\n%s", out.String())
	}

	for _, args := range [][]string{{"sync", "--once"}, {"meta", "sync", "--once"}} {
		name := strings.Join(args, " ")
		sb := env.bare(t, "sandbox")
		file := "from-" + strings.ReplaceAll(strings.TrimSuffix(name, " --once"), " ", "-") + ".md"
		sb.write(file, name+"\n")
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		b, err := pando(ctx, sb, args...).CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("pando %s: %v\n%s", name, err, b)
		}
		if got, _ := sb.read("from-dana.md"); got != "dana\n" {
			t.Errorf("pando %s: from-dana.md reads %q\n%s", name, got, b)
		}
		waitContent(t, a, file, name+"\n")
	}
}

// pando sync --once exits 3, naming each path, when changes here did not
// reach Pando: a path frozen after a conflict, or a change the server
// refused. An agent that trusts exit 0 is not misled (CODE-VS-MODEL M8).
func TestE2ESyncOnceReportsWhatStayed(t *testing.T) {
	env := newEnv(t)
	bin := filepath.Join(t.TempDir(), "pando")
	if b, err := exec.Command("go", "build", "-o", bin, "pando/cmd/pando").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, b)
	}
	a := env.machine(t, "ana")
	sb := env.bare(t, "sandbox")
	sb.writeRoot(".pando/local/root.json", rootJSON(env.mono, env.server))
	once := func(what string) (int, string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, bin, "sync", "--once", "--root", sb.root)
		cmd.Env = append(os.Environ(), "PANDO_MACHINE=sandbox", "PANDO_AUTHOR=Sandbox <sandbox@example.com>")
		out, err := cmd.CombinedOutput()
		code := 0
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else if err != nil {
			t.Fatal(err)
		}
		t.Logf("pando sync --once, %s: exit %d\n%s", what, code, out)
		return code, string(out)
	}
	history := func(p string) int {
		h, err := env.client().History(context.Background(), env.p(p), 10)
		if err != nil {
			return -1
		}
		return len(h.Versions)
	}

	a.write("plan.md", "v1\n")
	waitFor(t, "ana's save on the server", func() bool { return history("plan.md") == 1 })
	if code, _ := once("first"); code != 0 {
		t.Errorf("the first sync exits %d, want 0", code)
	}

	// Ana saves while the sandbox edits the same file: the sandbox loses the race.
	a.write("plan.md", "v2 from ana\n")
	waitFor(t, "ana's second save on the server", func() bool { return history("plan.md") == 2 })
	sb.write("plan.md", "the sandbox's edit\n")
	if code, out := once("after a conflict"); code != 3 || !strings.Contains(out, env.p("plan.md")+": frozen") {
		t.Errorf("after a conflict: exit %d, want 3 naming %s as frozen", code, env.p("plan.md"))
	}
	sb.write("plan.md", "the sandbox's fix\n")
	if code, out := once("an edit of the frozen file"); code != 3 || !strings.Contains(out, "pando resolve "+env.p("plan.md")) {
		t.Errorf("an edit of a frozen file: exit %d, want 3 and how to resolve it", code)
	}

	// A change the server refuses: a reference pointer whose url carries a password.
	leaky := ".pando/references/" + env.p("leaky.toml")
	sb.writeRoot(leaky, "url = \"https://user:not-a-real-token@example.com/x.git\"\n")
	if code, out := once("a refused pointer"); code != 3 || !strings.Contains(out, leaky+": refused") || !strings.Contains(out, "(credentials)") {
		t.Errorf("a refused change: exit %d, want 3 naming %s and the reason", code, leaky)
	}

	// Resolved, and the pointer gone: everything is in Pando again.
	var out strings.Builder
	if code := cmdResolve([]string{"--root", sb.root, sb.path("plan.md")}, &out, &out); code != 0 {
		t.Fatalf("resolve: %s", out.String())
	}
	os.Remove(sb.rootPath(leaky))
	if code, _ := once("resolved"); code != 0 {
		t.Errorf("once resolved: exit %d, want 0", code)
	}
	waitContent(t, a, "plan.md", "the sandbox's fix\n")
}

// ---- a TCP proxy that can be cut ----

// The proxy can also stop the server's bytes on their way to the client:
// drop loses them (an answer lost with a socket), hold keeps them until
// release (an answer that comes late).
type proxy struct {
	t        *testing.T
	ln       net.Listener
	target   string
	mu       sync.Mutex
	down     bool
	conns    []net.Conn
	toClient string // "" passes the server's bytes, "drop" loses them, "hold" keeps them
	held     []heldBytes
}

type heldBytes struct {
	c net.Conn
	b []byte
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
			go func() { p.toClientCopy(c, up); c.Close() }()
		}
	}()
	return p
}

// toClientCopy copies the server's bytes to the client, unless they are
// dropped or held. Writes happen under the lock, so release keeps the order.
func (p *proxy) toClientCopy(c, up net.Conn) {
	buf := make([]byte, 32<<10)
	for {
		n, err := up.Read(buf)
		if n > 0 {
			p.mu.Lock()
			switch p.toClient {
			case "drop":
			case "hold":
				p.held = append(p.held, heldBytes{c, append([]byte(nil), buf[:n]...)})
			default:
				c.Write(buf[:n])
			}
			p.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (p *proxy) url() string { return "http://" + p.ln.Addr().String() }

func (p *proxy) cut() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.down = true
	for _, c := range p.conns {
		c.Close()
	}
	p.conns, p.held, p.toClient = nil, nil, ""
}

func (p *proxy) restore() {
	p.mu.Lock()
	p.down = false
	p.mu.Unlock()
}

// drop loses everything the server sends from now on, until cut.
func (p *proxy) drop() {
	p.mu.Lock()
	p.toClient = "drop"
	p.mu.Unlock()
}

// hold keeps everything the server sends from now on, until release.
func (p *proxy) hold() {
	p.mu.Lock()
	p.toClient = "hold"
	p.mu.Unlock()
}

// release sends what was held, in order, and lets the server's bytes through again.
func (p *proxy) release() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, h := range p.held {
		h.c.Write(h.b)
	}
	p.held, p.toClient = nil, ""
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
	env.mono = "e2e/" + prefix + hex.EncodeToString(b)
	return env
}

func metaRepo(t *testing.T, server, mono, action string, extra map[string]string) []byte {
	t.Helper()
	body := map[string]string{"monorepo": nameOf(mono), "action": action}
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
		".pando/local/root.json": rootJSON(mono, server),
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
	carl.writeRoot(".pando/local/root.json", rootJSON(env.mono, env.server))
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
	if !withAccounts(env.server) {
		t.Skip("for a Worker with accounts and Artifacts (commits on real Artifacts locally: run-e2e.sh --artifacts)")
	}
	a := env.machine(t, "ana")
	a.write("committed.md", "a commit after quiet\n")
	start := time.Now()
	deadline := start.Add(60 * time.Second)
	for time.Now().Before(deadline) {
		h, err := env.client().History(context.Background(), env.p("committed.md"), 1)
		if err == nil && len(h.Versions) == 1 && h.Versions[0].Commit != "" {
			commit := h.Versions[0].Commit
			t.Logf("committed as %s after %s", commit[:10], time.Since(start).Round(time.Second))
			// Read it back from git: the meta layer's repo is "meta" (<m>--meta).
			u := env.server + srvapi.MonorepoPath(env.mono) + "/repos/meta/files/" + env.p("committed.md") + "?ref=" + commit
			req, _ := http.NewRequest(http.MethodGet, u, nil)
			req.Header.Set("Authorization", "Bearer "+os.Getenv("PANDO_TOKEN"))
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != 200 || string(body) != "a commit after quiet\n" {
				t.Fatalf("%s at %s in the meta repo: %d %q", env.p("committed.md"), commit[:10], resp.StatusCode, body)
			}
			t.Logf("git has %s at %s", env.p("committed.md"), commit[:10])
			return
		}
		time.Sleep(time.Second)
	}
	st, _ := env.client().Status(context.Background())
	t.Fatalf("no commit after 60 s; status %v", st)
}

// DELETE /v1/monorepos/{owner}/{name} calls the object's destroy(): sockets close with
// 4404 and engines stop, and a monorepo made again with the same name is empty.
func TestE2EDestroy(t *testing.T) {
	env := newEnv(t)
	deployed := withAccounts(env.server)
	env.own(t, "destroy")
	a := env.machine(t, "ana")
	b := env.machine(t, "ben")
	a.write("doomed.md", "soon gone\n")
	big := randomBinary(20 << 10)
	a.write("doomed.bin", big)
	waitContent(t, b, "doomed.md", "soon gone\n")
	waitContent(t, b, "doomed.bin", big)

	if deployed {
		// The real thing: DELETE ...?confirm=<owner/name>, then make it again.
		deleteMonorepo(t, env.server, os.Getenv("PANDO_TOKEN"), env.mono)
	} else {
		body, _ := json.Marshal(map[string]string{"monorepo": nameOf(env.mono)})
		resp, err := http.Post(env.server+"/test/destroy", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		out, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || !strings.Contains(string(out), `"closed":2`) {
			t.Fatalf("destroy: %d %s", resp.StatusCode, out)
		}
		t.Logf("destroy: %s", strings.TrimSpace(string(out)))
	}
	for _, m := range []*machine{a, b} {
		select {
		case err := <-m.done:
			if !errors.Is(err, errDeleted) {
				t.Errorf("%s stopped with %v, want errDeleted", m.name, err)
			}
			m.cancel = nil
			m.logw.mu.Lock()
			m.logw.done = true
			m.logw.mu.Unlock()
		case <-time.After(10 * time.Second):
			t.Fatalf("%s's engine kept running after the monorepo was deleted", m.name)
		}
	}
	if got, _ := b.read("doomed.md"); got != "soon gone\n" {
		t.Error("a deleted monorepo removed files on a machine")
	}

	// Same name, fresh object: nothing in it, and it works.
	if deployed {
		func() {
			remote.Lock()
			defer remote.Unlock() // createMonorepo may t.Fatal
			createMonorepo(t, env.server, os.Getenv("PANDO_TOKEN"), nameOf(env.mono))
		}()
	}
	st, err := env.client().Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st["head"].(float64) != 0 || st["files"].(float64) != 0 || st["uncommitted"].(float64) != 0 {
		t.Errorf("after destroy: %v", st)
	}
	h, err := env.client().History(context.Background(), "doomed.md", 10)
	if err != nil || len(h.Versions) != 0 {
		t.Errorf("history after destroy: %+v %v", h, err)
	}
	carl := env.machine(t, "carl")
	carl.write("fresh.md", "a new start\n")
	waitFor(t, "a save into the emptied object", func() bool {
		h, err := env.client().History(context.Background(), "fresh.md", 1)
		return err == nil && len(h.Versions) == 1 && h.Versions[0].Version == 1
	})
	if _, ok := carl.read("doomed.md"); ok {
		t.Error("a new machine received a file from before the delete")
	}
}

// A reference pointer never carries a user or password in its url.
func TestE2EReferenceCredentialsRefused(t *testing.T) {
	env := newEnv(t)
	send, next := rawSocket(t, env.server, env.mono)
	cases := []struct {
		url, reason string
	}{
		{"https://user:not-a-real-token@example.com/lib.git", "credentials"},
		{"https://token@example.com/lib.git", "credentials"},
		{"https://example.com/lib.git", ""},
		{"git@github.com:org/lib.git", ""},
	}
	for i, c := range cases {
		body := []byte(fmt.Sprintf("url = %q\nref = \"refs/heads/main\"\ncommit = \"0123456789abcdef0123456789abcdef01234567\"\n", c.url))
		p := ".pando/references/" + env.p(fmt.Sprintf("ref%d.toml", i))
		send(saveMsg{Type: "save", ID: strconv.Itoa(i), Path: p, SHA: gitSHA(body), Bytes: body})
		m := next("")
		if c.reason == "" && m.Type != "accepted" {
			t.Errorf("%s: got %s %s, want accepted", c.url, m.Type, m.Reason)
		}
		if c.reason != "" && (m.Type != "refused" || m.Reason != c.reason) {
			t.Errorf("%s: got %s %s, want refused %s", c.url, m.Type, m.Reason, c.reason)
		}
	}
	// Through an engine: the pointer stays on the machine that wrote it.
	a := env.machine(t, "ana")
	b := env.machine(t, "ben")
	bad := ".pando/references/" + env.p("leaky.toml")
	a.writeRoot(bad, "url = \"https://user:not-a-real-token@example.com/x.git\"\n")
	a.write("after.md", "after\n")
	waitContent(t, b, "after.md", "after\n")
	if _, ok := b.readRoot(bad); ok {
		t.Error("a pointer with credentials reached ben")
	}
}

func getJSON(t *testing.T, env *testEnv, route string, out any) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, env.server+srvapi.MonorepoPath(env.mono)+"/meta/"+route, nil)
	if tok := os.Getenv("PANDO_TOKEN"); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	json.NewDecoder(resp.Body).Decode(out)
	return resp.StatusCode
}

type treePage struct {
	Files []struct {
		Path  string `json:"path"`
		Large *struct {
			Size int64 `json:"size"`
		} `json:"large"`
	} `json:"files"`
	Folders []struct {
		Name  string `json:"name"`
		Files int    `json:"files"`
	} `json:"folders"`
	Next *string `json:"next"`
}

func (p treePage) paths() []string {
	var out []string
	for _, f := range p.Files {
		out = append(out, f.Path)
	}
	return out
}

// GET tree: pages, prefix as a range (emoji too), dir= for one folder.
func TestE2ETree(t *testing.T) {
	env := newEnv(t)
	env.own(t, "tree") // exact listings need a monorepo of its own
	a := env.machine(t, "ana")
	files := []string{"AGENTS.md", "b.md", "docs/one.md", "docs/two.md", "docs/deep/three.md", "📁notes/a.md", "📁notes/b.md", "research/x/y/z.md"}
	for _, p := range files {
		a.write(p, "x\n")
	}
	a.write("art/render.bin", randomBinary(2048))
	waitFor(t, "every file on the server", func() bool {
		var p treePage
		getJSON(t, env, "tree", &p)
		return len(p.Files) == len(files)+1
	})

	// Every file, two at a time, through next.
	var all []string
	after := ""
	pages := 0
	for {
		var p treePage
		route := "tree?limit=2"
		if after != "" {
			route += "&after=" + url.QueryEscape(after)
		}
		if code := getJSON(t, env, route, &p); code != 200 {
			t.Fatalf("%s: %d", route, code)
		}
		pages++
		all = append(all, p.paths()...)
		if p.Next == nil {
			break
		}
		after = *p.Next
	}
	if len(all) != len(files)+1 || pages != 5 || !slices.IsSorted(all) {
		t.Errorf("paged tree: %d pages, %v", pages, all)
	}

	var p treePage
	getJSON(t, env, "tree?prefix="+url.QueryEscape("📁notes/"), &p)
	if !slices.Equal(p.paths(), []string{"📁notes/a.md", "📁notes/b.md"}) {
		t.Errorf("emoji prefix: %v", p.paths())
	}
	p = treePage{}
	getJSON(t, env, "tree?prefix=docs/", &p)
	if len(p.Files) != 3 {
		t.Errorf("prefix docs/: %v", p.paths())
	}
	p = treePage{}
	getJSON(t, env, "tree?prefix=art/", &p)
	if len(p.Files) != 1 || p.Files[0].Large == nil || p.Files[0].Large.Size != 2048 {
		t.Errorf("a large file in tree: %+v", p.Files)
	}

	// dir=: the root's files and folders, then one folder.
	p = treePage{}
	getJSON(t, env, "tree?dir=", &p)
	folders := map[string]int{}
	for _, f := range p.Folders {
		folders[f.Name] = f.Files
	}
	if !slices.Equal(p.paths(), []string{"AGENTS.md", "b.md"}) ||
		folders["docs"] != 3 || folders["📁notes"] != 2 || folders["research"] != 1 || folders["art"] != 1 || len(folders) != 4 {
		t.Errorf("dir= (root): files %v folders %v", p.paths(), folders)
	}
	p = treePage{}
	getJSON(t, env, "tree?dir=docs", &p)
	if !slices.Equal(p.paths(), []string{"docs/one.md", "docs/two.md"}) || len(p.Folders) != 1 || p.Folders[0].Name != "deep" {
		t.Errorf("dir=docs: files %v folders %+v", p.paths(), p.Folders)
	}
	var e struct {
		Error struct{ Code string } `json:"error"`
	}
	if code := getJSON(t, env, "tree?dir=docs&prefix=docs/", &e); code != 400 {
		t.Errorf("dir and prefix together: %d", code)
	}
}

// applyFromMain (a reviewed merge into the meta layer's main) reaches every
// machine; GET references shows pointer urls without a user or password.
func TestE2EApplyFromMainAndReferences(t *testing.T) {
	env := newEnv(t)
	if env.shared || withAccounts(env.server) {
		t.Skip("uses the local test Worker's /test/apply-from-main")
	}
	a := env.machine(t, "ana")
	body, _ := json.Marshal(map[string]any{
		"monorepo": nameOf(env.mono), "commit": strings.Repeat("ab", 20), // the test Worker keys on the name
		"changes": []map[string]any{
			{"path": ".pando/pando.toml", "text": "local_only = [\"scratch/\"]\n"},
			{"path": ".pando/references/research/lib.toml", "text": "url = \"https://user:not-a-real-token@example.com/lib.git\"\nref = \"refs/heads/main\"\ncommit = \"0123456789abcdef0123456789abcdef01234567\"\n"},
			{"path": ".pando/references/research/plain.toml", "text": "url = \"git@github.com:org/plain.git\"\nref = \"refs/heads/main\"\ncommit = \"0123456789abcdef0123456789abcdef01234567\"\n"},
		},
	})
	resp, err := http.Post(env.server+"/test/apply-from-main", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	waitFor(t, ".pando/pando.toml from main on ana", func() bool {
		got, _ := a.readRoot(".pando/pando.toml")
		return got == "local_only = [\"scratch/\"]\n"
	})
	h, err := env.client().History(context.Background(), ".pando/pando.toml", 1)
	if err != nil || h.Versions[0].Source != "main" || h.Versions[0].Commit != strings.Repeat("ab", 20) {
		t.Errorf("history of a change from main: %+v %v", h, err)
	}
	var refs struct {
		References []struct {
			Path, URL string
		} `json:"references"`
	}
	getJSON(t, env, "references", &refs)
	got := map[string]string{}
	for _, r := range refs.References {
		got[r.Path] = r.URL
	}
	if got["research/lib"] != "https://example.com/lib.git" || got["research/plain"] != "git@github.com:org/plain.git" {
		t.Errorf("references: %v", got)
	}
}

// Many machines, each its own person, save inside one quiet window.
// META_COMMIT_SHAPE=window: one commit, the last saver its author, the
// others Co-authored-by. Default ("author"): one commit per person.
func TestE2ECommitWindow(t *testing.T) {
	env := artifactsEnv(t, "e2e-window-")
	server, mono := env.server, env.mono
	metaRepo(t, server, mono, "create", nil)
	t.Cleanup(func() { metaRepo(t, server, mono, "delete", nil) })
	shape := os.Getenv("PANDO_META_TEST_SHAPE")
	if shape == "" {
		shape = "author"
	}
	const n = 10
	var ms []*machine
	for i := 0; i < n; i++ {
		ms = append(ms, env.machine(t, fmt.Sprintf("m%02d", i)))
	}
	time.Sleep(time.Second)
	start := time.Now()
	for i, m := range ms {
		m.write(fmt.Sprintf("notes/from-%02d.md", i), fmt.Sprintf("saved by machine %d\n", i))
	}
	c := env.client()
	deadline := time.Now().Add(3 * time.Minute)
	for {
		h, err := c.Changes(context.Background(), 0, 100)
		done := 0
		if err == nil {
			for _, v := range h.Versions {
				if v.Commit != "" {
					done++
				}
			}
		}
		if done == n {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d of %d saves committed after 3 minutes", done, n)
		}
		time.Sleep(250 * time.Millisecond)
	}
	took := time.Since(start)
	var l []gitCommit
	json.Unmarshal(metaRepo(t, server, mono, "log", nil), &l)
	t.Logf("RESULT shape=%s: %d saves by %d people, all committed %s after the saves, in %d commits", shape, n, n, took.Round(100*time.Millisecond), len(l))
	t.Logf("newest commit (author %s):\n%s", l[0].Author.Name, l[0].Message)
	switch shape {
	case "window":
		if len(l) != 1 || !strings.HasPrefix(l[0].Message, "Save 10 files") || strings.Count(l[0].Message, "Co-authored-by: ") != n-1 ||
			strings.Count(l[0].Message, "Pando-Machine: ") != n {
			t.Errorf("window: %d commits, newest %q", len(l), l[0].Message)
		}
	default:
		if len(l) != n || strings.Contains(l[0].Message, "Co-authored-by") {
			t.Errorf("author: %d commits, newest %q", len(l), l[0].Message)
		}
	}
}
