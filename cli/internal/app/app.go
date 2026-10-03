// Package app holds the pando commands. cmd/pando/main.go wires them.
package app

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"pando/internal/config"
	"pando/internal/server"
)

// Env is what every command gets.
type Env struct {
	Ctx    context.Context
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	Cwd    string
	Home   *config.Home

	in *bufio.Reader
}

// NewEnv builds an Env for the current process.
func NewEnv(ctx context.Context, stdin io.Reader, stdout, stderr io.Writer) (*Env, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	home, err := config.LoadHome()
	if err != nil {
		return nil, err
	}
	return &Env{Ctx: ctx, Stdin: stdin, Stdout: stdout, Stderr: stderr, Cwd: cwd, Home: home}, nil
}

// Command is one pando command.
type Command struct {
	Name  string
	Usage string
	Run   func(e *Env, args []string) error
}

// UsageError makes main print the command's usage.
type UsageError struct{ Msg string }

func (u UsageError) Error() string { return u.Msg }

func (e *Env) printf(format string, a ...any) { fmt.Fprintf(e.Stdout, format, a...) }

func (e *Env) warnf(format string, a ...any) { fmt.Fprintf(e.Stderr, "pando: "+format+"\n", a...) }

// flags makes a FlagSet that reports errors as usage errors.
func flags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

// parse lets flags come before or after positional arguments.
func parse(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, UsageError{err.Error()}
		}
		args = fs.Args()
		if len(args) == 0 {
			return pos, nil
		}
		pos = append(pos, args[0])
		args = args[1:]
	}
}

func (e *Env) abs(p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(e.Cwd, p)
}

func (e *Env) isTerminal() bool {
	f, ok := e.Stdin.(*os.File)
	if !ok {
		return false
	}
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

func (e *Env) readLine() (string, error) {
	if e.in == nil {
		e.in = bufio.NewReader(e.Stdin)
	}
	line, err := e.in.ReadString('\n')
	if err != nil && (err != io.EOF || line == "") {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

// readSecret reads one line with echo off when stdin is a terminal. The
// value is never printed.
func (e *Env) readSecret(prompt string) (string, error) {
	if e.isTerminal() {
		fmt.Fprint(e.Stderr, prompt)
		stty := func(arg string) {
			c := exec.Command("stty", arg)
			c.Stdin = e.Stdin.(*os.File)
			_ = c.Run()
		}
		stty("-echo")
		defer func() { stty("echo"); fmt.Fprintln(e.Stderr) }()
	}
	return e.readLine()
}

// open returns the server for a root, with this machine's credential.
func (e *Env) open(root *config.Root) (server.Server, error) {
	tok, err := e.Home.Token(root.Server)
	if err != nil && !strings.HasPrefix(root.Server, "file://") {
		return nil, err
	}
	return server.Open(root.Server, tok)
}

// root finds the Pando root above the current folder.
func (e *Env) root() (*config.Root, error) { return config.FindRoot(e.Cwd) }

// agent is the agent name in force: --agent, else PANDO_AGENT.
func agentName(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	return os.Getenv("PANDO_AGENT")
}

func newWorktreeID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "wt_" + hex.EncodeToString(b)
}

// repoArg resolves a repo path given on the command line (relative to the
// current folder) to a repo path from the root.
func (e *Env) repoArg(root *config.Root, arg string) (string, error) {
	rel, err := root.Rel(e.abs(arg))
	if err != nil {
		return "", err
	}
	if _, ok := root.Repo(rel); ok {
		return rel, nil
	}
	if r, ok := root.RepoFor(rel); ok && (r == "." || strings.HasPrefix(rel, r+"/worktrees")) {
		return r, nil
	}
	return "", fmt.Errorf("%s is not a repo in %s (repos: %s)", rel, root.Name, repoList(root))
}

func repoList(root *config.Root) string {
	var ps []string
	for _, r := range root.Repos {
		ps = append(ps, r.Path)
	}
	if len(ps) == 0 {
		return "none yet"
	}
	return strings.Join(ps, ", ")
}

// currentRepo picks the repo for commands like diff and merge: --repo, else
// the repo the current folder is in, else the only repo.
func (e *Env) currentRepo(root *config.Root, flagRepo string) (string, error) {
	if flagRepo != "" {
		return e.repoArg(root, flagRepo)
	}
	if rel, err := root.Rel(e.Cwd); err == nil {
		if r, ok := root.RepoFor(rel); ok {
			return r, nil
		}
	}
	if len(root.Repos) == 1 {
		return root.Repos[0].Path, nil
	}
	return "", fmt.Errorf("which repo? pass --repo <path> (repos: %s)", repoList(root))
}

// currentBranch is the branch of the worktree the current folder is in.
func (e *Env) currentBranch(root *config.Root) string {
	rel, err := root.Rel(e.Cwd)
	if err != nil {
		return ""
	}
	ws, _ := root.LoadWorktrees()
	for _, w := range ws {
		if rel == w.Path || strings.HasPrefix(rel, w.Path+"/") {
			return w.Branch
		}
	}
	return ""
}

func repoName(root *config.Root, path string) string {
	if e, ok := root.Repo(path); ok && e.Name != "" {
		return e.Name
	}
	return server.RepoName(root.Name, path)
}

func short(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return s
}

var errSilent = errors.New("")

// label is how a repo is named in messages: its path, or the repo's name
// for a plain repo (path ".").
func label(root *config.Root, repo string) string {
	if repo == "." {
		return root.Name
	}
	return repo
}
