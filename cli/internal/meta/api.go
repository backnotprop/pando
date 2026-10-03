package meta

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Client calls the meta layer's HTTP routes: history, file, restore, status.
type Client struct {
	Server   string
	Monorepo string
	Token    string
	HTTP     *http.Client
}

// NewClient makes a Client from a Config.
func NewClient(c Config) *Client {
	return &Client{Server: c.Server, Monorepo: c.Monorepo, Token: c.Token, HTTP: &http.Client{Timeout: 60 * time.Second}}
}

// Version is one entry of a path's history.
type Version struct {
	Version      int64  `json:"version"`
	Path         string `json:"path"`
	Op           string `json:"op"`
	SHA          string `json:"sha"`
	Size         int64  `json:"size"`
	Deleted      bool   `json:"deleted"`
	Author       string `json:"author"`
	Machine      string `json:"machine"`
	Agent        string `json:"agent"`
	At           int64  `json:"at"` // ms since 1970
	Source       string `json:"source"`
	From         string `json:"from"`
	To           string `json:"to"`
	RestoredFrom *int64 `json:"restored_from"`
	Commit       string `json:"commit"`
}

// Time is when the version was saved.
func (v Version) Time() time.Time { return time.UnixMilli(v.At) }

// History is the answer of GET history.
type History struct {
	Path     string    `json:"path"`
	Head     int64     `json:"head"`
	Versions []Version `json:"versions"`
}

// Restored is the answer of POST restore.
type Restored struct {
	Path         string `json:"path"`
	Version      int64  `json:"version"`
	SHA          string `json:"sha"`
	RestoredFrom int64  `json:"restored_from"`
	Unchanged    bool   `json:"unchanged"`
}

// APIError is an error answer from the server.
type APIError struct {
	Status  int
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("%s (%d %s)", e.Message, e.Status, e.Code)
	}
	return fmt.Sprintf("server answered %d", e.Status)
}

func (c *Client) url(route string, q url.Values) string {
	u := c.Server + "/v1/monorepos/" + url.PathEscape(c.Monorepo) + "/meta/" + route
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	return u
}

func (c *Client) do(ctx context.Context, method, u string, body any) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, r)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		var wrapped struct {
			Error APIError `json:"error"`
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		_ = json.Unmarshal(b, &wrapped)
		wrapped.Error.Status = resp.StatusCode
		return nil, &wrapped.Error
	}
	return resp, nil
}

func (c *Client) getJSON(ctx context.Context, u string, out any) error {
	resp, err := c.do(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(out)
}

// History lists a path's versions, newest first (limit 0: the server's 50).
func (c *Client) History(ctx context.Context, path string, limit int) (*History, error) {
	q := url.Values{"path": {path}}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var h History
	return &h, c.getJSON(ctx, c.url("history", q), &h)
}

// Changes lists every change after a version, oldest first.
func (c *Client) Changes(ctx context.Context, since int64, limit int) (*History, error) {
	q := url.Values{"since": {strconv.FormatInt(since, 10)}}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var h History
	return &h, c.getJSON(ctx, c.url("history", q), &h)
}

// File returns the bytes of a path as it was at a version (0: now).
func (c *Client) File(ctx context.Context, path string, version int64) ([]byte, error) {
	q := url.Values{"path": {path}}
	if version > 0 {
		q.Set("version", strconv.FormatInt(version, 10))
	}
	resp, err := c.do(ctx, http.MethodGet, c.url("file", q), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

// Restore writes a path as it was at a version back, as a new save.
func (c *Client) Restore(ctx context.Context, path string, version int64, author, machine, agent string) (*Restored, error) {
	body := map[string]any{"path": path, "version": version, "author": author, "machine": machine}
	if agent != "" {
		body["agent"] = agent
	}
	resp, err := c.do(ctx, http.MethodPost, c.url("restore", nil), body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var r Restored
	return &r, json.NewDecoder(resp.Body).Decode(&r)
}

// Status is the object's summary: head, files, uncommitted, sockets.
func (c *Client) Status(ctx context.Context) (map[string]any, error) {
	var s map[string]any
	return s, c.getJSON(ctx, c.url("status", nil), &s)
}
