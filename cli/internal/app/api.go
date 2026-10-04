package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"

	"pando/internal/server"
)

// multi is a flag given any number of times.
type multi []string

func (m *multi) String() string     { return strings.Join(*m, ", ") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

const apiUsage = "pando api <path> [-X method] [-f key=value] [-F key=value] [--input file] [-H 'Name: value'] [--paginate] [-i]"

// API is `pando api <path>`, like `gh api`: one call of the /v1 API, signed
// with this machine's credential, its answer printed as it came.
//
// {owner}, {monorepo}, {repo} and {branch} in the path are filled from the
// folder (or --monorepo and --repo). Fields make a JSON body (or, with GET
// or --input, the query). It exits 0 on a 2xx or 3xx answer; otherwise it
// prints the API's error body on stderr and exits 1.
func API(e *Env, args []string) error {
	fs := flags("api")
	var method string
	var raw, typed, headers multi
	fs.StringVar(&method, "X", "", "the method (default GET, or POST with fields or --input)")
	fs.StringVar(&method, "method", "", "the method")
	fs.Var(&raw, "f", "a string field, key=value (repeat it)")
	fs.Var(&raw, "raw-field", "a string field")
	fs.Var(&typed, "F", "a typed field: true, false, null, a whole number, or @file (repeat it)")
	fs.Var(&typed, "field", "a typed field")
	fs.Var(&headers, "H", "a request header, 'Name: value' (repeat it)")
	fs.Var(&headers, "header", "a request header")
	input := fs.String("input", "", "send this file as the body (- for standard input)")
	paginate := fs.Bool("paginate", false, "follow the list's cursor and print every page as one answer")
	var include bool
	fs.BoolVar(&include, "i", false, "print the status and headers first")
	fs.BoolVar(&include, "include", false, "print the status and headers first")
	mono := fs.String("monorepo", "", "the monorepo for {owner} and {monorepo} (default: the one this folder is in)")
	repoFlag := fs.String("repo", "", "the repo for {repo} (default: the one this folder is in)")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return UsageError{apiUsage}
	}
	fields, err := apiFields(e, raw, typed)
	if err != nil {
		return err
	}
	method = strings.ToUpper(method)
	if method == "" {
		method = "GET"
		if len(fields) > 0 || *input != "" {
			method = "POST"
		}
	}
	if *paginate && method != "GET" {
		return UsageError{"--paginate follows a list's pages: GET only"}
	}
	header := http.Header{}
	for _, h := range headers {
		k, v, ok := strings.Cut(h, ":")
		if !ok || strings.TrimSpace(k) == "" {
			return UsageError{fmt.Sprintf("-H %q: give 'Name: value'", h)}
		}
		header.Add(strings.TrimSpace(k), strings.TrimSpace(v))
	}
	srv, _, err := e.signedIn(*srvFlag)
	if err != nil {
		return err
	}
	h, ok := srv.(*server.HTTP)
	if !ok {
		return errors.New("pando api needs a Pando server; this one is a local file:// server")
	}
	path, query, err := e.apiPath(h, pos[0], *srvFlag, *mono, *repoFlag)
	if err != nil {
		return err
	}
	var body []byte
	switch {
	case *input != "":
		if body, err = readInput(e, *input); err != nil {
			return err
		}
		addQuery(query, fields)
	case method == "GET" || method == "HEAD" || method == "DELETE":
		addQuery(query, fields)
	case len(fields) > 0:
		if body, err = json.Marshal(nested(fields)); err != nil {
			return err
		}
	}
	var pages [][]byte
	cursor := ""
	for {
		q := url.Values{}
		for k, v := range query {
			q[k] = v
		}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		pq := path
		if len(q) > 0 {
			pq += "?" + q.Encode()
		}
		resp, data, err := h.Raw(e.Ctx, method, pq, header, body)
		if err != nil {
			return err
		}
		if include && len(pages) == 0 {
			printHeaders(e, resp)
		}
		if resp.StatusCode >= 400 {
			e.mu.Lock()
			fmt.Fprintln(e.Stderr, strings.TrimSpace(string(data)))
			e.mu.Unlock()
			return errSilent
		}
		pages = append(pages, data)
		next := server.NextCursor(data)
		if !*paginate || next == "" || next == cursor || len(pages) >= 1000 {
			if !*paginate {
				return apiOut(e, resp, data)
			}
			break
		}
		cursor = next
	}
	all, err := server.MergePages(pages)
	if err != nil {
		return err
	}
	return e.printJSON(all)
}

