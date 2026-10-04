package app

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"pando/internal/server"
)

// ── pando ci build | job | run: builds as Pando has them, and their actions ──

const buildUsage = "pando ci build list [--pipeline p] [--branch b] [--state s] | view <build> | log <build> [--job j] [--follow] | rebuild <build> | cancel <build>   [--monorepo <owner/name>] [--json]"

// ciBuild is `pando ci build list | view | log | rebuild | cancel`. A build
// is named by its number (12, #12, or pando-ci/12 with its pipeline) or its
// id (cib_...).
func ciBuild(e *Env, args []string) error {
	usage := UsageError{buildUsage}
	if len(args) == 0 {
		return usage
	}
	fs := flags("ci build")
	pipeline := fs.String("pipeline", "", "the pipeline (default: the monorepo's one pipeline)")
	branch := fs.String("branch", "", "list: builds of this branch")
	state := fs.String("state", "", "list: builds in this state (queued, running, blocked, passed, failed, canceled, skipped)")
	repo := fs.String("repo", "", "list: builds of this repo")
	limit := fs.Int("limit", 30, "list: how many builds")
	job := fs.String("job", "", "log: this job (its key, name or id)")
	follow := fs.Bool("follow", false, "log: keep printing while the job runs")
	asJSON := fs.Bool("json", false, "print the API's JSON")
	mono := fs.String("monorepo", "", "the monorepo (default: the one this folder is in)")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	want := map[string]int{"list": 0, "ls": 0, "view": 1, "log": 1, "rebuild": 1, "cancel": 1}
	if n, ok := want[args[0]]; !ok || len(pos) != n {
		return usage
	}
	if *limit < 1 {
		return UsageError{"--limit is 1 or more"}
	}
	h, full, err := e.target(*srvFlag, *mono)
	if err != nil {
		return err
	}
	if args[0] == "list" || args[0] == "ls" {
		f := server.BuildFilter{Pipeline: *pipeline, Branch: *branch, State: *state}
		if *repo != "" {
			r, err := e.repoIn(h, full, *repo)
			if err != nil {
				return err
			}
			f.Repo = r.Name
		}
		return buildList(e, h, full, f, *limit, *asJSON)
	}
	id, err := buildID(e, h, full, pos[0], *pipeline)
	if err != nil {
		return err
	}
	switch args[0] {
	case "view":
		b, err := h.GetBuild(e.Ctx, full, id)
		if err != nil {
			return err
		}
		if *asJSON {
			return e.printJSON(b.JSON)
		}
		return buildView(e, b)
	case "log":
		return buildLog(e, h, full, id, *job, *follow, *asJSON)
	case "rebuild":
		res, err := h.Rebuild(e.Ctx, full, id)
		if err != nil {
			return err
		}
		if *asJSON {
			return e.printJSON(res.JSON)
		}
		return printStarted(e, res, "Rebuilding: ")
	}
	res, err := h.Cancel(e.Ctx, full, id)
	if err != nil {
		return err
	}
	if *asJSON {
		return e.printJSON(res.JSON)
	}
	if b := res.Build; b != nil {
		e.printf("Canceling %s #%d (%s); Buildkite has it now.\n", b.Pipeline, b.Number, b.ServiceState)
	}
	return nil
}

// ciJob is `pando ci job retry <build> <job>`.
func ciJob(e *Env, args []string) error {
	usage := UsageError{"pando ci job retry <build> <job> [--pipeline p] [--monorepo <owner/name>] [--json]"}
	if len(args) == 0 || args[0] != "retry" {
		return usage
	}
	fs := flags("ci job retry")
	pipeline := fs.String("pipeline", "", "the build's pipeline (default: the monorepo's one pipeline)")
	asJSON := fs.Bool("json", false, "print the API's JSON")
	mono := fs.String("monorepo", "", "the monorepo (default: the one this folder is in)")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return err
	}
	if len(pos) != 2 {
		return usage
	}
	h, full, err := e.target(*srvFlag, *mono)
	if err != nil {
		return err
	}
	id, err := buildID(e, h, full, pos[0], *pipeline)
	if err != nil {
		return err
	}
	b, err := h.GetBuild(e.Ctx, full, id)
	if err != nil {
		return err
	}
	j, err := pickJob(b, pos[1])
	if err != nil {
		return err
	}
	res, err := h.RetryJob(e.Ctx, full, id, j.ID)
	if err != nil {
		return err
	}
	if *asJSON {
		return e.printJSON(res.JSON)
	}
	if res.Job != nil {
		e.printf("Retrying %s in %s #%d: new job %s, %s.\n", jobName(*j), b.Pipeline, b.Number, res.Job.ID, res.Job.State)
	} else {
		e.printf("Retrying %s in %s #%d.\n", jobName(*j), b.Pipeline, b.Number)
	}
	return nil
}

