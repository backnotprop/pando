package app

import (
	"errors"
	"fmt"
	"strings"
	"text/tabwriter"
	"unicode/utf8"

	"pando/internal/server"
)

const orgUsage = "pando org create <login> [--name n] | list | view <org> | members [<org>] | add <org> <email | login> [--owner] | remove <org> <login | email> | leave <org>   [--json]"

// Org is `pando org`: organizations, namespaces many people share. Every
// member of an org can open and push to all of its repositories; its owners
// own them all. Adding and removing people needs an owner.
func Org(e *Env, args []string) error {
	usage := UsageError{orgUsage}
	if len(args) == 0 {
		return usage
	}
	fs := flags("org")
	name := fs.String("name", "", "create: its display name (up to 100 characters)")
	owner := fs.Bool("owner", false, "add: as an owner (default: member)")
	asJSON := fs.Bool("json", false, "print the API's JSON")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	want := map[string][2]int{"create": {1, 1}, "list": {0, 0}, "ls": {0, 0}, "view": {1, 1}, "members": {0, 1}, "add": {2, 2}, "remove": {2, 2}, "rm": {2, 2}, "leave": {1, 1}}
	n, ok := want[args[0]]
	if !ok || len(pos) < n[0] || len(pos) > n[1] {
		return usage
	}
	srv, _, err := e.signedIn(*srvFlag)
	if err != nil {
		return err
	}
	h, ok := srv.(*server.HTTP)
	if !ok {
		return errors.New("organizations need a Pando server; this one is a local file:// server")
	}
	out := func(data []byte, format string, a ...any) error {
		if *asJSON {
			return e.printJSON(data)
		}
		e.printf(format+"\n", a...)
		return nil
	}
	switch args[0] {
	case "create":
		return orgCreate(e, h, strings.ToLower(pos[0]), *name, *asJSON)
	case "list", "ls":
		l, err := h.MyOrgs(e.Ctx)
		if err != nil {
			return err
		}
		if *asJSON {
			return e.printJSON(l.JSON)
		}
		if len(l.Orgs) == 0 {
			e.printf("You are in no organization. Make one: pando org create <login>\n")
			return nil
		}
		tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "ORG\tNAME\tYOU ARE\tPEOPLE\tCREATED")
		for _, o := range l.Orgs {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", o.Login, dash(o.Name), dash(o.Role), num(o.Members), ago(o.CreatedAt))
		}
		return tw.Flush()
	case "view":
		return orgView(e, h, strings.ToLower(pos[0]), *asJSON)
	case "members":
		org := ""
		if len(pos) == 1 {
			org = strings.ToLower(pos[0])
		} else if root, err := e.root(); err == nil {
			org = root.Owner
		}
		if org == "" {
			return UsageError{"which organization? name it: pando org members <org>"}
		}
		return orgMembers(e, h, org, *asJSON)
	}
	org := strings.ToLower(pos[0])
	switch args[0] {
	case "add":
		role := "member"
		if *owner {
			role = "owner"
		}
		who := pos[1]
		if strings.Contains(who, "@") {
			r, err := h.InviteToOrg(e.Ctx, org, who, role)
			if err != nil {
				return ownerOnly(err, org, "add people")
			}
			if r.Status == "added" && r.Member != nil {
				return out(r.JSON, "%s is now a %s of %s (as %s).", who, r.Member.Role, org, r.Member.Login)
			}
			return out(r.JSON, "Invited %s to %s as a %s. They join when they first sign in with pando login.", who, org, role)
		}
		m, err := h.PutOrgMember(e.Ctx, org, strings.ToLower(who), role)
		if err != nil {
			return ownerOnly(err, org, "add people")
		}
		return out(m.JSON, "%s is a %s of %s: they can open and push to every repository it owns.", m.Login, m.Role, org)
	case "remove", "rm":
		who := pos[1]
		if strings.Contains(who, "@") {
			if err := h.RevokeOrgInvite(e.Ctx, org, who); err != nil {
				return ownerOnly(err, org, "withdraw an invite")
			}
			e.printf("Withdrew the invite for %s to %s.\n", who, org)
			return nil
		}
		if err := h.RemoveOrgMember(e.Ctx, org, strings.ToLower(who)); err != nil {
			return lastOwner(ownerOnly(err, org, "remove people"), org)
		}
		e.printf("Removed %s from %s. Their access to its repositories ends within about 15 seconds; repositories they are a member of directly stay theirs.\n", who, org)
		return nil
	}
	me, err := h.Me(e.Ctx)
	if err != nil {
		return err
	}
	if err := h.RemoveOrgMember(e.Ctx, org, me.Login); err != nil {
		return lastOwner(err, org)
	}
	e.printf("You left %s. Its repositories are no longer yours within about 15 seconds, unless you are a member of one directly.\n", org)
	return nil
}

