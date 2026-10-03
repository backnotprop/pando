package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"pando/internal/config"
	"pando/internal/gitx"
	"pando/internal/refs"
)

// Status is `pando status`: this Pando folder, its repos and worktrees on
// this machine, its references, and whether the server answers.
func Status(e *Env, args []string) error {
	if _, err := parse(flags("status"), args); err != nil {
		return err
	}
	root, err := e.root()
	if err != nil {
		return err
	}
	e.printf("Pando %s %s at %s\n", root.Kind, root.Name, root.Dir)
	acct, _ := e.Home.Account(root.Server)
	srv, err := e.open(root)
	switch {
	case err != nil:
		e.printf("server: %s (%v)\n", root.Server, err)
	default:
		if me, err := srv.Me(e.Ctx, root.Name); err != nil {
			e.printf("server: %s, not answering for you (%v)\n", root.Server, err)
		} else {
			e.printf("server: %s, you are %s (%s)\n", root.Server, me.Name, me.Role)
		}
	}
	if acct.Name != "" {
		e.printf("commits by: %s, machine %s\n", who(acct), e.Home.Machine)
	} else {
		e.printf("machine: %s\n", e.Home.Machine)
	}

	ws, _ := root.LoadWorktrees()
	e.printf("\nRepos (%d):\n", len(root.Repos))
	for _, r := range root.Repos {
		e.printf("  %s\n", r.Path)
		tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
		n := 0
		for _, w := range ws {
			if w.Repo != r.Path {
				continue
			}
			n++
			fmt.Fprintf(tw, "    %s\t%s\t%s\t%s\n", w.Path, w.Branch, w.Kind, worktreeState(e, root, w))
		}
		_ = tw.Flush()
		if n == 0 {
			e.printf("    no worktrees on this machine; pando worktree add %s <branch>\n", r.Path)
		}
	}
	if root.Kind == config.KindMonorepo {
		ptrs, err := refs.List(root.Dir)
		if err != nil {
			e.warnf("references: %v", err)
		}
		e.printf("\nReferences (%d):\n", len(ptrs))
		for _, p := range ptrs {
			e.printf("  %-44s %s at %s, %s\n", p.Path, strings.TrimPrefix(p.Ref, "refs/heads/"), short(p.Commit), referenceState(e, root, p))
		}
	}
	return nil
}

func worktreeState(e *Env, root *config.Root, w config.Worktree) string {
	dir := root.Abs(w.Path)
	if _, err := os.Stat(dir); err != nil {
		return "missing"
	}
	g := gitx.In(dir)
	head, err := g.Run(e.Ctx, "rev-parse", "--short", "HEAD")
	if err != nil {
		return "not mounted"
	}
	parts := []string{"at " + head}
	if w.ReadOnly {
		parts = append(parts, "read-only")
	}
	if st, err := g.Run(e.Ctx, "status", "--porcelain"); err == nil && st != "" {
		parts = append(parts, fmt.Sprintf("%d changed", len(strings.Split(st, "\n"))))
	}
	if lr, err := g.Run(e.Ctx, "rev-list", "--left-right", "--count", "@{upstream}...HEAD"); err == nil {
		f := strings.Fields(lr)
		if len(f) == 2 && (f[0] != "0" || f[1] != "0") {
			parts = append(parts, fmt.Sprintf("%s unpushed, %s to pull", f[1], f[0]))
		}
	}
	return strings.Join(parts, ", ")
}

func referenceState(e *Env, root *config.Root, p refs.Pointer) string {
	dir := root.Abs(p.Path)
	if _, err := os.Stat(filepath.Join(dir, "PANDO-UNAVAILABLE.txt")); err == nil {
		return "unavailable here"
	}
	if _, err := os.Lstat(filepath.Join(dir, ".git")); err != nil {
		return "not here"
	}
	head, _ := gitx.In(dir).Run(e.Ctx, "rev-parse", "HEAD")
	if head == p.Commit {
		return "here"
	}
	return "here at " + short(head)
}
