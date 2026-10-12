package app

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"pando/internal/server"
)

// ── pando artifact: documents on a branch's page, and their comments ────────
// (research/plans/artifacts-2026-10-12/SPEC.md). The loop it is for: an agent
// uploads a plan, a person marks it up, the agent reads the comments, uploads
// v2 and replies or resolves.

const artifactUsage = "pando artifact add [<branch>] <file> [<image>...] | list [<branch>] | get [<branch>] <name> [--version n] [-o dir] | open [<branch>] <name> | comments [<branch>] [<name>] [--all] | comment [<branch>] <name> [--quote words] -m text | reply <id> -m text | resolve <id> [--reopen]   [--repo <path>] [--monorepo <owner/name>] [--json]"

// artifactExts are the files an artifact is made of: a document, or an image.
var artifactExts = map[string]bool{".md": true, ".markdown": true, ".html": true, ".htm": true, ".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".svg": true}

func isArtifactName(s string) bool {
	return artifactExts[strings.ToLower(path.Ext(s))]
}

// artifactCmd holds what every subcommand shares: its flags, then the
// server, the monorepo and the repo.
type artifactCmd struct {
	fs      *flag.FlagSet
	repo    *string
	mono    *string
	srv     *string
	asJSON  *bool
	msg     *string
	quote   *string
	version *int
	out     *string
	all     *bool
	reopen  *bool
	h       *server.HTTP
	full    string
	r       server.Repo
}

// Artifact is `pando artifact`. With no <branch>, the branch of the
// worktree this folder is in, as pando review does.
func Artifact(e *Env, args []string) error {
	subs := map[string]func(*Env, *artifactCmd, []string) error{
		"add": artifactAdd, "list": artifactList, "ls": artifactList, "get": artifactGet, "open": artifactOpen,
		"comments": artifactComments, "comment": artifactComment, "reply": artifactReply, "resolve": artifactResolve,
	}
	if len(args) == 0 || subs[args[0]] == nil {
		return UsageError{artifactUsage}
	}
	fs := flags("artifact " + args[0])
	c := &artifactCmd{
		fs:      fs,
		repo:    fs.String("repo", "", "the repo (default: the one this folder is in, or the only one)"),
		mono:    fs.String("monorepo", "", "the monorepo (default: the one this folder is in)"),
		srv:     fs.String("server", "", "the server (default: the configured one)"),
		asJSON:  fs.Bool("json", false, "print the API's JSON"),
		msg:     fs.String("m", "", "comment, reply: the comment, Markdown"),
		quote:   fs.String("quote", "", "comment: the words it is on, plain, from one line (default: the whole artifact)"),
		version: fs.Int("version", 0, "get: the version (default: the newest)"),
		out:     fs.String("o", ".", "get: the folder to write its files in"),
		all:     fs.Bool("all", false, "comments: resolved threads too"),
		reopen:  fs.Bool("reopen", false, "resolve: reopen the thread instead"),
	}
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	c.h, c.full, err = e.target(*c.srv, *c.mono)
	if err != nil {
		return err
	}
	if args[0] != "reply" && args[0] != "resolve" {
		if c.r, err = e.repoIn(c.h, c.full, *c.repo); err != nil {
			return err
		}
	}
	return subs[args[0]](e, c, pos)
}

// branch is the branch given, else the current worktree's.
func (c *artifactCmd) branch(e *Env, given string) (string, error) {
	if given != "" {
		return given, nil
	}
	if root, err := e.root(); err == nil {
		if b := e.currentBranch(root); b != "" {
			return b, nil
		}
	}
	return "", UsageError{"which branch? name it, or run this inside its worktree"}
}

// branchAndName reads [<branch>] <name>: one argument is the name (an
// artifact's name always ends in its kind's extension).
func (c *artifactCmd) branchAndName(e *Env, pos []string) (string, string, error) {
	switch len(pos) {
	case 1:
		b, err := c.branch(e, "")
		return b, pos[0], err
	case 2:
		return pos[0], pos[1], nil
	}
	return "", "", UsageError{artifactUsage}
}

// find is the artifact with this name on the branch.
func (c *artifactCmd) find(e *Env, branch, name string) (*server.Artifact, error) {
	l, err := c.h.ListArtifacts(e.Ctx, c.full, c.r.Name, branch)
	if err != nil {
		return nil, err
	}
	for i := range l.Artifacts {
		if l.Artifacts[i].Name == name {
			return &l.Artifacts[i], nil
		}
	}
	var names []string
	for _, a := range l.Artifacts {
		names = append(names, a.Name)
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("%s has no artifacts yet", branch)
	}
	return nil, fmt.Errorf("%s has no artifact %s (it has: %s)", branch, name, strings.Join(names, ", "))
}

func artifactSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KiB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// ── add ────────────────────────────────────────────────────────────────────

// uploadsOf reads the document (or image) and the images it uses, each kept
// by its path from the document's folder.
func uploadsOf(e *Env, files []string) (server.ArtifactUpload, []server.ArtifactUpload, error) {
	mainPath := e.abs(files[0])
	b, err := os.ReadFile(mainPath)
	if err != nil {
		return server.ArtifactUpload{}, nil, err
	}
	main := server.ArtifactUpload{Path: filepath.Base(mainPath), Bytes: b}
	var images []server.ArtifactUpload
	for _, f := range files[1:] {
		p := e.abs(f)
		rel, err := filepath.Rel(filepath.Dir(mainPath), p)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return main, nil, fmt.Errorf("%s is outside %s's folder: an image is kept by its path from the document, so links in it resolve", f, main.Path)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return main, nil, err
		}
		images = append(images, server.ArtifactUpload{Path: filepath.ToSlash(rel), Bytes: b})
	}
	return main, images, nil
}