// lastOwner explains the last_owner refusal.
func lastOwner(err error, org string) error {
	if server.Code(err) == "last_owner" {
		return fmt.Errorf("%w; make someone else an owner first: pando org add %s <login> --owner", err, org)
	}
	return err
}

// orgCreate makes an org. Safe to run again: an org of that name you
// already own is the one a first run made.
func orgCreate(e *Env, h *server.HTTP, login, name string, asJSON bool) error {
	if !loginRe.MatchString(login) {
		return fmt.Errorf("%q cannot be an organization's login: lower-case letters, digits and single dashes, at most 39", login)
	}
	if utf8.RuneCountInString(name) > 100 {
		return errors.New("--name is at most 100 characters")
	}
	o, err := h.CreateOrg(e.Ctx, login, name)
	if server.Code(err) == "namespace_taken" {
		if mine, gerr := h.GetOrg(e.Ctx, login); gerr == nil && mine.Role == "owner" {
			if asJSON {
				return e.printJSON(mine.JSON)
			}
			e.printf("%s exists already, and you own it; nothing new.\n", login)
			return nil
		}
		return fmt.Errorf("%w: a person or another organization has that name", err)
	}
	if err != nil {
		return err
	}
	if asJSON {
		return e.printJSON(o.JSON)
	}
	e.printf("Made organization %s; you are its owner.\n", o.Login)
	e.printf("Add people: pando org add %s <email | login>. Make a repository in it: pando init --owner %s, or move one in: pando monorepo transfer <owner/name> %s\n", o.Login, o.Login, o.Login)
	return nil
}

func orgView(e *Env, h *server.HTTP, org string, asJSON bool) error {
	o, err := h.GetOrg(e.Ctx, org)
	if err != nil {
		return err
	}
	if asJSON {
		return e.printJSON(o.JSON)
	}
	e.printf("%s", o.Login)
	if o.Name != "" {
		e.printf("  %s", o.Name)
	}
	e.printf("\n")
	if o.Description != "" {
		e.printf("  %s\n", o.Description)
	}
	if o.Website != "" {
		e.printf("  website   %s\n", o.Website)
	}
	e.printf("  created   %s\n", ago(o.CreatedAt))
	if o.Role == "" {
		e.printf("  you are not in it\n")
		return nil
	}
	e.printf("  you are   %s; %s people: pando org members %s\n", o.Role, num(o.Members), o.Login)
	ms, err := h.OwnerMonorepos(e.Ctx, o.Login)
	if err != nil {
		return err
	}
	if len(ms) == 0 {
		e.printf("\nNo repositories yet. Make one: pando init --owner %s\n", o.Login)
		return nil
	}
	e.printf("\n")
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "REPOSITORY\tKIND\tYOU ARE\tCREATED")
	for _, m := range ms {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", m.Full(), m.Kind, dash(m.Role), ago(m.CreatedAt))
	}
	return tw.Flush()
}

func orgMembers(e *Env, h *server.HTTP, org string, asJSON bool) error {
	l, err := h.OrgMembers(e.Ctx, org)
	if err != nil {
		if server.StatusOf(err) == 404 {
			return fmt.Errorf("no organization %s that you are in: %w", org, err)
		}
		return err
	}
	if asJSON {
		return e.printJSON(l.JSON)
	}
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "PERSON\tNAME\tROLE\tADDED\tLAST ACTIVE")
	for _, m := range l.Members {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", m.Login, dash(m.Name), m.Role, ago(m.AddedAt), ago(m.LastActiveAt))
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	invs, err := h.OrgInvites(e.Ctx, org)
	if err != nil || len(invs) == 0 {
		return nil // the invites are an owner's view: a member who cannot read them sees the people
	}
	e.printf("\nInvited, waiting for their first sign-in:\n")
	return printInvites(e, invs)
}
