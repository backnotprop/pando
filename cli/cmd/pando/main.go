// The pando command. Each command lives in internal/app; lanes that own a
// package (the live lane's internal/meta) ask for their commands to be
// wired here.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"pando/internal/app"
	"pando/internal/meta"
)

// metaCommands are the live lane's (internal/meta): they take the arguments
// after their name and return an exit code.
var metaCommands = map[string]func([]string) int{
	"sync":    syncDaemon,
	"history": meta.CmdHistory,
	"restore": meta.CmdRestore,
	"resolve": meta.CmdResolve,
	"fetch":   meta.CmdFetch,
	// Hidden: pando meta sync is pando sync's old name, kept so scripts and
	// installed services keep working; pando meta status is a debugging aid.
	"meta": func(args []string) int {
		if len(args) > 0 && args[0] == "sync" {
			return syncDaemon(args[1:])
		}
		if len(args) > 0 && args[0] == "status" {
			return meta.CmdStatus(args[1:])
		}
		fmt.Fprintln(os.Stderr, "usage: pando sync [--once]")
		return 2
	},
}

// syncDaemon is pando sync, the one daemon of a monorepo: the live sync of
// its files outside projects/, and its read-only mains following merges.
func syncDaemon(args []string) int {
	if !hasFlag(args, "once") {
		dir, _ := os.Getwd()
		if r := flagValue(args, "root"); r != "" {
			dir = r
		}
		ctx, stop := context.WithCancel(context.Background())
		defer stop()
		app.StartFollower(ctx, dir)
	}
	return meta.CmdSync(args, meta.Hooks{References: app.ReferencesHook})
}

func hasFlag(args []string, name string) bool {
	for _, a := range args {
		if a == "-"+name || a == "--"+name || strings.HasPrefix(a, "--"+name+"=") {
			return true
		}
	}
	return false
}

func flagValue(args []string, name string) string {
	for i, a := range args {
		if (a == "-"+name || a == "--"+name) && i+1 < len(args) {
			return args[i+1]
		}
		if v, ok := strings.CutPrefix(a, "--"+name+"="); ok {
			return v
		}
	}
	return ""
}

var metaUsage = []string{
	"sync [--once]                                             keep the monorepo's files outside projects/ live (the daemon)",
	"history <path> [--limit n] [--json]                       every saved version of a file outside projects/",
	"restore <path> --to <version | HH:MM>                     write an old version back, as a new save",
	"resolve [<path>...]                                       unfreeze a file after a conflict",
	"fetch <path>...                                           download large files outside projects/ kept as pointers",
}

