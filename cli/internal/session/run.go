package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime/debug"
	"slices"
	"strings"
	"time"

	"pando/internal/config"
	"pando/internal/server"
)

// Runner records the sessions of one Pando folder from this machine. `pando sync` runs it beside the shared files'
// sync, never inside it: a failure here is logged and tried again, and the shared files keep syncing.
type Runner struct {
	Root    *config.Root
	HomeDir string // ~/.pando
	Client  *server.HTTP
	Log     *log.Logger
	// Every: how often the stores are looked at. Gap: at most one piece per session per Gap, unless a commit in it
	// asked for one now. Tests shorten both (PANDO_SESSIONS_EVERY).
	Every, Gap time.Duration
	Getenv     func(string) string
	UserHome   string

	state    *State
	redactor *Redactor
	excl     []CachedExclusion
	exclAt   time.Time
	reported string
}

// exclusionsEvery: how often the person's own exclusions are read again from the server.
const exclusionsEvery = 5 * time.Minute

// Start runs the Runner for the Pando folder at dir until ctx ends. Nothing it does can stop the caller.
func Start(ctx context.Context, dir string) {
	root, err := config.FindRoot(dir)
	if err != nil || !strings.HasPrefix(root.Server, "http") {
		return
	}
	home, err := config.HomeDir()
	if err != nil {
		return
	}
	token, _ := config.Credential(root.Server)
	userHome, _ := os.UserHomeDir()
	r := &Runner{Root: root, HomeDir: home, Client: server.NewHTTP(root.Server, token), Log: log.New(os.Stderr, "pando sync (sessions): ", log.LstdFlags),
		Every: 5 * time.Second, Gap: 30 * time.Second, Getenv: os.Getenv, UserHome: userHome}
	if d, err := time.ParseDuration(os.Getenv("PANDO_SESSIONS_EVERY")); err == nil && d > 0 {
		r.Every, r.Gap = d, d
	}
	go r.loop(ctx)
}

func (r *Runner) loop(ctx context.Context) {
	for ctx.Err() == nil {
		r.safeTick(ctx)
		select {
		case <-ctx.Done():
		case <-time.After(r.Every):
		}
	}
}

// safeTick runs one pass; a panic in session reading is logged, never passed on.
func (r *Runner) safeTick(ctx context.Context) {
	defer func() {
		if p := recover(); p != nil {
			r.Log.Printf("stopped a pass after a fault: %v\n%s", p, debug.Stack())
		}
	}()
	if err := r.Tick(ctx); err != nil && ctx.Err() == nil {
		r.Log.Print(err)
	}
}

// Tick is one pass: every store read, every recorded session's new lines sent.
func (r *Runner) Tick(ctx context.Context) error {
	settings, err := LoadSettings(r.HomeDir)
	if err != nil {
		return err
	}
	stores := Stores(r.HomeDir, settings, r.Getenv, r.UserHome)
	r.report(ctx, settings.Recording(), stores)
	if !settings.Recording() {
		return nil
	}
	rules, err := config.LoadSettings(r.Root.Dir)
	if err == nil && rules.Sessions.Record != nil && !*rules.Sessions.Record {
		return nil // the repository records no sessions (.pando/pando.toml)
	}
	if r.state == nil {
		if r.state, err = LoadState(r.Root.Dir); err != nil {
			return err
		}
	}
	if r.redactor == nil {
		token, _ := config.Credential(r.Root.Server)
		folders := []string{r.Root.Dir}
		if ws, err := r.Root.LoadWorktrees(); err == nil {
			for _, w := range ws {
				folders = append(folders, r.Root.Abs(w.Path))
			}
		}
		if r.redactor, err = NewRedactor(token, folders); err != nil {
			return fmt.Errorf("the secret check cannot run, so nothing is sent: %w", err)
		}
	}
	r.refreshExclusions(ctx)
	var excluded []string
	if rules != nil {
		excluded = rules.Sessions.Exclude
	}
	nudged := r.nudges()
	roots := []string{r.Root.Dir, real(r.Root.Dir)}
	for _, st := range stores {
		if ctx.Err() != nil {
			break
		}
		if st.Program == OpenCode {
			r.openCode(ctx, st, excluded, nudged)
			continue
		}
		for _, f := range Files(st, roots) {
			if r.state.Skip[f] {
				continue
			}
			h, ok := ReadHeader(st.Program, f)
			if !ok {
				continue
			}
			if !Inside(h.Folder, r.Root.Dir) {
				r.state.Skip[f] = true
				continue
			}
			parent := ""
			if h.ParentAgentID != "" {
				parent = ID(st.Program, h.ParentAgentID)
			}
			r.file(ctx, h, parent, excluded, nudged)
		}
	}
	return r.state.Save()
}

