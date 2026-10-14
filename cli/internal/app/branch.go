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
	"pando/internal/gitx"
	"pando/internal/server"
)

// Branch is `pando branch list | view`.
func Branch(e *Env, args []string) error {
	if len(args) > 0 && args[0] == "view" {
		return branchView(e, args[1:])
	}
	if len(args) == 0 || (args[0] != "list" && args[0] != "ls") {
		return UsageError{"pando branch list [--repo <path>] [--all] [--json] | view [<branch>] [--commits] [--json]"}
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
		bl, err := srv.ListBranches(e.Ctx, root.FullName(), repoName(root, r), state)
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
			fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", b.Name, count(b, b.Ahead), count(b, b.Behind), dash(b.Author),
				dash(b.Checks.State), mergeWord(b), dash(b.State), short(b.Head))
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
	body, omitted, err := srv.Diff(e.Ctx, root.FullName(), repoName(root, repo), branch, format, paths)
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
	b, err := srv.GetBranch(e.Ctx, root.FullName(), name, branch)
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
		patch, _, err := srv.Diff(e.Ctx, root.FullName(), name, branch, server.DiffPatch, nil)
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
	rv, err := srv.CreateReview(e.Ctx, root.FullName(), name, branch, in)
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

// Merge is `pando merge <branch> [--force] [--wait]`. It returns once the
// server confirms the merge. This machine's read-only main follows on its
// own: the follower moves it within a moment, and with no follower running a
// one-off follower is started in the background. --wait blocks until main
// has moved (scripts).
func Merge(e *Env, args []string) error {
	fs := flags("merge")
	repoFlag := fs.String("repo", "", "the repo (default: the one you are in)")
	force := fs.Bool("force", false, "merge past red or missing checks (recorded as forced)")
	wait := fs.Bool("wait", false, "return only once this machine's read-only main has the merge")
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
	// The head this machine pushed, when the command runs in the branch's
	// worktree: the merge is refused if the branch moved since (someone
	// else pushed). Elsewhere the server's current head is merged, as
	// gh pr merge does. Either way, no branch read before the merge.
	expected := e.pushedHead(root, branch)
	res, err := srv.Merge(e.Ctx, root.FullName(), name, branch, *force, expected)
	if err != nil {
		var ae *server.APIError
		if errors.As(err, &ae) {
			switch ae.Code {
			case "checks_not_green":
				on := branch
				if ae.Checks != nil && ae.Checks.SHA != "" {
					on += " at " + short(ae.Checks.SHA)
				}
				e.printf("Checks are not green on %s:\n", on)
				if ae.Checks != nil {
					for _, s := range ae.Checks.Statuses {
						e.printf("  %-20s %s\n", s.Context, s.State)
					}
					for _, m := range ae.Checks.Missing {
						e.printf("  %-20s missing\n", m)
					}
				}
				return errors.New("not merged; wait for green, or merge past them with --force")
			case "risk_pending":
				// Risk-based review is scoring the head (about a second): a wait, not a failure.
				return fmt.Errorf("not merged yet: the risk score for %s is still being worked out; merge again in a few seconds", branch)
			case "review_required":
				e.printf("Review required on %s: %s\n", branch, ae.Message)
				return errors.New("not merged; a person approves it on its page, or an owner merges past it with --force")
			case "conflict":
				for _, p := range ae.Paths {
					e.printf("  conflict: %s\n", p)
				}
				return fmt.Errorf("not merged: %s changes files main also changed; run git pull origin main in its worktree, push, and merge again", branch)
			case "head_moved":
				return fmt.Errorf("not merged: %s on the server is not what this worktree pushed (%s); git pull, check it, and merge again", branch, short(expected))
			case "merge_engine_unavailable":
				return errors.New("not merged: the server's merge engine is not wired in yet (HTTP 501)")
			}
			if ae.Status == 404 {
				return fmt.Errorf("no branch %s in %s", branch, label(root, repo))
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
	if len(res.Closes) > 0 {
		nums := make([]string, len(res.Closes))
		for k, n := range res.Closes {
			nums[k] = fmt.Sprintf("#%d", n)
		}
		e.printf("This merge closes %s (each within about a second).\n", strings.Join(nums, ", "))
	}
	if !hasReadOnlyMain(root, repo) {
		return nil
	}
	switch {
	case *wait:
		refreshMain(e, root, repo)
	case followerRunning(root):
		e.printf("worktrees/main follows within a moment (the follower is running)\n")
	default:
		if err := startFollowOnce(root); err != nil {
			e.warnf("main did not start following in the background (%v); moving it now", err)
			refreshMain(e, root, repo)
		} else {
			e.printf("worktrees/main follows within a moment\n")
		}
	}
	return nil
}

// pushedHead is the head this machine last pushed for branch, when the
// current folder is that branch's worktree (its upstream tracking ref,
// read locally), else "".
func (e *Env) pushedHead(root *config.Root, branch string) string {
	if e.currentBranch(root) != branch {
		return ""
	}
	sha, err := gitx.In(e.Cwd).Run(e.Ctx, "rev-parse", "--verify", "--quiet", "@{upstream}")
	if err != nil {
		return ""
	}
	return sha
}

func hasReadOnlyMain(root *config.Root, repo string) bool {
	ws, _ := root.LoadWorktrees()
	for _, w := range ws {
		if w.Repo == repo && w.Branch == "main" && w.ReadOnly {
			return true
		}
	}
	return false
}

// mergeWord is a branch's mergeable answer for people. "pending" means not
// known yet for the current main and head (the server is computing it); the
// last known answer is shown beside it.
func mergeWord(b server.Branch) string {
	if b.Mergeable == "pending" || (b.Stale && b.Mergeable == "") {
		if b.LastMergeable != "" && b.LastMergeable != "pending" {
			return "pending (was " + b.LastMergeable + ")"
		}
		return "pending"
	}
	return dash(b.Mergeable)
}

// count is a branch's ahead or behind for people: "?" while the server has
// not yet computed it for the current main and head.
func count(b server.Branch, n *int) string {
	if b.Stale {
		return "?"
	}
	return num(n)
}

// branchView is `pando branch view [<branch>]`: one branch as its page shows
// it: state, ahead and behind, whether it merges, checks, reviews and its
// head commit; with --commits, every commit it adds.
func branchView(e *Env, args []string) error {
	fs := flags("branch view")
	repoFlag := fs.String("repo", "", "the repo (default: the one you are in)")
	commits := fs.Bool("commits", false, "list the branch's commits (those not on main)")
	asJSON := fs.Bool("json", false, "print JSON: the branch, its reviews and its commits as the API gives them")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) > 1 {
		return UsageError{"pando branch view [<branch>] [--repo <path>] [--commits] [--json]"}
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
	h, ok := srv.(*server.HTTP)
	if !ok {
		return errors.New("branch view needs a Pando server; this one is a local file:// server")
	}
	full, name := root.FullName(), repoName(root, repo)
	b, err := h.GetBranch(e.Ctx, full, name, branch)
	if err != nil {
		return err
	}
	reviews, rawReviews, err := h.ListReviews(e.Ctx, full, name, branch)
	if err != nil {
		return err
	}
	limit := 1
	if *commits {
		limit = 250
	}
	cs, err := h.BranchCommits(e.Ctx, full, name, branch, limit)
	if err != nil {
		return err
	}
	if *asJSON {
		out, err := json.Marshal(map[string]json.RawMessage{"branch": b.JSON, "reviews": answerField(rawReviews, "reviews"), "commits": cs.JSON})
		if err != nil {
			return err
		}
		return e.printJSON(out)
	}
	e.printf("%s  %s  in %s\n", b.Name, b.State, label(root, repo))
	if b.Title != "" {
		e.printf("  %s\n", b.Title)
	}
	head := short(b.Head)
	if len(cs.Commits) > 0 && cs.Commits[0].SHA == b.Head {
		head += "  " + cs.Commits[0].Title
	}
	e.printf("  head      %s\n", head)
	by := dash(b.Author)
	if b.PushedMachine != "" {
		by += ", last pushed from " + b.PushedMachine
	}
	e.printf("  author    %s, %s\n", by, ago(b.UpdatedAt))
	if b.State == "merged" {
		forced := ""
		if b.Forced {
			forced = ", past its checks"
		}
		e.printf("  merged    by %s %s as %s%s\n", dash(b.MergedBy), ago(b.MergedAt), short(b.MergeCommit), forced)
	} else {
		e.printf("  vs main   %s ahead, %s behind; merge %s\n", count(*b, b.Ahead), count(*b, b.Behind), mergeWord(*b))
		if len(b.ConflictPaths) > 0 {
			e.printf("            changed on both sides: %s\n", strings.Join(b.ConflictPaths, ", "))
		}
	}
	req := "none required"
	if len(b.Checks.Required) > 0 {
		req = "required: " + strings.Join(b.Checks.Required, ", ")
	}
	e.printf("  checks    %s (%s)\n", dash(b.Checks.State), req)
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	for _, st := range b.Checks.Statuses {
		from := st.App
		if from == "" {
			from = st.Creator
		}
		fmt.Fprintf(tw, "            %s\t%s\t%s\t%s\n", st.Context, st.State, dash(from), st.Description)
	}
	for _, m := range b.Checks.Missing {
		fmt.Fprintf(tw, "            %s\tmissing\t-\t\n", m)
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	if len(reviews) == 0 {
		e.printf("  reviews   none\n")
	}
	verdict := map[string]string{"approve": "approved", "request_changes": "asked for changes", "comment": "commented"}
	for i, r := range reviews {
		lead := "  reviews   "
		if i > 0 {
			lead = "            "
		}
		body, _, _ := strings.Cut(r.Body, "\n")
		if body != "" {
			body = ": " + body
		}
		e.printf("%s%s %s on %s, %s%s\n", lead, r.Author, verdict[r.Verdict], short(r.Head), ago(r.CreatedAt), body)
	}
	if !*commits {
		return nil
	}
	e.printf("\n%d commit(s) not on main", cs.Total)
	if cs.Truncated {
		e.printf(" (the newest %d here)", len(cs.Commits))
	}
	e.printf(":\n")
	tw = tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	for _, c := range cs.Commits {
		fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\n", short(c.SHA), c.Title, dash(c.Author.Name), ago(c.Author.Date))
	}
	return tw.Flush()
}
