package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"pando/internal/config"
	"pando/internal/gitx"
	"pando/internal/server"
	"pando/internal/worktree"
)

// Worktree is `pando worktree add | list | remove`.
func Worktree(e *Env, args []string) error {
	if len(args) == 0 {
		return UsageError{"pando worktree add | list | remove | follow | mount"}
	}
	switch args[0] {
	case "add":
		return worktreeAdd(e, args[1:])
	case "list", "ls":
		return worktreeList(e, args[1:])
	case "remove", "rm":
		return worktreeRemove(e, args[1:])
	case "follow":
		return Follow(e, args[1:])
	case "mount":
		return worktreeMount(e, args[1:])
	}
	return UsageError{"unknown worktree command " + args[0]}
}

// worktreeMount is `pando worktree mount`: mount again this machine's
// worktrees whose daemon stopped (after a reboot, say). Sparse worktrees are
// plain folders and need nothing.
func worktreeMount(e *Env, args []string) error {
	if _, err := parse(flags("worktree mount"), args); err != nil {
		return err
	}
	root, err := e.root()
	if err != nil {
		return err
	}
	ws, err := root.LoadWorktrees()
	if err != nil {
		return err
	}
	// First every stale mount, so a daemon started for one worktree can
	// mount its repo's others too.
	for _, w := range ws {
		if w.Kind == "fuse" || w.Kind == "fskit" {
			worktree.ClearStale(e.Ctx, root.Abs(w.Path))
		}
	}
	failed, mounted := 0, 0
	for _, w := range ws {
		drv, err := worktree.Pick(w.Kind, e.Home.Dir)
		if err != nil {
			e.warnf("%s: %v", w.Path, err)
			failed++
			continue
		}
		up, ok := drv.(interface {
			Up(context.Context, worktree.Spec) (bool, error)
		})
		if !ok {
			continue
		}
		entry, _ := root.Repo(w.Repo)
		spec := worktree.Spec{Root: root.Dir, Repo: w.Repo, Branch: w.Branch, Path: w.Path, CloneURL: entry.CloneURL, ReadOnly: w.ReadOnly}
		start := time.Now()
		did, err := up.Up(e.Ctx, spec)
		if err != nil {
			e.warnf("%s: %v", w.Path, err)
			failed++
			continue
		}
		if did {
			mounted++
			e.printf("%s: mounted (%s) in %.1fs\n", w.Path, w.Kind, time.Since(start).Seconds())
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d worktree(s) did not mount", failed)
	}
	if mounted == 0 {
		e.printf("Every worktree here is mounted.\n")
	}
	return nil
}

func worktreeAdd(e *Env, args []string) error {
	fs := flags("worktree add")
	agent := fs.String("agent", "", "the agent working in it (default: PANDO_AGENT); written as the Pando-Agent trailer")
	kind := fs.String("kind", os.Getenv("PANDO_WORKTREE_KIND"), "fuse, fskit or sparse (default: fuse on Linux with artifact-fs, fskit on a Mac with Pando.app on, else sparse)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) < 2 {
		return UsageError{"pando worktree add <repo path> <branch> [folders...]"}
	}
	root, err := e.root()
	if err != nil {
		return err
	}
	repo, err := e.repoArg(root, pos[0])
	if err != nil {
		return err
	}
	w, err := addWorktree(e, root, repo, pos[1], agentName(*agent), *kind, pos[2:])
	if err != nil {
		return err
	}
	e.printf("Next: cd %s\n", rel(e.Cwd, root.Abs(w.Path)))
	return nil
}

// addWorktree makes the branch if needed, mounts it, and reports it.
func addWorktree(e *Env, root *config.Root, repo, branch, agent, kind string, paths []string) (*config.Worktree, error) {
	srv, err := e.open(root)
	if err != nil {
		return nil, err
	}
	entry, ok := root.Repo(repo)
	if !ok || entry.CloneURL == "" {
		r, err := srv.GetRepo(e.Ctx, root.Name, repoName(root, repo))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", repo, err)
		}
		entry = config.RepoEntry{Path: r.Path, Name: r.Name, CloneURL: r.CloneURL}
		root.SetRepo(entry)
		if err := root.Save(); err != nil {
			return nil, err
		}
	}
	wpath := config.WorktreePath(repo, branch)
	if repo == "." {
		wpath = path.Join("worktrees", config.WorktreeFolder(branch))
	}
	ws, err := root.LoadWorktrees()
	if err != nil {
		return nil, err
	}
	for _, w := range ws {
		if w.Path == wpath {
			return nil, fmt.Errorf("%s is already a worktree here (branch %s)", wpath, w.Branch)
		}
	}

	readOnly := branch == "main"
	made := false
	if !readOnly {
		made, err = srv.CreateBranch(e.Ctx, root.Name, entry.Name, branch)
		if err != nil {
			return nil, fmt.Errorf("branch %s: %w", branch, err)
		}
	}

	drv, err := e.pickNew(kind)
	if err != nil {
		return nil, err
	}
	acct, _ := e.Home.Account(root.Server)
	spec := worktree.Spec{
		Root: root.Dir, Repo: repo, Branch: branch, Path: wpath, CloneURL: entry.CloneURL,
		ReadOnly: readOnly, Paths: paths,
		Identity: worktree.Identity{Root: root.Dir, Worktree: wpath, Machine: e.Home.Machine, Agent: agent, Kind: drv.Kind(),
			UserName: acct.Name, UserEmail: acct.Email},
	}
	start := time.Now()
	if err := drv.Add(e.Ctx, spec); err != nil {
		return nil, err
	}
	w := config.Worktree{ID: newWorktreeID(), Repo: repo, Branch: branch, Path: wpath, Kind: drv.Kind(),
		Agent: agent, ReadOnly: readOnly, CreatedAt: time.Now().UTC()}
	if err := root.UpdateWorktrees(func(ws []config.Worktree) ([]config.Worktree, error) {
		return append(ws, w), nil
	}); err != nil {
		return nil, err
	}

	how := "existing branch"
	switch {
	case readOnly:
		how = "main, read-only"
	case made:
		how = "new branch off main"
	}
	e.printf("%s: %s (%s), %s worktree, ready in %.1fs\n", wpath, branch, how, drv.Kind(), time.Since(start).Seconds())
	if !readOnly {
		trail := fmt.Sprintf("Pando-Worktree: %s, Pando-Machine: %s", wpath, e.Home.Machine)
		if agent != "" {
			trail = "Pando-Agent: " + agent + ", " + trail
		}
		if acct.Name != "" {
			e.printf("  commits are authored as %s, with the trailers %s\n", who(acct), trail)
		} else {
			e.printf("  commits get the trailers %s\n", trail)
		}
	}
	if err := report(e, srv, root, w); err != nil {
		e.warnf("the worktree is made, but the server's worktree list did not take it: %v", err)
	}
	return &w, nil
}

