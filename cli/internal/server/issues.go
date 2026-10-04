package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// ── Issues (the issues tag in api-v1.yaml; packages/contract/src/issue.ts) ──

type Label struct {
	Name        string `json:"name"`
	Color       string `json:"color"` // one of eight names: gray, orange, yellow, green, teal, blue, purple, pink
	Description string `json:"description"`
}

// ReactionGroup is one of GitHub's eight reactions, how many, and who.
type ReactionGroup struct {
	Content string   `json:"content"` // +1, -1, laugh, hooray, confused, heart, rocket, eyes
	Count   int      `json:"count"`
	By      []string `json:"by"`
}

// IssueMerge is a merge that closed or named an issue.
type IssueMerge struct {
	Repo        string `json:"repo"`
	RepoPath    string `json:"repo_path"`
	Branch      string `json:"branch"`
	MergeCommit string `json:"merge_commit"`
}

// IssueRow is an issue as the list shows it: no body.
type IssueRow struct {
	Number      int      `json:"number"`
	Title       string   `json:"title"`
	State       string   `json:"state"`        // open or closed
	StateReason string   `json:"state_reason"` // completed or not_planned
	Project     string   `json:"project"`
	ProjectPath string   `json:"project_path"`
	Labels      []Label  `json:"labels"`
	Assignees   []string `json:"assignees"`
	Author      string   `json:"author"`
	Comments    int      `json:"comments"`
	Tasks       *struct {
		Done  int `json:"done"`
		Total int `json:"total"`
	} `json:"tasks"`
	LinkedBranches int         `json:"linked_branches"`
	CreatedAt      string      `json:"created_at"`
	UpdatedAt      string      `json:"updated_at"`
	ClosedAt       string      `json:"closed_at"`
	ClosedBy       string      `json:"closed_by"`
	ClosedByMerge  *IssueMerge `json:"closed_by_merge"`
}

// IssueLink is a branch linked to an issue, and every way it is linked.
type IssueLink struct {
	Repo        string   `json:"repo"`
	RepoPath    string   `json:"repo_path"`
	Branch      string   `json:"branch"`
	Sources     []string `json:"sources"` // link, title, commit
	SHA         string   `json:"sha"`
	LinkedBy    string   `json:"linked_by"`
	BranchState string   `json:"branch_state"` // open, ready, conflicts, failing, merged, deleted
	MergedAt    string   `json:"merged_at"`
	ClosedIssue bool     `json:"closed_issue"`
}

// Issue is one issue whole (getIssue).
type Issue struct {
	IssueRow
	Body         string          `json:"body"`
	BodyVersion  int             `json:"body_version"`
	Machine      string          `json:"machine"`
	Links        []IssueLink     `json:"links"`
	Participants []string        `json:"participants"`
	Reactions    []ReactionGroup `json:"reactions"`
	JSON         []byte          `json:"-"` // the answer as sent: what --json prints
	Replayed     bool            `json:"-"` // a retried create: the server answered the first one
}

type IssueComment struct {
	ID          string          `json:"id"`
	Body        string          `json:"body"`
	BodyVersion int             `json:"body_version"`
	Author      string          `json:"author"`
	Machine     string          `json:"machine"`
	CreatedAt   string          `json:"created_at"`
	UpdatedAt   string          `json:"updated_at"`
	Reactions   []ReactionGroup `json:"reactions"`
	JSON        []byte          `json:"-"`
	Replayed    bool            `json:"-"`
}

// IssueList is listIssues' answer, its pages joined.
type IssueList struct {
	Issues []IssueRow `json:"issues"`
	Counts struct {
		Open   int `json:"open"`
		Closed int `json:"closed"`
	} `json:"counts"`
	NextCursor string `json:"next_cursor"`
	JSON       []byte `json:"-"`
}

// TimelineItem is one comment or event of an issue's timeline. Which fields
// are set depends on Kind (comment, labeled, unlabeled, assigned,
// unassigned, renamed, project_changed, linked, unlinked, closed, reopened,
// merge_referenced).
type TimelineItem struct {
	ID       int64         `json:"id"`
	At       string        `json:"at"`
	Actor    string        `json:"actor"`
	Machine  string        `json:"machine"`
	Kind     string        `json:"kind"`
	Comment  *IssueComment `json:"comment"`
	Label    *Label        `json:"label"`
	Assignee string        `json:"assignee"`
	From     string        `json:"from"` // renamed: titles; project_changed: repo names
	To       string        `json:"to"`
	FromPath string        `json:"from_path"`
	ToPath   string        `json:"to_path"`
	Repo     string        `json:"repo"` // linked, unlinked
	RepoPath string        `json:"repo_path"`
	Branch   string        `json:"branch"`
	Source   string        `json:"source"`
	SHA      string        `json:"sha"`
	Reason   string        `json:"reason"`
	Merge    *IssueMerge   `json:"merge"`
}

// Timeline is an issue's comments and events, oldest first, its pages joined.
type Timeline struct {
	Items      []TimelineItem `json:"items"`
	Total      int            `json:"total"`
	NextCursor string         `json:"next_cursor"`
	JSON       []byte         `json:"-"`
}

// IssueFilter narrows the issue list; empty fields do not.
type IssueFilter struct {
	State, Assignee, Author, Project, Search, Sort string
	Labels                                         []string
}

