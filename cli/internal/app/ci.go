package app

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"pando/internal/server"
)

// CI is `pando ci connect | status | disconnect`: a monorepo's CI service
// (Buildkite) as the person sees it, with their own credential.
//
// The webhook token is a secret. It reaches only the person's own terminal
// (or a file they name, mode 600), never a pipe: an agent's session reads
// pipes. It is shown once and kept nowhere on this machine.
func CI(e *Env, args []string) error {
	usage := UsageError{"pando ci connect --org <slug> | status | disconnect --org <slug>   [--monorepo <owner/name>]"}
	if len(args) == 0 {
		return usage
	}
	fs := flags("ci")
	org := fs.String("org", "", "the Buildkite organization's slug (buildkite.com/<slug>)")
	mono := fs.String("monorepo", "", "the monorepo (default: the one this folder is in)")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	out := fs.String("out", "", "connect: write the webhook token to this file (mode 600) instead of the terminal")
	paste := fs.Bool("paste-token", false, "connect: use the token Buildkite made (typed with no echo) instead of a new one")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	if len(pos) > 0 {
		return usage
	}
	switch args[0] {
	case "connect":
		if *org == "" {
			return UsageError{"pando ci connect --org <slug> [--monorepo <owner/name>] [--out <file>] [--paste-token]"}
		}
		// Before anything is made: a token that cannot be shown would be lost.
		if *out == "" && !stdoutTerminal(e) {
			return errors.New("the webhook token is a secret and is shown only on a terminal: run this in your own terminal, or add --out <file>")
		}
	case "disconnect":
		if *org == "" {
			return UsageError{"pando ci disconnect --org <slug> [--monorepo <owner/name>]"}
		}
	case "status":
	default:
		return usage
	}
	h, full, err := ciTarget(e, *srvFlag, *mono)
	if err != nil {
		return err
	}
	switch args[0] {
	case "connect":
		return ciConnect(e, h, full, strings.ToLower(*org), *out, *paste)
	case "disconnect":
		return ciDisconnect(e, h, full, strings.ToLower(*org))
	}
	return ciStatus(e, h, full)
}

