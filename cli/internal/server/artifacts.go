package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Artifacts: documents uploaded to a branch's page (the pull request), and
// their comments (packages/contract/src/artifact.ts).

// ArtifactFile is one file of a version, kept by its path from the document.
type ArtifactFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Type   string `json:"type"`
}

// ArtifactVersion is one upload of an artifact.
type ArtifactVersion struct {
	N          int            `json:"n"`
	Size       int64          `json:"size"`
	SHA256     string         `json:"sha256"`
	Files      []ArtifactFile `json:"files"`
	UploadedBy string         `json:"uploaded_by"`
	Machine    *string        `json:"machine"`
	Via        string         `json:"via"`
	CreatedAt  string         `json:"created_at"`
}

// ArtifactCounts are open and resolved threads.
type ArtifactCounts struct {
	Open     int `json:"open"`
	Resolved int `json:"resolved"`
}

// Artifact is one artifact with its newest version; AllVersions only from
// GetArtifact.
type Artifact struct {
	ID          string            `json:"id"`
	Repo        string            `json:"repo"`
	Branch      string            `json:"branch"`
	Name        string            `json:"name"`
	Kind        string            `json:"kind"`
	Title       *string           `json:"title"`
	Latest      ArtifactVersion   `json:"latest"`
	Versions    int               `json:"versions"`
	Comments    ArtifactCounts    `json:"comments"`
	CreatedBy   string            `json:"created_by"`
	UpdatedAt   string            `json:"updated_at"`
	AllVersions []ArtifactVersion `json:"all_versions,omitempty"`
	JSON        []byte            `json:"-"`
	// Created is a new artifact (201), not its next version.
	Created bool `json:"-"`
}

// ArtifactList is a branch's artifacts, newest first.
type ArtifactList struct {
	Branch    string     `json:"branch"`
	Artifacts []Artifact `json:"artifacts"`
	JSON      []byte     `json:"-"`
}

// ArtifactComment is one comment: a thread's root or a reply.
type ArtifactComment struct {
	ID         string          `json:"id"`
	Artifact   string          `json:"artifact"`
	Version    int             `json:"version"`
	Thread     string          `json:"thread"`
	InReplyTo  *string         `json:"in_reply_to"`
	Anchor     json.RawMessage `json:"anchor"`
	Body       *string         `json:"body"`
	Author     string          `json:"author"`
	Machine    *string         `json:"machine"`
	Mentions   []string        `json:"mentions"`
	State      string          `json:"state"`
	ResolvedBy *string         `json:"resolved_by"`
	CreatedAt  string          `json:"created_at"`
	JSON       []byte          `json:"-"`
	Replayed   bool            `json:"-"`
}

// Quote is the words a comment is on (its anchor's originalText), or "".
func (c ArtifactComment) Quote() string {
	var a struct {
		OriginalText string `json:"originalText"`
	}
	_ = json.Unmarshal(c.Anchor, &a)
	return a.OriginalText
}

// ArtifactThread is a root and its replies.
type ArtifactThread struct {
	ArtifactComment
	Replies []ArtifactComment `json:"replies"`
}

// ArtifactThreads are threads oldest first, and the counts of all.
type ArtifactThreads struct {
	Threads []ArtifactThread `json:"threads"`
	Counts  ArtifactCounts   `json:"counts"`
	JSON    []byte           `json:"-"`
}

// ArtifactUpload is one file to send: its path (the document's name, or an
// image's path from the document) and its bytes.
type ArtifactUpload struct {
	Path  string
	Bytes []byte
}

func artifactPath(m, id string) string { return monoPath(m) + "/artifacts/" + esc(id) }

func artifactCommentPath(m, id string) string { return monoPath(m) + "/artifact-comments/" + esc(id) }

// ListArtifacts is the branch's artifacts.
func (h *HTTP) ListArtifacts(ctx context.Context, m, repo, branch string) (*ArtifactList, error) {
	out := &ArtifactList{}
	data, err := h.Call(ctx, "GET", branchPath(m, repo, branch)+"/artifacts", nil, nil, out)
	out.JSON = data
	return out, err
}

