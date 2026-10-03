// Package server is the CLI's view of a Pando server: the /v1 API in
// docs/contracts/api-v1.yaml. Types follow that file's JSON.
//
// A file:// server (local.go) is a folder of bare git repos that answers the
// same calls with real git. It exists for tests and the Linux test bed, and
// is never what a person uses.
package server

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// Monorepo is named owner/name, like a GitHub repo; ID is permanent
// (a rename or transfer changes the name, never the id).
type Monorepo struct {
	ID        string `json:"id"`
	Owner     string `json:"owner"`
	Name      string `json:"name"`
	FullName  string `json:"full_name"` // owner/name
	Kind      string `json:"kind"`      // "monorepo" or "repo"
	Role      string `json:"role"`      // the caller's: "owner" or "member"
	CreatedAt string `json:"created_at"`
}

// Full is owner/name (from full_name, or built when the server left it out).
func (m Monorepo) Full() string {
	switch {
	case m.FullName != "":
		return m.FullName
	case m.Owner != "":
		return m.Owner + "/" + m.Name
	}
	return m.Name
}

// ReplacedAlias says a create or rename took a name an old monorepo name
// had pointed to: that old name no longer leads where it did.
type ReplacedAlias struct {
	FullName  string `json:"full_name"`
	PointedTo string `json:"pointed_to"`
}

type Repo struct {
	Monorepo       string   `json:"monorepo"`
	Name           string   `json:"name"`
	Path           string   `json:"path"`
	DefaultBranch  string   `json:"default_branch"`
	CloneURL       string   `json:"clone_url"`
	RequiredChecks []string `json:"required_checks,omitempty"`
}

// Created is the answer to createMonorepo.
type Created struct {
	Monorepo      Monorepo       `json:"monorepo"`
	Repos         []Repo         `json:"repos"`
	ReplacedAlias *ReplacedAlias `json:"replaced_alias"`
}

type User struct {
	Login     string `json:"login"`
	Name      string `json:"name"`
	Email     string `json:"email"`
	CreatedAt string `json:"created_at"`
}

type Credential struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Kind       string `json:"kind"` // machine, sandbox, bootstrap
	CreatedAt  string `json:"created_at"`
	LastUsedAt string `json:"last_used_at"`
	// Secret is set only when a credential is made. It is stored at mode
	// 600 and never printed.
	Secret string `json:"secret,omitempty"`
}

type Member struct {
	Login   string `json:"login"`
	Role    string `json:"role"` // owner or member
	AddedAt string `json:"added_at"`
	AddedBy string `json:"added_by"`
}

type Invite struct {
	Email     string `json:"email"`
	Role      string `json:"role"`
	InvitedBy string `json:"invited_by"`
	CreatedAt string `json:"created_at"`
}

// InviteResult is the answer to an invite: "added" (that email has signed
// in before) or "invited" (waiting for that email's first sign-in).
type InviteResult struct {
	Status string  `json:"status"`
	Member *Member `json:"member"`
	Invite *Invite `json:"invite"`
}

// Head is one repo's main, from GET /v1/monorepos/{m}/heads.
type Head struct {
	Repo          string `json:"repo"` // the repo's URL name
	Path          string `json:"path"`
	DefaultBranch string `json:"default_branch"`
	Head          string `json:"head"` // "" for an empty repo
	UpdatedAt     string `json:"updated_at"`
}

// Heads is every code repo's main and the event stream's newest seq.
type Heads struct {
	Heads []Head `json:"heads"`
	Seq   *int64 `json:"seq"` // nil when the stream is off
}

// Me is GET /v1/user: the user and the credential in use.
type Me struct {
	User
	Credential Credential `json:"credential"`
}

// NewUser is the answer to createUser.
type NewUser struct {
	User       User       `json:"user"`
	Credential Credential `json:"credential"`
}

type Status struct {
	SHA         string `json:"sha"`
	Context     string `json:"context"`
	State       string `json:"state"`
	TargetURL   string `json:"target_url"`
	Description string `json:"description"`
}

type Checks struct {
	SHA      string   `json:"sha"`
	State    string   `json:"state"`
	Required []string `json:"required"`
	Missing  []string `json:"missing"`
	Statuses []Status `json:"statuses"`
}

