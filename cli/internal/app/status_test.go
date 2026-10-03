package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// pando status <state>: a CI step posts to PANDO_STATUS_URL with
// PANDO_STATUS_TOKEN. Against wrangler dev it is covered by worker/test/ci.mjs.
func TestStatusPostsWithTheStatusToken(t *testing.T) {
	sha := strings.Repeat("c", 40)
	var gotAuth, gotPath string
	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath = r.Header.Get("Authorization"), r.URL.EscapedPath()
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(map[string]any{"sha": sha, "context": gotBody["context"], "state": gotBody["state"], "creator": "app:buildkite", "app": "buildkite"})
	}))
	defer srv.Close()
	t.Setenv("PANDO_HOME", t.TempDir())
	t.Setenv("PANDO_STATUS_URL", srv.URL+"/v1/monorepos/ramos/pando/repos/projects-web/statuses/"+sha)
	t.Setenv("PANDO_STATUS_TOKEN", "pst1.test.token")
	t.Setenv("BUILDKITE_BUILD_URL", "https://buildkite.com/o/p/builds/7")

	var out bytes.Buffer
	e, err := NewEnv(context.Background(), strings.NewReader(""), &out, &out)
	if err != nil {
		t.Fatal(err)
	}
	e.Cwd = t.TempDir() // not a git checkout: no warning
	if err := Status(e, []string{"success", "--description", "42 passed"}); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer pst1.test.token" {
		t.Errorf("Authorization: the status token as a Bearer, got %q", strings.Split(gotAuth, " ")[0])
	}
	if gotPath != "/v1/monorepos/ramos/pando/repos/projects-web/statuses/"+sha {
		t.Errorf("path %s", gotPath)
	}
	want := map[string]string{"state": "success", "context": "ci", "target_url": "https://buildkite.com/o/p/builds/7", "description": "42 passed"}
	for k, v := range want {
		if gotBody[k] != v {
			t.Errorf("body %s = %q, want %q", k, gotBody[k], v)
		}
	}
	if !strings.Contains(out.String(), "ci: success on ccccccc (reported as buildkite)") {
		t.Errorf("output %q", out.String())
	}
	if strings.Contains(out.String(), "pst1.") {
		t.Error("the token was printed")
	}
}

func TestStatusUsage(t *testing.T) {
	t.Setenv("PANDO_HOME", t.TempDir())
	t.Setenv("PANDO_STATUS_URL", "")
	t.Setenv("PANDO_STATUS_TOKEN", "")
	var out bytes.Buffer
	e, err := NewEnv(context.Background(), strings.NewReader(""), &out, &out)
	if err != nil {
		t.Fatal(err)
	}
	var ue UsageError
	if err := Status(e, []string{"done"}); !errors.As(err, &ue) {
		t.Errorf("a bad state is a usage error, got %v", err)
	}
	if err := Status(e, []string{"--context", "ci"}); !errors.As(err, &ue) {
		t.Errorf("--context without a state is a usage error, got %v", err)
	}
	if err := Status(e, []string{"pending"}); err == nil || !strings.Contains(err.Error(), "PANDO_STATUS_TOKEN") {
		t.Errorf("no token: a plain error naming the variables, got %v", err)
	}
}