// report tells the server this machine's recording and stores when they change (Settings shows them).
func (r *Runner) report(ctx context.Context, recording bool, stores []Store) {
	list := make([]server.SessionStoreReport, 0, len(stores))
	for _, s := range stores {
		list = append(list, server.SessionStoreReport{Program: s.Program, Path: s.Path, Found: s.Found})
	}
	sig := fmt.Sprint(recording, list)
	if sig == r.reported {
		return
	}
	if err := r.Client.ReportSessionMachine(ctx, recording, list); err == nil {
		r.reported = sig
	}
}

func (r *Runner) refreshExclusions(ctx context.Context) {
	if time.Since(r.exclAt) < exclusionsEvery {
		return
	}
	list, err := r.Client.SessionExclusions(ctx)
	if err != nil {
		return
	}
	r.excl, r.exclAt = make([]CachedExclusion, 0, len(list)), time.Now()
	for _, x := range list {
		r.excl = append(r.excl, CachedExclusion{Monorepo: x.Monorepo, MonorepoID: x.MonorepoID, Project: x.Project})
	}
	// The commit hook reads them from here: it never calls the server.
	if b, err := json.Marshal(r.excl); err == nil {
		_ = os.WriteFile(ExclusionsFile(r.HomeDir), b, 0o600)
	}
}

// nudges are the sessions a commit just named (the hook writes them): sent now, whatever the gap.
func (r *Runner) nudges() map[string]bool {
	p := NudgeFile(r.Root.Dir)
	b, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	_ = os.Remove(p)
	out := map[string]bool{}
	for _, id := range strings.Fields(string(b)) {
		out[id] = true
	}
	return out
}

// NudgeFile is where the commit hook names a session that just committed.
func NudgeFile(root string) string { return filepath.Join(root, ".pando", "local", "session-nudge") }

// Place is where in the Pando folder a session ran: a project's branch worktree, a project, or the repository's own
// folder (Repo nil). Project is the project's path, for exclusions.
type Place struct {
	Repo, Branch *string
	Project      string
}

// PlaceOf finds where in the Pando folder root a folder is.
func PlaceOf(root *config.Root, folder string) Place {
	name := func(path string) *string {
		for _, e := range root.Repos {
			if e.Path == path {
				return &e.Name
			}
		}
		return nil
	}
	if ws, err := root.LoadWorktrees(); err == nil {
		for _, w := range ws {
			if Inside(folder, root.Abs(w.Path)) {
				b := w.Branch
				return Place{Repo: name(w.Repo), Branch: &b, Project: w.Repo}
			}
		}
	}
	rel, err := root.Rel(real(folder))
	if err != nil {
		rel, err = root.Rel(folder)
	}
	if err != nil {
		return Place{}
	}
	repo, ok := root.RepoFor(rel)
	if !ok || (repo == "." && root.Kind != config.KindRepo) {
		return Place{}
	}
	p := Place{Repo: name(repo), Project: repo}
	// A project's read-only main, <repo>/worktrees/main.
	if w := config.WorktreePath(repo, "main"); rel == w || strings.HasPrefix(rel, w+"/") {
		b := "main"
		p.Branch = &b
	}
	return p
}

// Excluded: by the repository's rule (.pando/pando.toml [sessions] exclude) or the person's own list.
func Excluded(root *config.Root, p Place, repoRule []string, mine []CachedExclusion) bool {
	if p.Project != "" && slices.Contains(repoRule, p.Project) {
		return true
	}
	for _, x := range mine {
		if x.MonorepoID != root.ID && x.Monorepo != root.FullName() {
			continue
		}
		if x.Project == nil || *x.Project == p.Project {
			return true
		}
	}
	return false
}

// tail finds where a session stands: its saved place, else the server's end (a machine that lost its state, or a
// session seen for the first time), else 0.
func (r *Runner) tail(ctx context.Context, id string, h Header) (*Tail, bool) {
	if t := r.state.Sessions[id]; t != nil {
		t.File = h.File
		return t, !t.Deleted && !t.Rewritten
	}
	v, err := r.Client.GetSession(ctx, r.Root.FullName(), id)
	if err != nil {
		return nil, false
	}
	t := &Tail{Program: h.Program, File: h.File, AgentID: h.AgentID}
	if v != nil && v.State == "deleted" {
		t.Deleted = true
	} else if v != nil {
		t.Offset = v.End
	}
	r.state.Sessions[id] = t
	return t, !t.Deleted
}

