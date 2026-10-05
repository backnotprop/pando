package gitx

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A config file held locked by another writer (the ArtifactFS daemon, as it
// mounts a worktree) makes git config fail at once. RunRaw tries again until
// the lock is gone, and gives up with git's own error when it never goes.
func TestConfigWaitsForALockedConfigFile(t *testing.T) {
	gitDir := filepath.Join(t.TempDir(), "git")
	ctx := context.Background()
	if _, err := (Cmd{}).Run(ctx, "init", "-q", "--bare", gitDir); err != nil {
		t.Fatal(err)
	}
	g := Cmd{Env: []string{"GIT_DIR=" + gitDir, "GIT_CONFIG_NOSYSTEM=1"}}
	lock := filepath.Join(gitDir, "config.lock")

	// The other writer lets go after 300 ms.
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(300 * time.Millisecond)
		_ = os.Remove(lock)
	}()
	if _, err := g.Run(ctx, "config", "pando.machine", "cloud-1"); err != nil {
		t.Fatalf("git config with the lock released after 300 ms: %v", err)
	}
	if v, _ := g.Run(ctx, "config", "--get", "pando.machine"); v != "cloud-1" {
		t.Fatalf("pando.machine = %q, want cloud-1", v)
	}

	// A lock that never goes: git's error, after about 2 s, not forever.
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, err := g.Run(ctx, "config", "pando.kind", "fuse")
	if err == nil || !strings.Contains(err.Error(), "could not lock config file") {
		t.Fatalf("want git's lock error, got %v", err)
	}
	if took := time.Since(start); took < time.Second || took > 10*time.Second {
		t.Fatalf("gave up after %s, want about 2 s", took)
	}

	// Other git commands are not retried.
	start = time.Now()
	if _, err := g.Run(ctx, "rev-parse", "--verify", "no-such-ref"); err == nil {
		t.Fatal("rev-parse of a missing ref succeeded")
	}
	if took := time.Since(start); took > time.Second {
		t.Fatalf("a failed rev-parse took %s; only git config is retried", took)
	}
}
