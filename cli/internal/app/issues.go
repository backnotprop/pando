package app

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"strconv"
	"strings"
	"text/tabwriter"

	"pando/internal/server"
)

// ── pando issue: a monorepo's issues, numbered #1, #2, ... ─────────────────

const issueUsage = "pando issue list | view <n> | create --title t | comment <n> | close <n> | reopen <n> | edit <n> | link <n> [<branch>] | unlink <n> [<branch>] | react <n> <reaction>   [--monorepo <owner/name>] [--json]"

// Issue is `pando issue`. The monorepo is the one this folder is in, or
// --monorepo. Every subcommand takes --json: the API's answer, and with it a
// refusal prints the API's error object on stderr.
func Issue(e *Env, args []string) error {
	subs := map[string]func(*Env, []string) error{
		"list": issueList, "ls": issueList, "view": issueView, "create": issueCreate, "comment": issueComment,
		"close": issueClose, "reopen": issueReopen, "edit": issueEdit, "react": issueReact,
		"link":   func(e *Env, args []string) error { return issueLink(e, args, false) },
		"unlink": func(e *Env, args []string) error { return issueLink(e, args, true) },
	}
	if len(args) == 0 || subs[args[0]] == nil {
		return UsageError{issueUsage}
	}
	return subs[args[0]](e, args[1:])
}

// issueCmd is what every issue subcommand shares: its flags, then the
// server and the monorepo.
type issueCmd struct {
	fs     *flag.FlagSet
	usage  string
	mono   *string
	srv    *string
	asJSON *bool
	h      *server.HTTP
	full   string
}

func newIssueCmd(name, usage string) *issueCmd {
	fs := flags("issue " + name)
	return &issueCmd{
		fs:     fs,
		usage:  "pando issue " + usage,
		mono:   fs.String("monorepo", "", "the monorepo (default: the one this folder is in)"),
		srv:    fs.String("server", "", "the server (default: the configured one)"),
		asJSON: fs.Bool("json", false, "print the API's JSON"),
	}
}

// parse reads the flags, checks there are want positional arguments (with
// optional more), and finds the server and the monorepo.
func (c *issueCmd) parse(e *Env, args []string, want, optional int) ([]string, error) {
	pos, err := parse(c.fs, args)
	if err != nil {
		return nil, err
	}
	if len(pos) < want || len(pos) > want+optional {
		return nil, UsageError{c.usage}
	}
	c.h, c.full, err = e.target(*c.srv, *c.mono)
	return pos, err
}

func (c *issueCmd) set(name string) bool {
	found := false
	c.fs.Visit(func(f *flag.Flag) { found = found || f.Name == name })
	return found
}

// fail is how an issue command ends on an error: with --json, a refusal
// prints the API's error object on stderr; else one line, and for a stale
// body edit, the version it is at now.
func (c *issueCmd) fail(e *Env, err error) error {
	var ae *server.APIError
	if !errors.As(err, &ae) {
		return err
	}
	if *c.asJSON && len(ae.Body) > 0 {
		e.mu.Lock()
		fmt.Fprintln(e.Stderr, strings.TrimSpace(string(ae.Body)))
		e.mu.Unlock()
		return errSilent
	}
	if ae.Code == "edited" {
		var b struct {
			Error struct {
				Current struct {
					BodyVersion int `json:"body_version"`
				} `json:"current"`
			} `json:"error"`
		}
		_ = json.Unmarshal(ae.Body, &b)
		return fmt.Errorf("%w; it is at version %d now: read it again with --json, then edit with that --base-version", err, b.Error.Current.BodyVersion)
	}
	return err
}

// done prints a write's answer: the API's JSON, or line.
func (c *issueCmd) done(e *Env, data []byte, format string, a ...any) error {
	if *c.asJSON {
		return e.printJSON(data)
	}
	e.printf(format+"\n", a...)
	return nil
}

// issueNumber reads 12 or #12.
func issueNumber(arg string) (int, error) {
	n, err := strconv.Atoi(strings.TrimPrefix(arg, "#"))
	if err != nil || n < 1 {
		return 0, UsageError{fmt.Sprintf("%q is not an issue number (12, or #12)", arg)}
	}
	return n, nil
}

