package app

import (
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

// Reference is `pando reference update <path>`.
func Reference(e *Env, args []string) error {
	if len(args) == 0 || args[0] != "update" {
		return UsageError{"pando reference update <path>"}
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