func artifactAdd(e *Env, c *artifactCmd, pos []string) error {
	if len(pos) == 0 {
		return UsageError{artifactUsage}
	}
	given := ""
	// A first argument that is not a file is the branch.
	if st, err := os.Stat(e.abs(pos[0])); err != nil || st.IsDir() {
		given, pos = pos[0], pos[1:]
	}
	if len(pos) == 0 {
		return UsageError{artifactUsage}
	}
	branch, err := c.branch(e, given)
	if err != nil {
		return err
	}
	main, images, err := uploadsOf(e, pos)
	if err != nil {
		return err
	}
	a, err := c.h.AddArtifact(e.Ctx, c.full, c.r.Name, branch, main, images)
	if err != nil {
		return err
	}
	// Every file as Pando computed it on upload, against the bytes sent.
	sent := map[string][]byte{main.Path: main.Bytes}
	for _, img := range images {
		sent[img.Path] = img.Bytes
	}
	for _, f := range a.Latest.Files {
		if sha256Hex(sent[f.Path]) != f.SHA256 {
			return fmt.Errorf("%s arrived with SHA-256 %s, not what was sent; upload it again", f.Path, f.SHA256)
		}
	}
	if *c.asJSON {
		return e.printJSON(a.JSON)
	}
	word := "Added"
	if !a.Created {
		word = "Uploaded"
	}
	e.printf("%s %s v%d to %s (%s, %d files, %s).\n", word, a.Name, a.Latest.N, branch, a.ID, len(a.Latest.Files), artifactSize(a.Latest.Size))
	return nil
}

// ── list ───────────────────────────────────────────────────────────────────

