package worktree

import (
	"context"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestAgentHeaderConfig(t *testing.T) {
	dir := t.TempDir()
	must(t, dir, nil, "init", "-q", "-b", "main")
	gd := filepath.Join(dir, ".git")
	url := "https://pando.example.com/ws/projects-app.git"
	for i := 0; i < 2; i++ { // written twice, kept once
		if err := WriteAgentHeader(context.Background(), gd, url, "agent-7\r\nX-Evil: 1"); err != nil {
			t.Fatal(err)
		}
	}
	if got := must(t, dir, nil, "config", "--get-all", "http.https://pando.example.com/.extraheader"); got != "X-Pando-Agent: agent-7X-Evil: 1" {
		t.Fatalf("header %q (one line, no CR or LF)", got)
	}
	if out, _ := gitIn(t, dir, nil, "config", "--get-urlmatch", "http.extraheader", "https://github.com/x/y.git"); out != "" {
		t.Fatalf("sent to another host: %q", out)
	}
	if err := WriteAgentHeader(context.Background(), gd, url, ""); err != nil {
		t.Fatal(err)
	}
	if out, _ := gitIn(t, dir, nil, "config", "--get-all", "http.https://pando.example.com/.extraheader"); out != "" {
		t.Fatalf("no agent should remove it: %q", out)
	}
	if AgentHeaderArgs("file:///srv/x.git", "a") != nil || AgentHeaderArgs(url, "") != nil {
		t.Fatal("no header for file:// or without an agent")
	}
	if got := strings.Join(AgentHeaderArgs(url, "agent-1"), " "); got != "-c http.https://pando.example.com/.extraHeader=X-Pando-Agent: agent-1" {
		t.Fatalf("args %q", got)
	}
}

// gitServer serves bare repos under root over smart HTTP with git
// http-backend, and records each request's X-Pando-Agent.
type gitServer struct {
	*httptest.Server
	mu   sync.Mutex
	seen []string // "METHOD path agent"
}

func newGitServer(t *testing.T, root string) *gitServer {
	execPath := must(t, root, nil, "--exec-path")
	backend := &cgi.Handler{
		Path: filepath.Join(execPath, "git-http-backend"),
		Env:  []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1"},
	}
	gs := &gitServer{}
	gs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gs.mu.Lock()
		gs.seen = append(gs.seen, r.Method+" "+r.URL.Path+" "+r.Header.Get("X-Pando-Agent"))
		gs.mu.Unlock()
		backend.ServeHTTP(w, r)
	}))
	t.Cleanup(gs.Close)
	return gs
}

func (gs *gitServer) pushAgents() []string {
	gs.mu.Lock()
	defer gs.mu.Unlock()
	var out []string
	for _, s := range gs.seen {
		if strings.Contains(s, "git-receive-pack") && strings.HasPrefix(s, "POST") {
			out = append(out, strings.TrimSpace(s[strings.LastIndex(s, ".git/git-receive-pack")+len(".git/git-receive-pack"):]))
		}
	}
	return out
}

func TestAgentHeaderOnPushes(t *testing.T) {
	base := t.TempDir()
	for _, name := range []string{"app.git", "other.git"} {
		bare := filepath.Join(base, name)
		must(t, base, nil, "init", "-q", "--bare", "-b", "main", bare)
		must(t, bare, nil, "config", "http.receivepack", "true")
		must(t, bare, nil, "config", "uploadpack.allowFilter", "true")
	}
	seed := filepath.Join(base, "seed")
	must(t, base, nil, "init", "-q", "-b", "main", seed)
	os.WriteFile(filepath.Join(seed, "a.txt"), []byte("a\n"), 0o644)
	must(t, seed, nil, "add", "-A")
	must(t, seed, nil, "commit", "-q", "-m", "seed")
	must(t, seed, nil, "push", "-q", filepath.Join(base, "app.git"), "main")
	pando, other := newGitServer(t, base), newGitServer(t, base) // two hosts: two ports

	// A worktree made by the sparse driver, for agent-7, from the Pando host.
	if _, err := Spec2Add(t, base, pando.URL+"/app.git", "agent-7"); err != nil {
		t.Fatal(err)
	}
	wt := filepath.Join(base, "root", "worktrees", "feat")
	os.WriteFile(filepath.Join(wt, "b.txt"), []byte("b\n"), 0o644)
	must(t, wt, nil, "add", "-A")
	must(t, wt, nil, "commit", "-q", "-m", "work")
	must(t, wt, nil, "push", "-q", "origin", "HEAD:refs/heads/feat")
	if got := pando.pushAgents(); len(got) == 0 || got[len(got)-1] != "agent-7" {
		t.Fatalf("push to the Pando host: X-Pando-Agent %q, want agent-7", got)
	}
	// The same worktree pushing to another host sends no agent.
	must(t, wt, nil, "push", "-q", other.URL+"/other.git", "HEAD:refs/heads/feat")
	if got := other.pushAgents(); len(got) == 0 || got[len(got)-1] != "" {
		t.Fatalf("push to another host carried X-Pando-Agent %q", got)
	}
}

// Spec2Add makes a branch worktree with the sparse driver, as pando
// worktree add does, after making the branch on the server.
func Spec2Add(t *testing.T, base, cloneURL, agent string) (Spec, error) {
	t.Helper()
	must(t, filepath.Join(base, "app.git"), nil, "branch", "feat", "main")
	s := Spec{Root: filepath.Join(base, "root"), Repo: ".", Branch: "feat", Path: "worktrees/feat", CloneURL: cloneURL,
		Identity: Identity{Worktree: "worktrees/feat", Machine: "box", Agent: agent, Kind: "sparse"}}
	return s, Sparse{}.Add(context.Background(), s)
}
