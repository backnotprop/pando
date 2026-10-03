// Package gitx runs the real git binary. Nothing here reimplements git.
package gitx

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// Error is a failed git command, with its stderr trimmed for display.
type Error struct {
	Args   []string
	Stderr string
	Err    error
}

func (e *Error) Error() string {
	msg := strings.TrimSpace(e.Stderr)
	if msg == "" {
		msg = e.Err.Error()
	}
	return fmt.Sprintf("git %s: %s", strings.Join(redactArgs(e.Args), " "), msg)
}

func (e *Error) Unwrap() error { return e.Err }

// Cmd describes one git invocation.
type Cmd struct {
	Dir   string    // working directory; empty means the current one
	Env   []string  // extra environment, added to os.Environ()
	Stdin io.Reader // optional
}

// Run runs git and returns its trimmed stdout.
func (c Cmd) Run(ctx context.Context, args ...string) (string, error) {
	out, err := c.RunRaw(ctx, args...)
	return strings.TrimSpace(string(out)), err
}

// RunRaw runs git and returns stdout untouched.
func (c Cmd) RunRaw(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = c.Dir
	cmd.Env = c.environ()
	if c.Stdin != nil {
		cmd.Stdin = c.Stdin
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return stdout.Bytes(), &Error{Args: args, Stderr: stderr.String(), Err: err}
	}
	return stdout.Bytes(), nil
}

// Stream runs git with its output going to the given writers (for long
// commands like clone and push that a person watches).
func (c Cmd) Stream(ctx context.Context, stdout, stderr io.Writer, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = c.Dir
	cmd.Env = c.environ()
	var errBuf bytes.Buffer
	cmd.Stdout = stdout
	if stderr != nil {
		cmd.Stderr = io.MultiWriter(stderr, &errBuf)
	} else {
		cmd.Stderr = &errBuf
	}
	if err := cmd.Run(); err != nil {
		return &Error{Args: args, Stderr: errBuf.String(), Err: err}
	}
	return nil
}

// RunShell runs a shell script with args ($1, $2, ...), in c.Dir with
// c.Env and c.Stdin, the way git runs a hook. A failure is an *Error whose
// Stderr is the script's.
func (c Cmd) RunShell(ctx context.Context, script string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "sh", append([]string{"-c", script, "pando-hook"}, args...)...)
	cmd.Dir = c.Dir
	cmd.Env = c.environ()
	if c.Stdin != nil {
		cmd.Stdin = c.Stdin
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return stdout.String(), &Error{Args: []string{"(hook)"}, Stderr: stderr.String(), Err: err}
	}
	return strings.TrimSpace(stdout.String()), nil
}

// NoSystemConfig keeps every git pando runs from reading the system git
// config. On a Mac that is Apple's, which sets credential.helper=osxkeychain:
// git would hand the Pando credential to the keychain after each push or
// fetch, and macOS shows "A keychain cannot be found to store ..." when
// there is no keychain to store it in.
const NoSystemConfig = "GIT_CONFIG_NOSYSTEM=1"

// environ is the environment for one git command: this process's, the
// command's extras, no system git config, and never a terminal prompt.
func (c Cmd) environ() []string {
	env := append(os.Environ(), c.Env...)
	return append(env, NoSystemConfig, "GIT_TERMINAL_PROMPT=0")
}

// In is a shorthand for Cmd{Dir: dir}.
func In(dir string) Cmd { return Cmd{Dir: dir} }

// redactArgs hides userinfo in any URL-looking argument so errors never
// print a token.
func redactArgs(args []string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		out[i] = RedactURL(a)
	}
	return out
}

// RedactURL replaces the user and password part of a URL with "REDACTED".
func RedactURL(s string) string {
	i := strings.Index(s, "://")
	if i < 0 {
		return s
	}
	rest := s[i+3:]
	slash := strings.IndexAny(rest, "/?#")
	host := rest
	if slash >= 0 {
		host = rest[:slash]
	}
	at := strings.LastIndex(host, "@")
	if at < 0 {
		return s
	}
	return s[:i+3] + "REDACTED@" + rest[at+1:]
}

// StripUserinfo removes any user or password from an http(s) URL. It
// returns the clean URL and whether anything was removed.
func StripUserinfo(s string) (string, bool) {
	r := RedactURL(s)
	if r == s {
		return s, false
	}
	return strings.Replace(r, "REDACTED@", "", 1), true
}
