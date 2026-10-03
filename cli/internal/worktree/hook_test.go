package worktree

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// gitIn runs real git in dir with a clean global config.
func gitIn(t *testing.T, dir string, env []string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	// No GIT_AUTHOR_* here: the identity comes from the worktree config
	// InstallHook writes, as in real use.
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "GIT_AUTHOR_") && !strings.HasPrefix(kv, "GIT_COMMITTER_") && !strings.HasPrefix(kv, "PANDO_AGENT=") {
			cmd.Env = append(cmd.Env, kv)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	cmd.Env = append(cmd.Env, env...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func must(t *testing.T, dir string, env []string, args ...string) string {
	t.Helper()
	out, err := gitIn(t, dir, env, args...)
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return out
}

func hookRepo(t *testing.T) string {
	dir := t.TempDir()
	must(t, dir, nil, "init", "-q", "-b", "main")
	err := InstallHook(context.Background(), filepath.Join(dir, ".git"), Identity{
		Root: "/r", Worktree: "projects/app/worktrees/feat", Machine: "box1", Agent: "agent-cfg",
		Kind: "sparse", UserName: "Pat Person", UserEmail: "pat@example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func lastMessage(t *testing.T, dir string) string {
	return must(t, dir, nil, "log", "-1", "--format=%B")
}

func count(s, sub string) int { return strings.Count(s, sub) }

func TestHookAddsTrailersOnce(t *testing.T) {
	dir := hookRepo(t)
	os.WriteFile(filepath.Join(dir, "a"), []byte("a"), 0o644)
	must(t, dir, nil, "add", "a")
	body := "Subject line\n\nA body with a rule:\n---\nafter the rule\n\nCo-authored-by: X <x@x>"
	must(t, dir, nil, "commit", "-q", "-m", body)
	msg := lastMessage(t, dir)
	want := body + "\nPando-Agent: agent-cfg\nPando-Worktree: projects/app/worktrees/feat\nPando-Machine: box1"
	if msg != want {
		t.Fatalf("message:\n%s\nwant:\n%s", msg, want)
	}
	if a := must(t, dir, nil, "log", "-1", "--format=%an <%ae>"); a != "Pat Person <pat@example.com>" {
		t.Fatalf("author %q", a)
	}
	// Amend twice: still one of each, and PANDO_AGENT replaces the agent.
	must(t, dir, nil, "commit", "-q", "--amend", "--no-edit")
	must(t, dir, []string{"PANDO_AGENT=agent-env"}, "commit", "-q", "--amend", "--no-edit")
	msg = lastMessage(t, dir)
	if count(msg, "Pando-") != 3 || !strings.Contains(msg, "Pando-Agent: agent-env") || strings.Contains(msg, "agent-cfg") {
		t.Fatalf("after amends:\n%s", msg)
	}
	if !strings.HasPrefix(msg, body) {
		t.Fatalf("the author's lines changed:\n%s", msg)
	}
}

func TestHookEditorCases(t *testing.T) {
	dir := hookRepo(t)
	os.WriteFile(filepath.Join(dir, "a"), []byte("a"), 0o644)
	must(t, dir, nil, "add", "a")
	// An editor that writes a message: the trailers come from commit-msg.
	editor := `sh -c 'printf "From the editor\n" > "$1.n"; cat "$1" >> "$1.n"; mv "$1.n" "$1"' --`
	must(t, dir, []string{"GIT_EDITOR=" + editor}, "commit", "-q", "-v")
	msg := lastMessage(t, dir)
	if !strings.HasPrefix(msg, "From the editor\n\nPando-Agent: agent-cfg") || count(msg, "Pando-") != 3 {
		t.Fatalf("editor commit:\n%s", msg)
	}
	// An editor that empties the message: git still aborts.
	os.WriteFile(filepath.Join(dir, "b"), []byte("b"), 0o644)
	must(t, dir, nil, "add", "b")
	out, err := gitIn(t, dir, []string{"GIT_EDITOR=sh -c ': > \"$1\"' --"}, "commit", "-q")
	if err == nil || !strings.Contains(out, "empty commit message") {
		t.Fatalf("an emptied message must abort, got err=%v out=%s", err, out)
	}
	// Comments and a commit -v diff alone do not count as a message.
	out, err = gitIn(t, dir, []string{"GIT_EDITOR=sh -c 'grep \"^#\" \"$1\" > \"$1.n\"; mv \"$1.n\" \"$1\"' --"}, "commit", "-q", "-v")
	if err == nil || !strings.Contains(out, "empty commit message") {
		t.Fatalf("a comments-only message must abort, got err=%v out=%s", err, out)
	}
}
