package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"

	"pando/internal/config"
	"pando/internal/server"
)

const hookUsage = "pando hook list | create <url> [--event e] [--app a] [--secret-file f] | delete <id> | deliveries <id> | redeliver <delivery-id> | redeliver <hook-id> --since <seq>   [--repo <path>] [--monorepo <owner/name>] [--json]"

// Hook is `pando hook`: a repo's web hooks, which POST signed JSON to a URL
// on a push, a new branch or a merge, and their deliveries. Buildkite hooks
// are made with pando ci pipeline; they show here too. Writes need an owner.
func Hook(e *Env, args []string) error {
	usage := UsageError{hookUsage}
	if len(args) == 0 {
		return usage
	}
	fs := flags("hook")
	var events multi
	fs.Var(&events, "event", "create: push, branch.opened or merged (repeat it; default all three)")
	app := fs.String("app", "", "create: the CI service behind the URL (github-actions, circleci, ...), shown on the checks it posts")
	secretFile := fs.String("secret-file", "", "create: read the signing secret from this file (- for standard input); else it is asked for with no echo")
	since := fs.Int64("since", -1, "redeliver: send again every delivery of the hook after this seq")
	repoFlag := fs.String("repo", "", "the repo (default: the one this folder is in, or the only one)")
	asJSON := fs.Bool("json", false, "print the API's JSON")
	mono := fs.String("monorepo", "", "the monorepo (default: the one this folder is in)")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	want := map[string]int{"list": 0, "ls": 0, "create": 1, "delete": 1, "rm": 1, "deliveries": 1, "redeliver": 1}
	if n, ok := want[args[0]]; !ok || len(pos) != n {
		return usage
	}
	h, full, err := e.target(*srvFlag, *mono)
	if err != nil {
		return err
	}
	repo, err := e.repoIn(h, full, *repoFlag)
	if err != nil {
		return err
	}
	switch args[0] {
	case "list", "ls":
		l, err := h.ListHooks(e.Ctx, full, repo.Name)
		if err != nil {
			return err
		}
		if *asJSON {
			return e.printJSON(l.JSON)
		}
		return hookList(e, repo, l.Hooks)
	case "create":
		return hookCreate(e, h, full, repo, pos[0], events, *app, *secretFile, *asJSON)
	case "delete", "rm":
		if err := h.DeleteHook(e.Ctx, full, repo.Name, pos[0]); err != nil {
			return ownerOnly(err, full, "remove a hook")
		}
		e.printf("Removed hook %s from %s. Deliveries already queued are not sent.\n", pos[0], repoLabel(repo))
		return nil
	case "deliveries":
		l, err := h.Deliveries(e.Ctx, full, repo.Name, pos[0])
		if err != nil {
			return err
		}
		if *asJSON {
			return e.printJSON(l.JSON)
		}
		return deliveryList(e, pos[0], l.Deliveries)
	}
	if *since >= 0 {
		r, err := h.Replay(e.Ctx, full, repo.Name, pos[0], *since)
		if err != nil {
			return ownerOnly(err, full, "replay a hook")
		}
		if *asJSON {
			return e.printJSON(r.JSON)
		}
		e.printf("Queued %d deliveries of hook %s after seq %d to be sent again, oldest first.\n", r.Queued, pos[0], *since)
		return nil
	}
	d, err := h.Redeliver(e.Ctx, full, repo.Name, pos[0])
	if err != nil {
		return ownerOnly(err, full, "redeliver a hook")
	}
	if *asJSON {
		return e.printJSON(d.JSON)
	}
	e.printf("Delivery %s (%s) is queued to be sent again; it keeps its id and seq. See it with: pando hook deliveries %s\n", d.ID, d.Event, d.HookID)
	return nil
}

// repoLabel is how a repo is named in messages: its path, or the monorepo's
// owner/name for a plain repo (path ".").
func repoLabel(r server.Repo) string {
	if r.Path == "." {
		return r.Monorepo
	}
	return r.Path
}

