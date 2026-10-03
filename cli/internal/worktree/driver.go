// Package worktree makes, refreshes and removes Pando worktrees: one branch
// of one repo in its own folder, with its own git folder (formats.md,
// section 1). The ArtifactFS fork mounts them: through FUSE on Linux (fuse)
// and through Pando.app's FSKit extension on a Mac (fskit). A blobless
// sparse clone (sparse) is the fallback everywhere else, and on a Mac
// without Pando.app or with its extension off.
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
	"sync"

	"pando/internal/gitx"
	"pando/internal/macbroker"
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

// Pick chooses a driver. kind is "", "fuse", "fskit" or "sparse". With "",
// Linux with /dev/fuse and an artifact-fs binary gets fuse; a Mac with
// Pando.app's file system extension turned on and an artifact-fs binary gets
// fskit; everything else gets sparse, whose Note says why.
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
			return nil, errors.New("the fuse driver runs on Linux; on a Mac Pando mounts through Pando.app (the fskit driver)")
		}
		return &Fuse{Bin: bin, Home: pandoHome}, nil
	case "fskit":
		// An existing fskit worktree is removed or refreshed with this,
		// so it does not ask whether the extension is still on.
		if runtime.GOOS != "darwin" {
			return nil, errors.New("the fskit driver runs on macOS")
		}
		bin, err := artifactFSBinary()
		if err != nil {
			return nil, err
		}
		return &Fuse{Bin: bin, Home: pandoHome, FSKit: true}, nil
	case "":
		switch runtime.GOOS {
		case "linux":
			if _, err := os.Stat("/dev/fuse"); err == nil {
				if bin, err := artifactFSBinary(); err == nil {
					return &Fuse{Bin: bin, Home: pandoHome}, nil
				}
			}
		case "darwin":
			st := macState()
			if !st.Enabled {
				return Sparse{Why: st.Why}, nil
			}
			bin, err := artifactFSBinary()
			if err != nil {
				return Sparse{Why: err.Error()}, nil
			}
			return &Fuse{Bin: bin, Home: pandoHome, FSKit: true, App: st.App}, nil
		}
		return Sparse{}, nil
	}
	return nil, fmt.Errorf("unknown worktree kind %q (fuse, fskit or sparse)", kind)
}

// macState asks macOS once per run whether the FSKit extension is on.
var macState = sync.OnceValue(func() macbroker.State { return macbroker.Check(context.Background()) })

// Noter is a driver with something to tell the person, such as why a Mac
// fell back to the sparse driver.
type Noter interface{ Note() string }

// artifactFSBinary is PANDO_ARTIFACT_FS, else artifact-fs next to the pando
// binary, else artifact-fs on PATH.
func artifactFSBinary() (string, error) {
	if p := os.Getenv("PANDO_ARTIFACT_FS"); p != "" {
		return p, nil
	}
	if exe, err := os.Executable(); err == nil {
		if r, err := filepath.EvalSymlinks(exe); err == nil {
			exe = r
		}
		p := filepath.Join(filepath.Dir(exe), "artifact-fs")
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	p, err := exec.LookPath("artifact-fs")
	if err != nil {
		return "", errors.New("artifact-fs is not next to pando or on PATH (build it from projects/artifact-fs, or set PANDO_ARTIFACT_FS)")
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

// PostBuffer is git's http.postBuffer for the Pando host: a push's pack up
// to 100 MiB is sent in one request instead of chunked.
const PostBuffer = "104857600"

// credentialConfigFor is credentialConfig with the pando binary named. The
// empty value comes first: it clears every helper git inherited for this
// host (Apple's git has osxkeychain in its system config), so git neither
// asks nor stores anywhere else. git adds "get", "store" or "erase".
//
// Two http settings ride along, for the Pando host only: HTTP/1.1, because
// Apple's git (LibreSSL) over HTTP/2 breaks mid-upload on large pushes
// ("bad record mac"); and a 100 MiB postBuffer, because a chunked HTTP/1.1
// upload hung against the Worker. Measured by server-git: 24 of 24 pushes of
// 12 MiB. The cost: git holds a push's pack in memory, up to 100 MiB.
func credentialConfigFor(cloneURL, exe string) [][2]string {
	scope := credentialScope(cloneURL)
	if scope == "" {
		return nil
	}
	return [][2]string{
		{"credential." + scope + ".helper", ""},
		{"credential." + scope + ".helper", "!'" + strings.ReplaceAll(exe, "'", `'\''`) + "' credential"},
		{"credential." + scope + ".useHttpPath", "true"},
		{"http." + scope + "/.version", "HTTP/1.1"},
		{"http." + scope + "/.postBuffer", PostBuffer},
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
	seen := map[string]bool{}
	for _, p := range kv {
		if !seen[p[0]] {
			seen[p[0]] = true
			_, _ = g.Run(ctx, "config", "--unset-all", p[0])
		}
	}
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