// stdoutTerminal is whether stdout is a terminal (a variable, for tests).
var stdoutTerminal = func(e *Env) bool {
	f, ok := e.Stdout.(*os.File)
	if !ok {
		return false
	}
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

// ciTarget is the signed-in server (a Pando server, not file://) and the monorepo's owner/name.
func ciTarget(e *Env, srvFlag, mono string) (*server.HTTP, string, error) {
	if mono == "" {
		root, err := e.root()
		if err != nil {
			return nil, "", UsageError{"which monorepo? add --monorepo <owner/name>, or run this inside its folder"}
		}
		mono = root.FullName()
	}
	srv, _, err := e.signedIn(srvFlag)
	if err != nil {
		return nil, "", err
	}
	h, ok := srv.(*server.HTTP)
	if !ok {
		return nil, "", errors.New("CI needs a Pando server; this one is a local file:// server")
	}
	if _, _, full := splitFull(mono); !full {
		m, err := resolveMonorepo(e, srv, mono)
		if err != nil {
			return nil, "", err
		}
		mono = m.Full()
	}
	return h, mono, nil
}

func ciConnect(e *Env, h *server.HTTP, full, org, out string, paste bool) error {
	token := ""
	if paste {
		t, err := e.readSecret("Buildkite's webhook token (Settings > Notification Services > your webhook > Token): ")
		if err != nil {
			return err
		}
		if token = strings.TrimSpace(t); len(token) < 16 {
			return errors.New("that token is shorter than 16 characters")
		}
	}
	res, err := h.CIConnect(e.Ctx, full, org, token)
	if err != nil {
		if server.StatusOf(err) == 409 {
			return fmt.Errorf("%w\nTo start over (a lost token): pando ci disconnect --org %s --monorepo %s, then connect again", err, org, full)
		}
		return err
	}
	c := res.Connection
	e.printf("Connected Buildkite organization %s to %s.\n\n", c.Organization, full)
	e.printf("  Webhook URL    %s\n", c.WebhookURL)
	switch {
	case paste:
		e.printf("  Token          the one you pasted (Buildkite has it already)\n")
	case out != "":
		p := e.abs(out)
		if err := os.WriteFile(p, []byte(res.WebhookToken+"\n"), 0o600); err != nil {
			return fmt.Errorf("connected, but the token could not be written (%v); disconnect and connect again", err)
		}
		if err := os.Chmod(p, 0o600); err != nil {
			return err
		}
		e.printf("  Token          in %s (mode 600); shown nowhere else\n", p)
	default:
		e.printf("  Token          %s\n", res.WebhookToken)
		e.printf("                 shown this once; Pando keeps it, this machine does not\n")
	}
	e.printf("\nIn Buildkite (%s):\n", c.WebURL)
	e.printf("  1. Settings > Notification Services > Webhook: Add.\n")
	e.printf("  2. Description: Pando %s.\n", full)
	e.printf("  3. Webhook URL: the URL above.\n")
	if paste {
		e.printf("  4. Token: leave Buildkite's, and pick X-Buildkite-Signature (signed) over X-Buildkite-Token.\n")
	} else {
		e.printf("  4. Token: replace Buildkite's with the token above, and pick X-Buildkite-Signature (signed) over X-Buildkite-Token.\n")
	}
	e.printf("  5. Events: build.scheduled, build.running, build.failing, build.finished, build.skipped,\n")
	e.printf("     job.scheduled, job.started, job.finished, job.activated.\n")
	e.printf("  6. Pipelines: Only Some pipelines, and pick the ones that build this monorepo's repos.\n")
	e.printf("  7. Save. Buildkite sends a ping; check it arrived with: pando ci status --monorepo %s\n", full)
	if !paste {
		e.printf("\nIf Buildkite will not take this token, disconnect and run: pando ci connect --org %s --monorepo %s --paste-token\n", org, full)
	}
	return nil
}

func ciDisconnect(e *Env, h *server.HTTP, full, org string) error {
	o, err := h.CIOverview(e.Ctx, full)
	if err != nil {
		return err
	}
	for _, c := range o.Connections {
		if c.Organization != org {
			continue
		}
		if err := h.CIDisconnect(e.Ctx, full, c.ID); err != nil {
			return err
		}
		e.printf("Disconnected Buildkite organization %s from %s. Its builds are gone from Pando; its checks stay.\n", org, full)
		e.printf("Remove the webhook in Buildkite too: Settings > Notification Services.\n")
		return nil
	}
	return fmt.Errorf("%s has no Buildkite connection for organization %s", full, org)
}

func ciStatus(e *Env, h *server.HTTP, full string) error {
	o, err := h.CIOverview(e.Ctx, full)
	if err != nil {
		return err
	}
	if len(o.Connections) == 0 {
		e.printf("%s has no CI service connected. Connect Buildkite: pando ci connect --org <slug> --monorepo %s\n", full, full)
		return nil
	}
	for _, c := range o.Connections {
		e.printf("Buildkite %s, connected %s by %s (token: %s)\n", c.Organization, ago(c.CreatedAt), c.CreatedBy, strings.ReplaceAll(c.Token, "_", " "))
		e.printf("  webhook       %s\n", c.WebhookURL)
		if c.LastEvent != nil {
			e.printf("  last event    %s %s: %s\n", dash(c.LastEvent.Event), ago(c.LastEvent.At), dash(c.LastEvent.Result))
		} else {
			e.printf("  last event    none yet (save the webhook in Buildkite; it sends a ping)\n")
		}
		if c.LastRefused != nil {
			e.printf("  last refused  %s: %s\n", ago(c.LastRefused.At), dash(c.LastRefused.Reason))
		} else {
			e.printf("  last refused  none\n")
		}
	}
	if len(o.Pipelines) == 0 {
		e.printf("\nNo pipelines yet: register a buildkite hook for a repo, or wait for a build.\n")
		return nil
	}
	e.printf("\n")
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "PIPELINE\tREPO\tREQUIRED\tLAST BUILD")
	for _, p := range o.Pipelines {
		last := "-"
		if b := p.LastBuild; b != nil {
			last = fmt.Sprintf("#%d %s, %s %s", b.Number, b.State, dash(b.Branch), ago(b.CreatedAt))
		}
		req := strings.Join(p.RequiredChecks, ", ")
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", p.Slug, dash(p.RepoPath), dash(req), last)
	}
	return tw.Flush()
}
