//go:build !linux && !darwin

package worktree

import (
	"context"
	"os/exec"
	"syscall"
)

func alive(pid int) bool { return pid > 0 && syscall.Kill(pid, 0) == nil }

func forceUnmount(ctx context.Context, mp string) { _ = exec.CommandContext(ctx, "umount", mp).Run() }

func isMounted(string) bool { return false }
