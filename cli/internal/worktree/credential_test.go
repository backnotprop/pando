package worktree

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The helper list git inherits (osxkeychain on a Mac; here a fake in the
// global config that leaves a mark) must never run for the Pando host: not to
// get, not to store. Other hosts keep it. The system level stays off
// (GIT_CONFIG_NOSYSTEM=1): Apple git's osxkeychain is there, and only that
// setting keeps it from running.
func TestCredentialConfigClearsInheritedHelpers(t *testing.T) {
	dir := t.TempDir()
	mark := filepath.Join(dir, "inherited-helper-ran")
	global := filepath.Join(dir, "global.gitconfig")
	os.WriteFile(global, []byte("[credential]\n\thelper = \"!f() { echo $1 >> '"+mark+"'; }; f\"\n"), 0o644)
	pando := filepath.Join(dir, "pando")
	os.WriteFile(pando, []byte("#!/bin/sh\n[ \"$2\" = get ] && printf 'username=pat\\npassword=pando_fake\\n'\nexit 0\n"), 0o755)

	var args []string
	for _, kv := range credentialConfigFor("https://pando.example.com/ws/projects-app.git", pando) {
		args = append(args, "-c", kv[0]+"="+kv[1])
	}
	run := func(action, host string) string {
		cmd := exec.Command("git", append(args, "credential", action)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+global, "GIT_TERMINAL_PROMPT=0")
		cmd.Stdin = strings.NewReader("protocol=https\nhost=" + host + "\npath=ws/projects-app.git\nusername=pat\npassword=pando_fake\n\n")
		out, _ := cmd.CombinedOutput()
		return string(out)
	}
	if out := run("fill", "pando.example.com"); !strings.Contains(out, "password=pando_fake") {
		t.Fatalf("pando's helper did not answer:\n%s", out)
	}
	run("approve", "pando.example.com")
	run("reject", "pando.example.com")
	if b, err := os.ReadFile(mark); err == nil {
		t.Fatalf("the inherited helper ran for the Pando host: %q", b)
	}
	run("approve", "other.example.com")
	if b, _ := os.ReadFile(mark); !strings.Contains(string(b), "store") {
		t.Fatalf("other hosts should keep the inherited helper, got %q", b)
	}
}
