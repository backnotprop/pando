package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
)

// SessionStart is the Pando-Session header: what the machine knows of a session without reading it.
type SessionStart struct {
	Program string  `json:"program"`
	AgentID string  `json:"agent_id"`
	Repo    *string `json:"repo"`
	Branch  *string `json:"branch"`
	Parent  *string `json:"parent"`
}

// SessionView is the part of a session the machine and `pando session` read.
type SessionView struct {
	ID        string `json:"id"`
	State     string `json:"state"`
	Person    string `json:"person"`
	Machine   string `json:"machine"`
	Program   string `json:"program"`
	Repo      string `json:"repo"`
	Branch    string `json:"branch"`
	Prompts   int    `json:"prompts"`
	ToolCalls int    `json:"tool_calls"`
	LastAt    string `json:"last_at"`
	End       int64  `json:"end"`
	DeletedBy string `json:"deleted_by"`
	DeletedAt string `json:"deleted_at"`
}

// NotAtEnd is the server's 409 for a piece that does not start at the session's end: resume from End.
type NotAtEnd struct{ End int64 }

func (e NotAtEnd) Error() string { return "the session ends at " + strconv.FormatInt(e.End, 10) }

func sessionPath(m, id string) string { return monoPath(m) + "/sessions/" + esc(id) }

// AppendSessionPiece sends whole lines, gzipped, at the session's end. A 409 comes back as NotAtEnd.
func (h *HTTP) AppendSessionPiece(ctx context.Context, m, id string, at, next int64, start SessionStart, lines []byte) (*SessionView, error) {
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	if _, err := w.Write(lines); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	head, err := json.Marshal(start)
	if err != nil {
		return nil, err
	}
	hdr := http.Header{}
	hdr.Set("Content-Type", "application/x-ndjson")
	hdr.Set("Content-Encoding", "gzip")
	hdr.Set("Pando-Session", string(head))
	var out SessionView
	q := url.Values{"at": {strconv.FormatInt(at, 10)}, "next": {strconv.FormatInt(next, 10)}}
	_, data, err := h.do(ctx, request{method: "POST", path: sessionPath(m, id) + "/pieces", query: q, raw: gz.Bytes(), header: hdr}, &out)
	var ae *APIError
	if errors.As(err, &ae) && ae.Code == "not_at_end" {
		var e struct {
			Error struct {
				End int64 `json:"end"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &e) == nil {
			return nil, NotAtEnd{End: e.Error.End}
		}
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// GetSession is a session, or its stub when deleted (State "deleted"); nil when there is none.
func (h *HTTP) GetSession(ctx context.Context, m, id string) (*SessionView, error) {
	var out SessionView
	_, _, err := h.do(ctx, request{method: "GET", path: sessionPath(m, id)}, &out)
	var ae *APIError
	if errors.As(err, &ae) && ae.Status == 404 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteSession deletes a session at once and for good.
func (h *HTTP) DeleteSession(ctx context.Context, m, id string) (*SessionView, error) {
	var out SessionView
	if _, _, err := h.do(ctx, request{method: "DELETE", path: sessionPath(m, id)}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SessionExclusion is one repository (Project empty) or project a person does not record.
type SessionExclusion struct {
	Monorepo   string  `json:"monorepo"`
	MonorepoID string  `json:"monorepo_id,omitempty"`
	Project    *string `json:"project"`
}

func (h *HTTP) SessionExclusions(ctx context.Context) ([]SessionExclusion, error) {
	var out struct {
		Exclusions []SessionExclusion `json:"exclusions"`
	}
	_, _, err := h.do(ctx, request{method: "GET", path: "/v1/user/session-exclusions"}, &out)
	return out.Exclusions, err
}

func (h *HTTP) SetSessionExclusions(ctx context.Context, list []SessionExclusion) error {
	if list == nil {
		list = []SessionExclusion{}
	}
	_, _, err := h.do(ctx, request{method: "PUT", path: "/v1/user/session-exclusions", body: map[string]any{"exclusions": list}}, nil)
	return err
}

// SessionStoreReport is a store as the machine reports it for Settings.
type SessionStoreReport struct {
	Program string `json:"program"`
	Path    string `json:"path"`
	Found   string `json:"found"`
}

// ReportSessionMachine tells the server whether this machine records, and which stores it reads.
func (h *HTTP) ReportSessionMachine(ctx context.Context, recording bool, stores []SessionStoreReport) error {
	if stores == nil {
		stores = []SessionStoreReport{}
	}
	_, _, err := h.do(ctx, request{method: "PUT", path: "/v1/user/session-machine", body: map[string]any{"recording": recording, "stores": stores}}, nil)
	return err
}
