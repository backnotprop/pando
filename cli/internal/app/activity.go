package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"text/tabwriter"

	"pando/internal/server"
)

// Activity is `pando activity`: what happened, newest first, one line each,
// as the web's home shows it. In a monorepo's folder, that monorepo's; else,
// or with --all, every monorepo you belong to.
func Activity(e *Env, args []string) error {
	fs := flags("activity")
	mono := fs.String("monorepo", "", "one monorepo (default: the one this folder is in)")
	all := fs.Bool("all", false, "every monorepo you belong to, even inside a monorepo's folder")
	limit := fs.Int("limit", 30, "how many lines")
	asJSON := fs.Bool("json", false, "print the API's JSON")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) > 0 || *limit < 1 || (*all && *mono != "") {
		return UsageError{"pando activity [--monorepo <owner/name> | --all] [--limit n] [--json]"}
	}
	in := ""
	var h *server.HTTP
	if _, rootErr := e.root(); !*all && (*mono != "" || rootErr == nil) {
		if h, in, err = e.target(*srvFlag, *mono); err != nil {
			return err
		}
	} else {
		srv, _, err := e.signedIn(*srvFlag)
		if err != nil {
			return err
		}
		var ok bool
		if h, ok = srv.(*server.HTTP); !ok {
			return fmt.Errorf("activity needs a Pando server; this one is a local file:// server")
		}
	}
	a, err := h.Activity(e.Ctx, in, *limit)
	if err != nil {
		return err
	}
	if *asJSON {
		return e.printJSON(a.JSON)
	}
	if len(a.Events) == 0 {
		e.printf("Nothing yet.\n")
		return nil
	}
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	for _, ev := range a.Events {
		if in == "" {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", ago(ev.At), ev.Monorepo, lineBy(ev), lineWhat(ev))
		} else {
			fmt.Fprintf(tw, "%s\t%s\t%s\n", ago(ev.At), lineBy(ev), lineWhat(ev))
		}
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	if len(a.Skipped) > 0 {
		e.warnf("not read for this page (over 20 monorepos): %s; narrow with --monorepo", strings.Join(a.Skipped, ", "))
	}
	return nil
}

// feedSummary is a line's summary; its fields depend on the kind.
type feedSummary struct {
	Commits   *int   `json:"commits"`
	HeadTitle string `json:"head_title"`
	Head      string `json:"head"`
	Forced    bool   `json:"forced"`
	Title     string `json:"title"`
	Verdict   string `json:"verdict"`
	Context   string `json:"context"`
	State     string `json:"state"`
	SHA       string `json:"sha"`
	App       string `json:"app"`
	Path      string `json:"path"`
	Deleted   bool   `json:"deleted"`
}

// lineBy is who a line is by: the person and the machine, or the CI service
// that posted a check.
func lineBy(ev server.FeedEvent) string {
	var s feedSummary
	_ = json.Unmarshal(ev.Summary, &s)
	w := ev.Actor
	if w == "" {
		w = s.App
	}
	if ev.Machine != "" && ev.Machine != w {
		w += " on " + ev.Machine
	}
	return dash(w)
}

// lineWhat is a line's action in words.
func lineWhat(ev server.FeedEvent) string {
	var s feedSummary
	_ = json.Unmarshal(ev.Summary, &s)
	quote := func(t string) string {
		if t == "" {
			return ""
		}
		return ": " + t
	}
	in := ""
	if ev.RepoPath != "" && ev.RepoPath != "." {
		in = " in " + ev.RepoPath
	}
	b := dash(ev.Branch)
	switch ev.Kind {
	case "push":
		n := "pushed"
		if s.Commits != nil {
			n = fmt.Sprintf("pushed %d commit(s)", *s.Commits)
			if *s.Commits == 1 {
				n = "pushed 1 commit"
			}
		}
		return n + " to " + b + in + quote(s.HeadTitle)
	case "branch.opened":
		return "opened " + b + in + quote(s.HeadTitle)
	case "branch.deleted":
		return "deleted branch " + b + in
	case "merged":
		forced := ""
		if s.Forced {
			forced = " past its checks"
		}
		return "merged " + b + in + forced + quote(s.Title)
	case "review":
		switch s.Verdict {
		case "approve":
			return "approved " + b + in
		case "request_changes":
			return "asked for changes on " + b + in
		}
		return "commented on " + b + in
	case "status":
		on := ev.Branch
		if on == "" {
			on = short(s.SHA)
		}
		return s.Context + " " + s.State + " on " + dash(on) + in
	case "worktree.reported":
		return "added a worktree at " + dash(s.Path) + " (" + b + ")"
	case "worktree.removed":
		return "removed the worktree at " + dash(s.Path)
	case "meta.saved":
		if s.Deleted {
			return "deleted " + dash(s.Path)
		}
		return "saved " + dash(s.Path)
	}
	return ev.Kind + " " + b + in
}

// Machine is `pando machine list`: each machine (a credential) that acted in
// the monorepo or is connected to it, latest activity first.
func Machine(e *Env, args []string) error {
	usage := UsageError{"pando machine list [--monorepo <owner/name>] [--json]"}
	if len(args) == 0 || (args[0] != "list" && args[0] != "ls") {
		return usage
	}
	fs := flags("machine list")
	asJSON := fs.Bool("json", false, "print the API's JSON")
	mono := fs.String("monorepo", "", "the monorepo (default: the one this folder is in)")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	if len(pos) > 0 {
		return usage
	}
	h, full, err := e.target(*srvFlag, *mono)
	if err != nil {
		return err
	}
	l, err := h.ListMachines(e.Ctx, full)
	if err != nil {
		return err
	}
	if *asJSON {
		return e.printJSON(l.JSON)
	}
	if len(l.Machines) == 0 {
		e.printf("No machine has acted in %s yet.\n", full)
		return nil
	}
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "MACHINE\tPERSON\tKIND\tCONNECTED\tWORKTREES\tLAST ACTIVITY")
	for _, m := range l.Machines {
		conn := "no"
		if m.Connected {
			conn = "since " + ago(m.ConnectedAt)
		}
		last := "-"
		if a := m.LastActivity; a != nil {
			last = a.Kind
			if a.Branch != "" {
				last += " " + a.Branch
			}
			if a.RepoPath != "" && a.RepoPath != "." {
				last += " in " + a.RepoPath
			}
			last += ", " + ago(a.At)
		}
		name := m.Name
		if name == e.Home.Machine {
			name += " (here)"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%d\t%s\n", name, m.Login, dash(m.Kind), conn, len(m.Worktrees), last)
	}
	return tw.Flush()
}
