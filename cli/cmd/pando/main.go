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
	"time"

	"pando/internal/app"
	"pando/internal/meta"
)

// metaCommands are the live lane's (internal/meta): they take the arguments
// after their name and return an exit code.
var metaCommands = map[string]func([]string) int{
	"history": meta.CmdHistory,
	"restore": meta.CmdRestore,
	"resolve": meta.CmdResolve,
	"fetch":   meta.CmdFetch,
	"meta": func(args []string) int {
		if len(args) > 0 && args[0] == "sync" {
			// The one daemon of a monorepo: the meta layer, and its
			// read-only mains following merges.
			if !hasFlag(args[1:], "once") {
				dir, _ := os.Getwd()
				if r := flagValue(args[1:], "root"); r != "" {
					dir = r
				}
				ctx, stop := context.WithCancel(context.Background())
				defer stop()
				app.StartFollower(ctx, dir, 15*time.Second)
			}
			return meta.CmdSync(args[1:], meta.Hooks{References: app.ReferencesHook})
		}
		if len(args) > 0 && args[0] == "status" {
			return meta.CmdStatus(args[1:])
		}
		fmt.Fprintln(os.Stderr, "usage: pando meta sync [--once] | status")
		return 2
	},
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
	"meta sync [--once]                                        keep the meta layer live (the daemon)",
	"history <path> [--limit n] [--json]                       every saved version of a meta layer file",
	"restore <path> --to <version | HH:MM>                     write an old version back, as a new save",
	"resolve [<path>...]                                       unfreeze a file after a conflict",
	"fetch <path>...                                           download large meta layer files kept as pointers",
}

var commands = []app.Command{
	{Name: "login", Usage: "login [--server <url>] [--bootstrap | --with-credential]   sign this machine in (in the browser)", Run: app.Login},
	{Name: "logout", Usage: "logout [--server <url>]                                   sign this machine out", Run: app.Logout},
	{Name: "auth", Usage: "auth status                                               who this machine is signed in as", Run: app.Auth},
	{Name: "init", Usage: "init [folder] [--name <name>] [--yes] [--dry-run]         make a Pando repo or monorepo from a folder", Run: app.Init},
	{Name: "clone", Usage: "clone <name> [folder] [--text-only]                       set up a Pando repo or monorepo on this machine", Run: app.Clone},
	{Name: "worktree", Usage: "worktree add <repo> <branch> | list | remove <path> | follow | mount   one branch, one folder, one agent", Run: app.Worktree},
	{Name: "branch", Usage: "branch list [--repo <path>] [--all]                       branches with ahead, behind and checks", Run: app.Branch},
	{Name: "diff", Usage: "diff [<branch>] [--json | --patch] [paths...]             the branch diff against main", Run: app.Diff},
	{Name: "review", Usage: "review [<branch>] [-m <comment>]                          review in Plannotator, or comment", Run: app.Review},
	{Name: "merge", Usage: "merge [<branch>] [--force]                                land a branch on main with a merge commit", Run: app.Merge},
	{Name: "reference", Usage: "reference update <path> | sync                            move a reference to its newest commit", Run: app.Reference},
	{Name: "status", Usage: "status                                                    this folder, its worktrees and references", Run: app.Status},
	{Name: "monorepo", Usage: "monorepo list | delete <name> [--yes]                     your monorepos; delete one (owners)", Run: app.Monorepo},
	{Name: "members", Usage: "members list | invite <email> [--owner] | remove <who>      who belongs to a monorepo", Run: app.Members},
	{Name: "mac", Usage: "mac broker [--dry-run]                                    load Pando.app's broker (before FSKit mounts)", Run: app.Mac},
	{Name: "credential", Usage: "credential create --name <sandbox> | list | revoke <id>   credentials that act as you", Run: app.Credential},
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
