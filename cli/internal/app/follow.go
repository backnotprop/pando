package app

import (
	"context"
	"os"
	"strings"
	"time"

	"pando/internal/config"
	"pando/internal/gitx"
)

// followMains brings every read-only main on this machine to the server's
// main: one branch-list call per repo, and a refresh only where main moved.
func followMains(e *Env, root *config.Root) {
	ws, err := root.LoadWorktrees()
	if err != nil || len(ws) == 0 {
		return
	}
	srv, err := e.open(root)
	if err != nil {
		e.warnf("follow: %v", err)
		return
	}
	heads := map[string]string{}
	for _, w := range ws {
		if w.Branch != "main" || !w.ReadOnly {
			continue
		}
		head, ok := heads[w.Repo]
		if !ok {
			bl, err := srv.ListBranches(e.Ctx, root.Name, repoName(root, w.Repo), "open")
			if err != nil {
				e.warnf("follow %s: %v", w.Repo, err)
				continue
			}
			head = bl.DefaultHead
			heads[w.Repo] = head
		}
		local, err := gitx.In(root.Abs(w.Path)).Run(e.Ctx, "rev-parse", "HEAD")
		if err != nil || head == "" || local == head {
			continue
		}
		refreshMain(e, root, w.Repo)
	}
}

// Follow is `pando worktree follow [--once] [--every 15s]`: keep this
// machine's read-only mains at the server's main until stopped.
func Follow(e *Env, args []string) error {
	fs := flags("worktree follow")
	once := fs.Bool("once", false, "check once and stop")
	every := fs.Duration("every", 15*time.Second, "how often to check")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	root, err := e.root()
	if err != nil {
		return err
	}
	for {
		followMains(e, root)
		if *once {
			return nil
		}
		select {
		case <-e.Ctx.Done():
			return nil
		case <-time.After(*every):
		}
	}
}

// StartFollower runs the follower in the background for the Pando root
// above dir, for as long as ctx lives. `pando meta sync` starts it so one
// daemon keeps a monorepo's meta layer and its mains current.
func StartFollower(ctx context.Context, dir string, every time.Duration) {
	root, err := config.FindRoot(dir)
	if err != nil {
		return
	}
	e, err := NewEnv(ctx, strings.NewReader(""), os.Stdout, os.Stderr)
	if err != nil {
		return
	}
	go func() {
		for {
			followMains(e, root)
			select {
			case <-ctx.Done():
				return
			case <-time.After(every):
			}
		}
	}()
}