// bodyFrom is --body, or --body-file (- for standard input); ok says one was given.
func (c *issueCmd) bodyFrom(e *Env, body, file *string) (string, bool, error) {
	switch {
	case c.set("body") && c.set("body-file"):
		return "", false, UsageError{"give --body or --body-file, not both"}
	case c.set("body-file"):
		b, err := readInput(e, *file)
		return string(b), err == nil, err
	}
	return *body, c.set("body"), nil
}

// newKey is an Idempotency-Key for one run of a command: its retries reuse it.
func newKey() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return "cli-" + hex.EncodeToString(b)
}

// projectName is a project given as a path (projects/web) or a name, as the
// repo's name; "none" stays none.
func (c *issueCmd) projectName(e *Env, p string) (string, error) {
	if p == "" || p == "none" {
		return p, nil
	}
	r, err := e.repoIn(c.h, c.full, p)
	return r.Name, err
}

// ── list, view ─────────────────────────────────────────────────────────────

func issueList(e *Env, args []string) error {
	c := newIssueCmd("list", "list [--state open|closed|all] [--label l] [--assignee login|@me|none] [--author login|@me] [--project path|none] [--search words] [--sort created|updated|comments] [--limit n]")
	state := c.fs.String("state", "open", "open, closed or all")
	var labels multi
	c.fs.Var(&labels, "label", "with this label (repeat it: every one must match)")
	assignee := c.fs.String("assignee", "", "assigned to this login, @me, or none")
	author := c.fs.String("author", "", "opened by this login, or @me")
	project := c.fs.String("project", "", "about this project (its path), or none")
	search := c.fs.String("search", "", "these words in the title or body")
	sort := c.fs.String("sort", "", "created (default), updated or comments")
	limit := c.fs.Int("limit", 30, "how many issues")
	if _, err := c.parse(e, args, 0, 0); err != nil {
		return err
	}
	if *limit < 1 {
		return UsageError{"--limit is 1 or more"}
	}
	proj, err := c.projectName(e, *project)
	if err != nil {
		return err
	}
	l, err := c.h.ListIssues(e.Ctx, c.full, server.IssueFilter{State: *state, Labels: labels, Assignee: *assignee, Author: *author, Project: proj, Search: *search, Sort: *sort}, *limit)
	if err != nil {
		return c.fail(e, err)
	}
	if *c.asJSON {
		return e.printJSON(l.JSON)
	}
	e.printf("%s: %d open, %d closed", c.full, l.Counts.Open, l.Counts.Closed)
	if len(labels)+len(*assignee)+len(*author)+len(proj)+len(*search) > 0 {
		e.printf(" that match")
	}
	e.printf("\n")
	if len(l.Issues) == 0 {
		return nil
	}
	e.printf("\n")
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "ISSUE\tTITLE\tSTATE\tLABELS\tASSIGNEES\tPROJECT\tCOMMENTS\tUPDATED")
	for _, i := range l.Issues {
		fmt.Fprintf(tw, "#%d\t%s\t%s\t%s\t%s\t%s\t%d\t%s\n", i.Number, clip(i.Title, 60), stateWords(i.State, i.StateReason), dash(labelNames(i.Labels)),
			dash(strings.Join(i.Assignees, ",")), dash(i.ProjectPath), i.Comments, ago(i.UpdatedAt))
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	if l.NextCursor != "" {
		e.printf("\nMore: pando issue list --limit %d\n", *limit*2)
	}
	return nil
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-3]) + "..."
}

func labelNames(ls []server.Label) string {
	names := make([]string, len(ls))
	for i, l := range ls {
		names[i] = l.Name
	}
	return strings.Join(names, ",")
}

// stateWords is open, closed, or closed (not planned).
func stateWords(state, reason string) string {
	if state == "closed" && reason == "not_planned" {
		return "closed (not planned)"
	}
	return state
}

