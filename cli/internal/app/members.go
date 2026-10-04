package app

import (
	"fmt"
	"strings"
	"text/tabwriter"

	"pando/internal/server"
)

// Members is `pando members list | invite | invites | revoke | remove`. The
// monorepo is named, or the one the current folder is in.
func Members(e *Env, args []string) error {
	usage := UsageError{"pando members list [<owner/name>] | invite [<owner/name>] <email> [--owner] | invites [<owner/name>] | revoke [<owner/name>] <email> | remove [<owner/name>] <login | email>"}
	if len(args) == 0 {
		return usage
	}
	fs := flags("members")
	owner := fs.Bool("owner", false, "invite as an owner (default: member)")
	asJSON := fs.Bool("json", false, "list, invites: print the API's JSON")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	want := map[string]int{"list": 0, "ls": 0, "invite": 1, "invites": 0, "revoke": 1, "remove": 1, "rm": 1}
	n, ok := want[args[0]]
	if !ok || len(pos) < n || len(pos) > n+1 {
		return usage
	}
	mono := ""
	if len(pos) == n+1 {
		mono, pos = pos[0], pos[1:]
	} else if root, err := e.root(); err == nil {
		mono = root.FullName()
	} else {
		return UsageError{"which monorepo? name it, or run this inside its folder"}
	}
	srv, _, err := e.signedIn(*srvFlag)
	if err != nil {
		return err
	}
	if _, _, full := splitFull(mono); !full {
		m, err := resolveMonorepo(e, srv, mono)
		if err != nil {
			return err
		}
		mono = m.Full()
	}
	if *asJSON {
		// The API's own answer: listMembers or listInvites.
		h, ok := srv.(*server.HTTP)
		if !ok || (args[0] != "list" && args[0] != "ls" && args[0] != "invites") {
			return UsageError{"--json goes with list or invites, on a Pando server"}
		}
		what := "/members"
		if args[0] == "invites" {
			what = "/invites"
		}
		data, err := h.Call(e.Ctx, "GET", server.MonorepoPath(mono)+what, nil, nil, nil)
		if err != nil {
			return err
		}
		return e.printJSON(data)
	}
	switch args[0] {
	case "list", "ls":
		ms, err := srv.ListMembers(e.Ctx, mono)
		if err != nil {
			return err
		}
		tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "MEMBER\tROLE\tADDED")
		for _, m := range ms {
			fmt.Fprintf(tw, "%s\t%s\t%s\n", m.Login, m.Role, dash(m.AddedAt))
		}
		if err := tw.Flush(); err != nil {
			return err
		}
		invs, err := srv.ListInvites(e.Ctx, mono)
		if err != nil {
			return err
		}
		if len(invs) > 0 {
			e.printf("\nInvited, waiting for their first sign-in:\n")
			return printInvites(e, invs)
		}
		return nil
	case "invites":
		invs, err := srv.ListInvites(e.Ctx, mono)
		if err != nil {
			return err
		}
		if len(invs) == 0 {
			e.printf("No invites are waiting in %s.\n", mono)
			return nil
		}
		return printInvites(e, invs)
	case "invite":
		role := "member"
		if *owner {
			role = "owner"
		}
		res, err := srv.Invite(e.Ctx, mono, pos[0], role)
		if err != nil {
			return err
		}
		if res.Status == "added" && res.Member != nil {
			e.printf("%s is now a %s of %s (as %s).\n", pos[0], res.Member.Role, mono, res.Member.Login)
			return nil
		}
		e.printf("Invited %s to %s as a %s. They join when they first sign in with pando login.\n", pos[0], mono, role)
		return nil
	case "revoke":
		if !strings.Contains(pos[0], "@") {
			return UsageError{"pando members revoke <email>: an invite is named by its email (pando members remove <login> removes a member)"}
		}
	}
	who := pos[0]
	if strings.Contains(who, "@") {
		if err := srv.RevokeInvite(e.Ctx, mono, who); err != nil {
			return err
		}
		e.printf("Withdrew the invite for %s.\n", who)
		return nil
	}
	if err := srv.RemoveMember(e.Ctx, mono, who); err != nil {
		return err
	}
	e.printf("Removed %s from %s.\n", who, mono)
	return nil
}

func printInvites(e *Env, invs []server.Invite) error {
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	for _, i := range invs {
		fmt.Fprintf(tw, "  %s\t%s\tby %s\t%s\n", i.Email, i.Role, i.InvitedBy, ago(i.CreatedAt))
	}
	return tw.Flush()
}
