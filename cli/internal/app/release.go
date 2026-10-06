package app

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"pando/internal/server"
)

// filesMax is the most files one release keeps (the server's limit).
const filesMax = 20

// ── pando release: a project's releases (research/plans/releases-2026-10-04) ──

const releaseUsage = "pando release list | view [<tag>] | create <tag> [<file>...] [--title t] [--notes n | --notes-file f] [--generate] [--target <sha>] [--draft] [--force] | publish <tag> [--force] | upload <tag> <file>... | download [<tag>] [--pattern p] [--dir d] | delete <tag> [--yes]   [--repo <path>] [--monorepo <owner/name>] [--json]"

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
	pattern := fs.String("pattern", "", "download: only files whose names match this pattern (pando-darwin-*)")
	dir := fs.String("dir", ".", "download: the folder to write the files in")
	repoFlag := fs.String("repo", "", "the repo (default: the one this folder is in, or the only one)")
	asJSON := fs.Bool("json", false, "print the API's JSON")
	mono := fs.String("monorepo", "", "the monorepo (default: the one this folder is in)")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	least := map[string]int{"list": 0, "ls": 0, "view": 0, "create": 1, "publish": 1, "upload": 2, "download": 0, "delete": 1, "rm": 1}
	most := map[string]int{"list": 0, "ls": 0, "view": 1, "create": 1 + filesMax, "publish": 1, "upload": 1 + filesMax, "download": 1, "delete": 1, "rm": 1}
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
		files, err := releaseFiles(e, pos[1:])
		if err != nil {
			return err
		}
		// With files: a draft first, its files, then published, so a release is never seen without them.
		in := server.ReleaseIn{Tag: pos[0], Target: *target, Title: *title, Notes: text, GenerateNotes: *generate, Draft: *draft || len(files) > 0, Force: *force}
		r, err := h.CreateRelease(e.Ctx, full, repo.Name, in)
		if err != nil {
			return checksRefused(err, pos[0])
		}
		if len(files) > 0 {
			if r, err = uploadAll(e, h, full, repo.Name, pos[0], files, *asJSON); err != nil {
				return fmt.Errorf("%w\n  the draft %s is kept; upload the rest with: pando release upload %s <file>...", err, pos[0], pos[0])
			}
			if !*draft {
				if r, err = h.PublishRelease(e.Ctx, full, repo.Name, pos[0], *force); err != nil {
					return fmt.Errorf("%w\n  the draft %s and its files are kept", checksRefused(err, pos[0]), pos[0])
				}
			}
		}
		if *asJSON {
			return e.printJSON(r.JSON)
		}
		return releaseMade(e, r)
	case "upload":
		files, err := releaseFiles(e, pos[1:])
		if err != nil {
			return err
		}
		r, err := uploadAll(e, h, full, repo.Name, pos[0], files, *asJSON)
		if err != nil {
			return err
		}
		if *asJSON {
			return e.printJSON(r.JSON)
		}
		return nil
	case "download":
		tag := "latest"
		if len(pos) == 1 {
			tag = pos[0]
		}
		return releaseDownload(e, h, full, repo.Name, tag, *pattern, e.abs(*dir), *asJSON)
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
	for _, f := range r.Files {
		e.printf("  file %s  %s  sha256 %s\n", f.Name, sizeText(f.Size), f.SHA256[:12])
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

// releaseFile is a file on this machine to upload: its name in the release
// (the file's own name), its size and its SHA-256.
type releaseFile struct {
	path   string
	name   string
	size   int64
	sha256 string
}

// releaseFiles reads each file once for its SHA-256, before anything is sent.
func releaseFiles(e *Env, paths []string) ([]releaseFile, error) {
	var out []releaseFile
	for _, p := range paths {
		abs := e.abs(p)
		f, err := os.Open(abs)
		if err != nil {
			return nil, err
		}
		h := sha256.New()
		n, err := io.Copy(h, f)
		f.Close()
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", p, err)
		}
		out = append(out, releaseFile{path: abs, name: filepath.Base(abs), size: n, sha256: hex.EncodeToString(h.Sum(nil))})
	}
	return out, nil
}

func uploadAll(e *Env, h *server.HTTP, full, repo, tag string, files []releaseFile, quiet bool) (*server.Release, error) {
	var r *server.Release
	for _, f := range files {
		body, err := os.Open(f.path)
		if err != nil {
			return nil, err
		}
		r, err = h.UploadReleaseFile(e.Ctx, full, repo, tag, f.name, body, f.size, f.sha256)
		body.Close()
		if err != nil {
			return nil, fmt.Errorf("uploading %s: %w", f.name, err)
		}
		if !quiet {
			e.printf("Uploaded %s (%s, sha256 %s)\n", f.name, sizeText(f.size), f.sha256[:12])
		}
	}
	return r, nil
}

// releaseDownload writes a release's files (those matching pattern) into dir,
// each checked against the SHA-256 Pando recorded at upload.
func releaseDownload(e *Env, h *server.HTTP, full, repo, tag, pattern, dir string, asJSON bool) error {
	r, err := h.GetRelease(e.Ctx, full, repo, tag)
	if err != nil {
		return err
	}
	var want []server.ReleaseFile
	for _, f := range r.Files {
		if ok, err := path.Match(pattern, f.Name); pattern == "" || (err == nil && ok) {
			want = append(want, f)
		}
	}
	if len(want) == 0 {
		return fmt.Errorf("%s has no files%s", r.Tag, map[bool]string{true: " matching " + pattern, false: ""}[pattern != ""])
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, f := range want {
		to := filepath.Join(dir, f.Name)
		tmp, err := os.CreateTemp(dir, "."+f.Name+".part-*")
		if err != nil {
			return err
		}
		sum := sha256.New()
		_, err = h.DownloadReleaseFile(e.Ctx, full, repo, r.Tag, f.Name, io.MultiWriter(tmp, sum))
		tmp.Close()
		if err == nil && hex.EncodeToString(sum.Sum(nil)) != f.SHA256 {
			err = fmt.Errorf("%s: its SHA-256 is %s, not %s as recorded; nothing was written", f.Name, hex.EncodeToString(sum.Sum(nil)), f.SHA256)
		}
		if err == nil {
			err = os.Rename(tmp.Name(), to)
		}
		if err != nil {
			os.Remove(tmp.Name())
			return err
		}
		if !asJSON {
			e.printf("Downloaded %s (%s) to %s\n", f.Name, sizeText(f.Size), to)
		}
	}
	return nil
}
