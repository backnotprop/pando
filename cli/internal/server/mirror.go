package server

import (
	"context"
)

// ── Mirror to GitHub (packages/contract/src/mirror.ts): members read, owners write ──

// GithubRepo is a GitHub repository a target mirrors to. ID is GitHub's own,
// stable through renames.
type GithubRepo struct {
	ID       int64  `json:"id"`
	FullName string `json:"full_name"`
	Private  bool   `json:"private"`
	URL      string `json:"url"`
}

// MirrorConnection is the GitHub account (or organization) the Pando app is
// installed on, as linked to the repository.
type MirrorConnection struct {
	InstallationID int64  `json:"installation_id"`
	Login          string `json:"login"`
	Type           string `json:"type"` // User or Organization
	ManageURL      string `json:"manage_url"`
	ConnectedAt    string `json:"connected_at"`
	ConnectedBy    string `json:"connected_by"`
}

// MirrorTarget is one row: a source (a project, the files outside projects/
// with path "", or the whole repository with repo "*") and its GitHub
// repository. State is off, not_started, up_to_date, waiting, paused,
// mirroring, retrying, no_access, not_found or refused.
type MirrorTarget struct {
	Repo   string      `json:"repo"`
	Path   string      `json:"path"`
	On     bool        `json:"on"`
	Github *GithubRepo `json:"github"`
	State  string      `json:"state"`
	Last   *struct {
		Commit string `json:"commit"`
		At     string `json:"at"`
	} `json:"last"`
	Behind  *int `json:"behind"` // 100 means 100 or more
	Problem *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		At      string `json:"at"`
	} `json:"problem"`
}

// Mirror is GET .../mirror: the connection, the mode (projects or whole),
// the section's switch and one row per source.
type Mirror struct {
	App struct {
		Configured bool `json:"configured"`
	} `json:"app"`
	Connection *MirrorConnection `json:"connection"`
	Mode       string            `json:"mode"`
	On         bool              `json:"on"`
	Started    bool              `json:"started"`
	Paused     *struct {
		By string `json:"by"`
		At string `json:"at"`
	} `json:"paused"`
	Targets []MirrorTarget `json:"targets"`
	JSON    []byte         `json:"-"` // the answer as sent: what --json prints
}

// MirrorTargetIn is one target of PUT .../mirror/targets.
type MirrorTargetIn struct {
	Repo     string `json:"repo"`
	GithubID int64  `json:"github_id"`
	On       bool   `json:"on"`
}

// MirrorSaved is the answer to PUT .../mirror/targets.
type MirrorSaved struct {
	Mirror       Mirror `json:"mirror"`
	AuthorizeURL string `json:"authorize_url"`
	JSON         []byte `json:"-"`
}

// MirrorQueued is the answer to POST .../mirror/run (Retry).
type MirrorQueued struct {
	Queued  []string `json:"queued"`
	Skipped []struct {
		Repo   string `json:"repo"`
		Reason string `json:"reason"`
	} `json:"skipped"`
	JSON []byte `json:"-"`
}

func mirrorPath(m string) string { return monoPath(m) + "/mirror" }

func (h *HTTP) GetMirror(ctx context.Context, m string) (*Mirror, error) {
	out := &Mirror{}
	_, data, err := h.do(ctx, request{method: "GET", path: mirrorPath(m)}, out)
	out.JSON = data
	return out, err
}

// SetMirrorOn is the section's switch: off pauses, on sends everything.
func (h *HTTP) SetMirrorOn(ctx context.Context, m string, on bool) (*Mirror, error) {
	out := &Mirror{}
	_, data, err := h.do(ctx, request{method: "PATCH", path: mirrorPath(m), body: map[string]bool{"on": on}}, out)
	out.JSON = data
	return out, err
}

// PutMirrorTargets saves the mode and the full list of targets: a target
// left out of the list is dropped.
func (h *HTTP) PutMirrorTargets(ctx context.Context, m, mode string, targets []MirrorTargetIn) (*MirrorSaved, error) {
	if targets == nil {
		targets = []MirrorTargetIn{}
	}
	out := &MirrorSaved{}
	body := map[string]any{"mode": mode, "targets": targets}
	_, data, err := h.do(ctx, request{method: "PUT", path: mirrorPath(m) + "/targets", body: body}, out)
	out.JSON = data
	return out, err
}

// RunMirror is Retry: the named targets (Pando repo names), or every one.
func (h *HTTP) RunMirror(ctx context.Context, m string, repos []string) (*MirrorQueued, error) {
	body := map[string]any{}
	if len(repos) > 0 {
		body["repos"] = repos
	}
	out := &MirrorQueued{}
	_, data, err := h.do(ctx, request{method: "POST", path: mirrorPath(m) + "/run", body: body}, out)
	out.JSON = data
	return out, err
}
