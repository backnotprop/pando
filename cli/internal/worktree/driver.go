// Package worktree makes, refreshes and removes Pando worktrees: one branch
// of one repo in its own folder, with its own git folder (formats.md,
// section 1). Two drivers do the mounting: ArtifactFS on Linux (fuse) and a
// blobless sparse clone everywhere else (sparse), until the Mac's FSKit
// mount lands.
package worktree

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"pando/internal/gitx"
)

// Spec is one worktree to make or act on.
type Spec struct {
	Root     string   // absolute Pando root
	Repo     string   // repo path from the root ("." for a plain repo)
	Branch   string   // the branch it holds
	Path     string   // worktree path from the root
	CloneURL string   // the git door URL, from the API
	ReadOnly bool     // worktrees/main
	Paths    []string // sparse only: folders to check out (empty: all)
	Identity Identity

	// A reference (formats.md, section 4): pinned at Commit, read-only, no
	// trailers hook, and fetched with the machine's own git access.
	Reference bool
	Commit    string
}

// Abs is the worktree's absolute folder.
func (s Spec) Abs() string { return filepath.Join(s.Root, filepath.FromSlash(s.Path)) }

// Driver mounts worktrees one way.
type Driver interface {
	Kind() string
	// Add makes the worktree at s.Abs(), installs the trailers hook and
	// points origin at the git door.
	Add(ctx context.Context, s Spec) error
	// Refresh moves a read-only main to the server's main.
	Refresh(ctx context.Context, s Spec) error
	// Remove unmounts and deletes the worktree and its local state.
	Remove(ctx context.Context, s Spec) error
}

// Pick chooses a driver. kind is "", "fuse" or "sparse". With "", Linux
// with /dev/fuse and an artifact-fs binary gets fuse; everything else gets
// sparse.
func Pick(kind, pandoHome string) (Driver, error) {
	switch kind {
	case "sparse":
		return Sparse{}, nil
	case "fuse":
		bin, err := artifactFSBinary()
		if err != nil {
			return nil, err
		}
		if runtime.GOOS != "linux" {
			return nil, errors.New("the fuse driver runs on Linux; on a Mac Pando uses the sparse driver until the FSKit mount lands")
		}
		return &Fuse{Bin: bin, Home: pandoHome}, nil
	case "":
		if runtime.GOOS == "linux" {
			if _, err := os.Stat("/dev/fuse"); err == nil {
				if bin, err := artifactFSBinary(); err == nil {
					return &Fuse{Bin: bin, Home: pandoHome}, nil
				}
			}
		}
		return Sparse{}, nil
	}
	return nil, fmt.Errorf("unknown worktree kind %q (fuse or sparse)", kind)
}

func artifactFSBinary() (string, error) {
	if p := os.Getenv("PANDO_ARTIFACT_FS"); p != "" {
		return p, nil
	}
	p, err := exec.LookPath("artifact-fs")
	if err != nil {
		return "", errors.New("artifact-fs is not on PATH (build it from projects/artifact-fs, or set PANDO_ARTIFACT_FS)")
	}
	return p, nil
}

// credentialScope is scheme://host for an http(s) clone URL, or "".
func credentialScope(cloneURL string) string {
	u, err := url.Parse(cloneURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// credentialConfig is the git config that hands the Pando token to git for
// the server's host through `pando credential`, and only for that host. The
// empty helper first clears other helpers for this host, so no keychain
// keeps a copy of the token. The token itself never appears in config,
// arguments or environment.
func credentialConfig(cloneURL string) [][2]string {
	exe, err := os.Executable()
	if err != nil {
		exe = "pando"
	} else if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return credentialConfigFor(cloneURL, exe)
}

// credentialConfigFor is credentialConfig with the pando binary named. The
// empty value comes first: it clears every helper git inherited for this
// host (Apple's git has osxkeychain in its system config), so git neither
// asks nor stores anywhere else. git adds "get", "store" or "erase".
func credentialConfigFor(cloneURL, exe string) [][2]string {
	scope := credentialScope(cloneURL)
	if scope == "" {
		return nil
	}
	return [][2]string{
		{"credential." + scope + ".helper", ""},
		{"credential." + scope + ".helper", "!'" + strings.ReplaceAll(exe, "'", `'\''`) + "' credential"},
		{"credential." + scope + ".useHttpPath", "true"},
	}
}

// CredentialArgs is credentialConfig as `git -c` arguments.
func CredentialArgs(cloneURL string) []string {
	var args []string
	for _, kv := range credentialConfig(cloneURL) {
		args = append(args, "-c", kv[0]+"="+kv[1])
	}
	return args
}

// CredentialEnv is credentialConfig as GIT_CONFIG_* variables, for
// processes that run git themselves (the ArtifactFS daemon).
func CredentialEnv(cloneURL string) []string {
	kv := credentialConfig(cloneURL)
	if len(kv) == 0 {
		return nil
	}
	env := []string{fmt.Sprintf("GIT_CONFIG_COUNT=%d", len(kv))}
	for i, p := range kv {
		env = append(env, fmt.Sprintf("GIT_CONFIG_KEY_%d=%s", i, p[0]), fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", i, p[1]))
	}
	return env
}

// WriteCredentialConfig stores credentialConfig in a git folder's config so
// git inside the worktree (push, fetch, lazy blob fetches) finds the token.
func WriteCredentialConfig(ctx context.Context, gitDir, cloneURL string) error {
	kv := credentialConfig(cloneURL)
	if len(kv) == 0 {
		return nil
	}
	g := gitx.Cmd{Env: []string{"GIT_DIR=" + gitDir}}
	_, _ = g.Run(ctx, "config", "--unset-all", kv[0][0])
	for _, p := range kv {
		if _, err := g.Run(ctx, "config", "--add", p[0], p[1]); err != nil {
			return err
		}
	}
	return nil
}

// emptyOrMissing reports whether dir is absent or an empty folder.
func emptyOrMissing(dir string) (bool, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return len(entries) == 0, nil
}
