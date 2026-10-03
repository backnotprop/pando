package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"pando/internal/config"
	"pando/internal/gitx"
	"pando/internal/refs"
	"pando/internal/worktree"
)

// Reference is `pando reference update <path>` and `pando reference sync`.
func Reference(e *Env, args []string) error {
	if len(args) > 0 && args[0] == "sync" {
		fs := flags("reference sync")
		kind := fs.String("kind", os.Getenv("PANDO_WORKTREE_KIND"), "fuse or sparse")
		if _, err := parse(fs, args[1:]); err != nil {
			return err
		}
		root, err := e.root()
		if err != nil {
			return err
		}
		return SyncReferences(e, root, *kind)
	}
	if len(args) == 0 || args[0] != "update" {
		return UsageError{"pando reference update <path> | sync"}
	}
	fs := flags("reference update")
	kind := fs.String("kind", os.Getenv("PANDO_WORKTREE_KIND"), "fuse or sparse, for a folder this machine mounts")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return UsageError{"pando reference update <path>"}
	}
	root, err := e.root()
	if err != nil {
		return err
	}
	if root.Kind != config.KindMonorepo {
		return errors.New("a plain repo has no references")
	}
	path, err := root.Rel(e.abs(pos[0]))
	if err != nil {
		return err
	}
	p, err := refs.Read(root.Dir, path)
	if os.IsNotExist(errors.Unwrap(err)) || os.IsNotExist(err) {
		return fmt.Errorf("%s is not a reference (no %s)", path, rel(root.Dir, refs.File(root.Dir, path)))
	}
	if err != nil {
		return err
	}
	out, err := gitx.Cmd{}.Run(e.Ctx, "ls-remote", p.URL, p.Ref)
	if err != nil {
		return fmt.Errorf("asking %s for %s: %w", p.URL, p.Ref, err)
	}
	f := strings.Fields(out)
	if len(f) == 0 {
		return fmt.Errorf("%s has no %s", p.URL, p.Ref)
	}
	newest := f[0]
	if newest == p.Commit {
		e.printf("%s is already at the newest %s commit, %s.\n", path, strings.TrimPrefix(p.Ref, "refs/heads/"), short(newest))
		return nil
	}
	old := p.Commit
	p.Commit = newest
	if err := refs.Write(root.Dir, p); err != nil {
		return err
	}
	e.printf("%s: %s -> %s (%s). The pointer travels with the meta layer; every machine follows.\n",
		path, short(old), short(newest), strings.TrimPrefix(p.Ref, "refs/heads/"))
	return moveLocalReference(e, root, p, old, *kind)
}

// moveLocalReference brings this machine's folder to the pointer's commit.
func moveLocalReference(e *Env, root *config.Root, p refs.Pointer, old, kind string) error {
	dir := root.Abs(p.Path)
	if _, err := os.Lstat(filepath.Join(dir, ".git")); err != nil {
		return mountReference(e, root, p, kind)
	}
	g := gitx.In(dir)
	if v, _ := g.Run(e.Ctx, "config", "--get", "pando.reference"); v == "true" {
		drv, err := worktree.Pick(kind, e.Home.Dir)
		if err != nil {
			return err
		}
		if err := drv.Refresh(e.Ctx, referenceSpec(root, p)); err != nil {
			return fmt.Errorf("%s: %w", p.Path, err)
		}
		e.printf("%s here is now at %s.\n", p.Path, short(p.Commit))
		return nil
	}
	// The original repo on the machine that ran pando init: move it only if
	// that is a clean fast-forward.
	head, _ := g.Run(e.Ctx, "rev-parse", "HEAD")
	dirty, _ := g.Run(e.Ctx, "status", "--porcelain", "--untracked-files=no")
	if head != old || dirty != "" {
		e.printf("%s here is your own checkout (at %s, with changes or other commits); it is left as it is.\n", p.Path, short(head))
		return nil
	}
	if _, err := g.Run(e.Ctx, "fetch", "--quiet", p.URL, p.Ref); err != nil {
		return err
	}
	if _, err := g.Run(e.Ctx, "merge", "--quiet", "--ff-only", p.Commit); err != nil {
		e.printf("%s here could not fast-forward (%v); it is left as it is.\n", p.Path, err)
		return nil
	}
	e.printf("%s here is now at %s.\n", p.Path, short(p.Commit))
	return nil
}

