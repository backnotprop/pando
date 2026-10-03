package worktree

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"pando/internal/gitx"
	"pando/internal/macbroker"
)

// Fuse drives the ArtifactFS fork (projects/artifact-fs): through FUSE on
// Linux, and on a Mac (FSKit set) through Pando.app's FSKit extension, which
// the fork's darwin build mounts with /sbin/mount -F -t pando. Each repo
// folder gets its own ArtifactFS state root and daemon, so worktree names
// only need to be unique within a repo and every mount lands exactly at
// <repo>/worktrees/<name>. Each worktree has its own blobless git folder,
// blob cache and edit layer in that state root.
//
// worktrees/main and references mount read-only (add-repo --read-only, from
// the fork): writes fail with EROFS, no root needed. They move only through
// their git folder (Refresh), never through the mount.
type Fuse struct {
	Bin   string // the artifact-fs binary
	Home  string // ~/.pando
	FSKit bool   // a Mac: the volume is Pando.app's FSKit extension
	App   string // FSKit: the installed Pando.app ("" finds it through pluginkit)
}

func (f *Fuse) Kind() string {
	if f.FSKit {
		return "fskit"
	}
	return "fuse"
}

// stateDir is ~/.pando/afs/<repo folder>-<hash>: ARTIFACT_FS_ROOT for one repo.
func (f *Fuse) stateDir(s Spec) string {
	repoAbs := filepath.Join(s.Root, filepath.FromSlash(s.Repo))
	sum := sha256.Sum256([]byte(repoAbs))
	base := filepath.Base(repoAbs)
	return filepath.Join(f.Home, "afs", base+"-"+hex.EncodeToString(sum[:])[:10])
}

func (f *Fuse) name(s Spec) string { return filepath.Base(s.Abs()) }

// mountPath is where ArtifactFS mounts it: the worktree folder itself.
func (f *Fuse) mountPath(s Spec) string { return s.Abs() }

func (f *Fuse) gitDir(s Spec) string {
	return filepath.Join(f.stateDir(s), "repos", f.name(s), "git")
}

func (f *Fuse) env(s Spec) []string {
	env := []string{"ARTIFACT_FS_ROOT=" + f.stateDir(s)}
	if !s.Reference {
		env = append(env, CredentialEnv(s.CloneURL)...)
	}
	return env
}

func (f *Fuse) run(ctx context.Context, s Spec, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, f.Bin, args...)
	cmd.Env = append(os.Environ(), f.env(s)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("artifact-fs %s: %s", args[0], lastLines(gitx.RedactURL(string(out)), 5))
	}
	return string(out), nil
}

func (f *Fuse) Add(ctx context.Context, s Spec) error {
	dst := s.Abs()
	ok, err := emptyOrMissing(dst)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%s already exists and is not empty", dst)
	}
	state := f.stateDir(s)
	mp := f.mountPath(s)
	for _, d := range []string{state, filepath.Dir(mp), mp} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	if f.FSKit {
		// The extension reaches the daemon through Pando.app's broker,
		// which launchd starts on demand once its LaunchAgent is loaded.
		app := f.App
		if app == "" {
			app = macbroker.AppPath(ctx)
		}
		if err := macbroker.Ensure(ctx, app, false, io.Discard); err != nil {
			return fmt.Errorf("Pando.app's broker: %w", err)
		}
	}
	// A worktree removed earlier under the same name may have left a
	// registry entry or state behind.
	_, _ = f.run(ctx, s, "remove-repo", "--name", f.name(s))
	f.cleanState(s)
	args := []string{"add-repo",
		"--name", f.name(s),
		"--remote", s.CloneURL,
		"--ref", "refs/heads/" + s.Branch,
		"--mount-root", filepath.Dir(mp),
	}
	if s.ReadOnly || s.Reference {
		args = append(args, "--read-only")
	}
	if _, err := f.run(ctx, s, args...); err != nil {
		if strings.Contains(err.Error(), "flag provided but not defined: -read-only") {
			return errors.New("this artifact-fs has no --read-only; build it from the fork's main (projects/artifact-fs)")
		}
		return err
	}
	gd := f.gitDir(s)
	if s.Reference {
		for _, kv := range [][2]string{{"pando.reference", "true"}, {"pando.kind", f.Kind()}} {
			if _, err := (gitx.Cmd{Env: []string{"GIT_DIR=" + gd}}).Run(ctx, "config", kv[0], kv[1]); err != nil {
				return err
			}
		}
	} else {
		if err := WriteCredentialConfig(ctx, gd, s.CloneURL); err != nil {
			return err
		}
		if err := InstallHook(ctx, gd, s.Identity); err != nil {
			return err
		}
	}
	logPath := filepath.Join(state, "daemon.log")
	var logStart int64
	if st, err := os.Stat(logPath); err == nil {
		logStart = st.Size()
	}
	if err := f.ensureDaemon(s); err != nil {
		return err
	}
	if err := waitAdded(mp, logPath, logStart, f.name(s), 90*time.Second); err != nil {
		return fmt.Errorf("%w (daemon log: %s)", err, logPath)
	}
	if s.Commit != "" {
		// Pin through the git folder, never by a checkout through the
		// mount: that would leave copies in the edit layer that later
		// shadow the published tree.
		if err := f.Refresh(ctx, s); err != nil {
			return err
		}
	}
	return nil
}

