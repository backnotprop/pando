package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"pando/internal/gitx"
)

// Local is a file:// server: one folder per monorepo, holding bare repos
// named like the API's repos. It keeps the rules the CLI relies on: main
// takes only its first push, and a merge writes a merge commit. There is one
// user, $USER in lower case.
type Local struct {
	Base string
	mu   sync.Mutex
}

type localRepo struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type localMono struct {
	Name      string      `json:"name"`
	Kind      string      `json:"kind"`
	CreatedAt string      `json:"created_at"`
	Repos     []localRepo `json:"repos"`
}

func (l *Local) monoDir(m string) string { return filepath.Join(l.Base, m) }
func (l *Local) repoDir(m, name string) string {
	return filepath.Join(l.monoDir(m), "repos", name+".git")
}
func (l *Local) cloneURL(m, name string) string { return "file://" + l.repoDir(m, name) }
func apiErr(status int, code, msg string) error {
	return &APIError{Status: status, Code: code, Message: msg}
}
func notFound(what string) error { return apiErr(404, "not_found", what+" not found") }
func (l *Local) login() string {
	if u := strings.ToLower(os.Getenv("USER")); u != "" {
		return u
	}
	return "local"
}

func (l *Local) load(m string) (*localMono, error) {
	b, err := os.ReadFile(filepath.Join(l.monoDir(m), "monorepo.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, notFound("monorepo " + m)
	}
	if err != nil {
		return nil, err
	}
	lm := &localMono{}
	return lm, json.Unmarshal(b, lm)
}

func (l *Local) save(lm *localMono) error {
	sort.Slice(lm.Repos, func(i, j int) bool { return lm.Repos[i].Path < lm.Repos[j].Path })
	return writeJSONFile(filepath.Join(l.monoDir(lm.Name), "monorepo.json"), lm)
}

func (l *Local) repo(lm *localMono, r localRepo) Repo {
	return Repo{Monorepo: lm.Name, Name: r.Name, Path: r.Path, DefaultBranch: "main", CloneURL: l.cloneURL(lm.Name, r.Name)}
}

func (l *Local) CreateUser(_ context.Context, _ string, login, name, email, credName string) (*NewUser, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	return &NewUser{User: User{Login: login, Name: name, Email: email, CreatedAt: now},
		Credential: Credential{ID: "cred_local", Name: credName, Kind: "machine", CreatedAt: now, Secret: "pando_local"}}, nil
}

func (l *Local) Me(_ context.Context) (*Me, error) {
	return &Me{User: User{Login: l.login()}, Credential: Credential{ID: "cred_local", Name: "local", Kind: "machine"}}, nil
}

func (l *Local) CreateCredential(_ context.Context, name, kind string) (*Credential, error) {
	return &Credential{ID: fmt.Sprintf("cred_%d", time.Now().UnixNano()), Name: name, Kind: kind,
		CreatedAt: time.Now().UTC().Format(time.RFC3339), Secret: "pando_local"}, nil
}

func (l *Local) ListCredentials(_ context.Context) ([]Credential, error) {
	return []Credential{{ID: "cred_local", Name: "local", Kind: "machine"}}, nil
}

func (l *Local) RevokeCredential(_ context.Context, _ string) error { return nil }

func (l *Local) CreateMonorepo(ctx context.Context, name, kind string) (*Created, error) {
	l.mu.Lock()
	if _, err := l.load(name); err == nil {
		l.mu.Unlock()
		return nil, apiErr(409, "monorepo_exists", "monorepo "+name+" exists")
	}
	lm := &localMono{Name: name, Kind: kind, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	if err := os.MkdirAll(l.monoDir(name), 0o755); err != nil {
		l.mu.Unlock()
		return nil, err
	}
	err := l.save(lm)
	l.mu.Unlock()
	if err != nil {
		return nil, err
	}
	out := &Created{Monorepo: Monorepo{Name: name, Kind: kind, Role: "owner", CreatedAt: lm.CreatedAt}}
	if kind == "repo" {
		r, err := l.CreateRepo(ctx, name, ".")
		if err != nil {
			return nil, err
		}
		out.Repos = []Repo{*r}
	}
	return out, nil
}

func (l *Local) ListMonorepos(_ context.Context) ([]Monorepo, error) {
	entries, err := os.ReadDir(l.Base)
	if err != nil {
		return nil, nil
	}
	var out []Monorepo
	for _, e := range entries {
		if lm, err := l.load(e.Name()); err == nil {
			out = append(out, Monorepo{Name: lm.Name, Kind: lm.Kind, Role: "owner", CreatedAt: lm.CreatedAt})
		}
	}
	return out, nil
}

func (l *Local) GetMonorepo(_ context.Context, m string) (*Monorepo, error) {
	lm, err := l.load(m)
	if err != nil {
		return nil, err
	}
	return &Monorepo{Name: lm.Name, Kind: lm.Kind, Role: "owner", CreatedAt: lm.CreatedAt}, nil
}

func (l *Local) ListRepos(_ context.Context, m string) ([]Repo, error) {
	lm, err := l.load(m)
	if err != nil {
		return nil, err
	}
	var out []Repo
	for _, r := range lm.Repos {
		out = append(out, l.repo(lm, r))
	}
	return out, nil
}

func (l *Local) GetRepo(_ context.Context, m, name string) (*Repo, error) {
	lm, err := l.load(m)
	if err != nil {
		return nil, err
	}
	for _, r := range lm.Repos {
		if r.Name == name {
			out := l.repo(lm, r)
			return &out, nil
		}
	}
	return nil, notFound("repo " + name)
}

// preReceive refuses updates to main once it exists, as the git door does.
const preReceive = `#!/bin/sh
zero=0000000000000000000000000000000000000000
while read old new ref; do
  if [ "$ref" = "refs/heads/main" ] && [ "$old" != "$zero" ]; then
    echo "pando: main takes no direct push; push a branch and ask a person to merge it" >&2
    exit 1
  fi
done
exit 0
`

func (l *Local) CreateRepo(ctx context.Context, m, path string) (*Repo, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	lm, err := l.load(m)
	if err != nil {
		return nil, err
	}
	name := RepoName(m, path)
	for _, r := range lm.Repos {
		if r.Name == name {
			return nil, apiErr(409, "repo_exists", "repo "+name+" exists")
		}
	}
	dir := l.repoDir(m, name)
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return nil, err
	}
	if _, err := (gitx.Cmd{}).Run(ctx, "init", "--quiet", "--bare", "--initial-branch=main", dir); err != nil {
		return nil, err
	}
	bare := gitx.In(dir)
	for _, kv := range [][2]string{
		{"uploadpack.allowFilter", "true"},
		{"uploadpack.allowAnySHA1InWant", "true"},
	} {
		if _, err := bare.Run(ctx, "config", kv[0], kv[1]); err != nil {
			return nil, err
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "hooks", "pre-receive"), []byte(preReceive), 0o755); err != nil {
		return nil, err
	}
	r := localRepo{Name: name, Path: path}
	lm.Repos = append(lm.Repos, r)
	if err := l.save(lm); err != nil {
		return nil, err
	}
	out := l.repo(lm, r)
	return &out, nil
}

func (l *Local) bare(m, repo string) (gitx.Cmd, error) {
	dir := l.repoDir(m, repo)
	if _, err := os.Stat(dir); err != nil {
		return gitx.Cmd{}, notFound("repo " + repo)
	}
	return gitx.Cmd{Dir: dir, Env: []string{
		"GIT_AUTHOR_NAME=Pando", "GIT_AUTHOR_EMAIL=pando@localhost",
		"GIT_COMMITTER_NAME=Pando", "GIT_COMMITTER_EMAIL=pando@localhost",
	}}, nil
}

func aheadBehind(ctx context.Context, g gitx.Cmd, branch string) (ahead, behind *int) {
	lr, err := g.Run(ctx, "rev-list", "--left-right", "--count", "main..."+branch)
	if err != nil {
		return nil, nil
	}
	p := strings.Fields(lr)
	if len(p) != 2 {
		return nil, nil
	}
	b, _ := strconv.Atoi(p[0])
	a, _ := strconv.Atoi(p[1])
	return &a, &b
}

func (l *Local) branch(ctx context.Context, g gitx.Cmd, name, head string) Branch {
	b := Branch{Name: name, Head: head, State: "open", Mergeable: "unknown", Checks: Checks{State: "success"}}
	b.Base, _ = g.Run(ctx, "merge-base", "main", head)
	b.Ahead, b.Behind = aheadBehind(ctx, g, name)
	if b.Ahead != nil && *b.Ahead == 0 {
		b.Mergeable = "up_to_date"
	}
	b.UpdatedAt, _ = g.Run(ctx, "log", "-1", "--format=%cI", head)
	return b
}

func (l *Local) ListBranches(ctx context.Context, m, repo, _ string) (*BranchList, error) {
	g, err := l.bare(m, repo)
	if err != nil {
		return nil, err
	}
	out := &BranchList{DefaultBranch: "main"}
	out.DefaultHead, _ = g.Run(ctx, "rev-parse", "--verify", "--quiet", "refs/heads/main")
	refs, err := g.Run(ctx, "for-each-ref", "refs/heads", "--format=%(refname:short) %(objectname)")
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(refs, "\n") {
		f := strings.Fields(line)
		if len(f) != 2 || f[0] == "main" {
			continue
		}
		out.Branches = append(out.Branches, l.branch(ctx, g, f[0], f[1]))
	}
	return out, nil
}

func (l *Local) GetBranch(ctx context.Context, m, repo, name string) (*Branch, error) {
	g, err := l.bare(m, repo)
	if err != nil {
		return nil, err
	}
	head, err := g.Run(ctx, "rev-parse", "--verify", "--quiet", "refs/heads/"+name)
	if err != nil || head == "" {
		return nil, notFound("branch " + name)
	}
	b := l.branch(ctx, g, name, head)
	return &b, nil
}

func (l *Local) CreateBranch(ctx context.Context, m, repo, name string) (bool, error) {
	g, err := l.bare(m, repo)
	if err != nil {
		return false, err
	}
	if name == "main" {
		return false, nil
	}
	if _, err := g.Run(ctx, "rev-parse", "--verify", "--quiet", "refs/heads/"+name); err == nil {
		return false, nil
	}
	if _, err := g.Run(ctx, "check-ref-format", "--branch", name); err != nil {
		return false, apiErr(400, "bad_branch", fmt.Sprintf("%q is not a valid branch name", name))
	}
	if _, err := g.Run(ctx, "update-ref", "refs/heads/"+name, "refs/heads/main", strings.Repeat("0", 40)); err != nil {
		return false, err
	}
	return true, nil
}

type localDiffFile struct {
	Path      string `json:"path"`
	OldPath   string `json:"old_path,omitempty"`
	Status    string `json:"status"`
	Binary    bool   `json:"binary"`
	Additions *int   `json:"additions"`
	Deletions *int   `json:"deletions"`
}

func (l *Local) Diff(ctx context.Context, m, repo, branch string, format DiffFormat, paths []string) ([]byte, int, error) {
	g, err := l.bare(m, repo)
	if err != nil {
		return nil, 0, err
	}
	if _, err := g.Run(ctx, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch); err != nil {
		return nil, 0, notFound("branch " + branch)
	}
	rng := "main..." + branch
	tail := append([]string{"--"}, paths...)
	if format == DiffPatch {
		b, err := g.RunRaw(ctx, append([]string{"diff", "--no-renames", rng}, tail...)...)
		return b, 0, err
	}
	base, _ := g.Run(ctx, "rev-parse", "main")
	head, _ := g.Run(ctx, "rev-parse", branch)
	mb, err := g.Run(ctx, "merge-base", "main", branch)
	if err != nil {
		return nil, 0, apiErr(409, "no_merge_base", "the branch shares no history with main")
	}
	ns, _ := g.Run(ctx, append([]string{"diff", "--no-renames", "--name-status", rng}, tail...)...)
	num, _ := g.Run(ctx, append([]string{"diff", "--no-renames", "--numstat", rng}, tail...)...)
	type ad struct{ a, d *int }
	counts := map[string]ad{}
	for _, line := range strings.Split(num, "\n") {
		f := strings.Split(line, "\t")
		if len(f) == 3 {
			var x ad
			if a, err := strconv.Atoi(f[0]); err == nil {
				x.a = &a
			}
			if d, err := strconv.Atoi(f[1]); err == nil {
				x.d = &d
			}
			counts[f[2]] = x
		}
	}
	statusWord := map[string]string{"A": "added", "M": "modified", "D": "deleted", "T": "modified"}
	files := []localDiffFile{}
	adds, dels := 0, 0
	for _, line := range strings.Split(ns, "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 2 {
			continue
		}
		c := counts[f[1]]
		df := localDiffFile{Path: f[1], Status: statusWord[f[0][:1]], Additions: c.a, Deletions: c.d, Binary: c.a == nil}
		if c.a != nil {
			adds += *c.a
			dels += *c.d
		}
		files = append(files, df)
	}
	b, err := json.MarshalIndent(map[string]any{
		"base_branch": "main", "base": base, "head": head, "merge_base": mb, "truncated": false,
		"stats": map[string]int{"files": len(files), "additions": adds, "deletions": dels},
		"files": files,
	}, "", "  ")
	return b, 0, err
}

