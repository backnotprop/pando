package server

import (
	"context"
	"net/url"
)

// ── Organizations (the orgs tag in api-v1.yaml; packages/contract/src/org.ts) ──
// An org is a namespace like a person's login: its monorepos are org/name.
// Every member of it can open and push to all of them; its owners own them.

// Org is an organization's header. Role is the caller's ("" when not in
// it); Members is how many people are in it (nil for someone outside).
type Org struct {
	Login       string `json:"login"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Website     string `json:"website"`
	CreatedAt   string `json:"created_at"`
	Role        string `json:"role"`
	Members     *int   `json:"members"`
	JSON        []byte `json:"-"` // the answer as sent: what --json prints
}

type OrgList struct {
	Orgs []Org  `json:"orgs"`
	JSON []byte `json:"-"`
}

type OrgMember struct {
	Login        string `json:"login"`
	Name         string `json:"name"`
	Role         string `json:"role"`
	AddedAt      string `json:"added_at"`
	AddedBy      string `json:"added_by"`
	LastActiveAt string `json:"last_active_at"`
	JSON         []byte `json:"-"`
}

type OrgMemberList struct {
	Members []OrgMember `json:"members"`
	JSON    []byte      `json:"-"`
}

// OrgAdded is the answer to adding someone by email: "added" (they have
// signed in with it before) or "invited" (waiting for that first sign-in).
type OrgAdded struct {
	Status string     `json:"status"`
	Member *OrgMember `json:"member"`
	Invite *Invite    `json:"invite"`
	JSON   []byte     `json:"-"`
}

func orgPath(org string) string { return "/v1/orgs/" + esc(org) }

// CreateOrg makes an organization; the caller is its first owner. name is
// its display name ("" for none).
func (h *HTTP) CreateOrg(ctx context.Context, login, name string) (*Org, error) {
	body := map[string]string{"login": login}
	if name != "" {
		body["name"] = name
	}
	out := &Org{}
	data, err := h.Call(ctx, "POST", "/v1/orgs", nil, body, out)
	out.JSON = data
	return out, err
}

func (h *HTTP) GetOrg(ctx context.Context, org string) (*Org, error) {
	out := &Org{}
	data, err := h.Call(ctx, "GET", orgPath(org), nil, nil, out)
	out.JSON = data
	return out, err
}

// MyOrgs is the organizations the caller is in, with their role in each.
func (h *HTTP) MyOrgs(ctx context.Context) (*OrgList, error) {
	out := &OrgList{}
	data, err := h.Call(ctx, "GET", "/v1/user/orgs", nil, nil, out)
	out.JSON = data
	return out, err
}

func (h *HTTP) OrgMembers(ctx context.Context, org string) (*OrgMemberList, error) {
	out := &OrgMemberList{}
	data, err := h.Call(ctx, "GET", orgPath(org)+"/members", nil, nil, out)
	out.JSON = data
	return out, err
}

func (h *HTTP) OrgInvites(ctx context.Context, org string) ([]Invite, error) {
	var out struct {
		Invites []Invite `json:"invites"`
	}
	_, err := h.Call(ctx, "GET", orgPath(org)+"/invites", nil, nil, &out)
	return out.Invites, err
}

// PutOrgMember adds a person by login, or changes their role (owners).
func (h *HTTP) PutOrgMember(ctx context.Context, org, login, role string) (*OrgMember, error) {
	out := &OrgMember{}
	data, err := h.Call(ctx, "PUT", orgPath(org)+"/members/"+esc(login), nil, map[string]string{"role": role}, out)
	out.JSON = data
	return out, err
}

// RemoveOrgMember takes a person out (owners), or the caller leaves.
func (h *HTTP) RemoveOrgMember(ctx context.Context, org, login string) error {
	_, err := h.Call(ctx, "DELETE", orgPath(org)+"/members/"+esc(login), nil, nil, nil)
	return err
}

// InviteToOrg adds a person by email: now if they have signed in with it,
// else at that first sign-in (owners).
func (h *HTTP) InviteToOrg(ctx context.Context, org, email, role string) (*OrgAdded, error) {
	out := &OrgAdded{}
	data, err := h.Call(ctx, "POST", orgPath(org)+"/invites", nil, map[string]string{"email": email, "role": role}, out)
	out.JSON = data
	return out, err
}

func (h *HTTP) RevokeOrgInvite(ctx context.Context, org, email string) error {
	_, err := h.Call(ctx, "DELETE", orgPath(org)+"/invites/"+esc(email), nil, nil, nil)
	return err
}

// TransferMonorepo moves a monorepo to another owner: an org the caller is
// in, or a person who already owns it directly. The old owner/name keeps
// leading to it.
func (h *HTTP) TransferMonorepo(ctx context.Context, m, owner string) (*Monorepo, error) {
	out := &Monorepo{}
	data, err := h.Call(ctx, "PATCH", monoPath(m), nil, map[string]string{"owner": owner}, out)
	out.JSON = data
	return out, err
}

// OwnerMonorepos is the caller's monorepos under one owner (an org or a person).
func (h *HTTP) OwnerMonorepos(ctx context.Context, owner string) ([]Monorepo, error) {
	var out struct {
		Monorepos []Monorepo `json:"monorepos"`
	}
	_, err := h.Call(ctx, "GET", "/v1/monorepos", url.Values{"owner": {owner}}, nil, &out)
	return out.Monorepos, err
}