// Up mounts an existing worktree again when its daemon stopped (a reboot, a
// killed process). The repo's daemon mounts every worktree registered with
// it, so one call brings back the repo's other worktrees too.
func (f *Fuse) Up(ctx context.Context, s Spec) (bool, error) {
	mp := f.mountPath(s)
	// A FUSE mount outlives its daemon (stale, "transport endpoint is not
	// connected"), and so does an FSKit volume (EIO), so a mount alone is
	// not proof.
	if f.daemonAlive(s) && mountWorks(mp) {
		return false, nil
	}
	ClearStale(ctx, mp)
	if f.FSKit {
		if err := macbroker.Ensure(ctx, macbroker.AppPath(ctx), false, io.Discard); err != nil {
			return false, fmt.Errorf("Pando.app's broker: %w", err)
		}
	}
	logPath := filepath.Join(f.stateDir(s), "daemon.log")
	var logStart int64
	if st, err := os.Stat(logPath); err == nil {
		logStart = st.Size()
	}
	if err := f.ensureDaemon(s); err != nil {
		return false, err
	}
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if mountWorks(mp) {
			return true, nil
		}
		if why := mountFailure(logPath, logStart, f.name(s)); why != "" {
			return false, fmt.Errorf("%s did not mount: %s (daemon log: %s)", mp, why, logPath)
		}
		time.Sleep(300 * time.Millisecond)
	}
	return false, fmt.Errorf("the mount did not come back at %s (daemon log: %s)", mp, logPath)
}

// mountWorks reports whether p is mounted and answers: listing it works.
// (Listings are never cached, unlike attributes.)
func mountWorks(p string) bool {
	if !isMounted(p) {
		return false
	}
	d, err := os.Open(p)
	if err != nil {
		return false
	}
	defer d.Close()
	_, err = d.Readdirnames(1)
	return err == nil || errors.Is(err, io.EOF)
}

// ClearStale unmounts p when it is mounted but nobody serves it, so a daemon
// started again can mount there.
func ClearStale(ctx context.Context, p string) {
	if isMounted(p) && !mountWorks(p) {
		forceUnmount(ctx, p)
	}
}