func report(e *Env, srv server.Server, root *config.Root, w config.Worktree) error {
	in := server.WorktreeIn{Repo: w.Repo, Branch: w.Branch, Path: w.Path, Machine: e.Home.Machine, Kind: w.Kind}
	if w.Agent != "" {
		a := w.Agent
		in.Agent = &a
	}
	return srv.PutWorktree(e.Ctx, root.Name, w.ID, in)
}

func worktreeList(e *Env, args []string) error {
	fs := flags("worktree list")
	asJSON := fs.Bool("json", false, "print JSON")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	root, err := e.root()
	if err != nil {
		return err
	}
	local, _ := root.LoadWorktrees()
	srv, err := e.open(root)
	var all []server.Worktree
	if err == nil {
		all, err = srv.ListWorktrees(e.Ctx, root.Name)
	}
	if err != nil {
		e.warnf("the server's list is not available (%v); showing this machine only", err)
		for _, w := range local {
			all = append(all, server.Worktree{ID: w.ID, Repo: w.Repo, Branch: w.Branch, Path: w.Path,
				Machine: e.Home.Machine, Agent: w.Agent, Kind: w.Kind, CreatedAt: w.CreatedAt.Format(time.RFC3339)})
		}
	} else {
		// Keep the server current about this machine's worktrees.
		seen := map[string]bool{}
		for _, w := range all {
			seen[w.ID] = true
		}
		for _, w := range local {
			if !seen[w.ID] {
				if report(e, srv, root, w) == nil {
					all = append(all, server.Worktree{ID: w.ID, Repo: w.Repo, Branch: w.Branch, Path: w.Path,
						Machine: e.Home.Machine, Agent: w.Agent, Kind: w.Kind})
				}
			}
		}
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].Path != all[j].Path {
			return all[i].Path < all[j].Path
		}
		return all[i].Machine < all[j].Machine
	})
	if *asJSON {
		b, _ := json.MarshalIndent(map[string]any{"worktrees": all}, "", "  ")
		e.printf("%s\n", b)
		return nil
	}
	// Ahead and behind come from each repo's branch list.
	type ab struct{ ahead, behind *int }
	counts := map[string]ab{}
	if srv != nil {
		repos := map[string]bool{}
		for _, w := range all {
			repos[w.Repo] = true
		}
		for r := range repos {
			if bl, err := srv.ListBranches(e.Ctx, root.Name, repoName(root, r), "all"); err == nil {
				for _, b := range bl.Branches {
					counts[r+"\x00"+b.Name] = ab{b.Ahead, b.Behind}
				}
			}
		}
	}
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "PATH\tBRANCH\tMACHINE\tAGENT\tKIND\tAHEAD\tBEHIND\tSEEN")
	for _, w := range all {
		c := counts[w.Repo+"\x00"+w.Branch]
		machine := w.Machine
		if machine == e.Home.Machine {
			machine += " (here)"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", w.Path, w.Branch, machine, dash(w.Agent), w.Kind,
			num(c.ahead), num(c.behind), ago(w.LastSeenAt))
	}
	return tw.Flush()
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func num(p *int) string {
	if p == nil {
		return "-"
	}
	return fmt.Sprint(*p)
}

