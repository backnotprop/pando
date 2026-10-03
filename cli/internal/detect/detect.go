// Package detect reads a folder and decides what Pando makes of it
// (docs/contracts/formats.md, section 1): a plain git repo, or a monorepo
// whose projects/* are repos and whose other git repos are references.
// It only reads; pando init acts on the plan.
package detect

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"pando/internal/config"
	"pando/internal/gitx"
)

// Project is a repo Pando will host.
type Project struct {
	Path       string   // repo path from the root ("." for a plain repo)
	Checkout   string   // absolute folder whose git history is pushed
	MainBranch string   // local branch pushed to main
	Head       string   // its commit
	Layout     bool     // already at <path>/worktrees/main
	Others     []string // other folders under <path>/worktrees/, left as they are
	Made       bool     // made by an answer (git init and a first commit)
}

// Reference is someone else's repo, synced as a pointer.
type Reference struct {
	Path   string
	URL    string
	Ref    string
	Commit string
}

// Choice is one answer to a Question.
type Choice struct {
	Key   string // one letter typed at the prompt
	Label string
}

// Question is something init cannot import as it is.
type Question struct {
	Path    string
	Kind    string // "no-history", "no-remote", "no-commits"
	Problem string
	Choices []Choice
	Default string
}

// Plan is what init will do.
type Plan struct {
	Root       string
	Kind       string // config.KindMonorepo or config.KindRepo
	Projects   []Project
	References []Reference
	Questions  []Question
	Notes      []string
	Settings   *config.Settings
}

// Skipped while walking: dependencies, build output and caches never hold a
// reference worth keeping, and walking them is slow.
var skipDirs = map[string]bool{
	".git": true, ".pando": true, "node_modules": true, ".pnpm-store": true,
	".wrangler": true, ".next": true, ".cache": true, "__pycache__": true,
	".venv": true, ".turbo": true, ".DS_Store": true,
}

// Scan reads root and returns the plan.
func Scan(ctx context.Context, root string) (*Plan, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("%s is not a folder", root)
	}
	settings, err := config.LoadSettings(root)
	if err != nil {
		return nil, err
	}
	p := &Plan{Root: root, Settings: settings}
	for _, k := range settings.Unknown {
		p.Notes = append(p.Notes, fmt.Sprintf(".pando/pando.toml: unknown key %q, ignored", k))
	}

	if hasGit(root) {
		p.Kind = config.KindRepo
		pr, q, notes := project(ctx, ".", root)
		p.Notes = append(p.Notes, notes...)
		if q != nil {
			return nil, fmt.Errorf("%s: %s", root, q.Problem)
		}
		p.Projects = append(p.Projects, *pr)
		return p, nil
	}
	// A folder inside someone's git checkout is not a monorepo root.
	if top, err := gitx.In(root).Run(ctx, "rev-parse", "--show-toplevel"); err == nil && top != "" {
		return nil, fmt.Errorf("%s is inside the git repo %s; run pando init there for a plain repo, or in a folder that is not a git repo for a monorepo", root, top)
	}
	p.Kind = config.KindMonorepo

	// 1. projects/*: each folder is a repo unless references = [...] says not.
	projectsDir := filepath.Join(root, "projects")
	entries, err := os.ReadDir(projectsDir)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		rel := "projects/" + e.Name()
		abs := filepath.Join(projectsDir, e.Name())
		if settings.IsReferenceOverride(rel) {
			r, q, notes := reference(ctx, rel, abs)
			p.Notes = append(p.Notes, notes...)
			p.add(r, q)
			continue
		}
		pr, q, notes := projectAt(ctx, rel, abs)
		p.Notes = append(p.Notes, notes...)
		if q != nil {
			p.Questions = append(p.Questions, *q)
			continue
		}
		p.Projects = append(p.Projects, *pr)
	}

	// 2. Every other folder with its own .git is a reference, unless
	// projects = [...] names it.
	err = filepath.WalkDir(root, func(abs string, d fs.DirEntry, err error) error {
		if err != nil {
			if abs == root {
				return err
			}
			return nil // unreadable folders are skipped, not fatal
		}
		if !d.IsDir() || abs == root {
			return nil
		}
		rel, _ := filepath.Rel(root, abs)
		rel = filepath.ToSlash(rel)
		if rel == "projects" || strings.HasPrefix(rel, "projects/") {
			return filepath.SkipDir
		}
		if skipDirs[d.Name()] || localOnly(settings.LocalOnly, rel) {
			return filepath.SkipDir
		}
		if !hasGit(abs) {
			return nil
		}
		if settings.IsProjectOverride(rel) {
			pr, q, notes := project(ctx, rel, abs)
			p.Notes = append(p.Notes, notes...)
			if q != nil {
				p.Questions = append(p.Questions, *q)
			} else {
				p.Projects = append(p.Projects, *pr)
			}
			return filepath.SkipDir
		}
		r, q, notes := reference(ctx, rel, abs)
		p.Notes = append(p.Notes, notes...)
		p.add(r, q)
		return filepath.SkipDir
	})
	if err != nil {
		return nil, err
	}
	// Overrides that name folders that are not there, or not git repos.
	for _, o := range settings.Projects {
		if !p.hasProject(o) && !p.hasQuestion(o) {
			p.Notes = append(p.Notes, fmt.Sprintf(".pando/pando.toml names %s as a project, but it is not a git repo here", o))
		}
	}
	sort.Slice(p.Projects, func(i, j int) bool { return p.Projects[i].Path < p.Projects[j].Path })
	sort.Slice(p.References, func(i, j int) bool { return p.References[i].Path < p.References[j].Path })
	sort.Slice(p.Questions, func(i, j int) bool { return p.Questions[i].Path < p.Questions[j].Path })
	return p, nil
}