func artifactList(e *Env, c *artifactCmd, pos []string) error {
	if len(pos) > 1 {
		return UsageError{artifactUsage}
	}
	given := ""
	if len(pos) == 1 {
		given = pos[0]
	}
	branch, err := c.branch(e, given)
	if err != nil {
		return err
	}
	l, err := c.h.ListArtifacts(e.Ctx, c.full, c.r.Name, branch)
	if err != nil {
		return err
	}
	if *c.asJSON {
		return e.printJSON(l.JSON)
	}
	if len(l.Artifacts) == 0 {
		e.printf("%s has no artifacts yet. Add one with: pando artifact add %s <file>\n", branch, branch)
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	w := tabwriter.NewWriter(e.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tKIND\tVERSION\tSIZE\tOPEN COMMENTS\tUPLOADED")
	for _, a := range l.Artifacts {
		from := "web"
		if a.Latest.Machine != nil {
			from = *a.Latest.Machine
		}
		fmt.Fprintf(w, "%s\t%s\tv%d\t%s\t%d\t%s on %s %s\n", a.Name, a.Kind, a.Latest.N, artifactSize(a.Latest.Size), a.Comments.Open, a.Latest.UploadedBy, from, ago(a.Latest.CreatedAt))
	}
	return w.Flush()
}

// ── get, open ──────────────────────────────────────────────────────────────

func artifactGet(e *Env, c *artifactCmd, pos []string) error {
	branch, name, err := c.branchAndName(e, pos)
	if err != nil {
		return err
	}
	a, err := c.find(e, branch, name)
	if err != nil {
		return err
	}
	full, err := c.h.GetArtifact(e.Ctx, c.full, a.ID)
	if err != nil {
		return err
	}
	v := full.Latest
	if *c.version != 0 {
		found := false
		for _, x := range full.AllVersions {
			if x.N == *c.version {
				v, found = x, true
			}
		}
		if !found {
			return fmt.Errorf("%s has versions 1 to %d", name, full.Latest.N)
		}
	}
	for _, f := range v.Files {
		b, err := c.h.ArtifactFileBytes(e.Ctx, c.full, a.ID, v.N, f.Path)
		if err != nil {
			return err
		}
		if sha256Hex(b) != f.SHA256 {
			return fmt.Errorf("%s arrived damaged (its SHA-256 is not %s); try again", f.Path, f.SHA256)
		}
		dest := filepath.Join(e.abs(*c.out), filepath.FromSlash(f.Path))
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dest, b, 0o644); err != nil {
			return err
		}
		if !*c.asJSON {
			e.printf("%s\n", dest)
		}
	}
	if *c.asJSON {
		return e.printJSON(full.JSON)
	}
	return nil
}

// artifactPage is the artifact's place on the branch's page in the web app.
func artifactPage(h *server.HTTP, full string, r server.Repo, branch, name string) string {
	where := "/" + full
	if r.Path != "." {
		where += "/projects/" + strings.TrimPrefix(r.Path, "projects/")
	}
	parts := strings.Split(branch, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return h.Base + where + "/branches/" + strings.Join(parts, "/") + "?" + url.Values{"tab": {"artifacts"}, "artifact": {name}}.Encode()
}

func artifactOpen(e *Env, c *artifactCmd, pos []string) error {
	branch, name, err := c.branchAndName(e, pos)
	if err != nil {
		return err
	}
	if _, err := c.find(e, branch, name); err != nil {
		return err
	}
	u := artifactPage(c.h, c.full, c.r, branch, name)
	e.printf("%s\n", u)
	openBrowser(e, u)
	return nil
}

// ── comments ───────────────────────────────────────────────────────────────

func artifactWho(author string, machine *string) string {
	if machine == nil {
		return author
	}
	return author + " on " + *machine
}

func printComment(e *Env, indent string, cm server.ArtifactComment) {
	body := "(deleted)"
	if cm.Body != nil {
		body = strings.ReplaceAll(strings.TrimSpace(*cm.Body), "\n", "\n"+indent+"  ")
	}
	e.printf("%s%s  %s, %s\n%s  %s\n", indent, cm.ID, artifactWho(cm.Author, cm.Machine), ago(cm.CreatedAt), indent, body)
}

func artifactComments(e *Env, c *artifactCmd, pos []string) error {
	given, name := "", ""
	switch {
	case len(pos) == 1 && isArtifactName(pos[0]):
		name = pos[0]
	case len(pos) == 1:
		given = pos[0]
	case len(pos) == 2:
		given, name = pos[0], pos[1]
	case len(pos) > 2:
		return UsageError{artifactUsage}
	}
	branch, err := c.branch(e, given)
	if err != nil {
		return err
	}
	state := "open"
	if *c.all {
		state = "all"
	}
	var t *server.ArtifactThreads
	names := map[string]string{}
	if name != "" {
		a, err := c.find(e, branch, name)
		if err != nil {
			return err
		}
		names[a.ID] = a.Name
		t, err = c.h.ArtifactThreads(e.Ctx, c.full, a.ID, state)
		if err != nil {
			return err
		}
	} else {
		l, err := c.h.ListArtifacts(e.Ctx, c.full, c.r.Name, branch)
		if err != nil {
			return err
		}
		for _, a := range l.Artifacts {
			names[a.ID] = a.Name
		}
		if t, err = c.h.BranchArtifactThreads(e.Ctx, c.full, c.r.Name, branch, state); err != nil {
			return err
		}
	}
	if *c.asJSON {
		return e.printJSON(t.JSON)
	}
	if len(t.Threads) == 0 {
		e.printf("No open threads (%d resolved).\n", t.Counts.Resolved)
		return nil
	}
	for _, th := range t.Threads {
		on := "on the whole file"
		if q := th.Quote(); q != "" {
			on = fmt.Sprintf("on %q", clip(q, 80))
		}
		st := th.State
		if th.State == "resolved" && th.ResolvedBy != nil {
			st = "resolved by " + *th.ResolvedBy
		}
		e.printf("%s v%d, %s, %s\n", names[th.Artifact], th.Version, st, on)
		printComment(e, "  ", th.ArtifactComment)
		for _, r := range th.Replies {
			printComment(e, "    ", r)
		}
		e.printf("\n")
	}
	e.printf("%d open, %d resolved. Reply with: pando artifact reply <id> -m \"...\"\n", t.Counts.Open, t.Counts.Resolved)
	return nil
}

func artifactComment(e *Env, c *artifactCmd, pos []string) error {
	branch, name, err := c.branchAndName(e, pos)
	if err != nil {
		return err
	}
	if strings.TrimSpace(*c.msg) == "" {
		return UsageError{"comment needs -m \"<comment>\""}
	}
	if strings.Contains(*c.quote, "\n") {
		return UsageError{"--quote is plain words from one line"}
	}
	a, err := c.find(e, branch, name)
	if err != nil {
		return err
	}
	// The page places a quote by searching the document's text: say when the words are not there as written.
	if *c.quote != "" && a.Kind != "image" {
		if doc, err := c.h.ArtifactFileBytes(e.Ctx, c.full, a.ID, a.Latest.N, a.Latest.Files[0].Path); err == nil && !strings.Contains(string(doc), *c.quote) {
			e.warnf("%q is not in %s v%d as written; the page may show this comment as Unanchored", *c.quote, name, a.Latest.N)
		}
	}
	cm, err := c.h.AddArtifactComment(e.Ctx, c.full, a.ID, server.ArtifactCommentIn{Body: *c.msg, Quote: *c.quote}, newKey())
	if err != nil {
		return err
	}
	if *c.asJSON {
		return e.printJSON(cm.JSON)
	}
	e.printf("Commented on %s v%d (%s).\n", name, cm.Version, cm.ID)
	return nil
}

func artifactReply(e *Env, c *artifactCmd, pos []string) error {
	if len(pos) != 1 || strings.TrimSpace(*c.msg) == "" {
		return UsageError{"pando artifact reply <id> -m \"<reply>\""}
	}
	to, err := c.h.GetArtifactComment(e.Ctx, c.full, pos[0])
	if err != nil {
		return err
	}
	cm, err := c.h.AddArtifactComment(e.Ctx, c.full, to.Artifact, server.ArtifactCommentIn{Body: *c.msg, InReplyTo: to.ID}, newKey())
	if err != nil {
		return err
	}
	if *c.asJSON {
		return e.printJSON(cm.JSON)
	}
	e.printf("Replied in %s (%s).\n", cm.Thread, cm.ID)
	return nil
}

func artifactResolve(e *Env, c *artifactCmd, pos []string) error {
	if len(pos) != 1 {
		return UsageError{"pando artifact resolve <id> [--reopen]"}
	}
	state := "resolved"
	if *c.reopen {
		state = "open"
	}
	root, err := c.h.SetArtifactThreadState(e.Ctx, c.full, pos[0], state)
	if err != nil {
		var ae *server.APIError
		if errors.As(err, &ae) && ae.Status == 404 {
			return fmt.Errorf("no comment %s", pos[0])
		}
		return err
	}
	if *c.asJSON {
		return e.printJSON(root.JSON)
	}
	if state == "open" {
		e.printf("Reopened %s.\n", root.ID)
	} else {
		e.printf("Resolved %s.\n", root.ID)
	}
	return nil
}
