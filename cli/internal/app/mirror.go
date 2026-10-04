package app

import (
	"errors"
	"fmt"
	"path"
	"strings"
	"text/tabwriter"
	"time"

	"pando/internal/server"
)

const mirrorUsage = "pando mirror status | on [<project>] | off [<project>] | retry [<project>...] | connect   [--monorepo <owner/name>] [--json]"

// Mirror is `pando mirror`: the repository's mirror to GitHub, in the same
// words as its section in Settings (research/plans/github-mirror-2026-10-04/
// SPEC.md, 5.2). Members read it; owners turn it on or off (off pauses), turn
// one project on or off, and retry. Setting it up needs GitHub in a browser,
// so connect opens Settings. No change of GitHub repository here: that is a
// person's choice on the screen.
func Mirror(e *Env, args []string) error {
	usage := UsageError{mirrorUsage}
	if len(args) == 0 {
		return usage
	}
	fs := flags("mirror")
	asJSON := fs.Bool("json", false, "print the API's JSON")
	mono := fs.String("monorepo", "", "the monorepo (default: the one this folder is in)")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	switch args[0] {
	case "status", "connect":
		if len(pos) > 0 {
			return usage
		}
	case "on", "off":
		if len(pos) > 1 {
			return usage
		}
	case "retry":
	default:
		return usage
	}
	h, full, err := e.target(*srvFlag, *mono)
	if err != nil {
		return err
	}
	switch args[0] {
	case "status":
		return mirrorStatus(e, h, full, *asJSON)
	case "connect":
		return mirrorConnect(e, h, full)
	case "retry":
		return mirrorRetry(e, h, full, pos, *asJSON)
	}
	if len(pos) == 1 {
		return mirrorProject(e, h, full, pos[0], args[0] == "on", *asJSON)
	}
	return mirrorSwitch(e, h, full, args[0] == "on", *asJSON)
}

func mirrorStatus(e *Env, h *server.HTTP, full string, asJSON bool) error {
	m, err := h.GetMirror(e.Ctx, full)
	if err != nil {
		return err
	}
	if asJSON {
		return e.printJSON(m.JSON)
	}
	e.printf("%s: %s\n", full, mirrorHeadline(m))
	if !m.Started || len(m.Targets) == 0 {
		return nil
	}
	e.printf("\n")
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 3, ' ', 0)
	fmt.Fprintln(tw, "PROJECT\tGITHUB\tSTATE")
	for _, t := range m.Targets {
		gh := "-"
		if t.Github != nil {
			gh = t.Github.FullName
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\n", mirrorLabel(full, t), gh, mirrorState(t))
	}
	return tw.Flush()
}

// mirrorHeadline is the status's first line, after the repository's name.
func mirrorHeadline(m *server.Mirror) string {
	switch {
	case !m.App.Configured:
		return "the GitHub App is not set up on this server"
	case m.Connection == nil:
		return "not connected. Set it up with: pando mirror connect"
	case !m.Started:
		return "connected to GitHub " + m.Connection.Login + ", not mirroring yet. Choose the repositories with: pando mirror connect"
	}
	to := "each project, to GitHub " + m.Connection.Login
	if m.Mode == "whole" {
		to = "whole repository, to GitHub " + m.Connection.Login
	}
	switch {
	case m.Paused != nil:
		return "paused by " + m.Paused.By + ", " + to
	case m.On:
		return "on, " + to
	}
	return "off, " + to
}

// mirrorLabel is how a row is named: a project by its path's last segment,
// the files outside projects/ (path ""), and the whole repository (or a
// plain repo) by the repository's name.
func mirrorLabel(full string, t server.MirrorTarget) string {
	switch t.Path {
	case "":
		return "files outside projects/"
	case "*", ".":
		return full
	}
	return path.Base(t.Path)
}

// mirrorState is a row's status in the screen's words.
func mirrorState(t server.MirrorTarget) string {
	switch t.State {
	case "up_to_date":
		if t.Last == nil {
			return "up to date"
		}
		return fmt.Sprintf("up to date, %s, %s", short(t.Last.Commit), shortSince(t.Last.At))
	case "not_started":
		return "starting"
	case "paused", "waiting":
		if t.Behind == nil || *t.Behind == 0 {
			return t.State
		}
		switch n := *t.Behind; {
		case n == 1:
			return t.State + ", 1 commit behind"
		case n >= 100:
			return t.State + ", 100+ commits behind"
		default:
			return fmt.Sprintf("%s, %d commits behind", t.State, n)
		}
	case "retrying", "no_access", "not_found", "refused":
		word := strings.ReplaceAll(t.State, "_", " ")
		if t.Problem != nil && t.Problem.Message != "" {
			return word + ": " + t.Problem.Message
		}
		return word
	}
	return t.State // off, mirroring
}

// shortSince is how long ago ts was: 12 s, 2 min, 3 h, 4 d.
func shortSince(ts string) string {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return "-"
	}
	d := max(time.Since(t), 0)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%d s", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%d min", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d h", int(d.Hours()))
	}
	return fmt.Sprintf("%d d", int(d.Hours()/24))
}

// mirrorNotSetUp is the error for a switch on a repository with no mirror yet.
func mirrorNotSetUp(full string, m *server.Mirror) error {
	if !m.App.Configured {
		return errors.New("the GitHub App is not set up on this server")
	}
	return fmt.Errorf("%s has no mirror set up yet. Set it up with: pando mirror connect", full)
}

