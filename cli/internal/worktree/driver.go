// Package worktree makes, refreshes and removes Pando worktrees: one branch
// of one repo in its own folder, with its own git folder (formats.md,
// section 1). A worktree is a git clone (sparse) on every machine by
// default. The ArtifactFS fork mounts one instead, through FUSE on Linux
// (fuse) or Pando.app's FSKit extension on a Mac (fskit): the default only
// inside a cloud agent's container, and by --kind anywhere else.
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
// every machine gets sparse, a clone with every working file on disk. Inside
// a cloud agent's container (PANDO_AGENT_CONTAINER, set by its image) with
// /dev/fuse and an artifact-fs binary, "" gets fuse: the mount sits next to
// the storage there. A lazy mount on a person's machine took 10 minutes to
// open Next.js in an editor against 8.7 s for a clone (RULINGS, Mount).
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
		if runtime.GOOS == "linux" && os.Getenv("PANDO_AGENT_CONTAINER") != "" {
			if _, err := os.Stat("/dev/fuse"); err == nil {
				if bin, err := artifactFSBinary(); err == nil {
					return &Fuse{Bin: bin, Home: pandoHome}, nil
				}
			}
		}
		return Sparse{}, nil
	}
	return nil, fmt.Errorf("unknown worktree kind %q (fuse, fskit or sparse)", kind)
}

// FSKitOff is why a new fskit mount cannot work on this Mac (Pando.app's
// file system extension is missing or off), or "" when it can. macOS is
// asked once per run.
func FSKitOff() string {
	if st := macState(); !st.Enabled {
		return st.Why
	}
	return ""
}

var macState = sync.OnceValue(func() macbroker.State { return macbroker.Check(context.Background()) })

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
	return credentialConfigFor(cloneURL, helperExe())
}

// helperExe is the binary git runs as the credential helper: this pando.
// PANDO_CREDENTIAL_EXE replaces it in tests, where this process is a test
// binary.
func helperExe() string {
	if v := os.Getenv("PANDO_CREDENTIAL_EXE"); v != "" {
		return v
	}
	exe, err := os.Executable()
	if err != nil {
		return "pando"
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return exe
}

// commandLineConfig is credentialConfig for a git that pando starts for the
// Pando host alone (a clone, the ArtifactFS daemon): the whole helper list
// is cleared first, so no helper from the system or the person's git config
// (Apple's osxkeychain, a person's own) runs or stores the Pando credential.
// A repo's own config keeps the host-scoped reset only, so a person's helpers
// still serve their other remotes there.
func commandLineConfig(cloneURL string) [][2]string {
	kv := credentialConfig(cloneURL)
	if len(kv) == 0 {
		return nil
	}
	return append([][2]string{{"credential.helper", ""}}, kv...)
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
	for _, kv := range commandLineConfig(cloneURL) {
		args = append(args, "-c", kv[0]+"="+kv[1])
	}
	return args
}

// CredentialEnv is credentialConfig as GIT_CONFIG_* variables, for
// processes that run git themselves (the ArtifactFS daemon).
func CredentialEnv(cloneURL string) []string {
	kv := commandLineConfig(cloneURL)
	if len(kv) == 0 {
		return nil
	}
	env := []string{fmt.Sprintf("GIT_CONFIG_COUNT=%d", len(kv))}
	for i, p := range kv {
		env = append(env, fmt.Sprintf("GIT_CONFIG_KEY_%d=%s", i, p[0]), fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", i, p[1]))
	}
	return env
}

// AgentHeader names the agent working through a credential, on API calls
// and on pushes through the git door (the Worker records it; on a merge it
// becomes merged_agent). It is the name in the Pando-Agent trailer.
const AgentHeader = "X-Pando-Agent"

// CleanAgent keeps an agent name safe for an HTTP header: printable ASCII
// only, trimmed, at most 100 characters.
func CleanAgent(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r >= 0x20 && r < 0x7f {
			b.WriteRune(r)
		}
	}
	out := strings.TrimSpace(b.String())
	if len(out) > 100 {
		out = out[:100]
	}
	return out
}

// AgentHeaderArgs is the agent header as `git -c` arguments for one git
// command, scoped to the Pando host; nil without an agent or for a
// non-http(s) remote.
func AgentHeaderArgs(cloneURL, agent string) []string {
	scope, agent := credentialScope(cloneURL), CleanAgent(agent)
	if scope == "" || agent == "" {
		return nil
	}
	return []string{"-c", "http." + scope + "/.extraHeader=" + AgentHeader + ": " + agent}
}

// WriteAgentHeader stores the agent header in a worktree's git config,
// for the Pando host only, so its pushes through the door name the agent.
// With no agent it removes the header.
func WriteAgentHeader(ctx context.Context, gitDir, cloneURL, agent string) error {
	scope := credentialScope(cloneURL)
	if scope == "" {
		return nil
	}
	g := gitx.Cmd{Env: []string{"GIT_DIR=" + gitDir}}
	key := "http." + scope + "/.extraHeader"
	_, _ = g.Run(ctx, "config", "--unset-all", key)
	if agent = CleanAgent(agent); agent == "" {
		return nil
	}
	_, err := g.Run(ctx, "config", "--add", key, AgentHeader+": "+agent)
	return err
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

// GitDir is a worktree's git folder: the sparse clone's .git, or the
// ArtifactFS git folder of a fuse or fskit mount (readable with the mount
// down).
func GitDir(kind, pandoHome string, s Spec) string {
	if kind == "sparse" || kind == "" {
		return filepath.Join(s.Abs(), ".git")
	}
	return (&Fuse{Home: pandoHome}).gitDir(s)
}
