package server

import (
	"context"
	"net/url"
	"strconv"
)

// ── Hooks (the hooks tag in api-v1.yaml): a repo's web and buildkite hooks ──

// Hook is a repo's hook. A web hook POSTs signed JSON to URL on its events;
// a buildkite hook starts a build of its pipeline on a push.
type Hook struct {
	ID        string   `json:"id"`
	Type      string   `json:"type"` // web or buildkite
	URL       string   `json:"url"`
	Events    []string `json:"events"`
	Buildkite *struct {
		Organization string `json:"organization"`
		Pipeline     string `json:"pipeline"`
	} `json:"buildkite"`
	App       string `json:"app"`
	Active    bool   `json:"active"`
	CreatedAt string `json:"created_at"`
	CreatedBy string `json:"created_by"`
	JSON      []byte `json:"-"` // the answer as sent: what --json prints
}

type HookList struct {
	Hooks []Hook `json:"hooks"`
	JSON  []byte `json:"-"`
}

// Delivery is one hook delivery and its tries.
type Delivery struct {
	ID            string `json:"id"`
	HookID        string `json:"hook_id"`
	Event         string `json:"event"`
	Seq           *int64 `json:"seq"`
	Status        string `json:"status"` // queued, retrying, delivered, failed, dead
	Attempts      int    `json:"attempts"`
	ResponseCode  *int   `json:"response_code"`
	Error         string `json:"error"`
	CreatedAt     string `json:"created_at"`
	LastAttemptAt string `json:"last_attempt_at"`
	NextAttemptAt string `json:"next_attempt_at"`
	JSON          []byte `json:"-"`
}

type DeliveryList struct {
	Deliveries []Delivery `json:"deliveries"`
	JSON       []byte     `json:"-"`
}

// Replayed is the answer to replaying a hook from a seq.
type Replayed struct {
	Queued int      `json:"queued"`
	IDs    []string `json:"ids"`
	JSON   []byte   `json:"-"`
}

func hooksPath(m, repo string) string { return repoPath(m, repo) + "/hooks" }

func (h *HTTP) ListHooks(ctx context.Context, m, repo string) (*HookList, error) {
	out := &HookList{}
	data, err := h.Call(ctx, "GET", hooksPath(m, repo), nil, nil, out)
	out.JSON = data
	return out, err
}

// AddBuildkiteHook needs an owner's credential.
func (h *HTTP) AddBuildkiteHook(ctx context.Context, m, repo, org, pipeline string) (*Hook, error) {
	body := map[string]any{"type": "buildkite", "buildkite": map[string]string{"organization": org, "pipeline": pipeline}}
	out := &Hook{}
	_, err := h.Call(ctx, "POST", hooksPath(m, repo), nil, body, out)
	return out, err
}

// WebHookIn is the body of a new web hook. Secret is its HMAC key: it is
// sent once and never shown again.
type WebHookIn struct {
	Type   string   `json:"type"` // web
	URL    string   `json:"url"`
	Secret string   `json:"secret"`
	Events []string `json:"events,omitempty"`
	App    string   `json:"app,omitempty"`
}

// AddWebHook needs an owner's credential.
func (h *HTTP) AddWebHook(ctx context.Context, m, repo string, in WebHookIn) (*Hook, error) {
	in.Type = "web"
	out := &Hook{}
	data, err := h.Call(ctx, "POST", hooksPath(m, repo), nil, in, out)
	out.JSON = data
	return out, err
}

// DeleteHook needs an owner's credential.
func (h *HTTP) DeleteHook(ctx context.Context, m, repo, id string) error {
	_, err := h.Call(ctx, "DELETE", hooksPath(m, repo)+"/"+esc(id), nil, nil, nil)
	return err
}

// Deliveries is a hook's last 100 deliveries, newest first.
func (h *HTTP) Deliveries(ctx context.Context, m, repo, hook string) (*DeliveryList, error) {
	out := &DeliveryList{}
	data, err := h.Call(ctx, "GET", hooksPath(m, repo)+"/"+esc(hook)+"/deliveries", nil, nil, out)
	out.JSON = data
	return out, err
}

// Redeliver sends one delivery again (owners).
func (h *HTTP) Redeliver(ctx context.Context, m, repo, delivery string) (*Delivery, error) {
	out := &Delivery{}
	data, err := h.Call(ctx, "POST", hooksPath(m, repo)+"/deliveries/"+esc(delivery)+"/redeliver", nil, nil, out)
	out.JSON = data
	return out, err
}

// Replay sends again every delivery of a hook after seq since (owners).
func (h *HTTP) Replay(ctx context.Context, m, repo, hook string, since int64) (*Replayed, error) {
	out := &Replayed{}
	q := url.Values{"since": {strconv.FormatInt(since, 10)}}
	data, err := h.Call(ctx, "POST", hooksPath(m, repo)+"/"+esc(hook)+"/redeliver", q, nil, out)
	out.JSON = data
	return out, err
}