// lines is what one agent's lines go through before they leave: Trim, with this machine's redaction.
func (r *Runner) lines(program string) func([]byte) ([]byte, bool, error) {
	return func(raw []byte) ([]byte, bool, error) { return Trim(program, raw, r.redactor.Redact) }
}

func (r *Runner) file(ctx context.Context, h Header, parent string, repoRule []string, nudged map[string]bool) {
	id := ID(h.Program, h.AgentID)
	place := PlaceOf(r.Root, h.Folder)
	if Excluded(r.Root, place, repoRule, r.excl) {
		return
	}
	t, live := r.tail(ctx, id, h)
	if !live {
		return
	}
	st, err := os.Stat(h.File)
	if err != nil || st.Size() == t.Offset || (time.Since(t.Sent) < r.Gap && !nudged[id]) {
		return
	}
	if st.Size() < t.Offset {
		t.Rewritten = true
		r.Log.Printf("session %s: its file is shorter than what was sent; it is no longer recorded", id)
		return
	}
	if fp, err := Fingerprint(h.File); err == nil && t.Fingerprint != "" && fp != t.Fingerprint {
		t.Rewritten = true
		r.Log.Printf("session %s: its file was written again from the start; it is no longer recorded", id)
		return
	}
	start := server.SessionStart{Program: h.Program, AgentID: h.AgentID, Repo: place.Repo, Branch: place.Branch}
	if parent != "" {
		start.Parent = &parent
	}
	r.send(ctx, id, t, start, func(at int64) (Piece, error) { return ReadPiece(h.File, at, PieceMax, r.lines(h.Program)) })
	if t.Fingerprint == "" && t.Offset > 0 {
		t.Fingerprint, _ = Fingerprint(h.File)
	}
}

func (r *Runner) openCode(ctx context.Context, st Store, repoRule []string, nudged map[string]bool) {
	db, ok, err := OpenDB(st.Path)
	if err != nil || !ok {
		return // OpenCode V1, or a database not readable now
	}
	defer db.Close()
	list, err := OpenCodeSessions(db)
	if err != nil {
		return
	}
	for _, s := range list {
		if ctx.Err() != nil || !Inside(s.Directory, r.Root.Dir) {
			continue
		}
		id := ID(OpenCode, s.ID)
		place := PlaceOf(r.Root, s.Directory)
		if Excluded(r.Root, place, repoRule, r.excl) {
			continue
		}
		t, live := r.tail(ctx, id, Header{Program: OpenCode, File: st.Path, AgentID: s.ID, Folder: s.Directory})
		if !live || (time.Since(t.Sent) < r.Gap && !nudged[id]) {
			continue
		}
		start := server.SessionStart{Program: OpenCode, AgentID: s.ID, Repo: place.Repo, Branch: place.Branch}
		if s.ParentID != "" {
			p := ID(OpenCode, s.ParentID)
			start.Parent = &p
		}
		r.send(ctx, id, t, start, func(at int64) (Piece, error) { return OpenCodePiece(db, s, at, PieceMax, r.lines(OpenCode)) })
	}
}

// send appends pieces from the session's place until nothing new is left, resuming from the server's end when it
// says the piece is not at the end. A failed send keeps the place: the next pass sends the same piece again.
func (r *Runner) send(ctx context.Context, id string, t *Tail, start server.SessionStart, read func(int64) (Piece, error)) {
	for tries := 0; ctx.Err() == nil && tries < 1000; tries++ {
		p, err := read(t.Offset)
		if err != nil {
			r.Log.Printf("session %s: %v", id, err)
			return
		}
		if p.Next == p.At {
			return
		}
		_, err = r.Client.AppendSessionPiece(ctx, r.Root.FullName(), id, p.At, p.Next, start, p.Lines)
		var nae server.NotAtEnd
		var ae *server.APIError
		switch {
		case err == nil:
			t.Offset, t.Sent = p.Next, time.Now()
			if err := r.state.Save(); err != nil {
				r.Log.Print(err)
			}
		case errors.As(err, &nae):
			t.Offset = nae.End
		case errors.As(err, &ae) && ae.Code == "session_deleted":
			t.Deleted = true
			return
		default:
			r.Log.Printf("session %s: %v", id, err)
			return
		}
	}
}
