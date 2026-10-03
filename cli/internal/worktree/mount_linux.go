package worktree

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// alive reports whether pid is a running artifact-fs.
func alive(pid int) bool {
	if pid <= 0 || syscall.Kill(pid, 0) != nil {
		return false
	}
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	return err != nil || strings.Contains(string(b), "artifact-fs")
}

// forceUnmount unmounts a FUSE mount the daemon left behind.
func forceUnmount(ctx context.Context, mp string) {
	for _, c := range [][]string{{"fusermount3", "-u", mp}, {"fusermount", "-u", mp}, {"umount", mp}} {
		if exec.CommandContext(ctx, c[0], c[1:]...).Run() == nil {
			return
		}
	}
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
