package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"text/tabwriter"

	"pando/internal/config"
	"pando/internal/server"
)

// Branch is `pando branch list`.
func Branch(e *Env, args []string) error {
	if len(args) == 0 || (args[0] != "list" && args[0] != "ls") {
		return UsageError{"pando branch list [--repo <path>] [--all] [--json]"}
	}
	fs := flags("branch list")
	repoFlag := fs.String("repo", "", "the repo (default: the one you are in, or every repo)")
	all := fs.Bool("all", false, "include merged branches")
	asJSON := fs.Bool("json", false, "print JSON")
	if _, err := parse(fs, args[1:]); err != nil {
		return err
	}
	root, err := e.root()
	if err != nil {
		return err
	}
	srv, err := e.open(root)
	if err != nil {
		return err
	}
	var repos []string
	if *repoFlag != "" {
		r, err := e.repoArg(root, *repoFlag)
		if err != nil {
			return err
		}
		repos = []string{r}
	} else if r, err := e.currentRepo(root, ""); err == nil {
		repos = []string{r}
	} else {
		for _, r := range root.Repos {
			repos = append(repos, r.Path)
		}
	}
	state := "open"
	if *all {
		state = "all"
	}
	out := map[string]*server.BranchList{}
	for _, r := range repos {
		bl, err := srv.ListBranches(e.Ctx, root.Name, repoName(root, r), state)
		if err != nil {
			return fmt.Errorf("%s: %w", r, err)
		}
		out[r] = bl
	}
	if *asJSON {
		b, _ := json.MarshalIndent(out, "", "  ")
		e.printf("%s\n", b)
		return nil
	}
	for i, r := range repos {
		bl := out[r]
		if i > 0 {
			e.printf("\n")
		}
		e.printf("%s  (main at %s)\n", label(root, r), short(bl.DefaultHead))
		if len(bl.Branches) == 0 {
			e.printf("  no open branches\n")
			continue
		}
		tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "  BRANCH\tAHEAD\tBEHIND\tAUTHOR\tCHECKS\tMERGE\tSTATE\tHEAD")
		for _, b := range bl.Branches {
			fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", b.Name, num(b.Ahead), num(b.Behind), dash(b.Author),
				dash(b.Checks.State), dash(b.Mergeable), dash(b.State), short(b.Head))
		}
		if err := tw.Flush(); err != nil {
			return err
		}
	}
	return nil
}

// branchArgs resolves the repo and branch for diff, review and merge.
func (e *Env) branchArgs(root *config.Root, repoFlag string, pos []string) (repo, branch string, rest []string, err error) {
	repo, err = e.currentRepo(root, repoFlag)
	if err != nil {
		return
	}
	if len(pos) > 0 {
		branch, rest = pos[0], pos[1:]
	} else {
		branch = e.currentBranch(root)
	}
	if branch == "" {
		err = UsageError{"which branch? name it, or run this inside its worktree"}
	}
	if branch == "main" {
		err = errors.New("main is the base of every branch diff; name another branch")
	}
	return
}

type diffJSON struct {
	Base      string `json:"base"`
	Head      string `json:"head"`
	MergeBase string `json:"merge_base"`
	Truncated bool   `json:"truncated"`
	Stats     struct {
		Files     int `json:"files"`
		Additions int `json:"additions"`
		Deletions int `json:"deletions"`
	} `json:"stats"`
	Files []struct {
		Path         string `json:"path"`
		OldPath      string `json:"old_path"`
		Status       string `json:"status"`
		Binary       bool   `json:"binary"`
		Additions    *int   `json:"additions"`
		Deletions    *int   `json:"deletions"`
		PatchOmitted string `json:"patch_omitted"`
	} `json:"files"`
}