func hookList(e *Env, repo server.Repo, hooks []server.Hook) error {
	if len(hooks) == 0 {
		e.printf("%s has no hooks. Add one: pando hook create <url>\n", repoLabel(repo))
		return nil
	}
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tTYPE\tSENDS TO\tEVENTS\tAPP\tADDED")
	for _, k := range hooks {
		to := k.URL
		if k.Type == "buildkite" && k.Buildkite != nil {
			to = "buildkite " + k.Buildkite.Organization + "/" + k.Buildkite.Pipeline
		}
		added := ago(k.CreatedAt)
		if k.CreatedBy != "" {
			added = k.CreatedBy + " " + added
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", k.ID, k.Type, dash(to), strings.Join(k.Events, ","), dash(k.App), added)
	}
	return tw.Flush()
}

func hookCreate(e *Env, h *server.HTTP, full string, repo server.Repo, url string, events []string, app, secretFile string, asJSON bool) error {
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
		return fmt.Errorf("%q is not a URL: a web hook POSTs to an http(s) URL", url)
	}
	// Safe to run again (the API takes no idempotency key): a hook to this
	// URL already there is the one a first run made.
	l, err := h.ListHooks(e.Ctx, full, repo.Name)
	if err != nil {
		return err
	}
	for i, k := range l.Hooks {
		if k.Type == "web" && k.URL == url {
			if asJSON {
				var raw struct {
					Hooks []json.RawMessage `json:"hooks"`
				}
				_ = json.Unmarshal(l.JSON, &raw)
				return e.printJSON(raw.Hooks[i])
			}
			e.printf("%s already has hook %s sending to %s (%s); nothing added. To change it, delete it and create it again.\n", repoLabel(repo), k.ID, url, strings.Join(k.Events, ", "))
			return nil
		}
	}
	var secret string
	switch {
	case secretFile == "-":
		secret, err = config.ReadToken(e.Stdin)
	case secretFile != "":
		var b []byte
		if b, err = os.ReadFile(e.abs(secretFile)); err == nil {
			secret = strings.TrimSpace(string(b))
		}
	case e.isTerminal():
		secret, err = e.readSecret("Secret that signs each delivery (X-Pando-Signature-256; input hidden): ")
	default:
		return errors.New("the hook's signing secret is not taken as an argument: add --secret-file <file>, or --secret-file - and pipe it")
	}
	if err != nil {
		return err
	}
	if secret == "" {
		return errors.New("the signing secret is empty")
	}
	k, err := h.AddWebHook(e.Ctx, full, repo.Name, server.WebHookIn{URL: url, Secret: secret, Events: events, App: app})
	if err != nil {
		return ownerOnly(err, full, "add a hook")
	}
	if asJSON {
		return e.printJSON(k.JSON)
	}
	e.printf("Added hook %s to %s: %s gets %s, signed with your secret.\n", k.ID, repoLabel(repo), k.URL, strings.Join(k.Events, ", "))
	e.printf("See what was sent with: pando hook deliveries %s\n", k.ID)
	return nil
}

func deliveryList(e *Env, hook string, ds []server.Delivery) error {
	if len(ds) == 0 {
		e.printf("Hook %s has no deliveries yet.\n", hook)
		return nil
	}
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tEVENT\tSEQ\tSTATUS\tTRIES\tANSWER\tCREATED")
	for _, d := range ds {
		seq, answer := "-", "-"
		if d.Seq != nil {
			seq = strconv.FormatInt(*d.Seq, 10)
		}
		switch {
		case d.ResponseCode != nil:
			answer = "HTTP " + strconv.Itoa(*d.ResponseCode)
		case d.Error != "":
			answer = d.Error
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%d\t%s\t%s\n", d.ID, d.Event, seq, d.Status, d.Attempts, answer, ago(d.CreatedAt))
	}
	return tw.Flush()
}
