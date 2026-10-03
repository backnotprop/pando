package app

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"text/tabwriter"

	"pando/internal/config"
	"pando/internal/gitx"
	"pando/internal/refs"
	"pando/internal/server"
)

// Status is `pando status`. With no arguments: this Pando folder, its repos
// and worktrees on this machine, its references, and whether the server
// answers. With a state: a commit status from a CI step (postStatus).
func Status(e *Env, args []string) error {
	fs := flags("status")
	context := fs.String("context", "", "the check's name (default ci)")
	targetURL := fs.String("target-url", "", "a link for the check (default $BUILDKITE_BUILD_URL)")
	description := fs.String("description", "", "a short line for the check")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) > 0 {
		return postStatus(e, pos, *context, *targetURL, *description)
	}
	if *context != "" || *targetURL != "" || *description != "" {
		return UsageError{"--context, --target-url and --description go with a state: pando status success --context ci"}
	}
	root, err := e.root()
	if err != nil {
		return err
	}
	e.printf("Pando %s %s at %s\n", root.Kind, root.FullName(), root.Dir)
	acct, _ := e.Home.Account(root.Server)
	srv, err := e.open(root)
	switch {
	case err != nil:
		e.printf("server: %s (%v)\n", root.Server, err)
	default:
		if m, err := srv.GetMonorepo(e.Ctx, root.FullName()); err != nil {
			e.printf("server: %s, not answering for you (%v)\n", root.Server, err)
		} else if me, err := srv.Me(e.Ctx); err == nil {
			e.printf("server: %s, you are %s (%s of %s)\n", root.Server, me.Login, dash(m.Role), root.FullName())
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

var statusStates = map[string]bool{"pending": true, "success": true, "failure": true, "error": true}

var statusSHA = regexp.MustCompile(`/statuses/([0-9a-f]{40})$`)

// postStatus is `pando status <state>` in a CI step that Pando started: it
// posts to PANDO_STATUS_URL (which names the commit) with
// PANDO_STATUS_TOKEN, and Pando stamps the CI service on the check. The
// token is never printed.
func postStatus(e *Env, pos []string, context, targetURL, description string) error {
	if len(pos) != 1 || !statusStates[pos[0]] {
		return UsageError{"the state is pending, success, failure or error"}
	}
	token := os.Getenv("PANDO_STATUS_TOKEN")
	statusURL := os.Getenv("PANDO_STATUS_URL")
	if token == "" || statusURL == "" {
		return fmt.Errorf("PANDO_STATUS_URL and PANDO_STATUS_TOKEN are not set: pando status <state> runs in a CI build that Pando started, which has both")
	}
	if context == "" {
		context = "ci"
	}
	if targetURL == "" {
		targetURL = os.Getenv("BUILDKITE_BUILD_URL")
	}
	sha := ""
	if m := statusSHA.FindStringSubmatch(statusURL); m != nil {
		sha = m[1]
	}
	// The token is for one commit. Say so when this checkout is elsewhere.
	if head, err := gitx.In(e.Cwd).Run(e.Ctx, "rev-parse", "HEAD"); err == nil && sha != "" && head != sha {
		e.warnf("this checkout is at %s; the status goes to %s, the commit this build is for", short(head), short(sha))
	}
	st, err := server.PostStatusTo(e.Ctx, statusURL, token, server.StatusIn{State: pos[0], Context: context, TargetURL: targetURL, Description: description})
	if err != nil {
		return err
	}
	by := st.Creator
	if st.App != "" {
		by = st.App
	}
	e.printf("%s: %s on %s (reported as %s)\n", st.Context, st.State, short(st.SHA), by)
	return nil
}
