package worktree

import (
	"bytes"
	"context"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// alive reports whether pid is a running artifact-fs.
func alive(pid int) bool {
	if pid <= 0 || syscall.Kill(pid, 0) != nil {
		return false
	}
	out, err := exec.Command("/bin/ps", "-p", strconv.Itoa(pid), "-o", "comm=").Output()
	return err != nil || strings.Contains(string(out), "artifact-fs")
}

// forceUnmount unmounts an FSKit volume the daemon left behind.
func forceUnmount(ctx context.Context, mp string) {
	if exec.CommandContext(ctx, "/sbin/umount", mp).Run() == nil {
		return
	}
	_ = exec.CommandContext(ctx, "/usr/sbin/diskutil", "unmount", "force", mp).Run()
}

// isMounted lists the mount table (getfsstat with MNT_NOWAIT), so it never
// calls into the volume itself, which may be waiting on a stopped daemon.
func isMounted(p string) bool {
	// The table has real paths (/private/tmp, not /tmp). Resolve the parent
	// only: resolving p itself would look inside the mount.
	if dir, err := filepath.EvalSymlinks(filepath.Dir(p)); err == nil {
		p = filepath.Join(dir, filepath.Base(p))
	}
	n, err := syscall.Getfsstat(nil, 2 /* MNT_NOWAIT */)
	if err != nil || n <= 0 {
		return false
	}
	buf := make([]syscall.Statfs_t, n+8)
	n, err = syscall.Getfsstat(buf, 2)
	if err != nil {
		return false
	}
	for _, st := range buf[:n] {
		on := make([]byte, 0, len(st.Mntonname))
		for _, c := range st.Mntonname {
			if c == 0 {
				break
			}
			on = append(on, byte(c))
		}
		if bytes.Equal(on, []byte(p)) {
			return true
		}
	}
	return false
}
