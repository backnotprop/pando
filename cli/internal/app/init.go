package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"pando/internal/config"
	"pando/internal/detect"
	"pando/internal/gitx"
	"pando/internal/meta"
	"pando/internal/refs"
	"pando/internal/server"
	"pando/internal/worktree"
)

var nameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,38}$`)

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
		return fmt.Errorf("%s is already a Pando %s named %s", dir, existing.Kind, existing.FullName())
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
		mono = strings.ToLower(filepath.Base(plan.Root))
	}
	if !validName(mono) {
		return fmt.Errorf("%q cannot be a monorepo name (lower-case letters, digits, '.', '_', '-'; no '--'; at most 39); pass --name", mono)
	}

	existingFull := ""
	if existing != nil && existing.Owner != "" && existing.Name == mono {
		existingFull = existing.FullName()
	}
	srvc, repos, mrec, made, err := ensureMonorepo(e, serverURL, mono, existingFull, plan.Kind)
	if err != nil {
		return err
	}
	root := &config.Root{Dir: plan.Root, Kind: plan.Kind, Owner: mrec.Owner, Name: mrec.Name, ID: mrec.ID, Server: serverURL}
	mono = root.FullName() // owner/name from here on
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
			if server.StatusOf(err) == 409 {
				repo, err = srvc.GetRepo(e.Ctx, mono, server.RepoName(mono, p.Path))
			}
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
	if plan.Kind == config.KindMonorepo {
		switch {
		case strings.HasPrefix(serverURL, "file://"):
			e.printf("shared files: not synced on a file:// server\n")
		case !made:
			e.printf("shared files: the first upload already started; keep the files outside projects/ live with pando sync\n")
		default:
			start := time.Now()
			if err := meta.Init(e.Ctx, plan.Root); err != nil {
				e.warnf("shared files: the first upload did not finish: %v", err)
				failed++
			} else {
				e.printf("shared files: uploaded the files outside projects/ in %.1fs; keep them live with pando sync\n", time.Since(start).Seconds())
			}
		}
	}

	e.printf("\nPando %s %s is set up at %s (server %s).\n", plan.Kind, mono, plan.Root, serverURL)
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
		e.printf("%s is not a git repo: it becomes a Pando monorepo. Its files outside projects/ are shared with every machine.\n", p.Root)
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

// ensureMonorepo makes the monorepo with this machine's credential (the
// signed-in user becomes its owner), or, if it exists, continues with it.
// It creates first and looks up only on 409: a lookup before the create
// would plant a "no such monorepo" answer in the Worker's per-isolate auth
// cache, which then answers 404 for some seconds after the create.
func ensureMonorepo(e *Env, serverURL, name, existingFull, kind string) (srv server.Server, repos []server.Repo, m *server.Monorepo, made bool, err error) {
	tok, terr := e.Home.Token(serverURL)
	if terr != nil && !strings.HasPrefix(serverURL, "file://") {
		return nil, nil, nil, false, terr
	}
	s, err := server.Open(serverURL, tok)
	if err != nil {
		return nil, nil, nil, false, err
	}
	if h, ok := s.(*server.HTTP); ok {
		h.Agent = worktree.CleanAgent(e.agentFor(nil))
	}
	full := existingFull
	if full == "" {
		created, err := s.CreateMonorepo(e.Ctx, name, kind)
		if err == nil {
			m := created.Monorepo
			e.printf("\nMade %s %s on %s; you are its owner.\n", kind, m.Full(), config.Host(serverURL))
			if ra := created.ReplacedAlias; ra != nil && ra.FullName != "" {
				e.warnf("%s no longer leads to %s", ra.FullName, ra.PointedTo)
			}
			return s, created.Repos, &m, true, nil
		}
		if server.StatusOf(err) != 409 {
			return nil, nil, nil, false, err
		}
		// It exists in this person's own namespace (a new monorepo is made
		// there): continue with it.
		me, err := s.Me(e.Ctx)
		if err != nil {
			return nil, nil, nil, false, err
		}
		full = strings.ToLower(me.Login) + "/" + name
	}
	got, err := s.GetMonorepo(e.Ctx, full)
	switch {
	case server.StatusOf(err) == 403:
		return nil, nil, nil, false, fmt.Errorf("monorepo %s exists on %s and you are not a member; ask an owner to add you", full, config.Host(serverURL))
	case err != nil:
		return nil, nil, nil, false, err
	case got.Kind != kind:
		return nil, nil, nil, false, fmt.Errorf("monorepo %s exists on the server as a %s, not a %s", full, got.Kind, kind)
	}
	repos, err = s.ListRepos(e.Ctx, got.Full())
	if err != nil {
		return nil, nil, nil, false, err
	}
	e.printf("\nMonorepo %s exists on %s (you are %s); continuing.\n", got.Full(), config.Host(serverURL), dash(got.Role))
	return s, repos, got, false, nil
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
	remote, _ := g.Run(e.Ctx, "ls-remote", "pando", "refs/heads/main") // "" also when not reachable yet
	if f := strings.Fields(remote); len(f) > 0 {
		if f[0] == p.Head {
			e.printf("%-44s main is on the server at %s\n", p.Path, short(p.Head))
			return nil
		}
		return fmt.Errorf("the server's main is at %s, not %s; it is left as it is (push a branch and merge it)", short(f[0]), short(p.Head))
	}
	// The same size check a worktree's pre-push hook makes. main takes only
	// its first push, so history over the limit goes up in pieces on a side
	// branch first.
	check := gitx.Cmd{Dir: p.Checkout, Stdin: strings.NewReader(fmt.Sprintf("refs/heads/%s %s refs/heads/main %s\n", p.MainBranch, p.Head, strings.Repeat("0", len(p.Head))))}
	if _, err := check.RunShell(e.Ctx, worktree.PrePushScript(), "pando", cloneURL); err != nil {
		var ge *gitx.Error
		if errors.As(err, &ge) {
			e.Stderr.Write([]byte(ge.Stderr))
		}
		return fmt.Errorf("main is not pushed. Push older history first on a side branch, in pieces under 100 MB: git -C %s push pando <older commit>:refs/heads/import, then run pando init again", p.Checkout)
	}
	// Two failures are retried. A repo made a moment ago can be "not found"
	// at the git door for a few seconds: retried for up to half a minute.
	// A transport failure mid-push (about 1 in 10 for a 12 MiB push in our
	// measurements): retried once. Before a retry, if main did land and only
	// the answer was lost, that counts as pushed; pushing main again would be
	// refused.
	push := func() error {
		// The agent header rides on this one push only; the person's own
		// checkout keeps no Pando agent in its config.
		args := append(worktree.AgentHeaderArgs(cloneURL, e.agentFor(nil)), "push", "--quiet", "pando", "refs/heads/"+p.MainBranch+":refs/heads/main")
		_, err := g.Run(e.Ctx, args...)
		return err
	}
	landed := func() bool {
		out, _ := g.Run(e.Ctx, "ls-remote", "pando", "refs/heads/main")
		f := strings.Fields(out)
		return len(f) > 0 && f[0] == p.Head
	}
	err = push()
	transportRetried := false
	for wait := time.Second; err != nil; wait *= 2 {
		switch {
		case landed():
			err = nil
			continue
		case strings.Contains(err.Error(), "not found") && wait <= 16*time.Second:
		case transportFailure(err) && !transportRetried:
			transportRetried = true
			e.warnf("%s: the push broke off (%s); trying once more", p.Path, firstLine(err))
		default:
			return err
		}
		select {
		case <-e.Ctx.Done():
			return e.Ctx.Err()
		case <-time.After(wait):
		}
		err = push()
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

// transportFailure reports whether a git push broke off in transit (the
// connection, TLS, or a pack cut short), as opposed to the server refusing
// it ("main is protected", a declined hook), which carries none of these.
func transportFailure(err error) bool {
	msg := err.Error()
	for _, s := range []string{
		"RPC failed", "unexpected disconnect", "remote end hung up", "early EOF", "unpacker error",
		"SSL", "TLS", "Connection reset", "connection reset", "broken pipe", "Broken pipe",
		"Operation timed out", "Could not resolve host", "Failed to connect",
	} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

func firstLine(err error) string {
	var ge *gitx.Error
	msg := err.Error()
	if errors.As(err, &ge) && strings.TrimSpace(ge.Stderr) != "" {
		msg = ge.Stderr
	}
	msg = strings.TrimSpace(msg)
	if i := strings.IndexByte(msg, '\n'); i >= 0 {
		msg = msg[:i]
	}
	return msg
}
