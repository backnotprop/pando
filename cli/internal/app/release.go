package app

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"

	"pando/internal/server"
)

// ── pando release: a project's releases (research/plans/releases-2026-10-04) ──

const releaseUsage = "pando release list | view [<tag>] | create <tag> [--title t] [--notes n | --notes-file f] [--generate] [--target <sha>] [--draft] [--force] | publish <tag> [--force] | delete <tag> [--yes]   [--repo <path>] [--monorepo <owner/name>] [--json]"

// Release is `pando release`. A release is a tag on a project's main with
// notes. Anyone who may merge may publish one; its commit's required checks
// must be green, unless --force (the merge rule). A published release's tag
// can't be moved or deleted with git until the release is deleted.
func Release(e *Env, args []string) error {
	usage := UsageError{releaseUsage}
	if len(args) == 0 {
		return usage
	}
	fs := flags("release")
	title := fs.String("title", "", "create: its title (default: the tag)")
	notes := fs.String("notes", "", "create: its notes (Markdown)")
	notesFile := fs.String("notes-file", "", "create: read its notes from this file (- for standard input)")
	generate := fs.Bool("generate", false, "create: write the notes from the branches merged since the last release (after --notes, if any)")
	target := fs.String("target", "", "create: the commit on main to release (default: main, or the tag's commit when the tag exists)")
	draft := fs.Bool("draft", false, "create: keep it a draft (publish it later)")
	force := fs.Bool("force", false, "create, publish: publish past red or missing required checks")
	yes := fs.Bool("yes", false, "delete: without asking (scripts)")
	limit := fs.Int("limit", 30, "list: how many releases")
	repoFlag := fs.String("repo", "", "the repo (default: the one this folder is in, or the only one)")
	asJSON := fs.Bool("json", false, "print the API's JSON")
	mono := fs.String("monorepo", "", "the monorepo (default: the one this folder is in)")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	least := map[string]int{"list": 0, "ls": 0, "view": 0, "create": 1, "publish": 1, "delete": 1, "rm": 1}
	most := map[string]int{"list": 0, "ls": 0, "view": 1, "create": 1, "publish": 1, "delete": 1, "rm": 1}
	if n, ok := least[args[0]]; !ok || len(pos) < n || len(pos) > most[args[0]] {
		return usage
	}
	if *limit < 1 || *limit > 100 {
		return UsageError{"--limit is 1 to 100"}
	}
	h, full, err := e.target(*srvFlag, *mono)
	if err != nil {
		return err
	}
	repo, err := e.repoIn(h, full, *repoFlag)
	if err != nil {
		return err
	}
	switch args[0] {
	case "list", "ls":
		l, err := h.ListReleases(e.Ctx, full, repo.Name, *limit)
		if err != nil {
			return err
		}
		if *asJSON {
			return e.printJSON(l.JSON)
		}
		return releaseList(e, l)
	case "view":
		tag := "latest"
		if len(pos) == 1 {
			tag = pos[0]
		}
		r, err := h.GetRelease(e.Ctx, full, repo.Name, tag)
		if err != nil {
			return err
		}
		if *asJSON {
			return e.printJSON(r.JSON)
		}
		return releaseView(e, r)
	case "create":
		text := *notes
		if *notesFile != "" {
			if text != "" {
				return UsageError{"--notes or --notes-file, not both"}
			}
			b, err := readNotes(e, *notesFile)
			if err != nil {
				return err
			}
			text = b
		}
		in := server.ReleaseIn{Tag: pos[0], Target: *target, Title: *title, Notes: text, GenerateNotes: *generate, Draft: *draft, Force: *force}
		r, err := h.CreateRelease(e.Ctx, full, repo.Name, in)
		if err != nil {
			return checksRefused(err, pos[0])
		}
		if *asJSON {
			return e.printJSON(r.JSON)
		}
		return releaseMade(e, r)
	case "publish":
		r, err := h.PublishRelease(e.Ctx, full, repo.Name, pos[0], *force)
		if err != nil {
			return checksRefused(err, pos[0])
		}
		if *asJSON {
			return e.printJSON(r.JSON)
		}
		return releaseMade(e, r)
	}
	tag := pos[0]
	if !*yes {
		if !e.isTerminal() {
			return errors.New("deleting a release needs a yes at a terminal, or --yes")
		}
		e.printf("Delete release %s of %s? Its files go too; the tag stays. [y/N] ", tag, repoLabel(repo))
		typed, err := e.readLine()
		if err != nil {
			return err
		}
		if !strings.EqualFold(strings.TrimSpace(typed), "y") && !strings.EqualFold(strings.TrimSpace(typed), "yes") {
			return errors.New("nothing was deleted")
		}
	}
	if err := h.DeleteRelease(e.Ctx, full, repo.Name, tag); err != nil {
		return err
	}
	if !*asJSON {
		e.printf("Deleted release %s. Its tag %s stays, and git can move or delete it now.\n", tag, tag)
	}
	return nil
}

func readNotes(e *Env, path string) (string, error) {
	var b []byte
	var err error
	if path == "-" {
		b, err = io.ReadAll(e.Stdin)
	} else {
		b, err = os.ReadFile(e.abs(path))
	}
	if err != nil {
		return "", fmt.Errorf("reading the notes: %w", err)
	}
	return string(b), nil
}

// checksRefused says what to do when publishing was refused over checks.
func checksRefused(err error, tag string) error {
	var ae *server.APIError
	if errors.As(err, &ae) && ae.Code == "checks_not_green" {
		return fmt.Errorf("%s\n  wait for the checks, or publish anyway: pando release publish %s --force", ae.Message, tag)
	}
	return err
}

func releaseState(r server.Release) string {
	switch {
	case r.Draft:
		return "draft"
	case r.Forced:
		return "published (forced)"
	}
	return "published"
}

func releaseWhen(r server.Release) string {
	if r.PublishedAt != nil {
		return ago(*r.PublishedAt)
	}
	return ago(r.CreatedAt)
}

func releaseList(e *Env, l *server.ReleaseList) error {
	if len(l.Releases) == 0 {
		e.printf("No releases yet. Make one with: pando release create <tag> --generate\n")
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	w := tabwriter.NewWriter(e.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "TAG\tTITLE\tSTATE\tCOMMIT\tWHEN")
	for _, r := range l.Releases {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", r.Tag, r.Title, releaseState(r), short(r.SHA), releaseWhen(r))
	}
	return w.Flush()
}

func releaseView(e *Env, r *server.Release) error {
	e.printf("%s  %s\n", r.Tag, r.Title)
	e.printf("  %s, commit %s\n", releaseState(*r), short(r.SHA))
	if r.PublishedBy != nil && r.PublishedAt != nil {
		e.printf("  published by %s %s\n", *r.PublishedBy, ago(*r.PublishedAt))
	} else {
		e.printf("  made by %s %s\n", r.CreatedBy, ago(r.CreatedAt))
	}
	if r.Checks != nil {
		e.printf("  checks %s\n", r.Checks.State)
	}
	if strings.TrimSpace(r.Notes) != "" {
		e.printf("\n%s\n", strings.TrimRight(r.Notes, "\n"))
	}
	return nil
}

func releaseMade(e *Env, r *server.Release) error {
	if r.Draft {
		e.printf("Draft %s at %s. Publish it with: pando release publish %s\n", r.Tag, short(r.SHA), r.Tag)
		return nil
	}
	forced := ""
	if r.Forced {
		forced = " past red or missing checks (forced)"
	}
	e.printf("Published %s at %s%s. Its tag is frozen until the release is deleted.\n", r.Tag, short(r.SHA), forced)
	return nil
}
