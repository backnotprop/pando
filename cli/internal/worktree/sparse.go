package worktree

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"pando/internal/gitx"
)

// Sparse is the fallback driver: a blobless clone (history and folder
// lists, no file contents until checkout needs them), with
// `git sparse-checkout` when only some folders are wanted. A read-only main
// has its files and folders made read-only, and is refreshed after merges.
type Sparse struct{}

func (Sparse) Kind() string { return "sparse" }

func (Sparse) Add(ctx context.Context, s Spec) error {
	dst := s.Abs()
	ok, err := emptyOrMissing(dst)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%s already exists and is not empty", dst)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	var args []string
	if !s.Reference {
		args = CredentialArgs(s.CloneURL)
	}
	args = append(args, "clone", "--quiet", "--filter=blob:none", "--sparse", "--branch", s.Branch, s.CloneURL, dst)
	if _, err := (gitx.Cmd{}).Run(ctx, args...); err != nil {
		return err
	}
	g := gitx.In(dst)
	gitDir := filepath.Join(dst, ".git")
	// The credential first: checkout and sparse-checkout fetch blobs.
	if !s.Reference {
		if err := WriteCredentialConfig(ctx, gitDir, s.CloneURL); err != nil {
			return err
		}
	}
	if s.Commit != "" {
		if _, err := g.Run(ctx, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", s.Commit); err != nil {
			return err
		}
	}
	if len(s.Paths) > 0 {
		if _, err := g.Run(ctx, append([]string{"sparse-checkout", "set", "--"}, s.Paths...)...); err != nil {
			return err
		}
	} else if _, err := g.Run(ctx, "sparse-checkout", "disable"); err != nil {
		return err
	}
	if s.Reference {
		for _, kv := range [][2]string{{"pando.reference", "true"}, {"pando.kind", "sparse"}} {
			if _, err := g.Run(ctx, "config", kv[0], kv[1]); err != nil {
				return err
			}
		}
		return setWritable(dst, false)
	}
	if err := InstallHook(ctx, gitDir, s.Identity); err != nil {
		return err
	}
	if s.ReadOnly {
		return setWritable(dst, false)
	}
	return nil
}

func (Sparse) Refresh(ctx context.Context, s Spec) error {
	dst := s.Abs()
	if err := setWritable(dst, true); err != nil {
		return err
	}
	g := gitx.In(dst)
	var err error
	if s.Commit != "" {
		if _, err = g.Run(ctx, "fetch", "--quiet", "origin"); err == nil {
			_, err = g.Run(ctx, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", s.Commit)
		}
	} else {
		_, err = g.Run(ctx, "pull", "--quiet", "--ff-only")
	}
	if s.ReadOnly || s.Reference {
		if err2 := setWritable(dst, false); err == nil {
			err = err2
		}
	}
	return err
}

func (Sparse) Remove(_ context.Context, s Spec) error {
	dst := s.Abs()
	if _, err := os.Stat(dst); os.IsNotExist(err) {
		return nil
	}
	if err := setWritable(dst, true); err != nil {
		return err
	}
	return os.RemoveAll(dst)
}

// setWritable adds or removes the write bits on every file and folder under
// dir except .git, which git keeps writing (index, refs) in a read-only main.
func setWritable(dir string, writable bool) error {
	return filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Name() == ".git" && p != dir {
			return filepath.SkipDir
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		mode := info.Mode().Perm()
		next := mode &^ 0o222
		if writable {
			next = mode | 0o200
		}
		if next == mode {
			return nil
		}
		return os.Chmod(p, next)
	})
}
