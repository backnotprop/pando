package server

import (
	"context"
	"net/url"
	"strconv"
)

// ── Releases (research/plans/releases-2026-10-04): a project's tags and releases ──

// Release is a tag on a project's main with a title, notes and files.
type Release struct {
	Repo        string  `json:"repo"`
	Tag         string  `json:"tag"`
	SHA         string  `json:"sha"`
	Title       string  `json:"title"`
	Notes       string  `json:"notes"`
	Draft       bool    `json:"draft"`
	Forced      bool    `json:"forced"`
	CreatedBy   string  `json:"created_by"`
	CreatedAt   string  `json:"created_at"`
	PublishedBy *string `json:"published_by"`
	PublishedAt *string `json:"published_at"`
	Checks      *Checks `json:"checks"`
	JSON        []byte  `json:"-"`
}

type ReleaseList struct {
	Releases   []Release `json:"releases"`
	NextCursor *string   `json:"next_cursor"`
	JSON       []byte    `json:"-"`
}

// ReleaseIn is a new release. Target is a commit on main, or "" for main
// (or the tag's commit when the tag exists).
type ReleaseIn struct {
	Tag           string `json:"tag"`
	Target        string `json:"target,omitempty"`
	Title         string `json:"title,omitempty"`
	Notes         string `json:"notes,omitempty"`
	GenerateNotes bool   `json:"generate_notes,omitempty"`
	Draft         bool   `json:"draft"`
	Force         bool   `json:"force,omitempty"`
}

func releasesPath(m, repo string) string { return repoPath(m, repo) + "/releases" }

func releasePath(m, repo, tag string) string { return releasesPath(m, repo) + "/" + esc(tag) }

func (h *HTTP) ListReleases(ctx context.Context, m, repo string, limit int) (*ReleaseList, error) {
	out := &ReleaseList{}
	data, err := h.Call(ctx, "GET", releasesPath(m, repo), url.Values{"limit": {strconv.Itoa(limit)}}, nil, out)
	out.JSON = data
	return out, err
}

// GetRelease reads one release; tag "latest" is the newest published one.
func (h *HTTP) GetRelease(ctx context.Context, m, repo, tag string) (*Release, error) {
	out := &Release{}
	data, err := h.Call(ctx, "GET", releasePath(m, repo, tag), nil, nil, out)
	out.JSON = data
	return out, err
}

func (h *HTTP) CreateRelease(ctx context.Context, m, repo string, in ReleaseIn) (*Release, error) {
	out := &Release{}
	data, err := h.Call(ctx, "POST", releasesPath(m, repo), nil, in, out)
	out.JSON = data
	return out, err
}

// PublishRelease publishes a draft: refused (412 checks_not_green) when its
// commit's required checks are red or missing, unless force.
func (h *HTTP) PublishRelease(ctx context.Context, m, repo, tag string, force bool) (*Release, error) {
	out := &Release{}
	data, err := h.Call(ctx, "POST", releasePath(m, repo, tag)+"/publish", nil, map[string]bool{"force": force}, out)
	out.JSON = data
	return out, err
}

// DeleteRelease deletes a release and its files; its tag stays.
func (h *HTTP) DeleteRelease(ctx context.Context, m, repo, tag string) error {
	_, err := h.Call(ctx, "DELETE", releasePath(m, repo, tag), nil, nil, nil)
	return err
}