type Branch struct {
	Name        string `json:"name"`
	Head        string `json:"head"`
	Base        string `json:"base"`
	Author      string `json:"author"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Ahead       *int   `json:"ahead"`
	Behind      *int   `json:"behind"`
	Mergeable   string `json:"mergeable"` // clean, conflicts, up_to_date, unknown, pending
	// Stale: ahead, behind, base and mergeable are not yet for the current
	// main and head (the server computes them on change); LastMergeable is
	// the last known answer meanwhile.
	Stale         bool   `json:"stale"`
	LastMergeable string `json:"last_mergeable"`
	Checks        Checks `json:"checks"`
	State         string `json:"state"`
	MergeCommit   string `json:"merge_commit"`
	UpdatedAt     string `json:"updated_at"`
}

type BranchList struct {
	DefaultBranch string   `json:"default_branch"`
	DefaultHead   string   `json:"default_head"`
	Branches      []Branch `json:"branches"`
	NextCursor    string   `json:"next_cursor"`
}

type ReviewComment struct {
	Path string `json:"path"`
	Line int    `json:"line,omitempty"`
	Side string `json:"side,omitempty"`
	Body string `json:"body"`
}

// ReviewIn is the body of createReview.
type ReviewIn struct {
	Verdict  string          `json:"verdict"` // comment, request_changes, approve
	Body     string          `json:"body,omitempty"`
	Head     string          `json:"head,omitempty"`
	Comments []ReviewComment `json:"comments,omitempty"`
}

type Review struct {
	ID        string `json:"id"`
	Branch    string `json:"branch"`
	Head      string `json:"head"`
	Verdict   string `json:"verdict"`
	Body      string `json:"body"`
	Author    string `json:"author"`
	CreatedAt string `json:"created_at"`
}

type MergeResult struct {
	Status     string `json:"status"` // merged, up_to_date
	Branch     string `json:"branch"`
	Head       string `json:"head"`
	SHA        string `json:"sha"`
	BaseBefore string `json:"base_before"`
	MergeBase  string `json:"merge_base"`
	Forced     bool   `json:"forced"`
	MergedBy   string `json:"merged_by"`
}

// WorktreeIn is the body of putWorktree.
type WorktreeIn struct {
	Repo    string  `json:"repo"`
	Branch  string  `json:"branch"`
	Path    string  `json:"path"`
	Machine string  `json:"machine"`
	Agent   *string `json:"agent"`
	Kind    string  `json:"kind"` // fuse, sparse, fskit
}

type Worktree struct {
	ID         string `json:"id"`
	Repo       string `json:"repo"`
	Branch     string `json:"branch"`
	Path       string `json:"path"`
	Machine    string `json:"machine"`
	Agent      string `json:"agent"`
	Kind       string `json:"kind"`
	ReportedBy string `json:"reported_by"`
	CreatedAt  string `json:"created_at"`
	LastSeenAt string `json:"last_seen_at"`
}

// DiffFormat is how a branch diff comes back.
type DiffFormat string

const (
	DiffJSON  DiffFormat = "json"
	DiffPatch DiffFormat = "patch"
)

// Server is everything the CLI asks of a Pando server. Repos are named by
// their URL name (RepoName), monorepos by their name.
type Server interface {
	// CreateUser uses the bootstrap secret, until sign-in exists.
	CreateUser(ctx context.Context, bootstrap, login, name, email, credentialName string) (*NewUser, error)
	Me(ctx context.Context) (*Me, error)
	CreateCredential(ctx context.Context, name, kind string) (*Credential, error)
	ListCredentials(ctx context.Context) ([]Credential, error)
	RevokeCredential(ctx context.Context, id string) error

	CreateMonorepo(ctx context.Context, name, kind string) (*Created, error)
	// ListMonorepos lists the caller's monorepos; with a name, only those
	// named so (any owner), the caller's own namespace first.
	ListMonorepos(ctx context.Context, name string) ([]Monorepo, error)
	GetMonorepo(ctx context.Context, mono string) (*Monorepo, error)
	// DeleteMonorepo deletes it, its repos and their history (owners).
	DeleteMonorepo(ctx context.Context, mono string) error

	ListMembers(ctx context.Context, mono string) ([]Member, error)
	RemoveMember(ctx context.Context, mono, login string) error
	Invite(ctx context.Context, mono, email, role string) (*InviteResult, error)
	ListInvites(ctx context.Context, mono string) ([]Invite, error)
	RevokeInvite(ctx context.Context, mono, email string) error

	ListRepos(ctx context.Context, mono string) ([]Repo, error)
	// Heads is every repo's main, for followers (no Artifacts read).
	Heads(ctx context.Context, mono string) (*Heads, error)
	GetRepo(ctx context.Context, mono, repo string) (*Repo, error)
	CreateRepo(ctx context.Context, mono, path string) (*Repo, error)

	ListBranches(ctx context.Context, mono, repo, state string) (*BranchList, error)
	GetBranch(ctx context.Context, mono, repo, branch string) (*Branch, error)
	// CreateBranch makes branch off main. created is false if it existed.
	CreateBranch(ctx context.Context, mono, repo, branch string) (created bool, err error)
	// Diff returns the branch diff; omitted counts files left out of a patch.
	Diff(ctx context.Context, mono, repo, branch string, format DiffFormat, paths []string) (body []byte, omitted int, err error)
	CreateReview(ctx context.Context, mono, repo, branch string, r ReviewIn) (*Review, error)
	Merge(ctx context.Context, mono, repo, branch string, force bool, expectedHead string) (*MergeResult, error)

	PutWorktree(ctx context.Context, mono, id string, w WorktreeIn) error
	ListWorktrees(ctx context.Context, mono string) ([]Worktree, error)
	DeleteWorktree(ctx context.Context, mono, id string) error
}

// RepoName is a repo's id in URLs: its path with each "/" turned into "-".
// A plain repo (path ".") is named after its monorepo.
func RepoName(mono, path string) string {
	if path == "." || path == "" {
		return mono[strings.LastIndexByte(mono, '/')+1:] // the monorepo's name, without its owner
	}
	return strings.ReplaceAll(path, "/", "-")
}

// MonorepoPath is a monorepo's API path, /v1/monorepos/<owner>/<name>, for
// a full name owner/name. Every monorepo URL the cli builds starts here
// (the API, the event socket, the meta layer's routes and socket). Git
// URLs come from the server's clone_url, never built.
func MonorepoPath(full string) string {
	parts := strings.Split(full, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return "/v1/monorepos/" + strings.Join(parts, "/")
}

// APIError is a non-2xx answer: {"error": {"code", "message", ...}}.
type APIError struct {
	Status  int
	Code    string
	Message string
	Paths   []string
	Checks  *Checks
}

func (e *APIError) Error() string {
	switch {
	case e.Message != "" && e.Code != "":
		return fmt.Sprintf("%s (%s, HTTP %d)", e.Message, e.Code, e.Status)
	case e.Message != "":
		return fmt.Sprintf("%s (HTTP %d)", e.Message, e.Status)
	}
	return fmt.Sprintf("server answered HTTP %d", e.Status)
}

// Is lets errors.Is(err, ErrNotFound) match a 404.
func (e *APIError) Is(target error) bool { return target == ErrNotFound && e.Status == 404 }

// ErrNotFound is a missing monorepo, repo, branch or worktree.
var ErrNotFound = errors.New("not found")

// Code returns the API error code of err, or "".
func Code(err error) string {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae.Code
	}
	return ""
}

// StatusOf returns the HTTP status of err, or 0.
func StatusOf(err error) int {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae.Status
	}
	return 0
}

// Open picks the backend from the server URL. The credential may be empty
// for file://.
func Open(url, token string) (Server, error) {
	switch {
	case url == "":
		return nil, errors.New("no Pando server: pass --server, set PANDO_SERVER, or run `pando login --server <url>`")
	case strings.HasPrefix(url, "file://"):
		return &Local{Base: strings.TrimPrefix(url, "file://")}, nil
	case strings.HasPrefix(url, "https://"), strings.HasPrefix(url, "http://"):
		return NewHTTP(url, token), nil
	}
	return nil, fmt.Errorf("unsupported server URL %q (want https:// or file://)", url)
}
