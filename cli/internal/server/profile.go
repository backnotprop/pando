package server

import (
	"context"
	"net/url"
	"strconv"
)

// ── Profiles (GET /v1/users/{login} and its /contributions;
// packages/contract/src/org.ts Profile and profile.ts Contributions) ──
// A viewer sees only the work in repositories they can open.

// Profile is a person's profile header.
type Profile struct {
	Type      string   `json:"type"`
	Login     string   `json:"login"`
	Name      string   `json:"name"`
	Bio       string   `json:"bio"`
	Location  string   `json:"location"`
	Links     []string `json:"links"`
	CreatedAt string   `json:"created_at"`
	Orgs      []struct {
		Login string `json:"login"`
		Name  string `json:"name"`
	} `json:"orgs"`
}

// RepoCount is a count in one repository.
type RepoCount struct {
	FullName string `json:"full_name"`
	N        int    `json:"n"`
}

// Period is a month ("2026-10") of a person's timeline.
type Period struct {
	Period  string      `json:"period"`
	Commit  []RepoCount `json:"commit"`
	Branch  []RepoCount `json:"branch"`
	Review  []RepoCount `json:"review"`
	Created []struct {
		FullName string `json:"full_name"`
		At       string `json:"at"`
	} `json:"created"`
	Joined []struct {
		Org     string `json:"org"`
		At      string `json:"at"`
		Created bool   `json:"created"`
	} `json:"joined"`
}

// Contributions is a person's graph and timeline for the last year.
type Contributions struct {
	Login  string `json:"login"`
	From   string `json:"from"`
	To     string `json:"to"`
	Total  int    `json:"total"`
	Levels []int  `json:"levels"`
	Days   []struct {
		Date string `json:"date"`
		N    int    `json:"n"`
	} `json:"days"`
	Months []Period `json:"months"`
	JSON   []byte   `json:"-"` // the answer as sent: what --json prints
}

// Owner is whose /{name} is: a person (Type "user") or an org ("org").
func (h *HTTP) Owner(ctx context.Context, name string) (*Profile, error) {
	out := &Profile{}
	_, err := h.Call(ctx, "GET", "/v1/users/"+esc(name), nil, nil, out)
	return out, err
}

// Contributions is a person's last year as the caller may see it; tz is
// the caller's minutes east of UTC (days are counted in it).
func (h *HTTP) Contributions(ctx context.Context, login string, tz int) (*Contributions, error) {
	out := &Contributions{}
	data, err := h.Call(ctx, "GET", "/v1/users/"+esc(login)+"/contributions", url.Values{"tz": {strconv.Itoa(tz)}}, nil, out)
	out.JSON = data
	return out, err
}
