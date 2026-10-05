package app

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"pando/internal/config"
	"pando/internal/server"
	"pando/internal/session"
)

// SessionUsage is the help line for `pando session`.
const SessionUsage = `session enable | disable                              record agent sessions on this machine, or stop
  pando session status                                            what this machine records, from where, and what it skips
  pando session paths [add <folder> --agent <name> | remove <folder>]   where agents keep sessions, beyond the usual places
  pando session exclude | include <owner/name> [--project <path>]   a repository or project you do not record, on every machine
  pando session delete <id> [--monorepo <owner/name>]             delete a session at once and for good`

// Session is `pando session`.
func Session(e *Env, args []string) error {
	if len(args) == 0 {
		return UsageError{"which? enable, disable, status, paths, exclude, include or delete"}
	}
	switch args[0] {
	case "enable", "disable":
		return sessionSwitch(e, args[0] == "enable")
	case "status":
		return sessionStatus(e)
	case "paths":
		return sessionPaths(e, args[1:])
	case "exclude", "include":
		return sessionExclude(e, args[0] == "exclude", args[1:])
	case "delete":
		return sessionDelete(e, args[1:])
	case "trailer":
		sessionTrailer(e)
		return nil
	}
	return UsageError{"unknown: pando session " + args[0]}
}

func sessionSwitch(e *Env, on bool) error {
	s, err := session.LoadSettings(e.Home.Dir)
	if err != nil {
		return err
	}
	s.Record = &on
	if err := s.Save(); err != nil {
		return err
	}
	if on {
		e.printf("This machine records agent sessions in Pando folders. Every member of a repository sees its sessions.\n")
	} else {
		e.printf("This machine no longer records agent sessions. Sessions already recorded stay until deleted.\n")
	}
	return nil
}

// askRecording is pando login's question, asked once per machine.
func askRecording(e *Env) {
	s, err := session.LoadSettings(e.Home.Dir)
	if err != nil || s.Record != nil || !e.isTerminal() {
		return
	}
	fmt.Fprint(e.Stderr, "Record agent sessions on this machine (Claude Code, Codex, Pi, OpenCode)?\nEvery member of a repository sees its sessions; secrets are removed first. [y/N] ")
	line, err := e.readLine()
	if err != nil {
		return
	}
	on := strings.HasPrefix(strings.ToLower(line), "y")
	s.Record = &on
	if s.Save() == nil && !on {
		e.printf("Not recording. Turn it on later with: pando session enable\n")
	}
}

func sessionStatus(e *Env) error {
	s, err := session.LoadSettings(e.Home.Dir)
	if err != nil {
		return err
	}
	switch {
	case s.Record == nil:
		e.printf("Recording: off (never asked; pando session enable turns it on)\n")
	case *s.Record:
		e.printf("Recording: on\n")
	default:
		e.printf("Recording: off\n")
	}
	home, _ := os.UserHomeDir()
	stores := session.Stores(e.Home.Dir, s, os.Getenv, home)
	e.printf("\nWhere sessions are read from:\n")
	if len(stores) == 0 {
		e.printf("  none found\n")
	}
	for _, st := range stores {
		e.printf("  %-12s %s  (%s)\n", st.Program, st.Path, st.Found)
	}
	root, err := e.root()
	if err != nil {
		return nil
	}
	rules, _ := config.LoadSettings(root.Dir)
	e.printf("\nIn %s:\n", root.FullName())
	if rules != nil && rules.Sessions.Record != nil && !*rules.Sessions.Record {
		e.printf("  not recorded: .pando/pando.toml says record = false\n")
	}
	if rules != nil {
		for _, p := range rules.Sessions.Exclude {
			e.printf("  not recorded: %s (.pando/pando.toml)\n", p)
		}
	}
	for _, x := range session.CachedExclusions(e.Home.Dir) {
		if x.MonorepoID == root.ID || x.Monorepo == root.FullName() {
			what := "the whole repository"
			if x.Project != nil {
				what = *x.Project
			}
			e.printf("  not recorded: %s (your own list)\n", what)
		}
	}
	st, err := session.LoadState(root.Dir)
	if err != nil {
		return err
	}
	var sent, deleted, rewritten int
	for _, t := range st.Sessions {
		switch {
		case t.Deleted:
			deleted++
		case t.Rewritten:
			rewritten++
		default:
			sent++
		}
	}
	e.printf("  sessions recorded from this machine: %d", sent)
	if deleted > 0 {
		e.printf(", %d deleted (no longer sent)", deleted)
	}
	if rewritten > 0 {
		e.printf(", %d whose files the agent wrote again (no longer sent)", rewritten)
	}
	e.printf("\n  session files elsewhere on this machine, not read: %d\n", len(st.Skip))
	return nil
}

