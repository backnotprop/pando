package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestCreateBranchRetriesServerErrors(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case n == 1:
			w.WriteHeader(http.StatusBadGateway)
			w.Write([]byte(`{"error":{"code":"artifacts","message":"Artifacts could not unpack: null"}}`))
		case n == 2:
			// The first try made it after all.
			w.WriteHeader(http.StatusConflict)
			w.Write([]byte(`{"error":{"code":"branch_exists","message":"exists"}}`))
		}
	}))
	defer ts.Close()
	s, err := Open(ts.URL, "tok")
	if err != nil {
		t.Fatal(err)
	}
	made, err := s.CreateBranch(context.Background(), "m", "projects-app", "b")
	if err != nil || made || calls.Load() != 2 {
		t.Fatalf("made %v err %v calls %d", made, err, calls.Load())
	}

	calls.Store(0)
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":{"code":"bad_name","message":"no"}}`))
	}))
	defer bad.Close()
	s, _ = Open(bad.URL, "tok")
	if _, err := s.CreateBranch(context.Background(), "m", "r", "b"); err == nil || calls.Load() != 1 {
		t.Fatalf("a 400 is not retried: err %v calls %d", err, calls.Load())
	}
}

func TestAgentHeaderOnAPICalls(t *testing.T) {
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Header.Get("X-Pando-Agent"))
		w.Write([]byte(`{"name":"feat","head":"abc","state":"open","checks":{}}`))
	}))
	defer srv.Close()
	h := NewHTTP(srv.URL, "tok")
	h.Agent = "agent-3"
	if _, err := h.GetBranch(context.Background(), "m", "r", "feat"); err != nil {
		t.Fatal(err)
	}
	h.Agent = ""
	if _, err := h.GetBranch(context.Background(), "m", "r", "feat"); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "agent-3" || got[1] != "" {
		t.Fatalf("X-Pando-Agent per call: %q", got)
	}
}