var commands = []app.Command{
	{Name: "login", Usage: "login [--server <url>] [--bootstrap | --with-credential]   sign this machine in (in the browser)", Run: app.Login},
	{Name: "logout", Usage: "logout [--server <url>]                                   sign this machine out", Run: app.Logout},
	{Name: "auth", Usage: "auth status                                               who this machine is signed in as", Run: app.Auth},
	{Name: "init", Usage: "init [folder] [--name <name>] [--owner <org>] [--yes] [--dry-run]   make a Pando repo or monorepo from a folder", Run: app.Init},
	{Name: "clone", Usage: "clone <owner/name | name> [folder] [--text-only]         set up a Pando repo or monorepo on this machine", Run: app.Clone},
	{Name: "worktree", Usage: "worktree add <repo> <branch> [--issue n] | list | remove <path> | follow | mount   one branch, one folder", Run: app.Worktree},
	{Name: "branch", Usage: "branch list [--repo <path>] [--all]                       branches with ahead, behind and checks\n  pando branch view [<branch>] [--commits]                        one branch: checks, merge, reviews, head commit", Run: app.Branch},
	{Name: "diff", Usage: "diff [<branch>] [--json | --patch] [paths...]             the branch diff against main", Run: app.Diff},
	{Name: "review", Usage: "review [<branch>] [-m <comment>]                          review in Plannotator, or comment", Run: app.Review},
	{Name: "merge", Usage: "merge [<branch>] [--force]                                land a branch on main with a merge commit", Run: app.Merge},
	{Name: "reference", Usage: "reference update <path> | sync                            move a reference to its newest commit", Run: app.Reference},
	{Name: "status", Usage: "status                                                    this folder, its worktrees and references\n  pando status <pending|success|failure|error> [--context ci] [--target-url u] [--description d]\n                                                                  in a CI build: a check on its commit (PANDO_STATUS_TOKEN)", Run: app.Status},
	{Name: "issue", Usage: "issue list [--state s] [--label l] [--assignee a] [--search w]   a monorepo's issues, newest first\n  pando issue view <n> [--comments]                               one issue: its body, branches and timeline\n  pando issue create --title t [--body b] [--label l] [--key k]   open an issue\n  pando issue comment <n> --body b [--key k]                      comment on one\n  pando issue close <n> [--reason not-planned] | reopen <n>       close or reopen one\n  pando issue edit <n> [--title t] [--body b] [--base-version v]   edit, label, assign one\n  pando issue link | unlink <n> [<branch>]                        merging the branch closes the issue\n  pando issue react <n> <reaction> [--comment id] [--remove]      +1, -1, laugh, hooray, confused, heart, rocket, eyes", Run: app.Issue},
	{Name: "monorepo", Usage: "monorepo list | view [<owner/name>]                       your monorepos; one with its repos and members\n  pando monorepo rename <new-name>                                rename one (owners); the old name keeps working\n  pando monorepo edit --description <text>                        its one line under the name on the web (owners)\n  pando monorepo transfer <owner/name> <new-owner> [--yes]        move one to an org, or back to a person (owners)\n  pando monorepo delete <owner/name> [--yes]                      delete one (owners)", Run: app.Monorepo},
	{Name: "members", Usage: "members list | invite <email> [--owner] | remove <who>    who belongs to a monorepo\n  pando members invites | revoke <email>                          invites still waiting; withdraw one", Run: app.Members},
	{Name: "org", Usage: "org create <login> [--name n] | list | view <org>         organizations: a namespace many people share\n  pando org members [<org>] | add <org> <email | login> [--owner]   who is in one; add someone (owners)\n  pando org remove <org> <login | email> | leave <org>            take someone out (owners), or leave", Run: app.Org},
	{Name: "mac", Usage: "mac broker [--dry-run]                                    load Pando.app's broker (before FSKit mounts)", Run: app.Mac},
	{Name: "ci", Usage: "ci connect --org <slug> | status | disconnect --org <slug>   a monorepo's Buildkite connection [--monorepo <owner/name>]\n  pando ci pipeline add <repo> <pipeline> | list | remove <repo> <pipeline>   the pipeline a push starts\n  pando ci build list [--pipeline p] [--branch b] [--state s]     builds, newest first\n  pando ci build view | log | rebuild | cancel <build>            one build: its jobs, a job's log [--job j] [--follow]\n  pando ci job retry <build> <job>                                run a job again\n  pando ci run <pipeline> [--branch b]                            start a build of a branch (default: main)", Run: app.CI},
	{Name: "credential", Usage: "credential create --name <sandbox> | list | revoke <id>   credentials that act as you", Run: app.Credential},
	{Name: "hook", Usage: "hook list | create <url> | delete <id>                    a repo's web hooks [--repo <path>] (owners write)\n  pando hook deliveries <id> | redeliver <delivery-id>            what a hook sent; send one again", Run: app.Hook},
	{Name: "machine", Usage: "machine list                                              machines that acted in the monorepo, and which are connected", Run: app.Machine},
	{Name: "profile", Usage: "profile [<login>] [--json]                                a person's profile: their graph for the last year, by month", Run: app.Profile},
	{Name: "activity", Usage: "activity [--monorepo <owner/name> | --all] [--limit n]    what happened, newest first", Run: app.Activity},
	{Name: "api", Usage: "api <path> [-X method] [-f k=v] [-F k=v] [--paginate]     any API call, signed as this machine (like gh api)", Run: app.API},
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: pando <command> [args]")
	fmt.Fprintln(os.Stderr)
	for _, c := range commands {
		fmt.Fprintln(os.Stderr, "  pando "+c.Usage)
	}
	for _, u := range metaUsage {
		fmt.Fprintln(os.Stderr, "  pando "+u)
	}
}

func main() {
	if len(os.Args) < 2 || os.Args[1] == "help" || os.Args[1] == "-h" || os.Args[1] == "--help" {
		usage()
		if len(os.Args) < 2 {
			os.Exit(2)
		}
		return
	}
	if run, ok := metaCommands[os.Args[1]]; ok {
		// A version 1 folder gets its owner/name first (the meta layer's
		// URLs are built from it).
		dir, _ := os.Getwd()
		if r := flagValue(os.Args[2:], "root"); r != "" {
			dir = r
		}
		if err := app.UpgradeRootAt(dir); err != nil {
			fmt.Fprintln(os.Stderr, "pando:", err)
			os.Exit(1)
		}
		os.Exit(run(os.Args[2:]))
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	e, err := app.NewEnv(ctx, os.Stdin, os.Stdout, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pando:", err)
		os.Exit(1)
	}
	for _, c := range commands {
		if c.Name != os.Args[1] {
			continue
		}
		err := c.Run(e, os.Args[2:])
		if err == nil {
			return
		}
		var ue app.UsageError
		if errors.As(err, &ue) {
			fmt.Fprintf(os.Stderr, "pando %s: %s\nusage: pando %s\n", c.Name, ue.Msg, c.Usage)
			os.Exit(2)
		}
		if err.Error() != "" {
			fmt.Fprintln(os.Stderr, "pando:", err)
		}
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "pando: unknown command %q\n\n", os.Args[1])
	usage()
	os.Exit(2)
}
