package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"pando/internal/config"
	"pando/internal/gitx"
	"pando/internal/meta"
	"pando/internal/refs"
	"pando/internal/worktree"
)

// Clone is `pando clone <name> [dir]`.
func Clone(e *Env, args []string) error {
	fs := flags("clone")
	srv := fs.String("server", "", "the Pando server URL (default: ~/.pando/config.toml or PANDO_SERVER)")
	kind := fs.String("kind", os.Getenv("PANDO_WORKTREE_KIND"), "fuse, fskit or sparse, for worktrees/main and references (default: the mount when this machine has one)")
	textOnly := fs.Bool("text-only", false, "keep the meta layer's large files and binaries as pointers until pando fetch (sandboxes)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) < 1 || len(pos) > 2 {
		return UsageError{"pando clone <owner/name | name> [folder]"}
	}
	serverURL := strings.TrimRight(*srv, "/")
	if serverURL == "" {
		serverURL = e.Home.Server
	}
	if serverURL == "" {
		return errors.New("no Pando server: pass --server <url>, set PANDO_SERVER, or run `pando login --server <url>`")
	}
	root := &config.Root{Server: serverURL}
	s, err := e.open(root)
	if err != nil {
		return err
	}
	m, err := resolveMonorepo(e, s, pos[0])
	if err != nil {
		return err
	}
	// The folder is the monorepo's name (not owner/name), as git clone does.
	dir := e.abs(m.Name)
	if len(pos) == 2 {
		dir = e.abs(pos[1])
	}
	if entries, err := os.ReadDir(dir); err == nil && len(entries) > 0 {
		return fmt.Errorf("%s exists and is not empty", dir)
	}
	mono := m.Full()
	root.Dir, root.Owner, root.Name, root.ID = dir, m.Owner, m.Name, m.ID
	repos, err := s.ListRepos(e.Ctx, mono)
	if err != nil {
		return err
	}
	root.Kind = m.Kind
	for _, r := range repos {
		root.SetRepo(config.RepoEntry{Path: r.Path, Name: r.Name, CloneURL: r.CloneURL})
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := root.Save(); err != nil {
		return err
	}
	e.printf("Cloning %s %s from %s into %s\n", m.Kind, mono, serverURL, dir)

	if m.Kind == config.KindMonorepo {
		switch {
		case strings.HasPrefix(serverURL, "file://"):
			e.printf("meta layer: none on a file:// server\n")
		default:
			start := time.Now()
			if err := meta.Clone(e.Ctx, dir, meta.CloneOptions{TextOnly: *textOnly}); err != nil {
				e.warnf("meta layer: %v", err)
			} else {
				e.printf("meta layer: downloaded in %.1fs; keep it live with pando meta sync\n", time.Since(start).Seconds())
			}
		}
	}

	// Every repo's read-only main, cloneParallel at a time: 20 repos one
	// after another took 107 to 132 s (load test C22). Each line says when
	// one is ready.
	failed := mountMains(e, root, *kind)
	if m.Kind == config.KindMonorepo {
		ptrs, err := refs.List(dir)
		if err != nil {
			e.warnf("references: %v", err)
		}
		for _, p := range ptrs {
			if err := mountReference(e, root, p, *kind); err != nil {
				e.warnf("%s: %v", p.Path, err)
			}
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d repo(s) did not mount", failed)
	}
	e.printf("Done. cd %s\n", rel(e.Cwd, dir))
	return nil
}

// referenceSpec is the worktree spec for a reference folder.
func referenceSpec(root *config.Root, p refs.Pointer) worktree.Spec {
	return worktree.Spec{Root: root.Dir, Repo: p.Path, Path: p.Path, Branch: strings.TrimPrefix(p.Ref, "refs/heads/"),
		CloneURL: p.URL, Reference: true, Commit: p.Commit, ReadOnly: true}
}

// mountReference shows a reference read-only at its pointer's commit, or
// leaves PANDO-UNAVAILABLE.txt saying why it cannot.
func mountReference(e *Env, root *config.Root, p refs.Pointer, kind string) error {
	dst := root.Abs(p.Path)
	if _, err := os.Lstat(filepath.Join(dst, ".git")); err == nil {
		return nil // the real repo, or already mounted
	}
	drv, err := e.pickNew(kind)
	if err != nil {
		return err
	}
	start := time.Now()
	spec := referenceSpec(root, p)
	if err := drv.Add(e.Ctx, spec); err != nil {
		_ = drv.Remove(e.Ctx, spec)
		if mkErr := os.MkdirAll(dst, 0o755); mkErr != nil {
			return mkErr
		}
		why := gitx.RedactURL(err.Error())
		note := fmt.Sprintf("This folder is a Pando reference: %s at %s.\n"+
			"This machine could not fetch it, so it is shown as unavailable.\n\nWhy: %s\n\n"+
			"A reference that needs a login uses the git access this machine already has.\n",
			p.URL, p.Commit, why)
		if wErr := os.WriteFile(filepath.Join(dst, "PANDO-UNAVAILABLE.txt"), []byte(note), 0o444); wErr != nil {
			return wErr
		}
		e.printf("%s: unavailable here (see %s/PANDO-UNAVAILABLE.txt)\n", p.Path, p.Path)
		return nil
	}
	e.printf("%s: reference at %s, read-only, %s, ready in %.1fs\n", p.Path, short(p.Commit), drv.Kind(), time.Since(start).Seconds())
	return nil
}

// cloneParallel is how many read-only mains pando clone mounts at once.
const cloneParallel = 6

// mountMains makes every repo's read-only main, cloneParallel at a time,
// and returns how many failed.
func mountMains(e *Env, root *config.Root, kind string) int {
	if len(root.Repos) > 1 {
		e.printf("Mounting %d repos' main, %d at a time\n", len(root.Repos), min(cloneParallel, len(root.Repos)))
	}
	start := time.Now()
	sem := make(chan struct{}, cloneParallel)
	var wg sync.WaitGroup
	var mu sync.Mutex
	failed := 0
	for _, r := range root.Repos {
		wg.Add(1)
		sem <- struct{}{}
		go func(path string) {
			defer wg.Done()
			defer func() { <-sem }()
			if _, err := addWorktree(e, root, path, "main", "", kind, nil); err != nil {
				e.warnf("%s: %v", path, err)
				mu.Lock()
				failed++
				mu.Unlock()
			}
		}(r.Path)
	}
	wg.Wait()
	if len(root.Repos) > 1 {
		e.printf("%d of %d mains ready in %.1fs\n", len(root.Repos)-failed, len(root.Repos), time.Since(start).Seconds())
	}
	return failed
}