// apiOut prints an answer: JSON indented on a terminal and compact in a pipe,
// anything else as it came. A redirect with no body prints where it leads
// (an artifact's download, for one).
func apiOut(e *Env, resp *http.Response, data []byte) error {
	if len(bytes.TrimSpace(data)) == 0 {
		if loc := resp.Header.Get("Location"); resp.StatusCode/100 == 3 && loc != "" {
			e.printf("%s\n", loc)
		}
		return nil
	}
	if strings.Contains(resp.Header.Get("Content-Type"), "json") {
		return e.printJSON(data)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	_, err := e.Stdout.Write(data)
	return err
}

func printHeaders(e *Env, resp *http.Response) {
	e.printf("%s %s\n", resp.Proto, resp.Status)
	names := make([]string, 0, len(resp.Header))
	for k := range resp.Header {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		for _, v := range resp.Header[k] {
			e.printf("%s: %s\n", k, v)
		}
	}
	e.printf("\n")
}

// apiPath turns the path given into one from the host, /v1 added when left
// out, with its placeholders filled, and splits off its query.
func (e *Env) apiPath(h *server.HTTP, arg, srvFlag, mono, repoFlag string) (string, url.Values, error) {
	if strings.Contains(arg, "://") {
		return "", nil, UsageError{"give a path such as /monorepos/{owner}/{monorepo}, not a URL: the credential goes only to the signed-in server"}
	}
	p, rawQuery, _ := strings.Cut(strings.TrimSpace(arg), "?")
	query, err := url.ParseQuery(rawQuery)
	if err != nil {
		return "", nil, UsageError{"the query in the path: " + err.Error()}
	}
	p = "/" + strings.TrimLeft(p, "/")
	if p != "/v1" && !strings.HasPrefix(p, "/v1/") {
		p = "/v1" + p
	}
	if !strings.Contains(p, "{") {
		return p, query, nil
	}
	full := ""
	if strings.Contains(p, "{owner}") || strings.Contains(p, "{monorepo}") || strings.Contains(p, "{repo}") {
		if _, full, err = e.target(srvFlag, mono); err != nil {
			return "", nil, err
		}
		owner, name, _ := splitFull(full)
		p = strings.ReplaceAll(p, "{owner}", url.PathEscape(owner))
		p = strings.ReplaceAll(p, "{monorepo}", url.PathEscape(name))
	}
	if strings.Contains(p, "{repo}") {
		r, err := e.repoIn(h, full, repoFlag)
		if err != nil {
			return "", nil, err
		}
		p = strings.ReplaceAll(p, "{repo}", url.PathEscape(r.Name))
	}
	if strings.Contains(p, "{branch}") {
		root, err := e.root()
		b := ""
		if err == nil {
			b = e.currentBranch(root)
		}
		if b == "" {
			return "", nil, errors.New("{branch} is the branch of the worktree you are in; run this inside one, or write the branch in the path")
		}
		p = strings.ReplaceAll(p, "{branch}", url.PathEscape(b))
	}
	return p, query, nil
}

// field is one -f or -F: its key as written (gh's form: a, a[b], a[]) and value.
type field struct {
	key string
	val any
}

// apiFields reads -f (strings) and -F (true, false, null, whole numbers,
// @file or @- for standard input; anything else a string).
func apiFields(e *Env, raw, typed []string) ([]field, error) {
	var out []field
	for _, f := range raw {
		k, v, ok := strings.Cut(f, "=")
		if !ok || k == "" || k[0] == '[' {
			return nil, UsageError{fmt.Sprintf("-f %q: give key=value", f)}
		}
		out = append(out, field{k, v})
	}
	for _, f := range typed {
		k, v, ok := strings.Cut(f, "=")
		if !ok || k == "" || k[0] == '[' {
			return nil, UsageError{fmt.Sprintf("-F %q: give key=value", f)}
		}
		var val any = v
		switch {
		case v == "true", v == "false":
			val = v == "true"
		case v == "null":
			val = nil
		case strings.HasPrefix(v, "@"):
			b, err := readInput(e, v[1:])
			if err != nil {
				return nil, err
			}
			val = string(b)
		default:
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				val = n
			}
		}
		out = append(out, field{k, val})
	}
	return out, nil
}

// nested builds the JSON body from the fields: a[b]=x is {"a": {"b": "x"}},
// a[]=x and a[]=y are {"a": ["x", "y"]}.
func nested(fields []field) map[string]any {
	body := map[string]any{}
	for _, f := range fields {
		parts := keyParts(f.key)
		var set func(cur any, parts []string) any
		set = func(cur any, parts []string) any {
			if len(parts) == 0 {
				return f.val
			}
			if parts[0] == "" {
				list, _ := cur.([]any)
				return append(list, set(nil, parts[1:]))
			}
			m, ok := cur.(map[string]any)
			if !ok {
				m = map[string]any{}
			}
			m[parts[0]] = set(m[parts[0]], parts[1:])
			return m
		}
		if m, ok := set(body, parts).(map[string]any); ok {
			body = m
		}
	}
	return body
}

// keyParts splits a[b][] into a, b and "".
func keyParts(key string) []string {
	name, rest, _ := strings.Cut(key, "[")
	parts := []string{name}
	for rest != "" {
		part, after, ok := strings.Cut(rest, "]")
		if !ok {
			return []string{key} // not gh's form: the key as written
		}
		parts = append(parts, part)
		rest = strings.TrimPrefix(after, "[")
	}
	return parts
}

func addQuery(q url.Values, fields []field) {
	for _, f := range fields {
		v := ""
		if f.val != nil {
			v = fmt.Sprint(f.val)
		}
		q.Add(f.key, v)
	}
}

// readInput reads a file, or standard input for "-".
func readInput(e *Env, name string) ([]byte, error) {
	if name == "-" {
		return io.ReadAll(e.Stdin)
	}
	return os.ReadFile(e.abs(name))
}
