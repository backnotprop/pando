package app

import (
	"errors"
	"fmt"
	"text/tabwriter"
)

// Monorepo is `pando monorepo list | delete <name>`.
func Monorepo(e *Env, args []string) error {
	usage := UsageError{"pando monorepo list | delete <name> [--yes]"}
	if len(args) == 0 {
		return usage
	}
	fs := flags("monorepo")
	yes := fs.Bool("yes", false, "delete without typing the name (scripts)")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	srv, serverURL, err := e.signedIn(*srvFlag)
	if err != nil {
		return err
	}
	switch args[0] {
	case "list", "ls":
		ms, err := srv.ListMonorepos(e.Ctx, "")
		if err != nil {
			return err
		}
		tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "MONOREPO\tKIND\tYOU ARE\tCREATED")
		for _, m := range ms {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", m.Full(), m.Kind, dash(m.Role), dash(m.CreatedAt))
		}
		return tw.Flush()
	case "delete":
		if len(pos) != 1 {
			return usage
		}
		m, err := resolveMonorepo(e, srv, pos[0])
		if err != nil {
			return err
		}
		name := m.Full()
		if !*yes {
			if !e.isTerminal() {
				return errors.New("deleting needs the name typed at a terminal, or --yes")
			}
			e.printf("This deletes %s on %s: every repo in it, their history, and its files outside projects/. There is no undo.\n", name, serverURL)
			e.printf("Type its full name (%s) to delete it: ", name)
			typed, err := e.readLine()
			if err != nil {
				return err
			}
			if typed != name {
				return errors.New("the name did not match; nothing was deleted")
			}
		}
		if err := srv.DeleteMonorepo(e.Ctx, name); err != nil {
			return err
		}
		e.printf("Deleted %s. Folders on this machine are left as they are.\n", name)
		return nil
	}
	return usage
}