func sessionPaths(e *Env, args []string) error {
	s, err := session.LoadSettings(e.Home.Dir)
	if err != nil {
		return err
	}
	if len(args) == 0 || args[0] == "list" {
		home, _ := os.UserHomeDir()
		for _, st := range session.Stores(e.Home.Dir, s, os.Getenv, home) {
			e.printf("%-12s %s  (%s)\n", st.Program, st.Path, st.Found)
		}
		return nil
	}
	fs := flags("session paths")
	agent := fs.String("agent", "", "claude-code, codex, pi or opencode")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return UsageError{"give one folder"}
	}
	path := e.abs(pos[0])
	switch args[0] {
	case "add":
		program := *agent
		if program == "" && strings.HasSuffix(path, ".db") {
			program = session.OpenCode
		}
		if !isProgram(program) {
			return UsageError{"which agent keeps sessions there? add --agent claude-code, codex, pi or opencode"}
		}
		if _, err := os.Stat(path); err != nil {
			return err
		}
		st := session.Normalize(program, path)
		for _, have := range s.Paths {
			if have.Program == st.Program && have.Path == st.Path {
				e.printf("Already read: %s\n", st.Path)
				return nil
			}
		}
		s.Paths = append(s.Paths, st)
		if err := s.Save(); err != nil {
			return err
		}
		e.printf("pando sync now reads %s sessions from %s\n", program, st.Path)
	case "remove":
		kept := s.Paths[:0]
		for _, p := range s.Paths {
			if p.Path != path && p.Path != filepath.Join(path, "projects") && p.Path != filepath.Join(path, "sessions") {
				kept = append(kept, p)
			}
		}
		if len(kept) == len(s.Paths) {
			return fmt.Errorf("%s was not added with pando session paths add", path)
		}
		s.Paths = kept
		return s.Save()
	default:
		return UsageError{"pando session paths [add <folder> --agent <name> | remove <folder>]"}
	}
	return nil
}

func isProgram(p string) bool {
	for _, x := range session.Programs {
		if x == p {
			return true
		}
	}
	return false
}

func sessionExclude(e *Env, exclude bool, args []string) error {
	fs := flags("session exclude")
	project := fs.String("project", "", "one project's path, such as projects/web")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	mono := ""
	if len(pos) > 0 {
		mono = pos[0]
	}
	h, full, err := e.target("", mono)
	if err != nil {
		return err
	}
	list, err := h.SessionExclusions(e.Ctx)
	if err != nil {
		return err
	}
	same := func(x server.SessionExclusion) bool {
		p := ""
		if x.Project != nil {
			p = *x.Project
		}
		return x.Monorepo == full && p == strings.Trim(*project, "/")
	}
	var out []server.SessionExclusion
	found := false
	for _, x := range list {
		if same(x) {
			found = true
			if !exclude {
				continue
			}
		}
		out = append(out, server.SessionExclusion{Monorepo: x.Monorepo, Project: x.Project})
	}
	what := full
	if *project != "" {
		what = full + " " + strings.Trim(*project, "/")
	}
	if exclude && !found {
		x := server.SessionExclusion{Monorepo: full}
		if *project != "" {
			p := strings.Trim(*project, "/")
			x.Project = &p
		}
		out = append(out, x)
	}
	if err := h.SetSessionExclusions(e.Ctx, out); err != nil {
		return err
	}
	// The commit hook reads this cache; pando sync refreshes it too.
	cached := make([]session.CachedExclusion, 0, len(out))
	for _, x := range out {
		cached = append(cached, session.CachedExclusion{Monorepo: x.Monorepo, Project: x.Project})
	}
	if root, err := e.root(); err == nil && root.FullName() == full {
		for i := range cached {
			if cached[i].Monorepo == full {
				cached[i].MonorepoID = root.ID
			}
		}
	}
	_ = writeExclusionsCache(e.Home.Dir, cached)
	if exclude {
		e.printf("Not recorded from now on, on every machine you sign in on: %s\n", what)
	} else {
		e.printf("Recorded again: %s\n", what)
	}
	return nil
}

func sessionDelete(e *Env, args []string) error {
	fs := flags("session delete")
	mono := fs.String("monorepo", "", "the monorepo (default: the one this folder is in)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return UsageError{"give the session's id (s_...)"}
	}
	h, full, err := e.target("", *mono)
	if err != nil {
		return err
	}
	v, err := h.DeleteSession(e.Ctx, full, pos[0])
	if err != nil {
		return err
	}
	e.printf("Deleted %s. It is gone for every member; commits that name it say it was deleted by %s.\n", v.ID, v.DeletedBy)
	return nil
}

// sessionTrailer is the commit hook's step (worktree/hook.go): it prints the Pando-Session id for this commit, or
// nothing. It never fails the commit.
func sessionTrailer(e *Env) {
	defer func() { _ = recover() }()
	s, err := session.LoadSettings(e.Home.Dir)
	if err != nil || !s.Recording() {
		return
	}
	gitDir := os.Getenv("GIT_DIR")
	if gitDir == "" {
		out, err := exec.Command("git", "rev-parse", "--absolute-git-dir").Output()
		if err != nil {
			return
		}
		gitDir = strings.TrimSpace(string(out))
	}
	nearest := session.NearestAgent(os.Getppid())
	id := session.TrailerFor(gitDir, os.Getenv, nearest, true)
	if id == "" {
		return
	}
	session.LearnFromShell(e.Home.Dir, nearest, os.Getenv)
	if out, err := exec.Command("git", "config", "--get", "pando.root").Output(); err == nil {
		if root, err := config.LoadRoot(strings.TrimSpace(string(out))); err == nil {
			rules, _ := config.LoadSettings(root.Dir)
			var repoRule []string
			if rules != nil {
				if rules.Sessions.Record != nil && !*rules.Sessions.Record {
					return
				}
				repoRule = rules.Sessions.Exclude
			}
			if session.Excluded(root, session.PlaceOf(root, e.Cwd), repoRule, session.CachedExclusions(e.Home.Dir)) {
				return
			}
			// Sent now, not after the usual 30 s: the commit's session reaches the server with the commit.
			if f, err := os.OpenFile(session.NudgeFile(root.Dir), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
				fmt.Fprintln(f, id)
				f.Close()
			}
		}
	}
	fmt.Fprint(e.Stdout, id)
}

func writeExclusionsCache(homeDir string, list []session.CachedExclusion) error {
	if err := os.MkdirAll(homeDir, 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(list)
	if err != nil {
		return err
	}
	return os.WriteFile(session.ExclusionsFile(homeDir), b, 0o600)
}