// SyncReferences makes this machine's reference folders match every
// pointer: it mounts the ones not here and moves mounted ones to their
// pointer's commit.
func SyncReferences(e *Env, root *config.Root, kind string) error {
	ptrs, err := refs.List(root.Dir)
	if err != nil {
		return err
	}
	for _, p := range ptrs {
		syncReference(e, root, p, kind)
	}
	return nil
}

// ReferencesHook is the meta layer's hook (meta.Hooks.References): another
// machine's change wrote or removed these pointers (root-relative
// .pando/references/<path>.toml), so this machine's folders follow. The
// meta layer calls it from its own goroutine, one call at a time.
func ReferencesHook(rootDir string, pointers []string) {
	e, err := NewEnv(context.Background(), strings.NewReader(""), os.Stdout, os.Stderr)
	if err != nil {
		return
	}
	root, err := config.LoadRoot(rootDir)
	if err != nil {
		e.warnf("references: %v", err)
		return
	}
	kind := os.Getenv("PANDO_WORKTREE_KIND")
	for _, ptr := range pointers {
		if !strings.HasPrefix(ptr, ".pando/references/") || !strings.HasSuffix(ptr, ".toml") {
			continue
		}
		path := strings.TrimSuffix(strings.TrimPrefix(ptr, ".pando/references/"), ".toml")
		p, err := refs.Read(root.Dir, path)
		if os.IsNotExist(err) || os.IsNotExist(errors.Unwrap(err)) {
			removeReference(e, root, path)
			continue
		}
		if err != nil {
			e.warnf("%s: %v", path, err)
			continue
		}
		syncReference(e, root, p, kind)
	}
}

// syncReference mounts one reference, or moves this machine's mount of it.
func syncReference(e *Env, root *config.Root, p refs.Pointer, kind string) {
	dir := root.Abs(p.Path)
	unavailable := filepath.Join(dir, "PANDO-UNAVAILABLE.txt")
	if _, err := os.Stat(unavailable); err == nil {
		_ = os.Chmod(unavailable, 0o644)
		_ = os.Remove(unavailable)
	}
	if _, err := os.Lstat(filepath.Join(dir, ".git")); err != nil {
		if err := mountReference(e, root, p, kind); err != nil {
			e.warnf("%s: %v", p.Path, err)
		}
		return
	}
	g := gitx.In(dir)
	if v, _ := g.Run(e.Ctx, "config", "--get", "pando.reference"); v != "true" {
		return // the original repo on the machine that has it; left as it is
	}
	if head, _ := g.Run(e.Ctx, "rev-parse", "HEAD"); head == p.Commit {
		return
	}
	mounted, _ := g.Run(e.Ctx, "config", "--get", "pando.kind")
	drv, err := worktree.Pick(mounted, e.Home.Dir)
	if err != nil {
		e.warnf("%s: %v", p.Path, err)
		return
	}
	if err := drv.Refresh(e.Ctx, referenceSpec(root, p)); err != nil {
		e.warnf("%s: %v", p.Path, err)
		return
	}
	e.printf("%s: moved to %s\n", p.Path, short(p.Commit))
}

// removeReference takes away a reference folder this machine mounted, after
// its pointer was removed. The original repo is never touched.
func removeReference(e *Env, root *config.Root, path string) {
	dir := root.Abs(path)
	unavailable := filepath.Join(dir, "PANDO-UNAVAILABLE.txt")
	if _, err := os.Stat(unavailable); err == nil {
		_ = os.Chmod(unavailable, 0o644)
		_ = os.Remove(unavailable)
		_ = os.Remove(dir)
		return
	}
	g := gitx.In(dir)
	if v, _ := g.Run(e.Ctx, "config", "--get", "pando.reference"); v != "true" {
		return
	}
	mounted, _ := g.Run(e.Ctx, "config", "--get", "pando.kind")
	drv, err := worktree.Pick(mounted, e.Home.Dir)
	if err != nil {
		e.warnf("%s: %v", path, err)
		return
	}
	spec := worktree.Spec{Root: root.Dir, Repo: path, Path: path, Reference: true, ReadOnly: true}
	if err := drv.Remove(e.Ctx, spec); err != nil {
		e.warnf("%s: %v", path, err)
		return
	}
	e.printf("%s: reference removed\n", path)
}