func (p *Plan) add(r *Reference, q *Question) {
	if q != nil {
		p.Questions = append(p.Questions, *q)
	} else if r != nil {
		p.References = append(p.References, *r)
	}
}

func (p *Plan) hasProject(rel string) bool {
	for _, x := range p.Projects {
		if x.Path == rel {
			return true
		}
	}
	return false
}

func (p *Plan) hasQuestion(rel string) bool {
	for _, x := range p.Questions {
		if x.Path == rel {
			return true
		}
	}
	return false
}

func hasGit(dir string) bool {
	_, err := os.Lstat(filepath.Join(dir, ".git"))
	return err == nil
}

// projectAt finds a project's git history under projects/<x>: the folder
// itself, its worktrees/main, or any checkout in its worktrees/.
func projectAt(ctx context.Context, rel, abs string) (*Project, *Question, []string) {
	if hasGit(abs) {
		pr, q, notes := project(ctx, rel, abs)
		if pr != nil {
			notes = append(notes, fmt.Sprintf("%s is a checkout at the repo folder; other machines get %s/worktrees/main", rel, rel))
		}
		return pr, q, notes
	}
	wtDir := filepath.Join(abs, "worktrees")
	entries, _ := os.ReadDir(wtDir)
	checkout := ""
	var others []string
	if hasGit(filepath.Join(wtDir, "main")) {
		checkout = filepath.Join(wtDir, "main")
	}
	for _, e := range entries {
		if !e.IsDir() || e.Name() == "main" || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		others = append(others, rel+"/worktrees/"+e.Name())
		if checkout == "" && hasGit(filepath.Join(wtDir, e.Name())) {
			checkout = filepath.Join(wtDir, e.Name())
		}
	}
	if checkout == "" {
		return nil, &Question{
			Path: rel, Kind: "no-history",
			Problem: "has no git history, so it cannot be pushed as a repo",
			Choices: []Choice{{"s", "skip it; its files stay on this machine"}, {"r", "make it a repo: git init and commit its files as the first commit"}},
			Default: "s",
		}, nil
	}
	pr, q, notes := project(ctx, rel, checkout)
	if pr != nil {
		pr.Layout = filepath.Base(checkout) == "main"
		pr.Others = others
		if !pr.Layout {
			notes = append(notes, fmt.Sprintf("%s has no worktrees/main; pushing from %s", rel, checkout))
		}
		for _, o := range others {
			if o != rel+"/worktrees/"+filepath.Base(checkout) {
				notes = append(notes, fmt.Sprintf("%s is left as it is; push its branch with `git push pando <branch>`", o))
			}
		}
	}
	return pr, q, notes
}

// project reads one git checkout that will become a Pando repo.
func project(ctx context.Context, rel, checkout string) (*Project, *Question, []string) {
	g := gitx.In(checkout)
	var notes []string
	head, err := g.Run(ctx, "rev-parse", "--verify", "--quiet", "HEAD")
	if err != nil || head == "" {
		return nil, &Question{
			Path: rel, Kind: "no-commits",
			Problem: "is a git repo with no commits yet, so there is no main to push",
			Choices: []Choice{{"s", "skip it for now"}},
			Default: "s",
		}, nil
	}
	branch := ""
	for _, b := range []string{"main", "master"} {
		if _, err := g.Run(ctx, "rev-parse", "--verify", "--quiet", "refs/heads/"+b); err == nil {
			branch = b
			break
		}
	}
	if branch == "" {
		cur, err := g.Run(ctx, "symbolic-ref", "--quiet", "--short", "HEAD")
		if err != nil || cur == "" {
			return nil, &Question{
				Path: rel, Kind: "no-commits",
				Problem: "has no main or master branch and HEAD is detached; check out the branch that should be main",
				Choices: []Choice{{"s", "skip it for now"}},
				Default: "s",
			}, nil
		}
		branch = cur
		notes = append(notes, fmt.Sprintf("%s has no main or master branch; pushing %s as main", rel, cur))
	} else if branch == "master" {
		notes = append(notes, fmt.Sprintf("%s: pushing master as main", rel))
	}
	commit, _ := g.Run(ctx, "rev-parse", "refs/heads/"+branch)
	if shallow, _ := g.Run(ctx, "rev-parse", "--is-shallow-repository"); shallow == "true" {
		notes = append(notes, fmt.Sprintf("%s is a shallow clone; the push may be refused until it is unshallowed (git fetch --unshallow)", rel))
	}
	return &Project{Path: rel, Checkout: checkout, MainBranch: branch, Head: commit}, nil, notes
}