func issueView(e *Env, args []string) error {
	c := newIssueCmd("view", "view <n> [--comments]")
	comments := c.fs.Bool("comments", false, "also its timeline: comments and events, oldest first")
	pos, err := c.parse(e, args, 1, 0)
	if err != nil {
		return err
	}
	n, err := issueNumber(pos[0])
	if err != nil {
		return err
	}
	i, err := c.h.GetIssue(e.Ctx, c.full, n)
	if err != nil {
		return c.fail(e, err)
	}
	var tl *server.Timeline
	if *comments {
		if tl, err = c.h.IssueTimeline(e.Ctx, c.full, n); err != nil {
			return c.fail(e, err)
		}
	}
	if *c.asJSON {
		if tl == nil {
			return e.printJSON(i.JSON)
		}
		// The issue, and its timeline under "timeline".
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(i.JSON, &obj); err != nil {
			return err
		}
		obj["timeline"] = tl.JSON
		out, err := json.Marshal(obj)
		if err != nil {
			return err
		}
		return e.printJSON(out)
	}
	e.printf("#%d %s  %s\n", i.Number, i.Title, stateWords(i.State, i.StateReason))
	from := ""
	if i.Machine != "" {
		from = " from " + i.Machine
	}
	e.printf("  opened by %s%s, %s; %d comment(s); body version %d\n", i.Author, from, ago(i.CreatedAt), i.Comments, i.BodyVersion)
	if i.State == "closed" {
		how := ""
		if m := i.ClosedByMerge; m != nil {
			how = fmt.Sprintf(" by merging %s into main (%s)", m.Branch, short(m.MergeCommit))
		}
		e.printf("  closed    by %s%s, %s\n", dash(i.ClosedBy), how, ago(i.ClosedAt))
	}
	if len(i.Labels) > 0 {
		e.printf("  labels    %s\n", strings.ReplaceAll(labelNames(i.Labels), ",", ", "))
	}
	if len(i.Assignees) > 0 {
		e.printf("  assigned  %s\n", strings.Join(i.Assignees, ", "))
	}
	if i.ProjectPath != "" {
		e.printf("  project   %s\n", i.ProjectPath)
	}
	if i.Tasks != nil {
		e.printf("  tasks     %d of %d done\n", i.Tasks.Done, i.Tasks.Total)
	}
	for k, l := range i.Links {
		lead := "  branches  "
		if k > 0 {
			lead = "            "
		}
		closes := ""
		switch {
		case l.ClosedIssue:
			closes = ", closed this issue"
		case i.State == "open" && l.BranchState != "merged" && l.BranchState != "deleted":
			closes = ", closes this issue on merge"
		}
		e.printf("%s%s (%s): %s%s; linked from %s\n", lead, l.Branch, l.RepoPath, l.BranchState, closes, strings.Join(l.Sources, ", "))
	}
	if len(i.Reactions) > 0 {
		e.printf("  reactions %s\n", reactionWords(i.Reactions))
	}
	if strings.TrimSpace(i.Body) != "" {
		e.printf("\n%s\n", strings.TrimRight(i.Body, "\n"))
	}
	if tl == nil {
		return nil
	}
	for _, it := range tl.Items {
		printTimelineItem(e, it)
	}
	return nil
}

// reactionWords is "+1 3, heart 1".
func reactionWords(rs []server.ReactionGroup) string {
	parts := make([]string, len(rs))
	for k, r := range rs {
		parts[k] = fmt.Sprintf("%s %d", r.Content, r.Count)
	}
	return strings.Join(parts, ", ")
}

// printTimelineItem prints a comment with its body, an event as one line.
func printTimelineItem(e *Env, it server.TimelineItem) {
	who := dash(it.Actor)
	if it.Machine != "" {
		who += ", " + it.Machine
	}
	when := ago(it.At)
	merge := func(m *server.IssueMerge) string {
		if m == nil {
			return ""
		}
		return fmt.Sprintf(" by merging %s into main (%s)", m.Branch, short(m.MergeCommit))
	}
	switch it.Kind {
	case "comment":
		if it.Comment == nil {
			return
		}
		e.printf("\n--- %s commented, %s (%s) ---\n%s\n", who, when, it.Comment.ID, strings.TrimRight(it.Comment.Body, "\n"))
		if len(it.Comment.Reactions) > 0 {
			e.printf("reactions: %s\n", reactionWords(it.Comment.Reactions))
		}
		return
	case "labeled", "unlabeled":
		verb := "added"
		if it.Kind == "unlabeled" {
			verb = "removed"
		}
		name := ""
		if it.Label != nil {
			name = it.Label.Name
		}
		e.printf("%s %s the %s label, %s\n", who, verb, name, when)
	case "assigned":
		e.printf("%s assigned %s, %s\n", who, it.Assignee, when)
	case "unassigned":
		e.printf("%s unassigned %s, %s\n", who, it.Assignee, when)
	case "renamed":
		e.printf("%s changed the title from %q to %q, %s\n", who, it.From, it.To, when)
	case "project_changed":
		e.printf("%s moved this to %s, %s\n", who, dash(it.ToPath), when)
	case "linked":
		e.printf("%s linked %s (%s) from its %s, %s\n", who, it.Branch, it.RepoPath, it.Source, when)
	case "unlinked":
		e.printf("%s unlinked %s (%s), %s\n", who, it.Branch, it.RepoPath, when)
	case "closed":
		e.printf("%s closed this as %s%s, %s\n", who, strings.ReplaceAll(it.Reason, "_", " "), merge(it.Merge), when)
	case "reopened":
		e.printf("%s reopened this, %s\n", who, when)
	case "merge_referenced":
		e.printf("%s merged a branch that also names this issue%s, %s\n", who, merge(it.Merge), when)
	default:
		e.printf("%s %s, %s\n", who, it.Kind, when)
	}
}