// ciRun is `pando ci run <pipeline> [--branch b]`: New build.
func ciRun(e *Env, args []string) error {
	usage := UsageError{"pando ci run <pipeline> [--branch b] [--monorepo <owner/name>] [--json]"}
	fs := flags("ci run")
	branch := fs.String("branch", "", "the branch to build (default: its repo's main)")
	asJSON := fs.Bool("json", false, "print the API's JSON")
	mono := fs.String("monorepo", "", "the monorepo (default: the one this folder is in)")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return usage
	}
	h, full, err := e.target(*srvFlag, *mono)
	if err != nil {
		return err
	}
	res, err := h.StartBuild(e.Ctx, full, pos[0], *branch)
	if err != nil {
		return err
	}
	if *asJSON {
		return e.printJSON(res.JSON)
	}
	if res.Build == nil {
		e.printf("Started a build of %s; Buildkite named none yet. See it with: pando ci build list --pipeline %s\n", pos[0], pos[0])
		return nil
	}
	return printStarted(e, res, "Started ")
}

func printStarted(e *Env, res *server.CIStarted, what string) error {
	b := res.Build
	if b == nil {
		e.printf("%sBuildkite named no build yet.\n", what)
		return nil
	}
	e.printf("%s%s #%d of %s at %s (%s). Follow it: pando ci build view %s\n", what, b.Pipeline, b.Number, dash(b.Branch), short(b.SHA), b.ID, b.ID)
	return nil
}

// buildID finds a build's id: cib_... as it is; a number with its pipeline
// (pando-ci/12, or 12 or #12 with --pipeline or the monorepo's one pipeline).
func buildID(e *Env, h *server.HTTP, full, ref, pipeline string) (string, error) {
	if strings.HasPrefix(ref, "cib_") {
		return ref, nil
	}
	n := ref
	if p, num, ok := strings.Cut(ref, "/"); ok {
		pipeline, n = p, num
	}
	number, err := strconv.Atoi(strings.TrimPrefix(n, "#"))
	if err != nil || number < 1 {
		return "", fmt.Errorf("%q is not a build: give its number (12, #12, pando-ci/12) or its id (cib_...)", ref)
	}
	if pipeline == "" {
		o, err := h.CIOverview(e.Ctx, full)
		if err != nil {
			return "", err
		}
		slugs := map[string]bool{}
		for _, p := range o.Pipelines {
			slugs[p.Slug] = true
		}
		switch len(slugs) {
		case 0:
			return "", fmt.Errorf("%s has no pipelines yet", full)
		case 1:
			for s := range slugs {
				pipeline = s
			}
		default:
			names := make([]string, 0, len(slugs))
			for s := range slugs {
				names = append(names, s)
			}
			return "", fmt.Errorf("which pipeline? add --pipeline, or write it as <pipeline>/%d (pipelines: %s)", number, strings.Join(names, ", "))
		}
	}
	l, err := h.ListBuilds(e.Ctx, full, server.BuildFilter{Pipeline: pipeline, Number: number}, 2)
	if err != nil {
		return "", err
	}
	switch len(l.Builds) {
	case 0:
		return "", fmt.Errorf("%s has no build %s #%d", full, pipeline, number)
	case 1:
		return l.Builds[0].ID, nil
	}
	return "", fmt.Errorf("two connections have a %s #%d; name it by its id: %s or %s", pipeline, number, l.Builds[0].ID, l.Builds[1].ID)
}

