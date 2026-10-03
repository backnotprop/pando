package worktree

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWaitAddedReturnsTheDaemonsReason(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "daemon.log")
	old := `{"time":"t","level":"ERROR","msg":"mount failed, runtime will retry","repo":"feat","error":"an older failure"}` + "\n"
	if err := os.WriteFile(log, []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	start := int64(len(old))
	go func() {
		time.Sleep(300 * time.Millisecond)
		f, _ := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0)
		f.WriteString(`{"time":"t","level":"INFO","msg":"mounting repo","repo":"feat"}` + "\n")
		f.WriteString(`{"time":"t","level":"ERROR","msg":"mount failed, runtime will retry","repo":"other","error":"not this one"}` + "\n")
		f.WriteString(`{"time":"t","level":"ERROR","msg":"mount failed, runtime will retry","repo":"feat","error":"the Pando file system extension is turned off. Turn on Pando in System Settings"}` + "\n")
		f.Close()
	}()
	t0 := time.Now()
	err := waitAdded(filepath.Join(dir, "mnt"), log, start, "feat", 10*time.Second)
	if err == nil || !strings.Contains(err.Error(), "turned off") || strings.Contains(err.Error(), "an older failure") {
		t.Fatalf("err = %v", err)
	}
	if time.Since(t0) > 3*time.Second {
		t.Fatalf("waited %s; it should stop at the daemon's failure", time.Since(t0))
	}
}