// ── create, comment ────────────────────────────────────────────────────────

func issueCreate(e *Env, args []string) error {
	c := newIssueCmd("create", "create --title t [--body text | --body-file file] [--label l] [--assignee login] [--project path] [--key k]")
	title := c.fs.String("title", "", "the title (1 to 256 characters)")
	body := c.fs.String("body", "", "the body, Markdown")
	bodyFile := c.fs.String("body-file", "", "read the body from this file (- for standard input)")
	var labels, assignees multi
	c.fs.Var(&labels, "label", "a label (repeat it)")
	c.fs.Var(&assignees, "assignee", "a member's login, or @me (repeat it)")
	project := c.fs.String("project", "", "the project it is about (its path)")
	key := c.fs.String("key", "", "an idempotency key (up to 64 characters): a run again with the same key makes no second issue")
	if _, err := c.parse(e, args, 0, 0); err != nil {
		return err
	}
	if strings.TrimSpace(*title) == "" {
		return UsageError{c.usage}
	}
	text, _, err := c.bodyFrom(e, body, bodyFile)
	if err != nil {
		return err
	}
	who, err := c.logins(e, assignees)
	if err != nil {
		return err
	}
	proj, err := c.projectName(e, *project)
	if err != nil {
		return err
	}
	k := *key
	if k == "" {
		k = newKey()
	}
	i, err := c.h.CreateIssue(e.Ctx, c.full, server.IssueIn{Title: *title, Body: text, Labels: labels, Assignees: who, Project: proj}, k)
	if err != nil {
		return c.fail(e, err)
	}
	if i.Replayed {
		return c.done(e, i.JSON, "#%d %s was opened already, with this key; nothing new.", i.Number, i.Title)
	}
	return c.done(e, i.JSON, "Opened #%d %s", i.Number, i.Title)
}

// logins turns @me into this person's login.
func (c *issueCmd) logins(e *Env, in []string) ([]string, error) {
	out := make([]string, len(in))
	for k, l := range in {
		out[k] = l
		if l == "@me" {
			me, err := c.h.Me(e.Ctx)
			if err != nil {
				return nil, err
			}
			out[k] = me.Login
		}
	}
	return out, nil
}

func issueComment(e *Env, args []string) error {
	c := newIssueCmd("comment", "comment <n> (--body text | --body-file file) [--key k]")
	body := c.fs.String("body", "", "the comment, Markdown")
	bodyFile := c.fs.String("body-file", "", "read the comment from this file (- for standard input)")
	key := c.fs.String("key", "", "an idempotency key (up to 64 characters): a run again with the same key makes no second comment")
	pos, err := c.parse(e, args, 1, 0)
	if err != nil {
		return err
	}
	n, err := issueNumber(pos[0])
	if err != nil {
		return err
	}
	text, given, err := c.bodyFrom(e, body, bodyFile)
	if err != nil {
		return err
	}
	if !given || strings.TrimSpace(text) == "" {
		return UsageError{c.usage}
	}
	k := *key
	if k == "" {
		k = newKey()
	}
	cm, err := c.h.AddIssueComment(e.Ctx, c.full, n, text, k)
	if err != nil {
		return c.fail(e, err)
	}
	if cm.Replayed {
		return c.done(e, cm.JSON, "That comment is on #%d already (%s), with this key; nothing new.", n, cm.ID)
	}
	return c.done(e, cm.JSON, "Commented on #%d (%s).", n, cm.ID)
}

