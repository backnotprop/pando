package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pando/internal/config"
)

// pando ci against a stand-in server. Against wrangler dev it is covered by
// worker/test/ci.mjs.

const ciToken = "0123456789abcdef0123456789abcdef0123456789abcdef"

type ciFake struct {
	srv       *httptest.Server
	posts     []map[string]string
	deletes   []string
	conflict  bool
	member    bool // not an owner: hook writes answer 403 owner_only
	hooks     map[string][]map[string]any
	hookPosts []map[string]any
	noConn    bool
}

func newCIFake(t *testing.T) *ciFake {
	f := &ciFake{hooks: map[string][]map[string]any{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer pando_test" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		conn := map[string]any{
			"id": "m_1--cic_aaaaaaaaaaaa", "service": "buildkite", "organization": "acme", "web_url": "https://buildkite.com/acme",
			"webhook_url": "https://pando.example/v1/integrations/buildkite/m_1--cic_aaaaaaaaaaaa", "token": "worker_secret",
			"created_at": "2026-10-03T12:00:00Z", "created_by": "ramos",
		}
		hookRe := strings.TrimPrefix(r.URL.Path, "/v1/monorepos/ramos/pando/repos/")
		repo, rest, _ := strings.Cut(hookRe, "/")
		switch {
		case r.Method == "GET" && r.URL.Path == "/v1/monorepos/ramos/pando/repos":
			_ = json.NewEncoder(w).Encode(map[string]any{"repos": []any{
				map[string]any{"name": "projects-web", "path": "projects/web"}, map[string]any{"name": "projects-api", "path": "projects/api"},
			}})
		case strings.HasPrefix(r.URL.Path, "/v1/monorepos/ramos/pando/repos/") && rest == "hooks" && r.Method == "GET":
			_ = json.NewEncoder(w).Encode(map[string]any{"hooks": append([]map[string]any{}, f.hooks[repo]...)})
		case strings.HasPrefix(r.URL.Path, "/v1/monorepos/ramos/pando/repos/") && (rest == "hooks" || strings.HasPrefix(rest, "hooks/")) && f.member:
			w.WriteHeader(403)
			_, _ = io.WriteString(w, `{"error":{"code":"owner_only","message":"only an owner can register hooks"}}`)
		case strings.HasPrefix(r.URL.Path, "/v1/monorepos/ramos/pando/repos/") && rest == "hooks" && r.Method == "POST":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			f.hookPosts = append(f.hookPosts, b)
			k := map[string]any{"id": "hk_" + repo, "type": "buildkite", "events": []string{"push"}, "buildkite": b["buildkite"], "created_at": "2026-10-03T12:00:00Z", "created_by": "ramos"}
			f.hooks[repo] = append(f.hooks[repo], k)
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(k)
		case strings.HasPrefix(r.URL.Path, "/v1/monorepos/ramos/pando/repos/") && strings.HasPrefix(rest, "hooks/") && r.Method == "DELETE":
			f.deletes = append(f.deletes, strings.TrimPrefix(rest, "hooks/"))
			f.hooks[repo] = nil
			w.WriteHeader(204)
		case r.Method == "GET" && r.URL.Path == "/v1/monorepos/ramos/pando/ci" && f.noConn:
			_ = json.NewEncoder(w).Encode(map[string]any{"connections": []any{}, "pipelines": []any{}})
		case r.Method == "POST" && r.URL.Path == "/v1/monorepos/ramos/pando/ci/connections":
			var b map[string]string
			_ = json.NewDecoder(r.Body).Decode(&b)
			f.posts = append(f.posts, b)
			if f.conflict {
				w.WriteHeader(409)
				_, _ = io.WriteString(w, `{"error":{"code":"ci_connection_exists","message":"buildkite organization acme is connected already"}}`)
				return
			}
			tok := ciToken
			if b["webhook_token"] != "" {
				tok = b["webhook_token"]
			}
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(map[string]any{"connection": conn, "webhook_token": tok})
		case r.Method == "GET" && r.URL.Path == "/v1/monorepos/ramos/pando/ci":
			conn["last_event"] = map[string]any{"at": "2026-10-03T12:01:00Z", "event": "ping", "result": "recorded"}
			conn["last_refused"] = map[string]any{"at": "2026-10-03T12:00:30Z", "reason": "X-Buildkite-Signature does not match"}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"connections": []any{conn},
				"pipelines": []any{map[string]any{"connection": conn["id"], "slug": "pando-ci", "repo": "projects-pando", "repo_path": "projects/pando",
					"required_checks": []string{"ci"}, "last_build": map[string]any{"id": "cib_1", "number": 12, "state": "passed", "branch": "main", "created_at": "2026-10-03T12:02:00Z"}}},
			})
		case r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/v1/monorepos/ramos/pando/ci/connections/"):
			f.deletes = append(f.deletes, strings.TrimPrefix(r.URL.Path, "/v1/monorepos/ramos/pando/ci/connections/"))
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
			_, _ = io.WriteString(w, `{"error":{"code":"not_found","message":"no such route"}}`)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// ciEnv is a signed-in Env (outside any Pando folder) with stdout captured.
func ciEnv(t *testing.T, f *ciFake, stdin string, terminal bool) (*Env, *bytes.Buffer) {
	t.Setenv("PANDO_HOME", t.TempDir())
	t.Setenv("PANDO_SERVER", "")
	home, err := config.LoadHome()
	if err != nil {
		t.Fatal(err)
	}
	if err := home.SaveCredential(f.srv.URL, "pando_test", config.Account{Login: "ramos"}); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	e, err := NewEnv(context.Background(), strings.NewReader(stdin), &out, &out)
	if err != nil {
		t.Fatal(err)
	}
	e.Cwd = t.TempDir()
	prev := stdoutTerminal
	stdoutTerminal = func(*Env) bool { return terminal }
	t.Cleanup(func() { stdoutTerminal = prev })
	return e, &out
}

func TestCIConnectShowsTheTokenOnATerminalOnly(t *testing.T) {
	f := newCIFake(t)
	e, out := ciEnv(t, f, "", true)
	if err := CI(e, []string{"connect", "--org", "Acme", "--monorepo", "ramos/pando", "--server", f.srv.URL}); err != nil {
		t.Fatal(err)
	}
	if len(f.posts) != 1 || f.posts[0]["service"] != "buildkite" || f.posts[0]["organization"] != "acme" || f.posts[0]["webhook_token"] != "" {
		t.Fatalf("POST body %v", f.posts)
	}
	s := out.String()
	for _, want := range []string{
		"https://pando.example/v1/integrations/buildkite/m_1--cic_aaaaaaaaaaaa", ciToken, "shown this once",
		"Settings > Notification Services > Webhook: Add", "X-Buildkite-Signature", "build.finished", "job.finished", "pando ci status --monorepo ramos/pando",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("connect output lacks %q:\n%s", want, s)
		}
	}

	// Not a terminal (an agent's session reads pipes): refused, and nothing is made.
	e, out = ciEnv(t, f, "", false)
	err := CI(e, []string{"connect", "--org", "acme", "--monorepo", "ramos/pando", "--server", f.srv.URL})
	if err == nil || !strings.Contains(err.Error(), "own terminal") || len(f.posts) != 1 || strings.Contains(out.String(), ciToken) {
		t.Fatalf("a pipe must not get the token: err %v, posts %d, out %q", err, len(f.posts), out.String())
	}
}