func buildList(e *Env, h *server.HTTP, full string, f server.BuildFilter, limit int, asJSON bool) error {
	l, err := h.ListBuilds(e.Ctx, full, f, limit)
	if err != nil {
		return err
	}
	if asJSON {
		return e.printJSON(l.JSON)
	}
	if len(l.Builds) == 0 {
		e.printf("No builds in %s that match.\n", full)
		return nil
	}
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "BUILD\tPIPELINE\tSTATE\tREPO\tBRANCH\tCOMMIT\tPUSHED BY\tCREATED\tTOOK\tID")
	for _, b := range l.Builds {
		fmt.Fprintf(tw, "#%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", b.Number, b.Pipeline, b.State, dash(b.RepoPath), dash(b.Branch), dash(short(b.SHA)),
			dash(b.PushedBy), ago(b.CreatedAt), took(b.DurationS), b.ID)
	}
	return tw.Flush()
}

func buildView(e *Env, b *server.CIBuildJobs) error {
	e.printf("%s #%d  %s\n", b.Pipeline, b.Number, b.State)
	if b.Message != "" {
		title, _, _ := strings.Cut(b.Message, "\n")
		e.printf("  %s\n", title)
	}
	e.printf("  repo       %s\n", dash(b.RepoPath))
	e.printf("  branch     %s at %s\n", dash(b.Branch), dash(short(b.SHA)))
	e.printf("  pushed by  %s\n", dash(b.PushedBy))
	e.printf("  created    %s, took %s\n", ago(b.CreatedAt), took(b.DurationS))
	if b.RebuiltFrom != "" {
		e.printf("  rebuilt    from Buildkite's build %s\n", b.RebuiltFrom)
	}
	e.printf("  id         %s\n", b.ID)
	if b.WebURL != "" {
		e.printf("  link       %s\n", b.WebURL)
	}
	if len(b.Jobs) == 0 {
		e.printf("\nNo jobs yet.\n")
		return nil
	}
	e.printf("\n")
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "  JOB\tSTATE\tCHECK\tEXIT\tTOOK\tID")
	for _, j := range b.Jobs {
		st := j.State
		switch {
		case j.Retried:
			st += " (retried)"
		case j.SoftFailed:
			st += " (soft)"
		}
		exit := "-"
		if j.ExitStatus != nil {
			exit = strconv.Itoa(*j.ExitStatus)
		}
		fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\t%s\t%s\n", jobName(j), st, dash(j.Check), exit, took(j.DurationS), j.ID)
	}
	return tw.Flush()
}

func jobName(j server.CIJob) string {
	switch {
	case j.StepKey != "":
		return j.StepKey
	case j.Name != "":
		return j.Name
	}
	return j.ID
}

// pickJob finds a job of a build by its id, step key or name.
func pickJob(b *server.CIBuildJobs, name string) (*server.CIJob, error) {
	var found []*server.CIJob
	for i := range b.Jobs {
		j := &b.Jobs[i]
		if j.ID == name {
			return j, nil
		}
		if (j.StepKey == name || strings.EqualFold(j.Name, name)) && !j.Retried {
			found = append(found, j)
		}
	}
	if len(found) == 1 {
		return found[0], nil
	}
	var names []string
	for _, j := range b.Jobs {
		if !j.Retried {
			names = append(names, jobName(j)+" ("+j.ID+")")
		}
	}
	if len(found) == 0 {
		return nil, fmt.Errorf("%s #%d has no job %s (jobs: %s)", b.Pipeline, b.Number, name, strings.Join(names, ", "))
	}
	return nil, fmt.Errorf("%s #%d has more than one job %s; name it by its id (jobs: %s)", b.Pipeline, b.Number, name, strings.Join(names, ", "))
}

func took(s *int) string {
	if s == nil {
		return "-"
	}
	return (time.Duration(*s) * time.Second).String()
}

var finished = map[string]bool{"passed": true, "failed": true, "canceled": true, "skipped": true}

// Buildkite's timestamps in a log line, and terminal colours.
var (
	bkStamp = regexp.MustCompile("\x1b_bk;t=\\d+\x07")
	ansi    = regexp.MustCompile("\x1b\\[[0-9;?]*[A-Za-z]")
)