func (l *Local) CreateReview(ctx context.Context, m, repo, branch string, r ReviewIn) (*Review, error) {
	b, err := l.GetBranch(ctx, m, repo, branch)
	if err != nil {
		return nil, err
	}
	if r.Head == "" {
		r.Head = b.Head
	}
	rv := &Review{ID: fmt.Sprintf("rev_%d", time.Now().UnixNano()), Branch: branch, Head: r.Head, Verdict: r.Verdict,
		Body: r.Body, Author: l.login(), CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := os.OpenFile(filepath.Join(l.monoDir(m), "reviews.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	line, _ := json.Marshal(map[string]any{"repo": repo, "review": rv})
	_, err = f.Write(append(line, '\n'))
	return rv, err
}

func (l *Local) Merge(ctx context.Context, m, repo, branch string, force bool, expectedHead string) (*MergeResult, error) {
	who := l.login()
	g, err := l.bare(m, repo)
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	main, err := g.Run(ctx, "rev-parse", "refs/heads/main")
	if err != nil {
		return nil, err
	}
	head, err := g.Run(ctx, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch)
	if err != nil || head == "" {
		return nil, notFound("branch " + branch)
	}
	if expectedHead != "" && expectedHead != head {
		return nil, apiErr(409, "head_moved", "the branch head moved")
	}
	res := &MergeResult{Branch: branch, Head: head, BaseBefore: main, Forced: force, MergedBy: who}
	res.MergeBase, _ = g.Run(ctx, "merge-base", main, head)
	if _, err := g.Run(ctx, "merge-base", "--is-ancestor", head, main); err == nil {
		res.Status, res.SHA = "up_to_date", main
		return res, nil
	}
	out, err := g.Run(ctx, "merge-tree", "--write-tree", "--name-only", main, head)
	if err != nil {
		lines := strings.Split(out, "\n")
		var paths []string
		for _, p := range lines[1:] {
			if p = strings.TrimSpace(p); p == "" {
				break
			}
			paths = append(paths, p)
		}
		return nil, &APIError{Status: 409, Code: "conflict", Paths: paths,
			Message: "files changed differently on both sides; merge main into the branch, push, and merge again"}
	}
	tree := strings.SplitN(out, "\n", 2)[0]
	msg := fmt.Sprintf("Merge branch '%s'", branch)
	commit, err := g.Run(ctx, "commit-tree", tree, "-p", main, "-p", head, "-m", msg)
	if err != nil {
		return nil, err
	}
	if _, err := g.Run(ctx, "update-ref", "refs/heads/main", commit, main); err != nil {
		return nil, apiErr(409, "ref_moved", "main moved; retry")
	}
	res.Status, res.SHA = "merged", commit
	return res, nil
}

func (l *Local) worktreesPath(m string) string { return filepath.Join(l.monoDir(m), "worktrees.json") }

func (l *Local) loadWorktrees(m string) ([]Worktree, error) {
	if _, err := l.load(m); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(l.worktreesPath(m))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ws []Worktree
	return ws, json.Unmarshal(b, &ws)
}

func (l *Local) PutWorktree(_ context.Context, m, id string, in WorktreeIn) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	ws, err := l.loadWorktrees(m)
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	who := l.login()
	w := Worktree{ID: id, Repo: in.Repo, Branch: in.Branch, Path: in.Path, Machine: in.Machine, Kind: in.Kind,
		ReportedBy: who, CreatedAt: now, LastSeenAt: now}
	if in.Agent != nil {
		w.Agent = *in.Agent
	}
	replaced := false
	for i := range ws {
		if ws[i].ID == id {
			w.CreatedAt = ws[i].CreatedAt
			ws[i], replaced = w, true
		}
	}
	if !replaced {
		ws = append(ws, w)
	}
	return writeJSONFile(l.worktreesPath(m), ws)
}

func (l *Local) ListWorktrees(_ context.Context, m string) ([]Worktree, error) {
	return l.loadWorktrees(m)
}

func (l *Local) DeleteWorktree(_ context.Context, m, id string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	ws, err := l.loadWorktrees(m)
	if err != nil {
		return err
	}
	out := ws[:0]
	for _, w := range ws {
		if w.ID != id {
			out = append(out, w)
		}
	}
	return writeJSONFile(l.worktreesPath(m), out)
}

func writeJSONFile(p string, v any) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", p, os.Getpid())
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Members and invites on a file:// server: the one user is the owner, and
// invites are kept in invites.json.

func (l *Local) ListMembers(_ context.Context, m string) ([]Member, error) {
	lm, err := l.load(m)
	if err != nil {
		return nil, err
	}
	return []Member{{Login: l.login(), Role: "owner", AddedAt: lm.CreatedAt}}, nil
}

func (l *Local) RemoveMember(_ context.Context, m, login string) error {
	if login == l.login() {
		return apiErr(409, "last_owner", "the last owner stays")
	}
	return notFound(login + " as a member")
}

func (l *Local) invitesPath(m string) string { return filepath.Join(l.monoDir(m), "invites.json") }

func (l *Local) ListInvites(_ context.Context, m string) ([]Invite, error) {
	if _, err := l.load(m); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(l.invitesPath(m))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Invite
	return out, json.Unmarshal(b, &out)
}

func (l *Local) Invite(ctx context.Context, m, email, role string) (*InviteResult, error) {
	if role == "" {
		role = "member"
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	invs, err := l.ListInvites(ctx, m)
	if err != nil {
		return nil, err
	}
	inv := Invite{Email: strings.ToLower(email), Role: role, InvitedBy: l.login(), CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	out := invs[:0]
	for _, i := range invs {
		if i.Email != inv.Email {
			out = append(out, i)
		}
	}
	out = append(out, inv)
	if err := writeJSONFile(l.invitesPath(m), out); err != nil {
		return nil, err
	}
	return &InviteResult{Status: "invited", Invite: &inv}, nil
}

func (l *Local) RevokeInvite(ctx context.Context, m, email string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	invs, err := l.ListInvites(ctx, m)
	if err != nil {
		return err
	}
	out := invs[:0]
	found := false
	for _, i := range invs {
		if i.Email == strings.ToLower(email) {
			found = true
			continue
		}
		out = append(out, i)
	}
	if !found {
		return notFound("invite for " + email)
	}
	return writeJSONFile(l.invitesPath(m), out)
}

func (l *Local) DeleteMonorepo(_ context.Context, m string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, err := l.load(m); err != nil {
		return err
	}
	return os.RemoveAll(l.monoDir(m))
}