func mirrorSwitch(e *Env, h *server.HTTP, full string, on, asJSON bool) error {
	m, err := h.SetMirrorOn(e.Ctx, full, on)
	if err != nil {
		return ownerOnly(err, full, "turn mirroring on or off")
	}
	if !m.Started {
		return mirrorNotSetUp(full, m)
	}
	if asJSON {
		return e.printJSON(m.JSON)
	}
	if on {
		e.printf("Mirroring of %s is on.\n", full)
	} else {
		e.printf("Mirroring of %s is paused. Turn it back on with: pando mirror on\n", full)
	}
	return nil
}

// mirrorProject is one project's switch: the full list of targets saved
// again, with that one on or off.
func mirrorProject(e *Env, h *server.HTTP, full, name string, on, asJSON bool) error {
	m, err := h.GetMirror(e.Ctx, full)
	if err != nil {
		return err
	}
	if !m.Started {
		return mirrorNotSetUp(full, m)
	}
	if m.Mode == "whole" {
		return fmt.Errorf("%s mirrors the whole repository to one GitHub repository, so it has no switch per project; use pando mirror on or off", full)
	}
	t, err := pickTarget(full, m.Targets, name)
	if err != nil {
		return err
	}
	label := mirrorLabel(full, t)
	if on && t.Github == nil {
		return fmt.Errorf("%s has no GitHub repository yet; choose one in Settings (pando mirror connect)", label)
	}
	var in []server.MirrorTargetIn
	for _, x := range m.Targets {
		if x.Github == nil {
			continue
		}
		xOn := x.On
		if x.Repo == t.Repo {
			xOn = on
		}
		in = append(in, server.MirrorTargetIn{Repo: x.Repo, GithubID: x.Github.ID, On: xOn})
	}
	saved, err := h.PutMirrorTargets(e.Ctx, full, m.Mode, in)
	if err != nil {
		return ownerOnly(err, full, "turn a project's mirror on or off")
	}
	if asJSON {
		return e.printJSON(saved.JSON)
	}
	word := "off"
	if on {
		word = "on"
	}
	e.printf("%s: %s\n", label, word)
	return nil
}

// pickTarget finds a row by the project's name as shown (pando), its path
// (projects/pando), its repo name, or "files" for the files outside projects/.
func pickTarget(full string, ts []server.MirrorTarget, arg string) (server.MirrorTarget, error) {
	a := strings.TrimSuffix(strings.TrimPrefix(arg, "./"), "/")
	var found []server.MirrorTarget
	var labels []string
	for _, t := range ts {
		label := mirrorLabel(full, t)
		labels = append(labels, label)
		if a != "" && (a == t.Repo || a == t.Path || a == strings.TrimSuffix(label, "/") || (t.Path == "" && a == "files")) {
			found = append(found, t)
		}
	}
	switch len(found) {
	case 1:
		return found[0], nil
	case 0:
		return server.MirrorTarget{}, fmt.Errorf("%s has no project %s to mirror (projects: %s)", full, arg, strings.Join(labels, ", "))
	}
	var paths []string
	for _, t := range found {
		paths = append(paths, t.Path)
	}
	return server.MirrorTarget{}, fmt.Errorf("%s is more than one project (%s); name it by its path", arg, strings.Join(paths, ", "))
}

// mirrorRetry is the row's Retry: try now, with the backoff reset.
func mirrorRetry(e *Env, h *server.HTTP, full string, names []string, asJSON bool) error {
	m, err := h.GetMirror(e.Ctx, full)
	if err != nil {
		return err
	}
	var repos []string
	for _, n := range names {
		t, err := pickTarget(full, m.Targets, n)
		if err != nil {
			return err
		}
		repos = append(repos, t.Repo)
	}
	q, err := h.RunMirror(e.Ctx, full, repos)
	if err != nil {
		return ownerOnly(err, full, "retry the mirror")
	}
	if asJSON {
		return e.printJSON(q.JSON)
	}
	labels := map[string]string{}
	for _, t := range m.Targets {
		labels[t.Repo] = mirrorLabel(full, t)
	}
	labelOf := func(repo string) string {
		if l, ok := labels[repo]; ok {
			return l
		}
		return repo
	}
	for _, r := range q.Queued {
		e.printf("%s: queued\n", labelOf(r))
	}
	for _, s := range q.Skipped {
		e.printf("%s: not queued, %s\n", labelOf(s.Repo), strings.ReplaceAll(s.Reason, "_", " "))
	}
	if len(q.Queued) == 0 && len(q.Skipped) == 0 {
		if m.Paused != nil {
			e.printf("nothing to retry: mirroring is paused. Turn it back on with: pando mirror on\n")
		} else {
			e.printf("nothing to retry\n")
		}
	}
	return nil
}

// mirrorConnect opens the repository's Settings: connecting the GitHub App
// and choosing repositories happen on GitHub, in a browser.
func mirrorConnect(e *Env, h *server.HTTP, full string) error {
	u := h.Base + "/" + full + "/settings"
	if openBrowser(e, u) {
		e.printf("Setting up a mirror needs GitHub in a browser. Opening:\n  %s\n", u)
	} else {
		e.printf("Setting up a mirror needs GitHub in a browser. Open:\n  %s\n", u)
	}
	return nil
}
