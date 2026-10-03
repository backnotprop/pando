package app

import (
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strings"

	"pando/internal/config"
	"pando/internal/detect"
	"pando/internal/gitx"
	"pando/internal/refs"
	"pando/internal/server"
	"pando/internal/worktree"
)

var nameRe = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._]|-(?:[^-]|$)){0,38}$`)

func validName(n string) bool {
	return nameRe.MatchString(n) && !strings.Contains(n, "--") && len(n) <= 39 && n != "v1" && n != "healthz"
}

// Init is `pando init [path]`.
func Init(e *Env, args []string) error {
	fs := flags("init")
	name := fs.String("name", "", "the monorepo's name on the server (default: the folder's name)")
	srv := fs.String("server", "", "the Pando server URL (default: ~/.pando/config.toml or PANDO_SERVER)")
	yes := fs.Bool("yes", false, "take the default answer to every question")
	dry := fs.Bool("dry-run", false, "show what would happen and change nothing")
	person := fs.String("person", "", "your name on the server (default: your login name)")
	email := fs.String("email", "", "your email, for merge commits (default: git config user.email)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) > 1 {
		return UsageError{"pando init takes at most one folder"}
	}
	dir := e.Cwd
	if len(pos) == 1 {
		dir = e.abs(pos[0])
	}

	var existing *config.Root
	if r, err := config.LoadRoot(dir); err == nil {
		existing = r
	}

	plan, err := detect.Scan(e.Ctx, dir)
	if err != nil {
		return err
	}
	if existing != nil && existing.Kind != plan.Kind {
		return fmt.Errorf("%s is already a Pando %s named %s", dir, existing.Kind, existing.Name)
	}

	printPlan(e, plan)

	// Answers.
	var addProjects, addLocal []string
	if len(plan.Questions) > 0 {
		interactive := e.isTerminal() && !*yes && !*dry
		e.printf("\nNeeds an answer (%d):\n", len(plan.Questions))
		for _, q := range plan.Questions {
			ans := q.Default
			e.printf("  %s %s\n", q.Path, q.Problem)
			for _, c := range q.Choices {
				mark := " "
				if c.Key == q.Default {
					mark = "*"
				}
				e.printf("    %s[%s] %s\n", mark, c.Key, c.Label)
			}
			if interactive {
				e.printf("    answer [%s]: ", q.Default)
				line, err := e.readLine()
				if err != nil {
					return err
				}
				if line != "" {
					ans = strings.ToLower(line[:1])
				}
			}
			valid := false
			for _, c := range q.Choices {
				valid = valid || c.Key == ans
			}
			if !valid {
				ans = q.Default
			}
			if !interactive {
				e.printf("    taking [%s]\n", ans)
			}
			switch {
			case q.Kind == "no-history" && ans == "r":
				if *dry {
					e.printf("    would run git init and commit its files\n")
					continue
				}
				pr, err := makeRepo(e, plan.Root, q.Path)
				if err != nil {
					return fmt.Errorf("%s: %w", q.Path, err)
				}
				plan.Projects = append(plan.Projects, *pr)
			case q.Kind == "no-remote" && ans == "p":
				addProjects = append(addProjects, q.Path)
				if !*dry {
					plan2, err := detect.ProjectAt(e.Ctx, q.Path, filepath.Join(plan.Root, filepath.FromSlash(q.Path)))
					if err != nil {
						return err
					}
					plan.Projects = append(plan.Projects, *plan2)
				}
			case q.Kind == "no-remote" && ans == "l":
				addLocal = append(addLocal, q.Path+"/")
			}
		}
	}
	if *dry {
		e.printf("\nDry run: nothing changed.\n")
		return nil
	}

	// The server and the monorepo.
	serverURL := strings.TrimRight(*srv, "/")
	if serverURL == "" && existing != nil {
		serverURL = existing.Server
	}
	if serverURL == "" {
		serverURL = e.Home.Server
	}
	if serverURL == "" {
		return errors.New("no Pando server: pass --server <url>, set PANDO_SERVER, or run `pando login --server <url>`")
	}
	mono := *name
	if mono == "" && existing != nil {
		mono = existing.Name
	}
	if mono == "" {
		mono = filepath.Base(plan.Root)
	}
	if !validName(mono) {
		return fmt.Errorf("%q cannot be a monorepo name (letters, digits, '.', '_', '-'; no '--'; at most 39); pass --name", mono)
	}

	srvc, repos, err := ensureMonorepo(e, serverURL, mono, plan.Kind, *person, *email)
	if err != nil {
		return err
	}

	root := &config.Root{Dir: plan.Root, Kind: plan.Kind, Name: mono, Server: serverURL}
	if existing != nil {
		root.Repos = existing.Repos
	}
	for _, r := range repos {
		root.SetRepo(config.RepoEntry{Path: r.Path, Name: r.Name, CloneURL: r.CloneURL})
	}

	// Repos: create each, push its main, and add a `pando` remote.
	e.printf("\n")
	failed := 0
	for _, p := range plan.Projects {
		var repo *server.Repo
		if plan.Kind == config.KindRepo {
			if len(repos) == 0 {
				return errors.New("the server returned no repo for this plain repo")
			}
			repo = &repos[0]
		} else {
			repo, err = srvc.CreateRepo(e.Ctx, mono, p.Path)
			if err != nil {
				e.warnf("%s: %v", p.Path, err)
				failed++
				continue
			}
		}
		root.SetRepo(config.RepoEntry{Path: repo.Path, Name: repo.Name, CloneURL: repo.CloneURL})
		if err := pushMain(e, p, repo.CloneURL); err != nil {
			e.warnf("%s: %v", p.Path, err)
			failed++
			continue
		}
	}

	// References: one pointer each.
	for _, r := range plan.References {
		if err := refs.Write(plan.Root, refs.Pointer{Path: r.Path, URL: r.URL, Ref: r.Ref, Commit: r.Commit}); err != nil {
			e.warnf("%s: %v", r.Path, err)
			failed++
			continue
		}
		e.printf("%-44s reference pointer at %s\n", r.Path, rel(plan.Root, refs.File(plan.Root, r.Path)))
	}
	if err := config.AppendSettingsList(plan.Root, "projects", addProjects); err != nil {
		return err
	}
	if err := config.AppendSettingsList(plan.Root, "local_only", addLocal); err != nil {
		return err
	}
	if len(addProjects)+len(addLocal) > 0 {
		e.printf("%-44s your answers are in .pando/pando.toml\n", ".pando/pando.toml")
	}

	if err := root.Save(); err != nil {
		return err
	}
	if plan.Kind == config.KindRepo {
		if err := excludeInRepo(e, plan.Root); err != nil {
			e.warnf("could not update .git/info/exclude: %v", err)
		}
	}

	e.printf("\nPando %s %s is set up at %s (server %s).\n", plan.Kind, mono, plan.Root, serverURL)
	if plan.Kind == config.KindMonorepo {
		e.printf("The meta layer (the files outside projects/ and references) syncs through the Pando daemon.\n")
	}
	e.printf("Next: pando worktree add %s <branch>    or, on another machine: pando clone %s\n", firstRepo(root), mono)
	if failed > 0 {
		return fmt.Errorf("%d item(s) failed; fix them and run pando init again (it skips what is done)", failed)
	}
	return nil
}

func firstRepo(root *config.Root) string {
	if len(root.Repos) == 0 {
		return "<repo>"
	}
	return root.Repos[0].Path
}

func rel(root, p string) string {
	r, err := filepath.Rel(root, p)
	if err != nil {
		return p
	}
	return filepath.ToSlash(r)
}

func printPlan(e *Env, p *detect.Plan) {
	if p.Kind == config.KindRepo {
		pr := p.Projects[0]
		e.printf("%s is a git repo: it becomes a plain Pando repo.\n", p.Root)
		e.printf("  main: local branch %s at %s\n", pr.MainBranch, short(pr.Head))
	} else {
		e.printf("%s is not a git repo: it becomes a Pando monorepo, with this folder as the meta layer.\n", p.Root)
		e.printf("\nRepos (%d):\n", len(p.Projects))
		for _, pr := range p.Projects {
			from := rel(p.Root, pr.Checkout)
			e.printf("  %-40s main <- %s %s (from %s)\n", pr.Path, pr.MainBranch, short(pr.Head), from)
		}
		e.printf("\nReferences (%d):\n", len(p.References))
		for _, r := range p.References {
			e.printf("  %-40s %s %s at %s\n", r.Path, r.URL, strings.TrimPrefix(r.Ref, "refs/heads/"), short(r.Commit))
		}
	}
	if len(p.Notes) > 0 {
		e.printf("\nNotes:\n")
		for _, n := range p.Notes {
			e.printf("  %s\n", n)
		}
	}
}

// ensureMonorepo makes the monorepo, or finds it if this machine can already
// reach it. Making one uses this machine's credential (pando login), or
// PANDO_BOOTSTRAP, or a secret typed at the prompt. A monorepo token the
// server returns is saved at mode 600 and never shown.
func ensureMonorepo(e *Env, serverURL, mono, kind, person, email string) (server.Server, []server.Repo, error) {
	local := strings.HasPrefix(serverURL, "file://")
	if tok, err := e.Home.Token(serverURL, mono); err == nil || local {
		s, err := server.Open(serverURL, tok)
		if err != nil {
			return nil, nil, err
		}
		m, err := s.GetMonorepo(e.Ctx, mono)
		if err == nil {
			if m.Kind != kind {
				return nil, nil, fmt.Errorf("monorepo %s exists on the server as a %s, not a %s", mono, m.Kind, kind)
			}
			repos, err := s.ListRepos(e.Ctx, mono)
			if err != nil {
				return nil, nil, err
			}
			e.printf("\nMonorepo %s exists on %s; continuing.\n", mono, serverURL)
			return s, repos, nil
		}
		if !errors.Is(err, server.ErrNotFound) && !local {
			return nil, nil, err
		}
	}
	if person == "" {
		if u, err := user.Current(); err == nil {
			person = u.Username
		}
	}
	if email == "" {
		email, _ = gitx.Cmd{}.Run(e.Ctx, "config", "--get", "user.email")
	}
	bootstrap := os.Getenv("PANDO_BOOTSTRAP")
	if bootstrap == "" && !local {
		if b, err := os.ReadFile(e.Home.CredentialPath(serverURL)); err == nil {
			bootstrap = strings.TrimSpace(string(b))
		}
	}
	if bootstrap == "" && !local {
		if !e.isTerminal() {
			return nil, nil, errors.New("making a monorepo needs a signed-in machine: run pando login (or set PANDO_BOOTSTRAP)")
		}
		b, err := e.readSecret("Bootstrap secret for " + serverURL + " (input hidden): ")
		if err != nil {
			return nil, nil, err
		}
		bootstrap = b
	}
	s, err := server.Open(serverURL, "")
	if err != nil {
		return nil, nil, err
	}
	created, err := s.CreateMonorepo(e.Ctx, bootstrap, mono, kind, person, email)
	if err != nil {
		if server.StatusOf(err) == 409 {
			return nil, nil, fmt.Errorf("monorepo %s already exists on %s; ask its owner for a token and run `pando login %s`", mono, serverURL, mono)
		}
		return nil, nil, err
	}
	if !local && created.Token.Token != "" {
		if err := e.Home.SaveToken(serverURL, mono, created.Token.Token); err != nil {
			return nil, nil, err
		}
		e.printf("\nMade monorepo %s on %s. Its token for %s is saved in %s, mode 600.\n",
			mono, serverURL, created.Token.Name, filepath.Join(e.Home.Dir, "tokens"))
	} else {
		e.printf("\nMade monorepo %s on %s.\n", mono, serverURL)
	}
	tok := created.Token.Token
	if tok == "" {
		tok = bootstrap
	}
	authed, err := server.Open(serverURL, tok)
	if err != nil {
		return nil, nil, err
	}
	return authed, created.Repos, nil
}

// pushMain pushes a project's main branch through the git door, and adds a
// `pando` remote to the checkout so its other branches can be pushed with
// plain git.
func pushMain(e *Env, p detect.Project, cloneURL string) error {
	g := gitx.In(p.Checkout)
	if cur, err := g.Run(e.Ctx, "remote", "get-url", "pando"); err != nil {
		if _, err := g.Run(e.Ctx, "remote", "add", "pando", cloneURL); err != nil {
			return err
		}
	} else if cur != cloneURL {
		if _, err := g.Run(e.Ctx, "remote", "set-url", "pando", cloneURL); err != nil {
			return err
		}
	}
	gitDir, err := g.Run(e.Ctx, "rev-parse", "--git-common-dir")
	if err == nil {
		if !filepath.IsAbs(gitDir) {
			gitDir = filepath.Join(p.Checkout, gitDir)
		}
		if err := worktree.WriteCredentialConfig(e.Ctx, gitDir, cloneURL); err != nil {
			return err
		}
	}
	remote, _ := g.Run(e.Ctx, "ls-remote", "pando", "refs/heads/main")
	if f := strings.Fields(remote); len(f) > 0 {
		if f[0] == p.Head {
			e.printf("%-44s main is on the server at %s\n", p.Path, short(p.Head))
			return nil
		}
		return fmt.Errorf("the server's main is at %s, not %s; it is left as it is (push a branch and merge it)", short(f[0]), short(p.Head))
	}
	if _, err := g.Run(e.Ctx, "push", "--quiet", "pando", "refs/heads/"+p.MainBranch+":refs/heads/main"); err != nil {
		return err
	}
	e.printf("%-44s pushed %s %s as main\n", p.Path, p.MainBranch, short(p.Head))
	return nil
}

// makeRepo answers "make it a repo" for a folder with no git history.
func makeRepo(e *Env, root, relPath string) (*detect.Project, error) {
	dir := filepath.Join(root, filepath.FromSlash(relPath))
	g := gitx.In(dir)
	if _, err := g.Run(e.Ctx, "init", "--quiet", "--initial-branch=main"); err != nil {
		return nil, err
	}
	if _, err := g.Run(e.Ctx, "add", "-A"); err != nil {
		return nil, err
	}
	if _, err := g.Run(e.Ctx, "commit", "--quiet", "--allow-empty", "-m", "Initial commit"); err != nil {
		return nil, err
	}
	return detect.ProjectAt(e.Ctx, relPath, dir)
}

// excludeInRepo keeps Pando's folders out of a plain repo's git status.
func excludeInRepo(e *Env, dir string) error {
	gitDir, err := gitx.In(dir).Run(e.Ctx, "rev-parse", "--git-dir")
	if err != nil {
		return err
	}
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(dir, gitDir)
	}
	p := filepath.Join(gitDir, "info", "exclude")
	old, _ := os.ReadFile(p)
	text := string(old)
	var add []string
	for _, line := range []string{"/.pando/local/", "/worktrees/"} {
		if !strings.Contains(text, line) {
			add = append(add, line)
		}
	}
	if len(add) == 0 {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	text += "# Pando (formats.md, section 1)\n" + strings.Join(add, "\n") + "\n"
	return os.WriteFile(p, []byte(text), 0o644)
}