// ── close, reopen, edit ────────────────────────────────────────────────────

func issueClose(e *Env, args []string) error {
	c := newIssueCmd("close", "close <n> [--reason completed|not-planned] [--comment text]")
	reason := c.fs.String("reason", "completed", "completed or not-planned")
	comment := c.fs.String("comment", "", "comment first")
	pos, err := c.parse(e, args, 1, 0)
	if err != nil {
		return err
	}
	r := strings.ReplaceAll(*reason, "-", "_")
	if r != "completed" && r != "not_planned" {
		return UsageError{"--reason is completed or not-planned"}
	}
	return c.setState(e, pos[0], *comment, map[string]any{"state": "closed", "state_reason": r})
}

func issueReopen(e *Env, args []string) error {
	c := newIssueCmd("reopen", "reopen <n> [--comment text]")
	comment := c.fs.String("comment", "", "comment first")
	pos, err := c.parse(e, args, 1, 0)
	if err != nil {
		return err
	}
	return c.setState(e, pos[0], *comment, map[string]any{"state": "open"})
}

// setState comments (when asked) and then sets the state; both are safe to
// run again (the comment keeps one key across this run's retries).
func (c *issueCmd) setState(e *Env, arg, comment string, fields map[string]any) error {
	n, err := issueNumber(arg)
	if err != nil {
		return err
	}
	if comment != "" {
		if _, err := c.h.AddIssueComment(e.Ctx, c.full, n, comment, newKey()); err != nil {
			return c.fail(e, err)
		}
	}
	i, err := c.h.UpdateIssue(e.Ctx, c.full, n, fields)
	if err != nil {
		return c.fail(e, err)
	}
	if i.State == "open" {
		return c.done(e, i.JSON, "#%d %s is open.", i.Number, i.Title)
	}
	return c.done(e, i.JSON, "#%d %s is closed as %s.", i.Number, i.Title, strings.ReplaceAll(i.StateReason, "_", " "))
}

func issueEdit(e *Env, args []string) error {
	c := newIssueCmd("edit", "edit <n> [--title t] [--body text | --body-file file] [--base-version v] [--add-label l] [--remove-label l] [--add-assignee login] [--remove-assignee login] [--project path|none]")
	title := c.fs.String("title", "", "a new title")
	body := c.fs.String("body", "", "a new body, Markdown")
	bodyFile := c.fs.String("body-file", "", "read the new body from this file (- for standard input)")
	base := c.fs.Int("base-version", 0, "with a body: the body_version it was written from; refused (edited) when the body moved since")
	var addL, rmL, addA, rmA multi
	c.fs.Var(&addL, "add-label", "add a label (repeat it)")
	c.fs.Var(&rmL, "remove-label", "remove a label (repeat it)")
	c.fs.Var(&addA, "add-assignee", "assign a member, or @me (repeat it)")
	c.fs.Var(&rmA, "remove-assignee", "unassign a member, or @me (repeat it)")
	project := c.fs.String("project", "", "the project (its path), or none")
	pos, err := c.parse(e, args, 1, 0)
	if err != nil {
		return err
	}
	n, err := issueNumber(pos[0])
	if err != nil {
		return err
	}
	fields := map[string]any{}
	if c.set("title") {
		fields["title"] = *title
	}
	text, given, err := c.bodyFrom(e, body, bodyFile)
	if err != nil {
		return err
	}
	if given {
		fields["body"] = text
	}
	if c.set("base-version") {
		if !given {
			return UsageError{"--base-version goes with --body or --body-file"}
		}
		fields["base_version"] = *base
	}
	for key, list := range map[string][]string{"add_labels": addL, "remove_labels": rmL, "add_assignees": addA, "remove_assignees": rmA} {
		if len(list) == 0 {
			continue
		}
		if strings.HasSuffix(key, "assignees") {
			if list, err = c.logins(e, list); err != nil {
				return err
			}
		}
		fields[key] = list
	}
	if c.set("project") {
		proj, err := c.projectName(e, *project)
		if err != nil {
			return err
		}
		fields["project"] = proj
		if proj == "none" || proj == "" {
			fields["project"] = nil
		}
	}
	if len(fields) == 0 {
		return UsageError{c.usage}
	}
	i, err := c.h.UpdateIssue(e.Ctx, c.full, n, fields)
	if err != nil {
		return c.fail(e, err)
	}
	return c.done(e, i.JSON, "Edited #%d %s (body version %d).", i.Number, i.Title, i.BodyVersion)
}