func TestCIConnectToAFile(t *testing.T) {
	f := newCIFake(t)
	e, out := ciEnv(t, f, "", false)
	p := filepath.Join(t.TempDir(), "bk-token")
	if err := CI(e, []string{"connect", "--org", "acme", "--monorepo", "ramos/pando", "--server", f.srv.URL, "--out", p}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(p)
	st, _ := os.Stat(p)
	if err != nil || strings.TrimSpace(string(b)) != ciToken || st.Mode().Perm() != 0o600 {
		t.Fatalf("token file: %v, mode %v", err, st.Mode().Perm())
	}
	if strings.Contains(out.String(), ciToken) || !strings.Contains(out.String(), "mode 600") {
		t.Fatalf("with --out the token goes only to the file:\n%s", out.String())
	}
}

func TestCIConnectPastedToken(t *testing.T) {
	f := newCIFake(t)
	pasted := "bk_token_from_buildkite_0123456789"
	e, out := ciEnv(t, f, pasted+"\n", true)
	if err := CI(e, []string{"connect", "--org", "acme", "--monorepo", "ramos/pando", "--server", f.srv.URL, "--paste-token"}); err != nil {
		t.Fatal(err)
	}
	if f.posts[0]["webhook_token"] != pasted || strings.Contains(out.String(), pasted) || !strings.Contains(out.String(), "leave Buildkite's") {
		t.Fatalf("pasted token: sent %q, output:\n%s", f.posts[0]["webhook_token"], out.String())
	}
}

func TestCIConnectTwice(t *testing.T) {
	f := newCIFake(t)
	f.conflict = true
	e, _ := ciEnv(t, f, "", true)
	err := CI(e, []string{"connect", "--org", "acme", "--monorepo", "ramos/pando", "--server", f.srv.URL})
	if err == nil || !strings.Contains(err.Error(), "pando ci disconnect --org acme --monorepo ramos/pando") {
		t.Fatalf("409 should say how to start over: %v", err)
	}
}

func TestCIStatusAndDisconnect(t *testing.T) {
	f := newCIFake(t)
	e, out := ciEnv(t, f, "", false)
	if err := CI(e, []string{"status", "--monorepo", "ramos/pando", "--server", f.srv.URL}); err != nil {
		t.Fatal(err)
	}
	s := out.String()
	for _, want := range []string{"Buildkite acme", "worker secret", "last event    ping", "recorded", "last refused", "X-Buildkite-Signature does not match", "pando-ci", "projects/pando", "#12 passed, main"} {
		if !strings.Contains(s, want) {
			t.Errorf("status lacks %q:\n%s", want, s)
		}
	}
	out.Reset()
	if err := CI(e, []string{"disconnect", "--org", "acme", "--monorepo", "ramos/pando", "--server", f.srv.URL}); err != nil {
		t.Fatal(err)
	}
	if len(f.deletes) != 1 || f.deletes[0] != "m_1--cic_aaaaaaaaaaaa" {
		t.Fatalf("deletes %v", f.deletes)
	}
	if err := CI(e, []string{"disconnect", "--org", "other", "--monorepo", "ramos/pando", "--server", f.srv.URL}); err == nil {
		t.Fatal("an organization with no connection is an error")
	}
}

func TestCIUsage(t *testing.T) {
	f := newCIFake(t)
	e, _ := ciEnv(t, f, "", true)
	for _, args := range [][]string{{}, {"nope"}, {"connect"}, {"disconnect"}, {"status", "extra"}} {
		var ue UsageError
		if err := CI(e, args); err == nil || !asUsage(err, &ue) {
			t.Errorf("%v: want a usage error, got %v", args, err)
		}
	}
	// No monorepo named and not in a Pando folder.
	if err := CI(e, []string{"status", "--server", f.srv.URL}); err == nil || !strings.Contains(err.Error(), "--monorepo") {
		t.Errorf("want: which monorepo, got %v", err)
	}
}

func asUsage(err error, ue *UsageError) bool {
	u, ok := err.(UsageError)
	if ok {
		*ue = u
	}
	return ok
}

func TestCIPipeline(t *testing.T) {
	f := newCIFake(t)
	e, out := ciEnv(t, f, "", false)
	run := func(args ...string) error {
		out.Reset()
		return CI(e, append(append([]string{"pipeline"}, args...), "--monorepo", "ramos/pando", "--server", f.srv.URL))
	}
	if err := run("list"); err != nil || !strings.Contains(out.String(), "No repo of ramos/pando starts a Buildkite pipeline") {
		t.Fatalf("empty list: %v\n%s", err, out.String())
	}
	// By path; the organization is the one connected (acme).
	if err := run("add", "projects/web", "Pando-CI"); err != nil {
		t.Fatal(err)
	}
	bk, _ := f.hookPosts[0]["buildkite"].(map[string]any)
	if f.hookPosts[0]["type"] != "buildkite" || bk["organization"] != "acme" || bk["pipeline"] != "pando-ci" {
		t.Fatalf("hook body %v", f.hookPosts[0])
	}
	if s := out.String(); !strings.Contains(s, "projects/web: each push to a branch now starts a build of acme/pando-ci") || !strings.Contains(s, `[repos."projects/web"]`) {
		t.Fatalf("add output:\n%s", s)
	}
	// Again, by name: nothing new.
	if err := run("add", "projects-web", "pando-ci"); err != nil || len(f.hookPosts) != 1 || !strings.Contains(out.String(), "already starts") {
		t.Fatalf("a second add: %v, %d posts\n%s", err, len(f.hookPosts), out.String())
	}
	if err := run("list"); err != nil || !strings.Contains(out.String(), "projects/web") || !strings.Contains(out.String(), "acme/pando-ci") {
		t.Fatalf("list: %v\n%s", err, out.String())
	}
	if err := run("add", "projects/nope", "pando-ci"); err == nil || !strings.Contains(err.Error(), "repos: projects/web, projects/api") {
		t.Fatalf("an unknown repo names the repos: %v", err)
	}
	if err := run("add", "projects/web", "not a slug"); err == nil {
		t.Fatal("a bad pipeline slug is refused")
	}
	// A member, not an owner.
	f.member = true
	if err := run("add", "projects/api", "api-ci"); err == nil || !strings.Contains(err.Error(), "only an owner of ramos/pando can add a pipeline") {
		t.Fatalf("a member: %v", err)
	}
	if err := run("remove", "projects/web", "pando-ci"); err == nil || !strings.Contains(err.Error(), "only an owner") {
		t.Fatalf("a member removing: %v", err)
	}
	f.member = false
	if err := run("remove", "projects/web", "pando-ci"); err != nil || len(f.deletes) != 1 || f.deletes[0] != "hk_projects-web" {
		t.Fatalf("remove: %v %v", err, f.deletes)
	}
	if err := run("remove", "projects/web", "pando-ci"); err == nil {
		t.Fatal("removing what is not there is an error")
	}
	// No connection: --org is needed, and the add says Pando will not hear from it yet.
	f.noConn = true
	if err := run("add", "projects/api", "api-ci"); err == nil || !strings.Contains(err.Error(), "--org") {
		t.Fatalf("no connection and no --org: %v", err)
	}
	if err := run("add", "projects/api", "api-ci", "--org", "other"); err != nil || !strings.Contains(out.String(), "pando ci connect --org other") {
		t.Fatalf("--org with no connection: %v\n%s", err, out.String())
	}
}