// reference reads a nested git repo that will be synced as a pointer.
func reference(ctx context.Context, rel, abs string) (*Reference, *Question, []string) {
	g := gitx.In(abs)
	var notes []string
	asProject := []Choice{{"l", "leave it on this machine only (adds it to local_only)"}, {"p", "make it a project (adds it to projects = [...])"}}
	// The raw URL from config, not `git remote get-url`, which applies this
	// machine's insteadOf rewrites (an https URL shown as git@...).
	remote := "origin"
	url, err := g.Run(ctx, "config", "--get", "remote.origin.url")
	if err != nil || url == "" {
		remotes, _ := g.Run(ctx, "remote")
		first := strings.Fields(remotes)
		if len(first) == 0 {
			return nil, &Question{Path: rel, Kind: "no-remote",
				Problem: "is a git repo with no remote, so other machines cannot fetch it as a reference",
				Choices: asProject, Default: "l"}, nil
		}
		remote = first[0]
		url, _ = g.Run(ctx, "config", "--get", "remote."+remote+".url")
	}
	if isLocalURL(url) {
		return nil, &Question{Path: rel, Kind: "no-remote",
			Problem: "has only a local remote (" + url + "), so other machines cannot fetch it as a reference",
			Choices: asProject, Default: "l"}, nil
	}
	if clean, stripped := gitx.StripUserinfo(url); stripped {
		url = clean
		notes = append(notes, fmt.Sprintf("%s: its remote URL holds a user or token; the pointer keeps only %s", rel, url))
	}
	ref := ""
	if sym, err := g.Run(ctx, "symbolic-ref", "--quiet", "refs/remotes/"+remote+"/HEAD"); err == nil && sym != "" {
		ref = "refs/heads/" + strings.TrimPrefix(sym, "refs/remotes/"+remote+"/")
	} else if up, err := g.Run(ctx, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); err == nil && up != "" {
		ref = "refs/heads/" + strings.TrimPrefix(up, remote+"/")
	} else if cur, err := g.Run(ctx, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil && cur != "" {
		ref = "refs/heads/" + cur
	} else {
		ref = "refs/heads/main"
	}
	head, err := g.Run(ctx, "rev-parse", "--verify", "--quiet", "HEAD")
	if err != nil || head == "" {
		return nil, &Question{Path: rel, Kind: "no-commits",
			Problem: "is a git repo with no commits", Choices: asProject[:1], Default: "l"}, nil
	}
	commit := head
	contains, _ := g.Run(ctx, "branch", "-r", "--contains", head)
	if strings.TrimSpace(contains) == "" {
		tracking := "refs/remotes/" + remote + "/" + strings.TrimPrefix(ref, "refs/heads/")
		if up, err := g.Run(ctx, "rev-parse", "--verify", "--quiet", tracking); err == nil && up != "" {
			commit = up
			notes = append(notes, fmt.Sprintf("%s: HEAD has commits its remote does not; the pointer uses %s %s", rel, path.Base(tracking), short(up)))
		} else {
			notes = append(notes, fmt.Sprintf("%s: HEAD %s may not be on its remote; other machines may not be able to fetch it", rel, short(head)))
		}
	}
	return &Reference{Path: rel, URL: url, Ref: ref, Commit: commit}, nil, notes
}

func isLocalURL(u string) bool {
	return strings.HasPrefix(u, "/") || strings.HasPrefix(u, ".") || strings.HasPrefix(u, "~") ||
		strings.HasPrefix(u, "file://")
}

func short(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return s
}

// localOnly matches rel (a folder) against .gitignore-style patterns.
func localOnly(patterns []string, rel string) bool {
	for _, pat := range patterns {
		p := strings.TrimSuffix(pat, "/")
		if p == "" {
			continue
		}
		if !strings.Contains(p, "/") {
			for _, part := range strings.Split(rel, "/") {
				if ok, _ := path.Match(p, part); ok {
					return true
				}
			}
			continue
		}
		p = strings.TrimPrefix(p, "/")
		parts := strings.Split(rel, "/")
		n := len(strings.Split(p, "/"))
		if n <= len(parts) {
			if ok, _ := path.Match(p, strings.Join(parts[:n], "/")); ok {
				return true
			}
		}
	}
	return false
}

// ProjectAt reads one git checkout as a project, for answers that turn a
// folder into a repo.
func ProjectAt(ctx context.Context, rel, checkout string) (*Project, error) {
	pr, q, _ := project(ctx, rel, checkout)
	if q != nil {
		return nil, fmt.Errorf("%s %s", rel, q.Problem)
	}
	return pr, nil
}