// ── link, unlink, react ────────────────────────────────────────────────────

// issueLink is `pando issue link | unlink <n> [<branch>]`: the
// branch of the worktree this folder is in, unless named. A linked branch's
// merge closes the issue. Both are safe to run again.
func issueLink(e *Env, args []string, unlink bool) error {
	verb := "link"
	if unlink {
		verb = "unlink"
	}
	c := newIssueCmd(verb, verb+" <n> [<branch>] [--repo path]")
	repoFlag := c.fs.String("repo", "", "the branch's repo (default: the one this folder is in)")
	pos, err := c.parse(e, args, 1, 1)
	if err != nil {
		return err
	}
	n, err := issueNumber(pos[0])
	if err != nil {
		return err
	}
	branch := ""
	if len(pos) == 2 {
		branch = pos[1]
	} else if root, err := e.root(); err == nil {
		branch = e.currentBranch(root)
	}
	if branch == "" || branch == "main" {
		return UsageError{"which branch? name it, or run this inside its worktree"}
	}
	repo, err := e.repoIn(c.h, c.full, *repoFlag)
	if err != nil {
		return err
	}
	ref := []server.BranchRef{{Repo: repo.Name, Branch: branch}}
	if !unlink {
		i, err := c.h.UpdateIssue(e.Ctx, c.full, n, map[string]any{"link": ref})
		if err != nil {
			return c.fail(e, err)
		}
		return c.done(e, i.JSON, "Linked %s (%s) to #%d %s: merging it closes #%d.", branch, repoLabel(repo), n, i.Title, n)
	}
	i, err := c.h.UpdateIssue(e.Ctx, c.full, n, map[string]any{"unlink": ref})
	if err != nil {
		return c.fail(e, err)
	}
	for _, l := range i.Links {
		if l.Repo == repo.Name && l.Branch == branch {
			return c.done(e, i.JSON, "Unlinked %s from #%d; it is still linked from its %s (a closing keyword there), so merging it still closes #%d.", branch, n, strings.Join(l.Sources, " and "), n)
		}
	}
	return c.done(e, i.JSON, "Unlinked %s (%s) from #%d.", branch, repoLabel(repo), n)
}

// reactions are GitHub's eight, by name or as the emoji.
var reactions = map[string]string{
	"+1": "+1", "-1": "-1", "laugh": "laugh", "hooray": "hooray", "confused": "confused", "heart": "heart", "rocket": "rocket", "eyes": "eyes",
	"👍": "+1", "👎": "-1", "😄": "laugh", "🎉": "hooray", "😕": "confused", "❤️": "heart", "❤": "heart", "🚀": "rocket", "👀": "eyes",
}

func issueReact(e *Env, args []string) error {
	c := newIssueCmd("react", "react <n> <+1|-1|laugh|hooray|confused|heart|rocket|eyes> [--comment id] [--remove]")
	comment := c.fs.String("comment", "", "react to this comment (its id, ic_...) instead of the issue")
	remove := c.fs.Bool("remove", false, "take your reaction back")
	pos, err := c.parse(e, args, 2, 0)
	if err != nil {
		return err
	}
	n, err := issueNumber(pos[0])
	if err != nil {
		return err
	}
	content, ok := reactions[pos[1]]
	if !ok {
		return UsageError{c.usage}
	}
	r, err := c.h.React(e.Ctx, c.full, n, *comment, content, *remove)
	if err != nil {
		return c.fail(e, err)
	}
	on := fmt.Sprintf("#%d", n)
	if *comment != "" {
		on = "comment " + *comment + " on " + on
	}
	if *remove {
		return c.done(e, r.JSON, "Took back %s on %s.", content, on)
	}
	return c.done(e, r.JSON, "Reacted %s to %s (%s).", content, on, reactionWords(r.Reactions))
}
