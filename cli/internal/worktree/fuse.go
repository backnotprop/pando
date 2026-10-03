package worktree

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"pando/internal/gitx"
)

// Fuse drives the ArtifactFS fork (projects/artifact-fs) on Linux. Each repo
// folder gets its own ArtifactFS state root and daemon, so worktree names
// only need to be unique within a repo and every mount lands exactly at
// <repo>/worktrees/<name>. Each worktree has its own blobless git folder,
// blob cache and edit layer in that state root.
//
// worktrees/main is mounted out of sight and bind-mounted read-only into
// place, which needs root (as in the test bed's container). Without root it
// is mounted writable in place, with a warning; a read-only flag in the fork
// is the lasting fix.
type Fuse struct {
	Bin  string // the artifact-fs binary
	Home string // ~/.pando
	Warn func(string)
}

func (f *Fuse) Kind() string { return "fuse" }

func (f *Fuse) warn(msg string) {
	if f.Warn != nil {
		f.Warn(msg)
	}
}

// stateDir is ~/.pando/afs/<repo folder>-<hash>: ARTIFACT_FS_ROOT for one repo.
func (f *Fuse) stateDir(s Spec) string {
	repoAbs := filepath.Join(s.Root, filepath.FromSlash(s.Repo))
	sum := sha256.Sum256([]byte(repoAbs))
	base := filepath.Base(repoAbs)
	return filepath.Join(f.Home, "afs", base+"-"+hex.EncodeToString(sum[:])[:10])
}

func (f *Fuse) name(s Spec) string { return filepath.Base(s.Abs()) }

// hidden reports whether this worktree mounts out of sight and is bound
// read-only into place.
func (f *Fuse) hidden(s Spec) bool { return (s.ReadOnly || s.Reference) && os.Geteuid() == 0 }

// mountPath is where ArtifactFS mounts it: the worktree folder itself, or a
// hidden folder for a read-only main.
func (f *Fuse) mountPath(s Spec) string {
	if f.hidden(s) {
		return filepath.Join(f.stateDir(s), "ro", f.name(s))
	}
	return s.Abs()
}

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
	if (s.ReadOnly || s.Reference) && !f.hidden(s) {
		f.warn(s.Path + " is mounted writable: a read-only mount needs root here (or a --read-only flag in the ArtifactFS fork)")
	}
	state := f.stateDir(s)
	mp := f.mountPath(s)
	for _, d := range []string{state, filepath.Dir(mp), mp} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	// A worktree removed earlier under the same name may have left a
	// registry entry or state behind.
	_, _ = f.run(ctx, s, "remove-repo", "--name", f.name(s))
	f.cleanState(s)
	if _, err := f.run(ctx, s, "add-repo",
		"--name", f.name(s),
		"--remote", s.CloneURL,
		"--ref", "refs/heads/"+s.Branch,
		"--mount-root", filepath.Dir(mp),
	); err != nil {
		return err
	}
	gd := f.gitDir(s)
	if s.Reference {
		if _, err := (gitx.Cmd{Env: []string{"GIT_DIR=" + gd}}).Run(ctx, "config", "pando.reference", "true"); err != nil {
			return err
		}
	} else {
		if err := writeCredentialConfig(ctx, gd, s.CloneURL); err != nil {
			return err
		}
		if err := InstallHook(ctx, gd, s.Identity); err != nil {
			return err
		}
	}
	if err := f.ensureDaemon(s); err != nil {
		return err
	}
	if err := waitMount(mp, true, 90*time.Second); err != nil {
		return fmt.Errorf("%w (daemon log: %s)", err, filepath.Join(state, "daemon.log"))
	}
	if s.Commit != "" {
		if _, err := gitx.In(mp).Run(ctx, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", s.Commit); err != nil {
			return err
		}
	}
	if f.hidden(s) {
		if err := os.MkdirAll(dst, 0o755); err != nil {
			return err
		}
		if out, err := exec.CommandContext(ctx, "mount", "--bind", mp, dst).CombinedOutput(); err != nil {
			return fmt.Errorf("bind mount %s: %s", dst, strings.TrimSpace(string(out)))
		}
		if out, err := exec.CommandContext(ctx, "mount", "-o", "remount,bind,ro", dst).CombinedOutput(); err != nil {
			return fmt.Errorf("read-only remount %s: %s", dst, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

// Refresh fast-forwards main through the writable mount; ArtifactFS sees
// HEAD move and publishes the new tree, and the read-only view follows.
func (f *Fuse) Refresh(ctx context.Context, s Spec) error {
	g := gitx.In(f.mountPath(s))
	if s.Commit != "" {
		if _, err := g.Run(ctx, "fetch", "--quiet", "origin"); err != nil {
			return err
		}
		_, err := g.Run(ctx, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", s.Commit)
		return err
	}
	_, err := g.Run(ctx, "pull", "--quiet", "--ff-only")
	return err
}

func (f *Fuse) Remove(ctx context.Context, s Spec) error {
	dst := s.Abs()
	mp := f.mountPath(s)
	if f.hidden(s) && isMounted(dst) {
		if out, err := exec.CommandContext(ctx, "umount", dst).CombinedOutput(); err != nil {
			return fmt.Errorf("umount %s: %s", dst, strings.TrimSpace(string(out)))
		}
	}
	if _, err := f.run(ctx, s, "remove-repo", "--name", f.name(s)); err != nil &&
		!strings.Contains(err.Error(), "not found") && !strings.Contains(err.Error(), "no rows") {
		return err
	}
	// The daemon notices the removal within a few seconds and unmounts.
	if err := waitMount(mp, false, 20*time.Second); err != nil {
		for _, c := range [][]string{{"fusermount3", "-u", mp}, {"fusermount", "-u", mp}, {"umount", mp}} {
			if exec.CommandContext(ctx, c[0], c[1:]...).Run() == nil {
				break
			}
		}
		if isMounted(mp) {
			return fmt.Errorf("%s is still mounted", mp)
		}
	}
	f.cleanState(s)
	_ = os.Remove(mp)
	_ = os.Remove(dst)
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

func alive(pid int) bool {
	if pid <= 0 || syscall.Kill(pid, 0) != nil {
		return false
	}
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	return err != nil || strings.Contains(string(b), "artifact-fs")
}

// isMounted reads /proc/self/mountinfo (Linux).
func isMounted(p string) bool {
	fh, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return false
	}
	defer fh.Close()
	sc := bufio.NewScanner(fh)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) > 4 && unescapeMount(fields[4]) == p {
			return true
		}
	}
	return false
}

func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
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