// Diff is `pando diff <branch> [--json] [--patch] [paths...]`.
func Diff(e *Env, args []string) error {
	fs := flags("diff")
	repoFlag := fs.String("repo", "", "the repo (default: the one you are in)")
	asJSON := fs.Bool("json", false, "print the API's JSON")
	patch := fs.Bool("patch", false, "print a unified diff (for git apply or plannotator)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	root, err := e.root()
	if err != nil {
		return err
	}
	repo, branch, paths, err := e.branchArgs(root, *repoFlag, pos)
	if err != nil {
		return err
	}
	srv, err := e.open(root)
	if err != nil {
		return err
	}
	format := server.DiffJSON
	if *patch {
		format = server.DiffPatch
	}
	body, omitted, err := srv.Diff(e.Ctx, root.Name, repoName(root, repo), branch, format, paths)
	if err != nil {
		return err
	}
	if *patch || *asJSON {
		_, err := e.Stdout.Write(body)
		if omitted > 0 {
			e.warnf("%d file(s) left out of the patch (over the size budget)", omitted)
		}
		return err
	}
	var d diffJSON
	if err := json.Unmarshal(body, &d); err != nil {
		return fmt.Errorf("bad diff from server: %w", err)
	}
	e.printf("%s: %s against main (from %s to %s)\n", label(root, repo), branch, short(d.MergeBase), short(d.Head))
	letter := map[string]string{"added": "A", "modified": "M", "deleted": "D", "renamed": "R"}
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	for _, f := range d.Files {
		name := f.Path
		if f.OldPath != "" {
			name = f.OldPath + " -> " + f.Path
		}
		counts := "binary"
		if !f.Binary {
			counts = fmt.Sprintf("+%s -%s", num(f.Additions), num(f.Deletions))
		}
		fmt.Fprintf(tw, "  %s\t%s\t%s\n", dash(letter[f.Status]), name, counts)
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	e.printf("%d file(s), +%d -%d\n", len(d.Files), d.Stats.Additions, d.Stats.Deletions)
	return nil
}

// plannotatorDecision is `plannotator review --json`'s answer.
type plannotatorDecision struct {
	Decision string `json:"decision"` // approved, annotated, dismissed
	Message  string `json:"message"`
}

// Review is `pando review <branch>`.
func Review(e *Env, args []string) error {
	fs := flags("review")
	repoFlag := fs.String("repo", "", "the repo (default: the one you are in)")
	msg := fs.String("m", "", "post this comment instead of opening Plannotator")
	approve := fs.Bool("approve", false, "with -m: approve (people only)")
	changes := fs.Bool("request-changes", false, "with -m: ask for changes")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	root, err := e.root()
	if err != nil {
		return err
	}
	repo, branch, _, err := e.branchArgs(root, *repoFlag, pos)
	if err != nil {
		return err
	}
	srv, err := e.open(root)
	if err != nil {
		return err
	}
	name := repoName(root, repo)
	agent := os.Getenv("PANDO_AGENT")
	b, err := srv.GetBranch(e.Ctx, root.Name, name, branch)
	if err != nil {
		return fmt.Errorf("branch %s: %w", branch, err)
	}

	in := server.ReviewIn{Head: b.Head}
	if *msg != "" || *approve || *changes {
		in.Body = *msg
		switch {
		case *approve:
			in.Verdict = "approve"
		case *changes:
			in.Verdict = "request_changes"
		default:
			in.Verdict = "comment"
		}
	} else {
		patch, _, err := srv.Diff(e.Ctx, root.Name, name, branch, server.DiffPatch, nil)
		if err != nil {
			return err
		}
		if len(bytes.TrimSpace(patch)) == 0 {
			return fmt.Errorf("%s has no changes against main", branch)
		}
		d, err := runPlannotator(e, patch)
		if err != nil {
			return err
		}
		switch d.Decision {
		case "dismissed":
			e.printf("Review dismissed; nothing posted.\n")
			return nil
		case "approved":
			in.Verdict, in.Body = "approve", d.Message
		case "annotated":
			in.Verdict, in.Body = "request_changes", d.Message
		default:
			return fmt.Errorf("plannotator answered %q", d.Decision)
		}
	}
	if agent != "" {
		// Agents act as the person (like gh); the body says which agent did.
		word := map[string]string{"comment": "Comment", "approve": "Approved", "request_changes": "Changes requested"}[in.Verdict]
		in.Body = strings.TrimSpace(in.Body + "\n\n" + word + " by agent " + agent + ".")
	}
	rv, err := srv.CreateReview(e.Ctx, root.Name, name, branch, in)
	if err != nil {
		return err
	}
	what := map[string]string{"comment": "a comment", "approve": "an approval", "request_changes": "a request for changes"}[rv.Verdict]
	e.printf("Posted %s on %s at %s as %s.\n", dash(what), branch, short(rv.Head), rv.Author)
	if rv.Verdict == "approve" {
		e.printf("Land it with: pando merge %s\n", branch)
	}
	return nil
}

// runPlannotator pipes a patch into `plannotator review --patch-file - --json`.
func runPlannotator(e *Env, patch []byte) (*plannotatorDecision, error) {
	bin := os.Getenv("PANDO_PLANNOTATOR")
	if bin == "" {
		bin = "plannotator"
	}
	if _, err := exec.LookPath(bin); err != nil {
		return nil, errors.New("plannotator is not installed; post a comment with -m instead")
	}
	cmd := exec.CommandContext(e.Ctx, bin, "review", "--patch-file", "-", "--json")
	cmd.Stdin = bytes.NewReader(patch)
	cmd.Stderr = e.Stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("plannotator: %w", err)
	}
	// The JSON record is the last line that parses.
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		var d plannotatorDecision
		if json.Unmarshal([]byte(lines[i]), &d) == nil && d.Decision != "" {
			return &d, nil
		}
	}
	return nil, fmt.Errorf("plannotator gave no decision: %s", strings.TrimSpace(string(out)))
}

