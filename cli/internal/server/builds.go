package server

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
)

// ── CI builds and jobs (the ci tag in api-v1.yaml) ─────────────────────────

// CIJob is one job of a build. Check is the status context it reports (its
// step key), "" for a job that reports none.
type CIJob struct {
	ID           string `json:"id"`
	Build        string `json:"build"`
	Name         string `json:"name"`
	StepKey      string `json:"step_key"`
	Type         string `json:"type"` // script, trigger or manual
	State        string `json:"state"`
	ServiceState string `json:"service_state"`
	ExitStatus   *int   `json:"exit_status"`
	SoftFailed   bool   `json:"soft_failed"`
	Retried      bool   `json:"retried"`
	WebURL       string `json:"web_url"`
	StartedAt    string `json:"started_at"`
	FinishedAt   string `json:"finished_at"`
	DurationS    *int   `json:"duration_s"`
	Check        string `json:"check"`
}

// CIBuildJobs is a build with its jobs (getCiBuild).
type CIBuildJobs struct {
	CIBuild
	Jobs []CIJob `json:"jobs"`
	JSON []byte  `json:"-"` // the answer as sent: what --json prints
}

// CIBuildList is listCiBuilds' answer, its pages joined.
type CIBuildList struct {
	Builds     []CIBuild `json:"builds"`
	NextCursor string    `json:"next_cursor"`
	JSON       []byte    `json:"-"`
}

// CIJobLog is a job's log from the service: its last 1 MiB, raw.
type CIJobLog struct {
	Job          string `json:"job"`
	Content      string `json:"content"`
	Bytes        int    `json:"bytes"`
	TotalBytes   int    `json:"total_bytes"`
	Truncated    bool   `json:"truncated"`
	Complete     bool   `json:"complete"`
	FetchedAt    string `json:"fetched_at"`
	Cached       bool   `json:"cached"`
	RetryAfterMS *int   `json:"retry_after_ms"`
	JSON         []byte `json:"-"`
}

// CIStarted is the answer to a new build or a rebuild, and to a cancel.
type CIStarted struct {
	Build *CIBuildJobs `json:"build"`
	JSON  []byte       `json:"-"`
}

// CIRetried is the answer to retrying a job.
type CIRetried struct {
	Job  *CIJob `json:"job"`
	JSON []byte `json:"-"`
}

// BuildFilter narrows a build list; empty fields do not.
type BuildFilter struct {
	Pipeline, Branch, State, Repo string
	Number                        int
}

func ciPath(m string) string { return monoPath(m) + "/ci" }

func buildPath(m, id string) string { return ciPath(m) + "/builds/" + esc(id) }

// ListBuilds is the stored builds, newest first, up to limit (100 a page).
func (h *HTTP) ListBuilds(ctx context.Context, m string, f BuildFilter, limit int) (*CIBuildList, error) {
	q := url.Values{}
	for k, v := range map[string]string{"pipeline": f.Pipeline, "branch": f.Branch, "state": f.State, "repo": f.Repo} {
		if v != "" {
			q.Set(k, v)
		}
	}
	if f.Number > 0 {
		q.Set("number", strconv.Itoa(f.Number))
	}
	data, err := h.pages(ctx, ciPath(m)+"/builds", q, limit, 100, func(page []byte) int {
		var p CIBuildList
		_ = json.Unmarshal(page, &p)
		return len(p.Builds)
	})
	if err != nil {
		return nil, err
	}
	out := &CIBuildList{JSON: data}
	return out, json.Unmarshal(data, out)
}

func (h *HTTP) GetBuild(ctx context.Context, m, id string) (*CIBuildJobs, error) {
	out := &CIBuildJobs{}
	data, err := h.Call(ctx, "GET", buildPath(m, id), nil, nil, out)
	out.JSON = data
	return out, err
}

func (h *HTTP) JobLog(ctx context.Context, m, build, job string) (*CIJobLog, error) {
	out := &CIJobLog{}
	data, err := h.Call(ctx, "GET", buildPath(m, build)+"/jobs/"+esc(job)+"/log", nil, nil, out)
	out.JSON = data
	return out, err
}

// Rebuild starts a new build of the same commit, with fresh tokens.
func (h *HTTP) Rebuild(ctx context.Context, m, build string) (*CIStarted, error) {
	return h.started(ctx, buildPath(m, build)+"/rebuild", nil)
}

// Cancel cancels a running build (409 ci_finished when it has finished).
func (h *HTTP) Cancel(ctx context.Context, m, build string) (*CIStarted, error) {
	return h.started(ctx, buildPath(m, build)+"/cancel", nil)
}

// StartBuild is New build: the pipeline builds branch's head as Pando has
// it ("" for its repo's default branch).
func (h *HTTP) StartBuild(ctx context.Context, m, pipeline, branch string) (*CIStarted, error) {
	body := map[string]string{}
	if branch != "" {
		body["branch"] = branch
	}
	return h.started(ctx, ciPath(m)+"/pipelines/"+esc(pipeline)+"/builds", body)
}

func (h *HTTP) started(ctx context.Context, path string, body any) (*CIStarted, error) {
	out := &CIStarted{}
	data, err := h.Call(ctx, "POST", path, nil, body, out)
	out.JSON = data
	return out, err
}

// RetryJob reruns a job, passed through to the service.
func (h *HTTP) RetryJob(ctx context.Context, m, build, job string) (*CIRetried, error) {
	out := &CIRetried{}
	data, err := h.Call(ctx, "POST", buildPath(m, build)+"/jobs/"+esc(job)+"/retry", nil, nil, out)
	out.JSON = data
	return out, err
}