// daemonAlive reports whether the repo's daemon is running.
func (f *Fuse) daemonAlive(s Spec) bool {
	b, err := os.ReadFile(filepath.Join(f.stateDir(s), "daemon.pid"))
	if err != nil {
		return false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	return err == nil && alive(pid)
}

// Refresh moves a read-only main to the server's main, or a reference to
// its pointer's commit, without writing through the mount: it fetches into
// the worktree's git folder, moves the ref, updates the index with a
// two-tree read-tree (cached stat data stays for unchanged files, so
// git status downloads nothing new), and waits for ArtifactFS to publish
// the new tree. So it works on a read-only mount.
func (f *Fuse) Refresh(ctx context.Context, s Spec) error {
	gd := f.gitDir(s)
	g := gitx.Cmd{Env: append([]string{"GIT_DIR=" + gd}, f.envGit(s)...)}
	old, err := g.Run(ctx, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	target := s.Commit
	if target != "" {
		if _, err := g.Run(ctx, "cat-file", "-e", target+"^{commit}"); err != nil {
			if _, err := g.Run(ctx, "fetch", "--quiet", "origin"); err != nil {
				return err
			}
		}
	} else {
		if _, err := g.Run(ctx, "fetch", "--quiet", "origin", s.Branch); err != nil {
			return err
		}
		if target, err = g.Run(ctx, "rev-parse", "refs/remotes/origin/"+s.Branch); err != nil {
			return err
		}
		if _, err := g.Run(ctx, "merge-base", "--is-ancestor", old, target); err != nil {
			return fmt.Errorf("%s: the server's %s is not a fast-forward of %s", s.Path, s.Branch, old[:7])
		}
	}
	if target == old {
		return nil
	}
	if _, err := g.Run(ctx, "read-tree", "-m", old, target); err != nil {
		return err
	}
	if s.Commit != "" {
		_, err = g.Run(ctx, "update-ref", "--no-deref", "HEAD", target, old)
	} else {
		_, err = g.Run(ctx, "update-ref", "refs/heads/"+s.Branch, target, old)
	}
	if err != nil {
		return err
	}
	// The daemon's watcher sees HEAD move within a second and publishes.
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if out, err := f.run(ctx, s, "status", "--name", f.name(s)); err == nil && strings.Contains(out, "head="+target) {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("%s: ArtifactFS did not publish %s in time", s.Path, target[:7])
}

// envGit is the credential environment for git run on a worktree's git
// folder (none for references, which use the machine's own access).
func (f *Fuse) envGit(s Spec) []string {
	if s.Reference {
		return nil
	}
	return CredentialEnv(s.CloneURL)
}

func (f *Fuse) Remove(ctx context.Context, s Spec) error {
	mp := f.mountPath(s)
	if _, err := f.run(ctx, s, "remove-repo", "--name", f.name(s)); err != nil &&
		!strings.Contains(err.Error(), "not found") && !strings.Contains(err.Error(), "no rows") {
		return err
	}
	// The daemon notices the removal within a few seconds and unmounts.
	if err := waitMount(mp, false, 20*time.Second); err != nil {
		forceUnmount(ctx, mp)
		if isMounted(mp) {
			return fmt.Errorf("%s is still mounted", mp)
		}
	}
	f.cleanState(s)
	_ = os.Remove(mp)
	return nil
}

// cleanState deletes one worktree's git folder, edit layer, blob cache and
// snapshot database.
func (f *Fuse) cleanState(s Spec) {
	state, n := f.stateDir(s), f.name(s)
	for _, p := range []string{
		filepath.Join(state, "repos", n),
		filepath.Join(state, "overlays", n),
		filepath.Join(state, "cache", "blobs", n),
	} {
		_ = os.RemoveAll(p)
	}
	matches, _ := filepath.Glob(filepath.Join(state, "meta", n+".sqlite*"))
	for _, m := range matches {
		_ = os.Remove(m)
	}
}

// ensureDaemon starts the repo's artifact-fs daemon unless it is running.
func (f *Fuse) ensureDaemon(s Spec) error {
	state := f.stateDir(s)
	// Several worktree adds at once (agents) must start one daemon, not one
	// each: two daemons on one state root fight over the same mounts.
	lk, err := os.OpenFile(filepath.Join(state, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lk.Close()
	if err := syscall.Flock(int(lk.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lk.Fd()), syscall.LOCK_UN)
	pidFile := filepath.Join(state, "daemon.pid")
	if b, err := os.ReadFile(pidFile); err == nil {
		if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && alive(pid) {
			return nil
		}
	}
	logf, err := os.OpenFile(filepath.Join(state, "daemon.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer logf.Close()
	cmd := exec.Command(f.Bin, "daemon", "--root", filepath.Join(state, "mnt"))
	cmd.Env = append(os.Environ(), f.env(s)...)
	cmd.Stdout, cmd.Stderr = logf, logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	if err := os.WriteFile(pidFile, []byte(strconv.Itoa(cmd.Process.Pid)+"\n"), 0o644); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// waitAdded waits for a new worktree's mount. When the daemon logs that
// mounting failed (it retries with a back-off), it stops waiting and returns
// the daemon's reason, which says what to do (the Mac's FSKit messages do).
func waitAdded(mp, logPath string, logStart int64, name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if isMounted(mp) {
			return nil
		}
		if why := mountFailure(logPath, logStart, name); why != "" {
			return fmt.Errorf("%s did not mount: %s", mp, why)
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("the mount did not appear at %s", mp)
}

// mountFailure is the error of the first "mount failed" line the daemon
// logged for repo name after offset start, or "".
func mountFailure(logPath string, start int64, name string) string {
	fh, err := os.Open(logPath)
	if err != nil {
		return ""
	}
	defer fh.Close()
	if _, err := fh.Seek(start, io.SeekStart); err != nil {
		return ""
	}
	sc := bufio.NewScanner(fh)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if !bytes.Contains(line, []byte("mount failed")) {
			continue
		}
		var rec struct {
			Msg   string `json:"msg"`
			Repo  string `json:"repo"`
			Error string `json:"error"`
		}
		if json.Unmarshal(line, &rec) == nil && rec.Repo == name && rec.Error != "" {
			return gitx.RedactURL(rec.Error)
		}
	}
	return ""
}

func waitMount(p string, want bool, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if isMounted(p) == want {
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	if want {
		return fmt.Errorf("the mount did not appear at %s", p)
	}
	return errors.New("the mount did not go away at " + p)
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}
