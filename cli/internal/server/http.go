package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// HTTP talks to the Pando Worker's /v1 API.
type HTTP struct {
	Base   string
	token  string
	Client *http.Client
	// Agent, when set, goes out as X-Pando-Agent on every call: the agent
	// acting through this credential (the Pando-Agent trailer's name).
	Agent string
}

// NewHTTP makes an API client. The credential goes in the Authorization
// header and nowhere else: never in a URL, a log line or an error.
func NewHTTP(base, token string) *HTTP {
	return &HTTP{Base: strings.TrimRight(base, "/"), token: token, Client: &http.Client{Timeout: 120 * time.Second}}
}

type request struct {
	method string
	path   string
	query  url.Values
	body   any
	bearer string // overrides the token (bootstrap)
	accept string
}

func (h *HTTP) do(ctx context.Context, r request, out any) (*http.Response, []byte, error) {
	var rd io.Reader
	if r.body != nil {
		b, err := json.Marshal(r.body)
		if err != nil {
			return nil, nil, err
		}
		rd = bytes.NewReader(b)
	}
	u := h.Base + r.path
	if len(r.query) > 0 {
		u += "?" + r.query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, r.method, u, rd)
	if err != nil {
		return nil, nil, err
	}
	if r.body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if r.accept != "" {
		req.Header.Set("Accept", r.accept)
	}
	bearer := h.token
	if r.bearer != "" {
		bearer = r.bearer
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	req.Header.Set("User-Agent", "pando-cli/0.1")
	if h.Agent != "" {
		req.Header.Set("X-Pando-Agent", h.Agent)
	}
	resp, err := h.Client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("%s %s: %w", r.method, h.Base+r.path, unwrapURLError(err))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 512<<20))
	if err != nil {
		return resp, nil, err
	}
	if resp.StatusCode/100 != 2 {
		return resp, data, decodeError(resp.StatusCode, data)
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return resp, data, fmt.Errorf("%s %s: bad JSON from server: %w", r.method, r.path, err)
		}
	}
	return resp, data, nil
}

func unwrapURLError(err error) error {
	if ue, ok := err.(*url.Error); ok {
		return ue.Err
	}
	return err
}

