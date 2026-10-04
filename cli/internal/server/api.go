package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// Raw sends one request as given, for `pando api`: pathQuery is the path from
// the host with its query, header and body go out as they are (after this
// credential and the agent, so a header given wins). The answer comes back
// whatever its status; redirects are not followed (a 302 is the answer). Only
// a failure to reach the server is an error.
func (h *HTTP) Raw(ctx context.Context, method, pathQuery string, header http.Header, body []byte) (*http.Response, []byte, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, h.Base+pathQuery, rd)
	if err != nil {
		return nil, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if h.token != "" {
		req.Header.Set("Authorization", "Bearer "+h.token)
	}
	req.Header.Set("User-Agent", "pando-cli/0.1")
	if h.Agent != "" {
		req.Header.Set("X-Pando-Agent", h.Agent)
	}
	for k, vs := range header {
		req.Header.Del(k)
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	c := *h.Client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := c.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("%s %s: %w", method, h.Base+pathQuery, unwrapURLError(err))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 512<<20))
	return resp, data, err
}

// Call is one JSON call of the API: a path from the host, a query, a body
// sent as JSON (nil: none). out, when not nil, gets the answer decoded. The
// answer's bytes come back too: --json prints them as the API sent them. A
// non-2xx answer is an *APIError.
func (h *HTTP) Call(ctx context.Context, method, path string, query url.Values, body, out any) ([]byte, error) {
	_, data, err := h.do(ctx, request{method: method, path: path, query: query, body: body}, out)
	return data, err
}

// NextCursor is the cursor of the page after this one in a list answer:
// `next_cursor` (branches, CI builds, a pipeline's builds) or `next` (the
// activity log). "" on the last page, or for an answer that is not paged.
func NextCursor(page []byte) string {
	var p struct {
		NextCursor *string `json:"next_cursor"`
		Next       *string `json:"next"`
	}
	if json.Unmarshal(page, &p) != nil {
		return ""
	}
	if p.NextCursor != nil {
		return *p.NextCursor
	}
	if p.Next != nil {
		return *p.Next
	}
	return ""
}

// MergePages joins the pages of one list into one answer: each top-level
// array is the pages' arrays end to end, the cursor (`next_cursor`, `next`)
// is the last page's, and every other field is the first page's. Keys come
// out sorted.
func MergePages(pages [][]byte) ([]byte, error) {
	if len(pages) == 1 {
		return pages[0], nil
	}
	var out map[string]json.RawMessage
	arrays := map[string][]json.RawMessage{}
	for i, p := range pages {
		var page map[string]json.RawMessage
		if err := json.Unmarshal(p, &page); err != nil {
			return nil, errors.New("a page is not a JSON object; it cannot be joined with the others")
		}
		if i == 0 {
			out = page
		}
		for k, v := range page {
			var items []json.RawMessage
			if json.Unmarshal(v, &items) == nil && len(v) > 0 && v[0] == '[' {
				arrays[k] = append(arrays[k], items...)
			}
			if k == "next_cursor" || k == "next" {
				out[k] = v
			}
		}
	}
	for k, items := range arrays {
		b, err := json.Marshal(items)
		if err != nil {
			return nil, err
		}
		out[k] = b
	}
	return json.Marshal(out)
}

// pages calls a list route with ?cursor= until limit items (counted by
// count) or the last page, each page asking for at most max. It returns the
// answer with its pages joined (MergePages).
func (h *HTTP) pages(ctx context.Context, path string, query url.Values, limit, max int, count func([]byte) int) ([]byte, error) {
	var all [][]byte
	got, cursor := 0, ""
	for len(all) < 1000 {
		q := url.Values{}
		for k, v := range query {
			q[k] = v
		}
		q.Set("limit", fmt.Sprint(min(max, limit-got)))
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		data, err := h.Call(ctx, "GET", path, q, nil, nil)
		if err != nil {
			return nil, err
		}
		all = append(all, data)
		got += count(data)
		next := NextCursor(data)
		if got >= limit || next == "" || next == cursor {
			break
		}
		cursor = next
	}
	return MergePages(all)
}