// buildLog is `pando ci build log`: each job's log (its last 1 MiB), or one
// job's with --job; --follow prints it as it grows until the job finishes.
func buildLog(e *Env, h *server.HTTP, full, id, jobFlag string, follow, asJSON bool) error {
	b, err := h.GetBuild(e.Ctx, full, id)
	if err != nil {
		return err
	}
	var jobs []server.CIJob
	if jobFlag != "" {
		j, err := pickJob(b, jobFlag)
		if err != nil {
			return err
		}
		jobs = append(jobs, *j)
	} else {
		for _, j := range b.Jobs {
			if j.Type == "script" && !j.Retried {
				jobs = append(jobs, j)
			}
		}
	}
	if follow {
		if asJSON {
			return UsageError{"--follow prints the log as it grows; leave out --json"}
		}
		if len(jobs) != 1 {
			var names []string
			for _, j := range jobs {
				names = append(names, jobName(j))
			}
			return UsageError{fmt.Sprintf("--follow follows one job: add --job (jobs: %s)", strings.Join(names, ", "))}
		}
		return followLog(e, h, full, b, jobs[0])
	}
	if asJSON {
		parts := make([][]byte, 0, len(jobs))
		for _, j := range jobs {
			lg, err := h.JobLog(e.Ctx, full, id, j.ID)
			if err != nil {
				return err
			}
			parts = append(parts, lg.JSON)
		}
		return e.printJSON(append(append([]byte("["), joinJSON(parts)...), ']'))
	}
	if len(jobs) == 0 {
		e.printf("%s #%d has no job with a log yet.\n", b.Pipeline, b.Number)
		return nil
	}
	for _, j := range jobs {
		lg, err := h.JobLog(e.Ctx, full, id, j.ID)
		if err != nil {
			return fmt.Errorf("%s: %w", jobName(j), err)
		}
		if len(jobs) > 1 {
			e.printf("--- %s: %s (%s) ---\n", jobName(j), j.State, j.ID)
		}
		e.printLog([]byte(lg.Content))
		switch {
		case lg.Truncated:
			e.warnf("%s: this is the log's last %d of %d bytes; the whole log is in Buildkite: %s", jobName(j), lg.Bytes, lg.TotalBytes, dash(j.WebURL))
		case lg.RetryAfterMS != nil:
			e.warnf("%s: an older copy (Buildkite's rate limit is held); ask again in %d s", jobName(j), *lg.RetryAfterMS/1000+1)
		}
		if !finished[j.State] {
			e.warnf("%s is %s; pando ci build log %s --job %s --follow keeps printing", jobName(j), j.State, id, j.ID)
		}
	}
	return nil
}

func joinJSON(parts [][]byte) []byte {
	var out []byte
	for i, p := range parts {
		if i > 0 {
			out = append(out, ',')
		}
		out = append(out, p...)
	}
	return out
}

// printLog prints log bytes with Buildkite's timestamps taken out, and,
// into a pipe, its colours too.
func (e *Env) printLog(b []byte) {
	b = bkStamp.ReplaceAll(b, nil)
	if !stdoutTerminal(e) {
		b = ansi.ReplaceAll(b, nil)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	_, _ = e.Stdout.Write(b)
	if len(b) > 0 && b[len(b)-1] != '\n' {
		_, _ = e.Stdout.Write([]byte("\n"))
	}
}

// followLog prints a job's log as it grows, every 2 s, until the job has
// finished and its log was read after that.
func followLog(e *Env, h *server.HTTP, full string, b *server.CIBuildJobs, j server.CIJob) error {
	printed := 0 // of the log's total bytes
	wait := 2 * time.Second
	for {
		cur, err := h.GetBuild(e.Ctx, full, b.ID)
		if err != nil {
			return err
		}
		state := j.State
		for _, x := range cur.Jobs {
			if x.ID == j.ID {
				state = x.State
			}
		}
		lg, err := h.JobLog(e.Ctx, full, b.ID, j.ID)
		switch {
		case server.Code(err) == "ci_rate_limited":
			wait = 10 * time.Second
		case err != nil:
			return err
		default:
			c := []byte(lg.Content)
			if lg.TotalBytes < printed {
				printed = 0 // a new log (a retry): from its start
			}
			n := lg.TotalBytes - printed
			if n > len(c) {
				e.warnf("%d bytes of the log were not shown (only its last 1 MiB is kept here)", n-len(c))
				n = len(c)
			}
			e.printLog(c[len(c)-n:])
			printed = lg.TotalBytes
			wait = 2 * time.Second
			if lg.RetryAfterMS != nil {
				wait = time.Duration(*lg.RetryAfterMS) * time.Millisecond
			}
			if lg.Complete || (finished[state] && !lg.Cached) {
				e.warnf("%s %s", jobName(j), state)
				return nil
			}
		}
		select {
		case <-e.Ctx.Done():
			return e.Ctx.Err()
		case <-time.After(wait):
		}
	}
}