// Merge is `pando merge <branch> [--force]`.
func Merge(e *Env, args []string) error {
	fs := flags("merge")
	repoFlag := fs.String("repo", "", "the repo (default: the one you are in)")
	force := fs.Bool("force", false, "merge past red or missing checks (recorded as forced)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	root, err := e.root()
	if err != nil {
		return err
	}
	repo, branch, _, err := e.branchArgs(root, *repoFlag, pos)
	if err != nil {
		return err
	}
	srv, err := e.open(root)
	if err != nil {
		return err
	}
	name := repoName(root, repo)
	b, err := srv.GetBranch(e.Ctx, root.Name, name, branch)
	if err != nil {
		return fmt.Errorf("branch %s: %w", branch, err)
	}
	res, err := srv.Merge(e.Ctx, root.Name, name, branch, *force, b.Head)
	if err != nil {
		var ae *server.APIError
		if errors.As(err, &ae) {
			switch ae.Code {
			case "checks_not_green":
				e.printf("Checks are not green on %s:\n", short(b.Head))
				if ae.Checks != nil {
					for _, s := range ae.Checks.Statuses {
						e.printf("  %-20s %s\n", s.Context, s.State)
					}
					for _, m := range ae.Checks.Missing {
						e.printf("  %-20s missing\n", m)
					}
				}
				return errors.New("not merged; wait for green, or merge past them with --force")
			case "conflict":
				for _, p := range ae.Paths {
					e.printf("  conflict: %s\n", p)
				}
				return fmt.Errorf("not merged: %s changes files main also changed; run git pull origin main in its worktree, push, and merge again", branch)
			case "merge_engine_unavailable":
				return errors.New("not merged: the server's merge engine is not wired in yet (HTTP 501)")
			}
		}
		return err
	}
	if res.Status == "up_to_date" {
		e.printf("%s adds nothing to main; nothing to merge.\n", branch)
		return nil
	}
	forced := ""
	if res.Forced {
		forced = ", forced past checks"
	}
	e.printf("Merged %s into main of %s: %s (merge commit%s, by %s)\n", branch, label(root, repo), short(res.SHA), forced, dash(res.MergedBy))
	refreshMain(e, root, repo)
	return nil
}