func ago(ts string) string {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return "-"
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	}
	return fmt.Sprintf("%dd ago", int(d.Hours()/24))
}

func worktreeRemove(e *Env, args []string) error {
	fs := flags("worktree remove")
	force := fs.Bool("force", false, "remove even with uncommitted or unpushed work")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return UsageError{"pando worktree remove <worktree path> [--force]"}
	}
	root, err := e.root()
	if err != nil {
		return err
	}
	target, err := root.Rel(e.abs(pos[0]))
	if err != nil {
		return err
	}
	ws, err := root.LoadWorktrees()
	if err != nil {
		return err
	}
	idx := -1
	for i, w := range ws {
		if w.Path == target {
			idx = i
		}
	}
	if idx < 0 {
		return fmt.Errorf("%s is not a worktree this machine made", target)
	}
	w := ws[idx]
	if !*force && !w.ReadOnly {
		if msg := unsaved(e, root.Abs(w.Path)); msg != "" {
			return fmt.Errorf("%s has %s; push it first, or pass --force to lose it", w.Path, msg)
		}
	}
	drv, err := worktree.Pick(w.Kind, e.Home.Dir)
	if err != nil {
		return err
	}
	entry, _ := root.Repo(w.Repo)
	spec := worktree.Spec{Root: root.Dir, Repo: w.Repo, Branch: w.Branch, Path: w.Path, CloneURL: entry.CloneURL, ReadOnly: w.ReadOnly}
	if err := drv.Remove(e.Ctx, spec); err != nil {
		return err
	}
	if err := root.UpdateWorktrees(func(ws []config.Worktree) ([]config.Worktree, error) {
		out := ws[:0]
		for _, x := range ws {
			if x.Path != w.Path {
				out = append(out, x)
			}
		}
		return out, nil
	}); err != nil {
		return err
	}
	if srv, err := e.open(root); err == nil {
		if err := srv.DeleteWorktree(e.Ctx, root.Name, w.ID); err != nil {
			e.warnf("removed here, but the server's worktree list still has it: %v", err)
		}
	}
	e.printf("Removed %s. The branch %s stays on the server until it merges.\n", w.Path, w.Branch)
	return nil
}

// unsaved describes uncommitted or unpushed work in a worktree, or "".
func unsaved(e *Env, dir string) string {
	g := gitx.In(dir)
	var parts []string
	if st, err := g.Run(e.Ctx, "status", "--porcelain"); err == nil && st != "" {
		parts = append(parts, fmt.Sprintf("%d uncommitted change(s)", len(strings.Split(st, "\n"))))
	}
	if n, err := g.Run(e.Ctx, "rev-list", "--count", "@{upstream}..HEAD"); err == nil && n != "0" {
		parts = append(parts, n+" unpushed commit(s)")
	} else if err != nil {
		var ge *gitx.Error
		if errors.As(err, &ge) && strings.Contains(ge.Stderr, "no upstream") {
			parts = append(parts, "a branch with no upstream")
		}
	}
	return strings.Join(parts, " and ")
}

// refreshMain moves this machine's read-only main of a repo to the
// server's main, after a merge.
func refreshMain(e *Env, root *config.Root, repo string) {
	ws, _ := root.LoadWorktrees()
	entry, _ := root.Repo(repo)
	for _, w := range ws {
		if w.Repo != repo || w.Branch != "main" {
			continue
		}
		drv, err := worktree.Pick(w.Kind, e.Home.Dir)
		if err != nil {
			e.warnf("%s: %v", w.Path, err)
			continue
		}
		spec := worktree.Spec{Root: root.Dir, Repo: repo, Branch: "main", Path: w.Path, CloneURL: entry.CloneURL, ReadOnly: w.ReadOnly}
		if err := drv.Refresh(e.Ctx, spec); err != nil {
			e.warnf("%s did not update: %v", w.Path, err)
			continue
		}
		head, _ := gitx.In(root.Abs(w.Path)).Run(e.Ctx, "rev-parse", "--short", "HEAD")
		e.printf("%s now at %s\n", w.Path, head)
	}
}
