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
	"syscall"

	"pando/internal/app"
)

var commands = []app.Command{
	{Name: "login", Usage: "login [--server <url>] [--name <name>] [--email <email>]   sign this machine in", Run: app.Login},
	{Name: "logout", Usage: "logout [--server <url>]                                   sign this machine out", Run: app.Logout},
	{Name: "auth", Usage: "auth status                                               who this machine is signed in as", Run: app.Auth},
	{Name: "init", Usage: "init [folder] [--name <name>] [--yes] [--dry-run]         make a Pando repo or monorepo from a folder", Run: app.Init},
	{Name: "clone", Usage: "clone <name> [folder]                                     set up a Pando repo or monorepo on this machine", Run: app.Clone},
	{Name: "worktree", Usage: "worktree add <repo> <branch> | list | remove <path>      one branch, one folder, one agent", Run: app.Worktree},
	{Name: "branch", Usage: "branch list [--repo <path>] [--all]                       branches with ahead, behind and checks", Run: app.Branch},
	{Name: "diff", Usage: "diff [<branch>] [--json | --patch] [paths...]             the branch diff against main", Run: app.Diff},
	{Name: "review", Usage: "review [<branch>] [-m <comment>]                          review in Plannotator, or comment", Run: app.Review},
	{Name: "merge", Usage: "merge [<branch>] [--force]                                land a branch on main with a merge commit", Run: app.Merge},
	{Name: "reference", Usage: "reference update <path>                                   move a reference to its newest commit", Run: app.Reference},
	{Name: "status", Usage: "status                                                    this folder, its worktrees and references", Run: app.Status},
	{Name: "credential", Usage: "credential create --name <sandbox> | list | revoke <id>   credentials that act as you", Run: app.Credential},
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: pando <command> [args]")
	fmt.Fprintln(os.Stderr)
	for _, c := range commands {
		fmt.Fprintln(os.Stderr, "  pando "+c.Usage)
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
