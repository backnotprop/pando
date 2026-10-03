package worktree

import (
	"testing"
)

func TestIsMountedDarwin(t *testing.T) {
	if !isMounted("/") {
		t.Fatal("/ is not listed as mounted")
	}
	if isMounted(t.TempDir()) {
		t.Fatal("a plain folder is listed as mounted")
	}
	// /tmp is a symlink to /private/tmp; neither is a mount point.
	if isMounted("/tmp") {
		t.Fatal("/tmp listed as mounted")
	}
}
