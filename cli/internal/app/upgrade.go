package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"pando/internal/config"
	"pando/internal/gitx"
	"pando/internal/worktree"
)

// upgradeRoot brings a version 1 root (made before monorepos were named
// owner/name) to version 2. It asks the server for the monorepo by its name
// (GET /v1/monorepos?name=, which finds it in the person's own namespace),
// points every git remote here at the server's clone_url (the old
// /<name>/<repo>.git door paths are gone, with no bridge), and saves
// version 2 last: a run cut short is simply done again, and every step is
// safe to repeat.
func (e *Env) upgradeRoot(root *config.Root) error {
	if root.Owner != "" || root.Name == "" || root.Server == "" {
		return nil
	}
	srv, err := e.open(root)
	if err != nil {
		return err
	}
	m, err := resolveMonorepo(e, srv, root.Name)
	if err != nil {
		return err
	}
	repos, err := srv.ListRepos(e.Ctx, m.Full())
	if err != nil {
		return err
	}
	urls := map[string]string{} // repo path -> clone_url
	for _, r := range repos {
		urls[r.Path] = r.CloneURL
	}
	moved, err := e.repointRemotes(root, urls)
	if err != nil {
		return err
	}
	root.Owner, root.Name, root.ID = m.Owner, m.Name, m.ID
	for _, r := range repos {
		root.SetRepo(config.RepoEntry{Path: r.Path, Name: r.Name, CloneURL: r.CloneURL})
	}
	if err := root.Save(); err != nil {
		return err
	}
	e.warnf("this folder's monorepo is now named %s (Pando names monorepos owner/name); %d git remote(s) point at its new address", root.FullName(), moved)
	return nil
}

// repointRemotes sets every git remote here that leads to the Pando server
// to the repo's clone_url, where it differs: each worktree's origin (in its
// own git folder, so a mount that is down is fixed too) and the `pando`
// remote pando init added to the checkouts it pushed from. It returns how
// many it changed. Repeating it changes nothing.
func (e *Env) repointRemotes(root *config.Root, urls map[string]string) (int, error) {
	moved := 0
	set := func(gitDir, remote, url string) error {
		g := gitx.Cmd{Env: []string{"GIT_DIR=" + gitDir}}
		cur, err := g.Run(e.Ctx, "config", "--get", "remote."+remote+".url")
		if err != nil || cur == url {
			return nil // no such remote, or already right
		}
		if _, err := g.Run(e.Ctx, "config", "remote."+remote+".url", url); err != nil {
			return err
		}
		moved++
		return worktree.WriteCredentialConfig(e.Ctx, gitDir, url)
	}
	ws, _ := root.LoadWorktrees()
	inPando := map[string]bool{}
	for _, w := range ws {
		inPando[root.Abs(w.Path)] = true
		url := urls[w.Repo]
		if url == "" {
			continue
		}
		spec := worktree.Spec{Root: root.Dir, Repo: w.Repo, Branch: w.Branch, Path: w.Path, CloneURL: url, ReadOnly: w.ReadOnly}
		gd := worktree.GitDir(w.Kind, e.Home.Dir, spec)
		if _, err := os.Stat(gd); err != nil {
			continue
		}
		if err := set(gd, "origin", url); err != nil {
			return moved, fmt.Errorf("%s: %w", w.Path, err)
		}
		if err := worktree.WriteAgentHeader(e.Ctx, gd, url, w.Agent); err != nil {
			return moved, err
		}
	}
	// The checkouts pando init pushed from: the repo folder itself, or a
	// checkout in its worktrees/ that Pando did not make.
	for path, url := range urls {
		repoAbs := root.Abs(path)
		cands := []string{repoAbs}
		if entries, err := os.ReadDir(filepath.Join(repoAbs, "worktrees")); err == nil {
			for _, d := range entries {
				cands = append(cands, filepath.Join(repoAbs, "worktrees", d.Name()))
			}
		}
		for _, c := range cands {
			if inPando[c] {
				continue
			}
			if _, err := os.Lstat(filepath.Join(c, ".git")); err != nil {
				continue
			}
			gd, err := gitx.In(c).Run(e.Ctx, "rev-parse", "--absolute-git-dir")
			if err != nil {
				continue
			}
			common, err := gitx.In(c).Run(e.Ctx, "rev-parse", "--git-common-dir")
			if err == nil && common != "" {
				if !filepath.IsAbs(common) {
					common = filepath.Join(c, common)
				}
				gd = common
			}
			if err := set(gd, "pando", url); err != nil {
				return moved, fmt.Errorf("%s: %w", c, err)
			}
		}
	}
	return moved, nil
}

// UpgradeRootAt upgrades the Pando folder above dir, if it is version 1, so
// commands outside internal/app (the meta layer's) see owner/name.
func UpgradeRootAt(dir string) error {
	root, err := config.FindRoot(dir)
	if err != nil {
		return nil // not in a Pando folder: the command says so itself
	}
	if root.Owner != "" {
		return nil
	}
	e, err := NewEnv(context.Background(), strings.NewReader(""), os.Stdout, os.Stderr)
	if err != nil {
		return err
	}
	return e.upgradeRoot(root)
}
