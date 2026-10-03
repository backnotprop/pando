package app

import (
	"context"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pando/internal/config"
)

func TestRefreshesCoalesce(t *testing.T) {
	root := &config.Root{Dir: t.TempDir(), Name: "acme", Repos: []config.RepoEntry{{Path: ".", Name: "acme"}}}
	e, _ := NewEnv(context.Background(), strings.NewReader(""), io.Discard, io.Discard)
	var runs atomic.Int32
	var mu sync.Mutex
	var at []time.Duration
	start := time.Now()
	prev := refreshMainFn
	defer func() { refreshMainFn = prev }()
	refreshMainFn = func(*Env, *config.Root, string) {
		runs.Add(1)
		mu.Lock()
		at = append(at, time.Since(start))
		mu.Unlock()
		time.Sleep(300 * time.Millisecond) // a fetch
	}

	// A burst: 20 requests, 100 ms apart, each from its own goroutine as
	// frames arrive (and its own lock file handle, as separate processes).
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); requestMainRefresh(e, root, ".") }()
		time.Sleep(100 * time.Millisecond)
	}
	wg.Wait()
	if n := runs.Load(); n != 2 {
		t.Fatalf("20 requests in 2 s gave %d refreshes, want 2", n)
	}
	if at[0] > 100*time.Millisecond {
		t.Fatalf("the first refresh waited %s; it must run at once", at[0])
	}
	if at[1] < 2*time.Second+burstQuiet-200*time.Millisecond {
		t.Fatalf("the second refresh ran at %s, before the burst ended and went quiet", at[1])
	}

	// Steady requests, one every 2 s for 24 s (never quiet for burstQuiet):
	// at most one refresh per burstMax after the first.
	runs.Store(0)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); requestMainRefresh(e, root, ".") }()
		time.Sleep(2 * time.Second)
	}
	wg.Wait()
	if n := runs.Load(); n < 2 || n > 4 {
		t.Fatalf("12 requests over 24 s gave %d refreshes, want 2 to 4 (one per %s)", n, burstMax)
	}

	// A single request later: one refresh, at once.
	runs.Store(0)
	t0 := time.Now()
	requestMainRefresh(e, root, ".")
	if runs.Load() != 1 {
		t.Fatalf("one request gave %d refreshes", runs.Load())
	}
	if d := time.Since(t0); d > 300*time.Millisecond+burstQuiet+500*time.Millisecond {
		t.Fatalf("one request held the caller %s", d)
	}
}
