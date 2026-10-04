package app

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
)

// pando mirror against a stand-in for the Pando API's mirror routes. Against
// wrangler dev the routes are covered by worker/test/mirror.mjs.

type mirrorFake struct {
	srv        *httptest.Server
	configured bool
	connected  bool
	paused     bool
	mode       string
	member     bool // not an owner: writes answer 403 owner_only
	queued     []string
	sent       []byte // the last GET answer, as sent
	patches    []map[string]any
	puts       []map[string]any
	runs       []map[string]any
}

func newMirrorFake(t *testing.T) *mirrorFake {
	f := &mirrorFake{configured: true, connected: true, mode: "projects", queued: []string{"projects-pando", "projects-artifact-fs", "meta"}}
	gh := func(id int, name string) map[string]any {
		return map[string]any{"id": id, "full_name": "backnotprop/" + name, "private": true, "url": "https://github.com/backnotprop/" + name}
	}
	mirror := func() map[string]any {
		m := map[string]any{
			"app": map[string]any{"configured": f.configured}, "connection": nil, "mode": f.mode, "on": false, "started": false, "paused": nil, "targets": []any{},
		}
		if !f.connected {
			return m
		}
		m["connection"] = map[string]any{
			"installation_id": 7, "login": "backnotprop", "type": "User", "repository_selection": "selected",
			"manage_url": "https://github.com/settings/installations/7", "connected_at": "2026-10-04T10:00:00Z", "connected_by": "ramos",
		}
		m["started"], m["on"] = true, !f.paused
		state := func(s string) string {
			if f.paused {
				return "paused"
			}
			return s
		}
		pando := map[string]any{"repo": "projects-pando", "path": "projects/pando", "on": true, "github": gh(11, "pando"), "state": state("up_to_date"),
			"last":   map[string]any{"commit": "a41c9e2f00000000000000000000000000000000", "at": time.Now().Add(-12 * time.Second).UTC().Format(time.RFC3339Nano)},
			"behind": nil, "waiting_since": nil, "next_try_at": nil, "problem": nil}
		fs := map[string]any{"repo": "projects-artifact-fs", "path": "projects/artifact-fs", "on": true, "github": gh(12, "artifact-fs"), "state": state("waiting"),
			"last": nil, "behind": 3, "waiting_since": "2026-10-04T10:00:00Z", "next_try_at": nil, "problem": nil}
		meta := map[string]any{"repo": "meta", "path": "", "on": true, "github": gh(13, "pando-files"), "state": "refused", "last": nil, "behind": nil,
			"waiting_since": nil, "next_try_at": nil, "problem": map[string]any{"code": "refused", "message": "main is protected and needs a pull request", "at": "2026-10-04T10:00:00Z"}}
		web := map[string]any{"repo": "projects-web", "path": "projects/web", "on": false, "github": nil, "state": "off", "last": nil, "behind": nil,
			"waiting_since": nil, "next_try_at": nil, "problem": nil}
		if f.paused {
			pando["behind"] = 14
			m["paused"] = map[string]any{"by": "ramos", "at": "2026-10-04T10:05:00Z"}
		}
		m["targets"] = []any{pando, fs, meta, web}
		return m
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer pando_test" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		const base = "/v1/monorepos/ramos/pando/mirror"
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.Method != "GET" && f.member {
			w.WriteHeader(403)
			_, _ = io.WriteString(w, `{"error":{"code":"owner_only","message":"only an owner can change the mirror"}}`)
			return
		}
		switch {
		case r.Method == "GET" && r.URL.Path == base:
			f.sent, _ = json.Marshal(mirror())
			_, _ = w.Write(f.sent)
		case r.Method == "PATCH" && r.URL.Path == base:
			f.patches = append(f.patches, body)
			f.paused = body["on"] == false
			_ = json.NewEncoder(w).Encode(mirror())
		case r.Method == "PUT" && r.URL.Path == base+"/targets":
			f.puts = append(f.puts, body)
			_ = json.NewEncoder(w).Encode(map[string]any{"mirror": mirror(), "authorize_url": nil})
		case r.Method == "POST" && r.URL.Path == base+"/run":
			f.runs = append(f.runs, body)
			queued := []string{}
			for _, q := range f.queued {
				if want, ok := body["repos"].([]any); !ok || slices.Contains(anyStrings(want), q) {
					queued = append(queued, q)
				}
			}
			w.WriteHeader(202)
			_ = json.NewEncoder(w).Encode(map[string]any{"queued": queued, "skipped": []any{}})
		default:
			w.WriteHeader(404)
			_, _ = io.WriteString(w, `{"error":{"code":"not_found","message":"no such route"}}`)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func anyStrings(xs []any) []string {
	var out []string
	for _, x := range xs {
		s, _ := x.(string)
		out = append(out, s)
	}
	return out
}

// mirrorRun runs pando mirror against the fake, signed in and outside any Pando folder.
func mirrorRun(t *testing.T, f *mirrorFake, args ...string) (string, error) {
	e, out := ciEnv(t, &ciFake{srv: f.srv}, "", false)
	err := Mirror(e, append(args, "--monorepo", "ramos/pando", "--server", f.srv.URL))
	return out.String(), err
}

func TestMirrorStatus(t *testing.T) {
	f := newMirrorFake(t)
	s, err := mirrorRun(t, f, "status")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"ramos/pando: on, each project, to GitHub backnotprop\n",
		"PROJECT", "GITHUB", "STATE",
		"pando                     backnotprop/pando         up to date, a41c9e2, 12 s",
		"artifact-fs               backnotprop/artifact-fs   waiting, 3 commits behind",
		"files outside projects/   backnotprop/pando-files   refused: main is protected and needs a pull request",
		"web                       -                         off",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("status lacks %q:\n%s", want, s)
		}
	}

	// --json: the API's bytes as they came (compact in a pipe).
	s, err = mirrorRun(t, f, "status", "--json")
	var want bytes.Buffer
	_ = json.Compact(&want, f.sent)
	if err != nil || s != want.String()+"\n" {
		t.Fatalf("--json: %v\ngot  %s\nwant %s", err, s, want.String())
	}

	f.paused = true
	if s, _ = mirrorRun(t, f, "status"); !strings.Contains(s, "ramos/pando: paused by ramos, each project, to GitHub backnotprop") || !strings.Contains(s, "paused, 14 commits behind") {
		t.Errorf("paused:\n%s", s)
	}
	f.connected = false
	if s, _ = mirrorRun(t, f, "status"); !strings.HasPrefix(s, "ramos/pando: not connected") || strings.Contains(s, "PROJECT") {
		t.Errorf("not connected:\n%s", s)
	}
	f.configured = false
	if s, _ = mirrorRun(t, f, "status"); s != "ramos/pando: the GitHub App is not set up on this server\n" {
		t.Errorf("no app:\n%s", s)
	}
}

func TestMirrorOnOff(t *testing.T) {
	f := newMirrorFake(t)
	s, err := mirrorRun(t, f, "off")
	if err != nil || s != "Mirroring of ramos/pando is paused. Turn it back on with: pando mirror on\n" || len(f.patches) != 1 || f.patches[0]["on"] != false {
		t.Fatalf("off: %v %v\n%s", err, f.patches, s)
	}
	s, err = mirrorRun(t, f, "on")
	if err != nil || s != "Mirroring of ramos/pando is on.\n" || f.patches[1]["on"] != true {
		t.Fatalf("on: %v %v\n%s", err, f.patches, s)
	}
	// No mirror set up: the switch says so instead of claiming it is on.
	f.connected = false
	if _, err = mirrorRun(t, f, "on"); err == nil || !strings.Contains(err.Error(), "pando mirror connect") {
		t.Fatalf("on with nothing set up: %v", err)
	}
}

func TestMirrorProjectSwitch(t *testing.T) {
	f := newMirrorFake(t)
	s, err := mirrorRun(t, f, "off", "artifact-fs")
	if err != nil || s != "artifact-fs: off\n" {
		t.Fatalf("off artifact-fs: %v\n%s", err, s)
	}
	// The full list (every row with a GitHub repository), with that one off.
	got, _ := json.Marshal(f.puts[0])
	want := `{"mode":"projects","targets":[{"github_id":11,"on":true,"repo":"projects-pando"},{"github_id":12,"on":false,"repo":"projects-artifact-fs"},{"github_id":13,"on":true,"repo":"meta"}]}`
	if string(got) != want {
		t.Fatalf("PUT body\ngot  %s\nwant %s", got, want)
	}
	// By path, and the files outside projects/ by "files".
	if s, err = mirrorRun(t, f, "on", "projects/artifact-fs"); err != nil || s != "artifact-fs: on\n" {
		t.Fatalf("on by path: %v\n%s", err, s)
	}
	if s, err = mirrorRun(t, f, "off", "files"); err != nil || s != "files outside projects/: off\n" {
		t.Fatalf("off files: %v\n%s", err, s)
	}
	if tg := f.puts[2]["targets"].([]any)[2].(map[string]any); tg["repo"] != "meta" || tg["on"] != false {
		t.Fatalf("off files sent %v", f.puts[2])
	}
	// A project with no GitHub repository yet: refused, nothing sent.
	if _, err = mirrorRun(t, f, "on", "web"); err == nil || err.Error() != "web has no GitHub repository yet; choose one in Settings (pando mirror connect)" || len(f.puts) != 3 {
		t.Fatalf("on web: %v, %d PUTs", err, len(f.puts))
	}
	if _, err = mirrorRun(t, f, "off", "nope"); err == nil || !strings.Contains(err.Error(), "projects: pando, artifact-fs, files outside projects/, web") {
		t.Fatalf("an unknown project names the projects: %v", err)
	}
}

func TestMirrorRetry(t *testing.T) {
	f := newMirrorFake(t)
	s, err := mirrorRun(t, f, "retry")
	if err != nil || s != "pando: queued\nartifact-fs: queued\nfiles outside projects/: queued\n" || len(f.runs[0]) != 0 {
		t.Fatalf("retry all: %v, body %v\n%s", err, f.runs, s)
	}
	s, err = mirrorRun(t, f, "retry", "pando", "files")
	if err != nil || s != "pando: queued\nfiles outside projects/: queued\n" {
		t.Fatalf("retry pando files: %v\n%s", err, s)
	}
	if got := strings.Join(anyStrings(f.runs[1]["repos"].([]any)), ","); got != "projects-pando,meta" {
		t.Fatalf("retry sent repos %q", got)
	}
	f.queued = nil
	if s, err = mirrorRun(t, f, "retry"); err != nil || s != "nothing to retry\n" {
		t.Fatalf("nothing queued: %v\n%s", err, s)
	}
	s, err = mirrorRun(t, f, "retry", "--json")
	if err != nil || s != `{"queued":[],"skipped":[]}`+"\n" {
		t.Fatalf("retry --json: %v\n%s", err, s)
	}
}

func TestMirrorOwnerOnly(t *testing.T) {
	f := newMirrorFake(t)
	f.member = true
	for _, args := range [][]string{{"off"}, {"off", "artifact-fs"}, {"retry"}} {
		_, err := mirrorRun(t, f, args...)
		if err == nil || !strings.Contains(err.Error(), "only an owner can change the mirror (owner_only, HTTP 403)") || !strings.Contains(err.Error(), "only an owner of ramos/pando can") {
			t.Errorf("%v as a member: %v", args, err)
		}
	}
	// Reading is for members.
	if _, err := mirrorRun(t, f, "status"); err != nil {
		t.Errorf("status as a member: %v", err)
	}
}

func TestMirrorConnect(t *testing.T) {
	f := newMirrorFake(t)
	s, err := mirrorRun(t, f, "connect")
	if err != nil || s != "Setting up a mirror needs GitHub in a browser. Open:\n  "+f.srv.URL+"/ramos/pando/settings\n" {
		t.Fatalf("connect: %v\n%s", err, s)
	}
}

func TestMirrorUsage(t *testing.T) {
	f := newMirrorFake(t)
	for _, args := range [][]string{{}, {"nope"}, {"status", "extra"}, {"on", "a", "b"}, {"connect", "x"}} {
		e, _ := ciEnv(t, &ciFake{srv: f.srv}, "", false)
		var ue UsageError
		if err := Mirror(e, args); err == nil || !asUsage(err, &ue) {
			t.Errorf("%v: want a usage error, got %v", args, err)
		}
	}
}
