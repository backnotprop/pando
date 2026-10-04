package server

import (
	"context"
	"encoding/json"
	"net/url"
)

// ── What happened, and who is connected ───────────────────────────────────

// FeedEvent is one line of the activity log (FeedEvent in api-v1.yaml).
// Summary's fields depend on the kind.
type FeedEvent struct {
	Monorepo string          `json:"monorepo"` // owner/name
	Seq      int64           `json:"seq"`
	At       string          `json:"at"`
	Kind     string          `json:"kind"`
	Repo     string          `json:"repo"`
	RepoPath string          `json:"repo_path"`
	Branch   string          `json:"branch"`
	Actor    string          `json:"actor"`
	Machine  string          `json:"machine"`
	Summary  json.RawMessage `json:"summary"`
}

// Activity is listActivity's answer, its pages joined.
type Activity struct {
	Events   []FeedEvent `json:"events"`
	Next     string      `json:"next"`
	FromLogs bool        `json:"from_logs"`
	Skipped  []string    `json:"skipped"`
	JSON     []byte      `json:"-"` // the answer as sent: what --json prints
}

// Activity is the activity log across the person's monorepos, newest first,
// or one monorepo's (in: owner/name), up to limit lines (200 a page).
func (h *HTTP) Activity(ctx context.Context, in string, limit int) (*Activity, error) {
	q := url.Values{}
	if in != "" {
		q.Set("in", in)
	}
	data, err := h.pages(ctx, "/v1/events", q, limit, 200, func(page []byte) int {
		var p Activity
		_ = json.Unmarshal(page, &p)
		return len(p.Events)
	})
	if err != nil {
		return nil, err
	}
	out := &Activity{JSON: data}
	return out, json.Unmarshal(data, out)
}

// Machine is a credential that acted in, or is connected to, a monorepo.
type Machine struct {
	Login        string `json:"login"`
	CredentialID string `json:"credential_id"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	Connected    bool   `json:"connected"`
	ConnectedAt  string `json:"connected_at"`
	LastActivity *struct {
		At       string `json:"at"`
		Kind     string `json:"kind"`
		RepoPath string `json:"repo_path"`
		Branch   string `json:"branch"`
	} `json:"last_activity"`
	Worktrees []struct {
		ID     string `json:"id"`
		Path   string `json:"path"`
		Branch string `json:"branch"`
	} `json:"worktrees"`
	UpdatedAt string `json:"updated_at"`
}

type MachineList struct {
	Machines []Machine `json:"machines"`
	JSON     []byte    `json:"-"`
}

func (h *HTTP) ListMachines(ctx context.Context, m string) (*MachineList, error) {
	out := &MachineList{}
	data, err := h.Call(ctx, "GET", monoPath(m)+"/machines", nil, nil, out)
	out.JSON = data
	return out, err
}