func decodeError(status int, data []byte) error {
	ae := &APIError{Status: status}
	var e struct {
		Error struct {
			Code    string   `json:"code"`
			Message string   `json:"message"`
			Paths   []string `json:"paths"`
			Checks  *Checks  `json:"checks"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &e) == nil {
		ae.Code, ae.Message, ae.Paths, ae.Checks = e.Error.Code, e.Error.Message, e.Error.Paths, e.Error.Checks
	} else if s := strings.TrimSpace(string(data)); s != "" && len(s) < 300 {
		ae.Message = s
	}
	return ae
}

func esc(s string) string { return url.PathEscape(s) }

func monoPath(m string) string { return MonorepoPath(m) }

func repoPath(m, repo string) string { return monoPath(m) + "/repos/" + esc(repo) }

func branchPath(m, repo, b string) string { return repoPath(m, repo) + "/branches/" + esc(b) }

func (h *HTTP) CreateUser(ctx context.Context, bootstrap, login, name, email, credentialName string) (*NewUser, error) {
	out := &NewUser{}
	body := map[string]string{"login": login}
	for k, v := range map[string]string{"name": name, "email": email, "credential_name": credentialName} {
		if v != "" {
			body[k] = v
		}
	}
	_, _, err := h.do(ctx, request{method: "POST", path: "/v1/users", body: body, bearer: bootstrap}, out)
	return out, err
}

func (h *HTTP) DeleteMonorepo(ctx context.Context, m string) error {
	_, _, err := h.do(ctx, request{method: "DELETE", path: monoPath(m), query: url.Values{"confirm": {m}}}, nil)
	return err
}

func (h *HTTP) ListMembers(ctx context.Context, m string) ([]Member, error) {
	var out struct {
		Members []Member `json:"members"`
	}
	_, _, err := h.do(ctx, request{method: "GET", path: monoPath(m) + "/members"}, &out)
	return out.Members, err
}

func (h *HTTP) RemoveMember(ctx context.Context, m, login string) error {
	_, _, err := h.do(ctx, request{method: "DELETE", path: monoPath(m) + "/members/" + esc(login)}, nil)
	return err
}

func (h *HTTP) Invite(ctx context.Context, m, email, role string) (*InviteResult, error) {
	body := map[string]string{"email": email}
	if role != "" {
		body["role"] = role
	}
	out := &InviteResult{}
	_, _, err := h.do(ctx, request{method: "POST", path: monoPath(m) + "/invites", body: body}, out)
	return out, err
}

func (h *HTTP) ListInvites(ctx context.Context, m string) ([]Invite, error) {
	var out struct {
		Invites []Invite `json:"invites"`
	}
	_, _, err := h.do(ctx, request{method: "GET", path: monoPath(m) + "/invites"}, &out)
	return out.Invites, err
}

func (h *HTTP) RevokeInvite(ctx context.Context, m, email string) error {
	_, _, err := h.do(ctx, request{method: "DELETE", path: monoPath(m) + "/invites/" + esc(email)}, nil)
	return err
}

func (h *HTTP) Me(ctx context.Context) (*Me, error) {
	out := &Me{}
	_, _, err := h.do(ctx, request{method: "GET", path: "/v1/user"}, out)
	return out, err
}

func (h *HTTP) CreateCredential(ctx context.Context, name, kind string) (*Credential, error) {
	out := &Credential{}
	_, _, err := h.do(ctx, request{method: "POST", path: "/v1/user/credentials", body: map[string]string{"name": name, "kind": kind}}, out)
	return out, err
}

func (h *HTTP) ListCredentials(ctx context.Context) ([]Credential, error) {
	var out struct {
		Credentials []Credential `json:"credentials"`
	}
	_, _, err := h.do(ctx, request{method: "GET", path: "/v1/user/credentials"}, &out)
	return out.Credentials, err
}

func (h *HTTP) RevokeCredential(ctx context.Context, id string) error {
	_, _, err := h.do(ctx, request{method: "DELETE", path: "/v1/user/credentials/" + esc(id)}, nil)
	return err
}

func (h *HTTP) CreateMonorepo(ctx context.Context, name, kind string) (*Created, error) {
	out := &Created{}
	_, _, err := h.do(ctx, request{method: "POST", path: "/v1/monorepos", body: map[string]string{"name": name, "kind": kind}}, out)
	return out, err
}

func (h *HTTP) ListMonorepos(ctx context.Context, name string) ([]Monorepo, error) {
	var out struct {
		Monorepos []Monorepo `json:"monorepos"`
	}
	q := url.Values{}
	if name != "" {
		q.Set("name", name)
	}
	_, _, err := h.do(ctx, request{method: "GET", path: "/v1/monorepos", query: q}, &out)
	return out.Monorepos, err
}

func (h *HTTP) GetMonorepo(ctx context.Context, m string) (*Monorepo, error) {
	out := &Monorepo{}
	_, _, err := h.do(ctx, request{method: "GET", path: monoPath(m)}, out)
	return out, err
}

func (h *HTTP) Heads(ctx context.Context, m string) (*Heads, error) {
	out := &Heads{}
	_, _, err := h.do(ctx, request{method: "GET", path: monoPath(m) + "/heads"}, out)
	return out, err
}

func (h *HTTP) ListRepos(ctx context.Context, m string) ([]Repo, error) {
	var out struct {
		Repos []Repo `json:"repos"`
	}
	_, _, err := h.do(ctx, request{method: "GET", path: monoPath(m) + "/repos"}, &out)
	return out.Repos, err
}

func (h *HTTP) GetRepo(ctx context.Context, m, repo string) (*Repo, error) {
	out := &Repo{}
	_, _, err := h.do(ctx, request{method: "GET", path: repoPath(m, repo)}, out)
	return out, err
}

func (h *HTTP) CreateRepo(ctx context.Context, m, path string) (*Repo, error) {
	out := &Repo{}
	_, _, err := h.do(ctx, request{method: "POST", path: monoPath(m) + "/repos", body: map[string]string{"path": path}}, out)
	return out, err
}

// ListBranches reads every page of the branch list (500 a page).
func (h *HTTP) ListBranches(ctx context.Context, m, repo, state string) (*BranchList, error) {
	out := &BranchList{}
	cursor := ""
	for page := 0; page < 100; page++ {
		q := url.Values{"limit": {"500"}}
		if state != "" {
			q.Set("state", state)
		}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		pg := &BranchList{}
		if _, _, err := h.do(ctx, request{method: "GET", path: repoPath(m, repo) + "/branches", query: q}, pg); err != nil {
			return nil, err
		}
		if page == 0 {
			out.DefaultBranch, out.DefaultHead = pg.DefaultBranch, pg.DefaultHead
		}
		out.Branches = append(out.Branches, pg.Branches...)
		if pg.NextCursor == "" || pg.NextCursor == cursor {
			break
		}
		cursor = pg.NextCursor
	}
	return out, nil
}

func (h *HTTP) GetBranch(ctx context.Context, m, repo, b string) (*Branch, error) {
	out := &Branch{}
	_, _, err := h.do(ctx, request{method: "GET", path: branchPath(m, repo, b)}, out)
	return out, err
}

// CreateBranch makes branch b off main. Making it is idempotent (an existing
// branch is not an error), so a server error is tried again, twice: with
// five agents adding worktrees at once, pando-dev answered 2 of 5 with
// "Artifacts could not unpack" (HTTP 502), 2026-10-03.
func (h *HTTP) CreateBranch(ctx context.Context, m, repo, b string) (bool, error) {
	var err error
	for attempt := 1; ; attempt++ {
		_, _, err = h.do(ctx, request{method: "POST", path: repoPath(m, repo) + "/branches", body: map[string]string{"name": b}}, nil)
		if Code(err) == "branch_exists" || (StatusOf(err) == http.StatusConflict && Code(err) == "") {
			return false, nil
		}
		if err == nil || StatusOf(err) < 500 || attempt == 3 {
			break
		}
		select {
		case <-ctx.Done():
			return false, err
		case <-time.After(time.Duration(attempt) * 700 * time.Millisecond):
		}
	}
	return err == nil, err
}

func (h *HTTP) Diff(ctx context.Context, m, repo, b string, format DiffFormat, paths []string) ([]byte, int, error) {
	q := url.Values{"format": {string(format)}}
	if len(paths) > 0 {
		q.Set("paths", strings.Join(paths, ","))
	}
	resp, data, err := h.do(ctx, request{method: "GET", path: branchPath(m, repo, b) + "/diff", query: q}, nil)
	if err != nil {
		return nil, 0, err
	}
	omitted, _ := strconv.Atoi(resp.Header.Get("X-Pando-Diff-Omitted"))
	return data, omitted, nil
}

func (h *HTTP) CreateReview(ctx context.Context, m, repo, b string, r ReviewIn) (*Review, error) {
	out := &Review{}
	_, _, err := h.do(ctx, request{method: "POST", path: branchPath(m, repo, b) + "/reviews", body: r}, out)
	return out, err
}

func (h *HTTP) Merge(ctx context.Context, m, repo, b string, force bool, expectedHead string) (*MergeResult, error) {
	q := url.Values{}
	if force {
		q.Set("force", "1")
	}
	body := map[string]string{}
	if expectedHead != "" {
		body["expected_head"] = expectedHead
	}
	out := &MergeResult{}
	_, _, err := h.do(ctx, request{method: "POST", path: branchPath(m, repo, b) + "/merge", query: q, body: body}, out)
	return out, err
}

func (h *HTTP) PutWorktree(ctx context.Context, m, id string, w WorktreeIn) error {
	_, _, err := h.do(ctx, request{method: "PUT", path: monoPath(m) + "/worktrees/" + esc(id), body: w}, nil)
	return err
}

func (h *HTTP) ListWorktrees(ctx context.Context, m string) ([]Worktree, error) {
	var out struct {
		Worktrees []Worktree `json:"worktrees"`
	}
	_, _, err := h.do(ctx, request{method: "GET", path: monoPath(m) + "/worktrees"}, &out)
	return out.Worktrees, err
}

func (h *HTTP) DeleteWorktree(ctx context.Context, m, id string) error {
	_, _, err := h.do(ctx, request{method: "DELETE", path: monoPath(m) + "/worktrees/" + esc(id)}, nil)
	if StatusOf(err) == http.StatusNotFound {
		return nil
	}
	return err
}