// IssueIn is the body of a new issue. Project is a repo's name.
type IssueIn struct {
	Title     string      `json:"title"`
	Body      string      `json:"body,omitempty"`
	Labels    []string    `json:"labels,omitempty"`
	Assignees []string    `json:"assignees,omitempty"`
	Project   string      `json:"project,omitempty"`
	Link      []BranchRef `json:"link,omitempty"`
}

// BranchRef names a branch: its repo's name and the branch.
type BranchRef struct {
	Repo   string `json:"repo"`
	Branch string `json:"branch"`
}

func issuesPath(m string) string { return monoPath(m) + "/issues" }

func issuePath(m string, n int) string { return issuesPath(m) + "/" + strconv.Itoa(n) }

// ListIssues is a page of issues up to limit (100 a page), and the open and
// closed counts for the same filters.
func (h *HTTP) ListIssues(ctx context.Context, m string, f IssueFilter, limit int) (*IssueList, error) {
	q := url.Values{}
	for k, v := range map[string]string{"state": f.State, "assignee": f.Assignee, "author": f.Author, "project": f.Project, "q": f.Search, "sort": f.Sort} {
		if v != "" {
			q.Set(k, v)
		}
	}
	for _, l := range f.Labels {
		q.Add("label", l)
	}
	data, err := h.pages(ctx, issuesPath(m), q, limit, 100, func(page []byte) int {
		var p IssueList
		_ = json.Unmarshal(page, &p)
		return len(p.Issues)
	})
	if err != nil {
		return nil, err
	}
	out := &IssueList{JSON: data}
	return out, json.Unmarshal(data, out)
}

func (h *HTTP) GetIssue(ctx context.Context, m string, n int) (*Issue, error) {
	out := &Issue{}
	data, err := h.Call(ctx, "GET", issuePath(m, n), nil, nil, out)
	out.JSON = data
	return out, err
}

// CreateIssue opens an issue. key is its Idempotency-Key: a retry with the
// same key answers the first issue (Replayed).
func (h *HTTP) CreateIssue(ctx context.Context, m string, in IssueIn, key string) (*Issue, error) {
	out := &Issue{}
	data, replayed, err := h.keyed(ctx, issuesPath(m), in, key, out)
	out.JSON, out.Replayed = data, replayed
	return out, err
}

// UpdateIssue sends one PATCH: any of title, body (with base_version),
// project (a repo's name, or nil for none), state, state_reason, the add and
// remove lists, link and unlink. 409 edited when base_version is stale.
func (h *HTTP) UpdateIssue(ctx context.Context, m string, n int, fields map[string]any) (*Issue, error) {
	out := &Issue{}
	data, err := h.Call(ctx, "PATCH", issuePath(m, n), nil, fields, out)
	out.JSON = data
	return out, err
}

// IssueTimeline is every item of an issue's timeline, oldest first.
func (h *HTTP) IssueTimeline(ctx context.Context, m string, n int) (*Timeline, error) {
	data, err := h.pages(ctx, issuePath(m, n)+"/timeline", nil, 1<<20, 100, func(page []byte) int {
		var p Timeline
		_ = json.Unmarshal(page, &p)
		return len(p.Items)
	})
	if err != nil {
		return nil, err
	}
	out := &Timeline{JSON: data}
	return out, json.Unmarshal(data, out)
}

// AddIssueComment comments on an issue, with key as its Idempotency-Key.
func (h *HTTP) AddIssueComment(ctx context.Context, m string, n int, body, key string) (*IssueComment, error) {
	out := &IssueComment{}
	data, replayed, err := h.keyed(ctx, issuePath(m, n)+"/comments", map[string]string{"body": body}, key, out)
	out.JSON, out.Replayed = data, replayed
	return out, err
}

// Reactions is the answer to a reaction: the issue's or comment's reactions now.
type Reactions struct {
	Reactions []ReactionGroup `json:"reactions"`
	JSON      []byte          `json:"-"`
}

// React gives (or, with remove, takes back) one reaction on an issue, or on
// one of its comments when comment is set. Either way is safe to repeat.
func (h *HTTP) React(ctx context.Context, m string, n int, comment, content string, remove bool) (*Reactions, error) {
	p := issuePath(m, n)
	if comment != "" {
		p += "/comments/" + esc(comment)
	}
	method := "PUT"
	if remove {
		method = "DELETE"
	}
	out := &Reactions{}
	data, err := h.Call(ctx, method, p+"/reactions/"+esc(content), nil, nil, out)
	out.JSON = data
	return out, err
}

// keyed POSTs a new issue or comment with an Idempotency-Key, and tries
// again with the same key after a network error or a 502, 503 or 504, up to
// 3 more times: a lost answer never makes a second one. replayed says the
// server answered the first one (Pando-Replayed: true).
func (h *HTTP) keyed(ctx context.Context, path string, body any, key string, out any) ([]byte, bool, error) {
	r := request{method: "POST", path: path, body: body, header: http.Header{"Idempotency-Key": {key}}}
	for attempt := 1; ; attempt++ {
		resp, data, err := h.do(ctx, r, out)
		if err == nil {
			return data, resp.Header.Get("Pando-Replayed") == "true", nil
		}
		st := StatusOf(err)
		again := resp == nil || st == http.StatusBadGateway || st == http.StatusServiceUnavailable || st == http.StatusGatewayTimeout
		if !again || attempt == 4 || ctx.Err() != nil {
			return data, false, err
		}
		select {
		case <-ctx.Done():
			return data, false, err
		case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
		}
	}
}
