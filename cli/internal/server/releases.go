package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

// ── Releases (research/plans/releases-2026-10-04): a project's tags and releases ──

// Release is a tag on a project's main with a title, notes and files.
type Release struct {
	Repo        string        `json:"repo"`
	Tag         string        `json:"tag"`
	SHA         string        `json:"sha"`
	Title       string        `json:"title"`
	Notes       string        `json:"notes"`
	Draft       bool          `json:"draft"`
	Forced      bool          `json:"forced"`
	CreatedBy   string        `json:"created_by"`
	CreatedAt   string        `json:"created_at"`
	PublishedBy *string       `json:"published_by"`
	PublishedAt *string       `json:"published_at"`
	Files       []ReleaseFile `json:"files"`
	Checks      *Checks       `json:"checks"`
	JSON        []byte        `json:"-"`
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

// ReleaseFile is one file of a release; its bytes are kept by Pando (R2).
type ReleaseFile struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"content_type"`
	UploadedBy  string `json:"uploaded_by"`
	UploadedAt  string `json:"uploaded_at"`
}

func releaseFilePath(m, repo, tag, name string) string {
	return releasePath(m, repo, tag) + "/files/" + esc(name)
}

// UploadReleaseFile sends one file, streamed, with its size and SHA-256
// (the server computes it again and refuses a mismatch). A name uploaded
// again replaces the file. Answers the release.
func (h *HTTP) UploadReleaseFile(ctx context.Context, m, repo, tag, name string, body io.Reader, size int64, sha256hex string) (*Release, error) {
	req, err := http.NewRequestWithContext(ctx, "PUT", h.Base+releaseFilePath(m, repo, tag, name), body)
	if err != nil {
		return nil, err
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Pando-Sha256", sha256hex)
	resp, data, err := h.send(req)
	if err != nil {
		return nil, err
	}
	out := &Release{JSON: data}
	if err := json.Unmarshal(data, out); err != nil {
		return nil, fmt.Errorf("PUT %s: bad JSON from server (HTTP %d): %w", releaseFilePath(m, repo, tag, name), resp.StatusCode, err)
	}
	return out, nil
}

// DownloadReleaseFile writes one file's bytes to w as they arrive, and
// answers the SHA-256 the server recorded for it. Tag "latest" is the newest
// published release.
func (h *HTTP) DownloadReleaseFile(ctx context.Context, m, repo, tag, name string, w io.Writer) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", h.Base+releaseFilePath(m, repo, tag, name), nil)
	if err != nil {
		return "", err
	}
	h.authorize(req)
	resp, err := h.streaming().Do(req)
	if err != nil {
		return "", fmt.Errorf("GET %s: %w", h.Base+releaseFilePath(m, repo, tag, name), unwrapURLError(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return "", decodeError(resp.StatusCode, data)
	}
	if _, err := io.Copy(w, resp.Body); err != nil {
		return "", err
	}
	return resp.Header.Get("X-Pando-Sha256"), nil
}

// DeleteReleaseFile deletes one file of a release.
func (h *HTTP) DeleteReleaseFile(ctx context.Context, m, repo, tag, name string) error {
	_, err := h.Call(ctx, "DELETE", releaseFilePath(m, repo, tag, name), nil, nil, nil)
	return err
}
