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
	"strings"
)

type Monorepo struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"` // "monorepo" or "repo"
	CreatedAt string `json:"created_at"`
}

type Repo struct {
	Monorepo       string   `json:"monorepo"`
	Name           string   `json:"name"`
	Path           string   `json:"path"`
	DefaultBranch  string   `json:"default_branch"`
	CloneURL       string   `json:"clone_url"`
	RequiredChecks []string `json:"required_checks,omitempty"`
}

type NewToken struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Role  string `json:"role"`
	Token string `json:"token"` // the secret; stored at mode 600, never printed
}

// Created is the answer to createMonorepo.
type Created struct {
	Monorepo Monorepo `json:"monorepo"`
	Token    NewToken `json:"token"`
	Repos    []Repo   `json:"repos"`
}

type Identity struct {
	Monorepo string `json:"monorepo"`
	Name     string `json:"name"`
	Role     string `json:"role"` // "person" or "agent"
	Email    string `json:"email"`
	TokenID  string `json:"token_id"`
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
	AuthorRole  string `json:"author_role"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Ahead       *int   `json:"ahead"`
	Behind      *int   `json:"behind"`
	Mergeable   string `json:"mergeable"`
	Checks      Checks `json:"checks"`
	State       string `json:"state"`
	MergeCommit string `json:"merge_commit"`
	UpdatedAt   string `json:"updated_at"`
}

type BranchList struct {
	DefaultBranch string   `json:"default_branch"`
	DefaultHead   string   `json:"default_head"`
	Branches      []Branch `json:"branches"`
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
	ID         string `json:"id"`
	Branch     string `json:"branch"`
	Head       string `json:"head"`
	Verdict    string `json:"verdict"`
	Body       string `json:"body"`
	Author     string `json:"author"`
	AuthorRole string `json:"author_role"`
	CreatedAt  string `json:"created_at"`
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
	// CreateMonorepo uses the bootstrap secret, not a token.
	CreateMonorepo(ctx context.Context, bootstrap, name, kind, person, email string) (*Created, error)
	GetMonorepo(ctx context.Context, mono string) (*Monorepo, error)
	Me(ctx context.Context, mono string) (*Identity, error)

	ListRepos(ctx context.Context, mono string) ([]Repo, error)
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
		return mono
	}
	return strings.ReplaceAll(path, "/", "-")
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

// Open picks the backend from the server URL. token may be empty for file://.
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
