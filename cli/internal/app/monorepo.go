package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"text/tabwriter"

	"pando/internal/config"
	"pando/internal/server"
)

// Monorepo is `pando monorepo list | view | rename | delete`.
func Monorepo(e *Env, args []string) error {
	usage := UsageError{"pando monorepo list | view [<owner/name>] | rename <new-name> | transfer <owner/name> <new-owner> [--yes] | delete <owner/name> [--yes]"}
	if len(args) == 0 {
		return usage
	}
	fs := flags("monorepo")
	yes := fs.Bool("yes", false, "delete or transfer without typing the name (scripts)")
	asJSON := fs.Bool("json", false, "view, rename, transfer: print the API's JSON")
	mono := fs.String("monorepo", "", "rename: the monorepo (default: the one this folder is in)")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	switch args[0] {
	case "view":
		if len(pos) > 1 {
			return usage
		}
		name := *mono
		if len(pos) == 1 {
			name = pos[0]
		}
		h, full, err := e.target(*srvFlag, name)
		if err != nil {
			return err
		}
		return monorepoView(e, h, full, *asJSON)
	case "rename":
		if len(pos) != 1 {
			return UsageError{"pando monorepo rename <new-name> [--monorepo <owner/name>]"}
		}
		return monorepoRename(e, *srvFlag, *mono, pos[0], *asJSON)
	case "transfer":
		if len(pos) != 2 {
			return UsageError{"pando monorepo transfer <owner/name> <new-owner> [--yes]"}
		}
		return monorepoTransfer(e, *srvFlag, pos[0], strings.ToLower(pos[1]), *yes, *asJSON)
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

// answerField is one field of an API answer as it came (listRepos' "repos").
func answerField(data []byte, key string) json.RawMessage {
	var m map[string]json.RawMessage
	_ = json.Unmarshal(data, &m)
	return m[key]
}

// monorepoView is `pando monorepo view`: the monorepo, its repos with main's
// head, and its members. --json prints {"monorepo", "repos", "members"}, each
// as the API gives it.
func monorepoView(e *Env, h *server.HTTP, full string, asJSON bool) error {
	m, err := h.GetMonorepo(e.Ctx, full)
	if err != nil {
		return err
	}
	var repos struct {
		Repos []server.Repo `json:"repos"`
	}
	rawRepos, err := h.Call(e.Ctx, "GET", server.MonorepoPath(full)+"/repos", nil, nil, &repos)
	if err != nil {
		return err
	}
	var members struct {
		Members []server.Member `json:"members"`
	}
	rawMembers, err := h.Call(e.Ctx, "GET", server.MonorepoPath(full)+"/members", nil, nil, &members)
	if err != nil {
		return err
	}
	if asJSON {
		out, err := json.Marshal(map[string]json.RawMessage{"monorepo": m.JSON, "repos": answerField(rawRepos, "repos"), "members": answerField(rawMembers, "members")})
		if err != nil {
			return err
		}
		return e.printJSON(out)
	}
	heads, err := h.Heads(e.Ctx, full)
	if err != nil {
		return err
	}
	owners := 0
	for _, x := range members.Members {
		if x.Role == "owner" {
			owners++
		}
	}
	kind := "monorepo"
	if m.Kind == "repo" {
		kind = "plain git repo"
	}
	e.printf("%s  %s  (you are %s)\n", m.Full(), kind, dash(m.Role))
	e.printf("  id        %s\n", m.ID)
	e.printf("  created   %s\n", ago(m.CreatedAt))
	e.printf("  members   %d (%d owner(s)): pando members list %s\n", len(members.Members), owners, m.Full())
	if len(repos.Repos) == 0 {
		e.printf("\nNo repos yet.\n")
		return nil
	}
	head := map[string]server.Head{}
	for _, x := range heads.Heads {
		head[x.Path] = x
	}
	e.printf("\n")
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "REPO\tMAIN\tCLONE URL")
	for _, r := range repos.Repos {
		fmt.Fprintf(tw, "%s\t%s\t%s\n", r.Path, dash(short(head[r.Path].Head)), r.CloneURL)
	}
	return tw.Flush()
}

// monorepoRename is `pando monorepo rename <new-name>` (owners). The old
// owner/name keeps leading to it. When this folder is that monorepo's, the
// folder takes the new name and its git remotes the new clone URLs.
func monorepoRename(e *Env, srvFlag, mono, newName string, asJSON bool) error {
	if !validName(newName) {
		return fmt.Errorf("%q cannot be a name: lower-case letters, digits, '.', '_' and '-', at most 39, with no '--'", newName)
	}
	h, full, err := e.target(srvFlag, mono)
	if err != nil {
		return err
	}
	// Safe to run again (the API takes no idempotency key): a monorepo that
	// has the name already was renamed by a first run; the folder catches up.
	m, err := h.GetMonorepo(e.Ctx, full)
	if err != nil {
		return err
	}
	switch {
	case m.Name == newName && asJSON:
		if err := e.printJSON(m.JSON); err != nil {
			return err
		}
	case m.Name == newName:
		e.printf("%s already has that name.\n", m.Full())
	default:
		if m, err = h.RenameMonorepo(e.Ctx, m.Full(), newName); err != nil {
			return ownerOnly(err, full, "rename it")
		}
		if asJSON {
			if err := e.printJSON(m.JSON); err != nil {
				return err
			}
			break
		}
		e.printf("Renamed %s to %s. The old name keeps leading to it until it is given to another monorepo.\n", full, m.Full())
		if a := m.ReplacedAlias; a != nil {
			e.printf("%s was an old name of another monorepo; it now leads here.\n", a.FullName)
		}
	}
	root, err := e.root()
	if err != nil || !(strings.EqualFold(root.FullName(), full) || (root.ID != "" && root.ID == m.ID)) || root.FullName() == m.Full() {
		return nil
	}
	moved, err := e.renameRoot(h, root, m)
	if err != nil {
		return fmt.Errorf("renamed on the server, but this folder still says %s: %w", root.FullName(), err)
	}
	if !asJSON {
		e.printf("This folder now uses %s; %d git remote(s) point at the new clone URLs. A running pando sync keeps the old name until it restarts (it still works).\n", m.Full(), moved)
	}
	return nil
}

// renameRoot gives this folder the monorepo's new name and points its git
// remotes at the new clone URLs (as upgradeRoot does for a version 1 folder).
func (e *Env) renameRoot(h *server.HTTP, root *config.Root, m *server.Monorepo) (int, error) {
	repos, err := h.ListRepos(e.Ctx, m.Full())
	if err != nil {
		return 0, err
	}
	urls := map[string]string{}
	for _, r := range repos {
		urls[r.Path] = r.CloneURL
	}
	moved, err := e.repointRemotes(root, urls)
	if err != nil {
		return moved, err
	}
	root.Owner, root.Name, root.ID = m.Owner, m.Name, m.ID
	for _, r := range repos {
		root.SetRepo(config.RepoEntry{Path: r.Path, Name: r.Name, CloneURL: r.CloneURL})
	}
	return moved, root.Save()
}

// monorepoTransfer is `pando monorepo transfer <owner/name> <new-owner>`
// (owners): to an organization you are in, or back to a person who owns it
// directly. The old owner/name keeps leading to it. Safe to run again: one
// that has that owner already is left as it is, and this folder catches up.
func monorepoTransfer(e *Env, srvFlag, mono, newOwner string, yes, asJSON bool) error {
	if !loginRe.MatchString(newOwner) {
		return fmt.Errorf("%q cannot be an owner: an organization's or a person's login", newOwner)
	}
	h, full, err := e.target(srvFlag, mono)
	if err != nil {
		return err
	}
	m, err := h.GetMonorepo(e.Ctx, full)
	if err != nil {
		return err
	}
	if m.Owner == newOwner {
		if asJSON {
			if err := e.printJSON(m.JSON); err != nil {
				return err
			}
		} else {
			e.printf("%s is owned by %s already.\n", m.Full(), newOwner)
		}
	} else {
		if !yes {
			if !e.isTerminal() {
				return errors.New("transferring needs the name typed at a terminal, or --yes")
			}
			e.printf("This moves %s to %s. Its own members stay; %s's people gain it, and %s's lose it.\n", m.Full(), newOwner, newOwner, m.Owner)
			e.printf("Type its full name (%s) to transfer it: ", m.Full())
			typed, err := e.readLine()
			if err != nil {
				return err
			}
			if typed != m.Full() {
				return errors.New("the name did not match; nothing was moved")
			}
		}
		from := m.Full()
		if m, err = h.TransferMonorepo(e.Ctx, from, newOwner); err != nil {
			if server.Code(err) == "not_your_namespace" {
				return fmt.Errorf("you are not in the organization %s (pando org list shows yours): %w", newOwner, err)
			}
			return ownerOnly(err, from, "transfer it")
		}
		if asJSON {
			if err := e.printJSON(m.JSON); err != nil {
				return err
			}
		} else {
			e.printf("Moved %s to %s. The old name keeps leading to it, for the API and for git.\n", from, m.Full())
			if m.OwnerType == "org" {
				e.printf("Everyone in %s can open and push to it now; its owners own it.\n", newOwner)
			}
		}
	}
	root, err := e.root()
	if err != nil || !(strings.EqualFold(root.FullName(), full) || (root.ID != "" && root.ID == m.ID)) || root.FullName() == m.Full() {
		return nil
	}
	moved, err := e.renameRoot(h, root, m)
	if err != nil {
		return fmt.Errorf("moved on the server, but this folder still says %s: %w", root.FullName(), err)
	}
	if !asJSON {
		e.printf("This folder now uses %s; %d git remote(s) point at the new clone URLs.\n", m.Full(), moved)
	}
	return nil
}