// AddArtifact uploads one artifact (the document or image, then the images
// it uses) as one multipart request. The same name again is its next version.
func (h *HTTP) AddArtifact(ctx context.Context, m, repo, branch string, main ArtifactUpload, images []ArtifactUpload) (*Artifact, error) {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	put := func(field string, f ArtifactUpload) error {
		part, err := w.CreateFormFile(field, f.Path)
		if err != nil {
			return err
		}
		_, err = part.Write(f.Bytes)
		return err
	}
	if err := put("file", main); err != nil {
		return nil, err
	}
	for _, img := range images {
		if err := put("image", img); err != nil {
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	p := branchPath(m, repo, branch) + "/artifacts"
	req, err := http.NewRequestWithContext(ctx, "POST", h.Base+p, bytes.NewReader(body.Bytes()))
	if err != nil {
		return nil, err
	}
	req.ContentLength = int64(body.Len())
	req.Header.Set("Content-Type", w.FormDataContentType())
	resp, data, err := h.send(req)
	if err != nil {
		return nil, err
	}
	out := &Artifact{JSON: data, Created: resp.StatusCode == http.StatusCreated}
	if err := json.Unmarshal(data, out); err != nil {
		return nil, fmt.Errorf("POST %s: bad JSON from server (HTTP %d): %w", p, resp.StatusCode, err)
	}
	return out, nil
}

// GetArtifact is one artifact with every version.
func (h *HTTP) GetArtifact(ctx context.Context, m, id string) (*Artifact, error) {
	out := &Artifact{}
	data, err := h.Call(ctx, "GET", artifactPath(m, id), nil, nil, out)
	out.JSON = data
	return out, err
}

// DeleteArtifact deletes one, every version and its comments.
func (h *HTTP) DeleteArtifact(ctx context.Context, m, id string) error {
	_, err := h.Call(ctx, "DELETE", artifactPath(m, id), nil, nil, nil)
	return err
}

// ArtifactFileBytes reads one file of a version (at most 10 MiB, the
// artifact limit).
func (h *HTTP) ArtifactFileBytes(ctx context.Context, m, id string, n int, path string) ([]byte, error) {
	parts := strings.Split(path, "/")
	for i, p := range parts {
		parts[i] = esc(p)
	}
	req, err := http.NewRequestWithContext(ctx, "GET", h.Base+artifactPath(m, id)+"/versions/"+strconv.Itoa(n)+"/files/"+strings.Join(parts, "/"), nil)
	if err != nil {
		return nil, err
	}
	_, data, err := h.send(req)
	return data, err
}

// ArtifactThreads is an artifact's threads; state "open", "resolved" or "all".
func (h *HTTP) ArtifactThreads(ctx context.Context, m, id, state string) (*ArtifactThreads, error) {
	out := &ArtifactThreads{}
	data, err := h.Call(ctx, "GET", artifactPath(m, id)+"/comments", url.Values{"state": {state}}, nil, out)
	out.JSON = data
	return out, err
}

// BranchArtifactThreads is every artifact's threads on a branch.
func (h *HTTP) BranchArtifactThreads(ctx context.Context, m, repo, branch, state string) (*ArtifactThreads, error) {
	out := &ArtifactThreads{}
	data, err := h.Call(ctx, "GET", branchPath(m, repo, branch)+"/artifact-comments", url.Values{"state": {state}}, nil, out)
	out.JSON = data
	return out, err
}

// ArtifactCommentIn is a new thread (Quote, or neither: the whole artifact)
// or a reply (InReplyTo).
type ArtifactCommentIn struct {
	Body      string `json:"body"`
	Quote     string `json:"quote,omitempty"`
	InReplyTo string `json:"in_reply_to,omitempty"`
}

// AddArtifactComment posts a thread or a reply, once per key.
func (h *HTTP) AddArtifactComment(ctx context.Context, m, id string, in ArtifactCommentIn, key string) (*ArtifactComment, error) {
	out := &ArtifactComment{}
	data, replayed, err := h.keyed(ctx, artifactPath(m, id)+"/comments", in, key, out)
	out.JSON, out.Replayed = data, replayed
	return out, err
}

// GetArtifactComment is one comment.
func (h *HTTP) GetArtifactComment(ctx context.Context, m, id string) (*ArtifactComment, error) {
	out := &ArtifactComment{}
	data, err := h.Call(ctx, "GET", artifactCommentPath(m, id), nil, nil, out)
	out.JSON = data
	return out, err
}

// SetArtifactThreadState resolves or reopens the thread a comment is in;
// answers the thread's root.
func (h *HTTP) SetArtifactThreadState(ctx context.Context, m, id, state string) (*ArtifactComment, error) {
	out := &ArtifactComment{}
	data, err := h.Call(ctx, "PATCH", artifactCommentPath(m, id), nil, map[string]string{"state": state}, out)
	out.JSON = data
	return out, err
}
