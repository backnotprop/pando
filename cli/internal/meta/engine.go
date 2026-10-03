package meta

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

// Engine keeps one meta layer folder in sync with its monorepo's object
// (docs/contracts/meta-sync.md, "The client's rules"). One goroutine owns all
// state; a reader goroutine per connection feeds it messages.
type Engine struct {
	cfg   Config
	rules *Rules
	st    *state
	dirty bool

	cache   map[string]*seen      // what the last scans saw, by path
	missing map[string]int        // synced files not on disk, by the pass that noticed
	frozen  map[string]Frozen     // paths frozen after a conflict
	held    map[string]*serverMsg // changes waiting for a clean file
	byFrom  map[string]*Op        // rename ops by their From
	pass    int

	conn     *websocket.Conn
	gen      int // connection number; events from older ones are dropped
	dialing  bool
	live     bool // caught up: changes flow both ways
	inflight map[string]*Op
	attempt  int
	nextDial time.Time
	lastPing time.Time
	quiet    bool // during a clone download: no line per file

	events chan event
	done   chan struct{}
	lock   *os.File

	client    *Client
	runCtx    context.Context
	downloads map[string]*serverMsg // large files being downloaded, by path
	dlRetry   map[string]time.Time  // when a failed download may try again
	transfers chan struct{}         // at most 2 uploads or downloads at a time

	untilSynced bool // return from Run once everything here is sent
	textOnly    bool // CatchUp for a --text-only clone (saved in the state)
	hooks       Hooks
	refsChanged map[string]bool // pointers written this pass
	hookBusy    chan struct{}   // one hook call at a time
}

// Hooks let the caller react to what the engine writes.
type Hooks struct {
	// References is called after the engine wrote or removed reference
	// pointers (.pando/references/**) that came from another machine, with
	// their paths. It runs in its own goroutine, one call at a time.
	References func(root string, pointers []string)
}

type seen struct {
	size, mtime int64
	firstMove   time.Time // when it started changing; zero once quiet
	sha         string    // git blob id of these bytes, once read
	oid         string    // SHA-256 of a large file or binary, once read
	why         string    // why it stays on this machine (over 100 MB)
}

// key names the bytes seen, for the refused list.
func (c *seen) key() string {
	if c.oid != "" {
		return "sha256:" + c.oid
	}
	return c.sha
}

type event struct {
	gen      int
	conn     *websocket.Conn
	msg      *serverMsg
	err      error
	upload   *uploadResult
	download *downloadResult
}

type uploadResult struct {
	op   *Op
	ptr  Pointer
	info os.FileInfo
	err  error
}

type downloadResult struct {
	m   *serverMsg
	ptr Pointer
	tmp string
	err error
}

// New makes an engine for cfg.Root. Call Run (the daemon) or CatchUp (clone).
func New(cfg Config) (*Engine, error) {
	cfg.defaults()
	if err := cfg.check(); err != nil {
		return nil, err
	}
	root, err := filepath.Abs(cfg.Root)
	if err != nil {
		return nil, err
	}
	cfg.Root = root
	rules, err := LoadRules(root)
	if err != nil {
		return nil, err
	}
	return &Engine{
		cfg:         cfg,
		rules:       rules,
		cache:       map[string]*seen{},
		missing:     map[string]int{},
		frozen:      map[string]Frozen{},
		held:        map[string]*serverMsg{},
		byFrom:      map[string]*Op{},
		inflight:    map[string]*Op{},
		events:      make(chan event, 256),
		done:        make(chan struct{}),
		refsChanged: map[string]bool{},
		hookBusy:    make(chan struct{}, 1),
		client:      NewClient(cfg),
		runCtx:      context.Background(),
		downloads:   map[string]*serverMsg{},
		dlRetry:     map[string]time.Time{},
		transfers:   make(chan struct{}, 2),
	}, nil
}

// Run syncs until ctx ends: it scans the folder, sends local changes, and
// writes changes from other machines. Offline, changes wait in the outbox.
func (e *Engine) Run(ctx context.Context) error {
	if err := e.open(); err != nil {
		return err
	}
	defer e.close()
	e.runCtx = ctx
	e.cfg.Log.Printf("syncing %s with %s (monorepo %s, machine %s)", e.cfg.Root, e.cfg.Server, e.cfg.Monorepo, e.cfg.Machine)
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev := <-e.events:
			e.handle(ctx, ev)
		case <-timer.C:
			// A scan takes at most a tenth of the time: on a big tree the
			// passes space out instead of using more of a core.
			took := e.tick(ctx)
			if e.untilSynced && e.synced() {
				return nil
			}
			timer.Reset(max(e.cfg.Poll, 10*took))
		}
	}
}

// synced reports whether everything here is on the server: online, nothing
// queued or in flight, nothing still changing or waiting to count as deleted.
func (e *Engine) synced() bool {
	if !e.live || len(e.st.Outbox) > 0 || len(e.inflight) > 0 || len(e.missing) > 0 || len(e.downloads) > 0 {
		return false
	}
	for _, c := range e.cache {
		if !c.firstMove.IsZero() {
			return false
		}
	}
	return true
}

// CatchUp downloads every change since this machine last synced (all of the
// meta layer on a new clone), writes it, and returns. It does not send.
func (e *Engine) CatchUp(ctx context.Context) error {
	if err := e.open(); err != nil {
		return err
	}
	defer e.close()
	e.quiet = true
	e.runCtx = ctx
	if e.textOnly {
		e.st.TextOnly = true
	}
	start := len(e.st.Files)
	e.dial(ctx)
	timeout := time.NewTimer(10 * time.Minute)
	defer timeout.Stop()
	for !e.live || len(e.downloads) > 0 || e.retryingDownloads() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timeout.C:
			return errors.New("the download did not finish in 10 minutes")
		case ev := <-e.events:
			if ev.err != nil && ev.gen == e.gen {
				return fmt.Errorf("download: %w", ev.err)
			}
			e.handle(ctx, ev)
		case <-time.After(time.Second):
			for _, m := range e.held {
				e.applyOne(m) // large files whose download is due again
			}
		}
	}
	e.cfg.Log.Printf("downloaded the meta layer: %d paths known (%d new), at version %d", len(e.st.Files), len(e.st.Files)-start, e.st.Cursor)
	return nil
}

func (e *Engine) retryingDownloads() bool {
	for p := range e.dlRetry {
		if e.held[p] != nil {
			return true
		}
	}
	return false
}

func (e *Engine) open() error {
	dir := stateDir(e.cfg.Root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dir, "lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return fmt.Errorf("another pando sync is running for %s", e.cfg.Root)
	}
	e.lock = f
	st, err := loadState(e.cfg.Root, e.cfg.Monorepo)
	if err != nil {
		return fmt.Errorf("reading %s: %w", dir, err)
	}
	e.st = st
	e.loadFrozen()
	return nil
}

func (e *Engine) close() {
	close(e.done)
	if e.conn != nil {
		e.conn.Close(websocket.StatusNormalClosure, "")
		e.conn = nil
	}
	e.saveState()
	if e.lock != nil {
		syscall.Flock(int(e.lock.Fd()), syscall.LOCK_UN)
		e.lock.Close()
	}
}

// saveState writes the state. The cursor saved never passes a held change, so
// a restart asks for it again.
func (e *Engine) saveState() {
	cursor := e.st.Cursor
	for _, h := range e.held {
		cursor = min(cursor, h.Version-1)
	}
	for _, d := range e.downloads {
		cursor = min(cursor, d.Version-1)
	}
	saved := *e.st
	saved.Cursor = cursor
	if err := saved.save(e.cfg.Root); err != nil {
		e.cfg.Log.Printf("could not save state: %v", err)
		return
	}
	e.dirty = false
}

func (e *Engine) abs(rel string) string { return filepath.Join(e.cfg.Root, filepath.FromSlash(rel)) }

func (e *Engine) logf(format string, args ...any) {
	if !e.quiet {
		e.cfg.Log.Printf(format, args...)
	}
}

// ---- the connection ----

func (e *Engine) socketURL() string {
	u := e.cfg.Server + "/v1/monorepos/" + url.PathEscape(e.cfg.Monorepo) + "/meta/socket"
	if strings.HasPrefix(u, "https://") {
		return "wss://" + strings.TrimPrefix(u, "https://")
	}
	if strings.HasPrefix(u, "http://") {
		return "ws://" + strings.TrimPrefix(u, "http://")
	}
	return u
}

func (e *Engine) post(ev event) {
	select {
	case e.events <- ev:
	case <-e.done:
	}
}

func (e *Engine) dial(ctx context.Context) {
	if e.dialing || e.conn != nil {
		return
	}
	e.dialing = true
	e.gen++
	gen := e.gen
	header := http.Header{}
	if e.cfg.Token != "" {
		header.Set("Authorization", "Bearer "+e.cfg.Token)
	}
	go func() {
		dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		c, _, err := websocket.Dial(dctx, e.socketURL(), &websocket.DialOptions{HTTPHeader: header})
		cancel()
		if err != nil {
			e.post(event{gen: gen, err: err})
			return
		}
		c.SetReadLimit(64 << 20)
		e.post(event{gen: gen, conn: c})
		for {
			typ, data, err := c.Read(ctx)
			if err != nil {
				e.post(event{gen: gen, err: err})
				return
			}
			if typ != websocket.MessageText || string(data) == "pong" {
				continue
			}
			var m serverMsg
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			e.post(event{gen: gen, msg: &m})
		}
	}()
}

func (e *Engine) write(ctx context.Context, v any) {
	if e.conn == nil {
		return
	}
	var data []byte
	if s, ok := v.(string); ok {
		data = []byte(s)
	} else {
		var err error
		if data, err = json.Marshal(v); err != nil {
			e.cfg.Log.Printf("encoding a message: %v", err)
			return
		}
	}
	wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := e.conn.Write(wctx, websocket.MessageText, data); err != nil {
		// The reader sees the broken socket too and reports it.
		e.live = false
		e.conn.CloseNow()
	}
}

func (e *Engine) hello(ctx context.Context) {
	e.write(ctx, helloMsg{
		Type: "hello", Since: e.st.Cursor, Author: e.cfg.Author, Machine: e.cfg.Machine,
		Agent: e.cfg.Agent, Client: "pando/0.1",
	})
}

func (e *Engine) handle(ctx context.Context, ev event) {
	if ev.upload != nil {
		e.uploaded(ctx, ev.upload)
		return
	}
	if ev.download != nil {
		e.downloaded(ev.download)
		return
	}
	if ev.gen != e.gen {
		if ev.conn != nil {
			ev.conn.CloseNow()
		}
		return
	}
	switch {
	case ev.conn != nil:
		e.dialing = false
		e.conn = ev.conn
		e.live = false
		e.hello(ctx)
	case ev.err != nil:
		wasUp := e.conn != nil
		e.dialing = false
		if e.conn != nil {
			e.conn.CloseNow()
			e.conn = nil
		}
		e.live = false
		for id, op := range e.inflight {
			op.id = ""
			delete(e.inflight, id)
		}
		wait := e.cfg.Backoff[min(e.attempt, len(e.cfg.Backoff)-1)]
		wait += time.Duration(rand.Int64N(int64(wait)/5 + 1)) // up to 20% jitter
		e.attempt++
		e.nextDial = time.Now().Add(wait)
		if wasUp || e.attempt == 1 {
			e.cfg.Log.Printf("offline (%v); changes wait in the outbox; retrying in %s", ev.err, wait.Round(100*time.Millisecond))
		}
	case ev.msg != nil:
		e.message(ctx, ev.msg)
	}
}

func (e *Engine) message(ctx context.Context, m *serverMsg) {
	e.dirty = true
	switch m.Type {
	case "welcome":
		if m.Head < e.st.Cursor {
			// The server's history is not the one this machine saw: start over,
			// keeping the bytes. Matching files are adopted as they arrive.
			e.cfg.Log.Printf("the server is at version %d, behind this machine's %d: syncing from the start", m.Head, e.st.Cursor)
			e.st.Cursor = 0
			for _, f := range e.st.Files {
				f.Version = 0
			}
		}
	case "change":
		e.apply(m)
		if e.live && m.Version > e.st.Cursor {
			e.st.Cursor = m.Version
		}
	case "caught_up":
		e.st.Cursor = max(e.st.Cursor, m.Head)
		if m.More {
			e.hello(ctx)
			return
		}
		e.live = true
		if e.attempt > 0 || !e.quiet {
			e.logf("online at version %d", e.st.Cursor)
		}
		e.attempt = 0
		e.flush(ctx)
	case "accepted":
		e.accepted(m)
		e.flush(ctx)
	case "stale":
		e.stale(m)
		e.flush(ctx)
	case "refused":
		e.refused(m)
		e.flush(ctx)
	case "error":
		e.cfg.Log.Printf("server: %s", m.Message)
	}
}

// ---- the folder ----

// tick is one pass: scan, held changes, connection, outbox. It returns how
// long the scan took.
func (e *Engine) tick(ctx context.Context) time.Duration {
	e.pass++
	if e.rules.Refresh() {
		e.logf("read .pando/pando.toml again")
	}
	e.loadFrozen()
	start := time.Now()
	e.scan(start)
	took := time.Since(start)
	for _, m := range e.held {
		e.applyOne(m)
	}
	now := time.Now()
	if e.conn == nil && !e.dialing && now.After(e.nextDial) {
		e.dial(ctx)
	}
	if e.live {
		e.flush(ctx)
		if now.Sub(e.lastPing) > e.cfg.PingEvery {
			e.write(ctx, "ping")
			e.lastPing = now
		}
	}
	if e.dirty {
		e.saveState()
	}
	e.callHooks()
	return took
}

func (e *Engine) loadFrozen() {
	list, err := ListFrozen(e.cfg.Root)
	if err != nil {
		return
	}
	next := make(map[string]Frozen, len(list))
	for _, f := range list {
		next[f.Path] = f
	}
	for p := range e.frozen {
		if _, still := next[p]; !still {
			e.logf("resolved %s: it syncs again", p)
		}
	}
	e.frozen = next
}

type newSave struct {
	op  *Op
	sha string
}

// scan walks the folder and queues what changed since the last sync.
func (e *Engine) scan(now time.Time) {
	present := map[string]bool{}
	var created []newSave
	root := e.cfg.Root
	filepath.WalkDir(root, func(abs string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		r, rerr := filepath.Rel(root, abs)
		if rerr != nil {
			return nil
		}
		rel := filepath.ToSlash(r)
		if d.IsDir() {
			if rel != "." && e.rules.SkipDir(rel) {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || !e.rules.SyncFile(rel) {
			return nil // symlinks and local-only files stay here
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		present[rel] = true
		if op := e.observe(rel, abs, info, now); op != nil {
			created = append(created, newSave{op, e.cache[rel].sha})
		}
		return nil
	})

	// Synced files that are gone: a delete, or a rename when one new file
	// has the same bytes. Never guessed from different bytes.
	paths := make([]string, 0)
	for rel, f := range e.st.Files {
		if f.SHA != "" && !present[rel] {
			paths = append(paths, rel)
		} else {
			delete(e.missing, rel)
		}
	}
	sort.Strings(paths)
	for _, rel := range paths {
		f := e.st.Files[rel]
		if _, err := os.Lstat(e.abs(rel)); err == nil {
			continue // still here, only not scanned (now inside a repo, say): not a delete
		}
		if _, frozen := e.frozen[rel]; frozen || e.st.Outbox[rel] != nil || e.byFrom[rel] != nil {
			continue
		}
		since, ok := e.missing[rel]
		if !ok {
			e.missing[rel] = e.pass
			continue
		}
		if since == e.pass {
			continue
		}
		delete(e.missing, rel)
		if e.renameInto(rel, f, created) {
			continue
		}
		e.queue(&Op{Kind: "delete", Path: rel, Base: f.Version})
	}
	for rel := range e.cache {
		if !present[rel] {
			delete(e.cache, rel)
		}
	}
}

// observe looks at one file. It returns the op it queued for a path that had
// no synced bytes (a rename candidate).
func (e *Engine) observe(rel, abs string, info fs.FileInfo, now time.Time) *Op {
	size, mt := info.Size(), info.ModTime().UnixNano()
	f := e.st.Files[rel]
	if f != nil && f.SHA != "" && f.Size == size && f.Mtime == mt {
		e.cache[rel] = &seen{size: size, mtime: mt, sha: f.SHA}
		return nil // synced and untouched
	}
	c := e.cache[rel]
	if c == nil || c.size != size || c.mtime != mt {
		first := now
		if c != nil && !c.firstMove.IsZero() {
			first = c.firstMove
		}
		c = &seen{size: size, mtime: mt, firstMove: first}
		e.cache[rel] = c
		if now.Sub(first) < e.cfg.MaxHold {
			return nil // still changing: wait for a quiet pass
		}
	}
	c.firstMove = time.Time{}
	if c.why != "" {
		return nil
	}
	if c.sha == "" && c.oid == "" {
		data, _, why, err := readSyncable(abs)
		if err != nil {
			return nil
		}
		switch why {
		case "":
			c.sha = gitSHA(data)
		case "too_large", "binary": // its bytes go to R2, a pointer goes live
			if size > MaxLarge {
				c.why = "over 100 MB"
				e.logf("%s stays on this machine (over 100 MB)", rel)
				return nil
			}
			oid, _, err := sha256File(abs)
			if err != nil {
				return nil
			}
			c.oid = oid
		default:
			c.why = strings.ReplaceAll(why, "_", " ")
			return nil
		}
	}
	if f != nil && f.SHA != "" && ((c.sha != "" && c.sha == f.SHA) || (c.oid != "" && c.oid == f.Oid)) {
		f.Size, f.Mtime = size, mt // touched, same bytes
		e.dirty = true
		return nil
	}
	if _, frozen := e.frozen[rel]; frozen {
		return nil
	}
	if e.st.Refused[rel] == c.key() || e.st.Outbox[rel] != nil || e.byFrom[rel] != nil {
		return nil // refused as it is, or already queued (its bytes are read when sent)
	}
	var base int64
	if f != nil {
		base = f.Version
	}
	op := e.queue(&Op{Kind: "save", Path: rel, Base: base})
	if f == nil || f.SHA == "" {
		return op
	}
	return nil
}

func (e *Engine) renameInto(from string, f *FileState, created []newSave) bool {
	var match *Op
	for _, c := range created {
		if c.sha != "" && c.sha == f.SHA && c.op.id == "" && c.op.Kind == "save" {
			if match != nil {
				return false // two candidates: not a rename
			}
			match = c.op
		}
	}
	if match == nil {
		return false
	}
	match.Kind, match.From, match.ToBase, match.Base, match.SHA = "rename", from, match.Base, f.Version, f.SHA
	e.byFrom[from] = match
	e.dirty = true
	return true
}

func (e *Engine) queue(op *Op) *Op {
	e.st.NextSeq++
	op.Seq = e.st.NextSeq
	e.st.Outbox[op.Path] = op
	if op.Kind == "rename" {
		e.byFrom[op.From] = op
	}
	e.dirty = true
	return op
}

func (e *Engine) removeOp(op *Op) {
	if e.st.Outbox[op.Path] == op {
		delete(e.st.Outbox, op.Path)
	}
	if op.From != "" && e.byFrom[op.From] == op {
		delete(e.byFrom, op.From)
	}
	if op.id != "" {
		delete(e.inflight, op.id)
		op.id = ""
	}
	e.dirty = true
}

// opFor is the queued or in-flight op touching rel, if any.
func (e *Engine) opFor(rel string) *Op {
	if op := e.st.Outbox[rel]; op != nil {
		return op
	}
	return e.byFrom[rel]
}

// ---- sending ----

func (e *Engine) flush(ctx context.Context) {
	if !e.live || e.conn == nil || len(e.st.Outbox) == 0 {
		return
	}
	ops := make([]*Op, 0, len(e.st.Outbox))
	for _, op := range e.st.Outbox {
		if op.id == "" {
			ops = append(ops, op)
		}
	}
	sort.Slice(ops, func(i, j int) bool { return ops[i].Seq < ops[j].Seq })
	for _, op := range ops {
		if len(e.inflight) >= e.cfg.MaxInFlight || !e.live {
			return
		}
		e.send(ctx, op, true)
	}
}

func (e *Engine) send(ctx context.Context, op *Op, mayConvert bool) {
	id := fmt.Sprintf("%d.%d", e.gen, op.Seq)
	switch op.Kind {
	case "save":
		data, info, why, err := readSyncable(e.abs(op.Path))
		if errors.Is(err, fs.ErrNotExist) {
			f := e.st.Files[op.Path]
			if f == nil || f.SHA == "" || !mayConvert {
				e.removeOp(op) // made and removed while offline: nothing to send
				return
			}
			op.Kind = "delete" // gone since it was queued
			e.send(ctx, op, false)
			return
		}
		if err != nil {
			return // try again on the next pass
		}
		if why == "too_large" || why == "binary" {
			e.sendLarge(ctx, op, id, info)
			return
		}
		if why != "" {
			e.removeOp(op)
			return
		}
		sha := gitSHA(data)
		if f := e.st.Files[op.Path]; f != nil && f.SHA == sha {
			f.Size, f.Mtime = info.Size(), info.ModTime().UnixNano()
			e.removeOp(op) // back to the synced bytes
			return
		}
		if data == nil {
			data = []byte{}
		}
		op.sentSHA, op.sentSize, op.sentMt = sha, info.Size(), info.ModTime().UnixNano()
		op.id = id
		e.inflight[id] = op
		e.write(ctx, saveMsg{Type: "save", ID: id, Path: op.Path, Base: op.Base, SHA: sha, Bytes: data})
	case "delete":
		if _, err := os.Lstat(e.abs(op.Path)); err == nil && mayConvert {
			op.Kind = "save" // back since it was queued
			e.send(ctx, op, false)
			return
		}
		op.id = id
		e.inflight[id] = op
		e.write(ctx, deleteMsg{Type: "delete", ID: id, Path: op.Path, Base: op.Base})
	case "rename":
		op.id = id
		e.inflight[id] = op
		e.write(ctx, renameMsg{Type: "rename", ID: id, From: op.From, Base: op.Base, Path: op.Path, ToBase: op.ToBase, SHA: op.SHA})
	}
}

// sendLarge uploads a large file's bytes to R2 in the background, then sends
// its pointer as the save.
func (e *Engine) sendLarge(ctx context.Context, op *Op, id string, info fs.FileInfo) {
	if info.Size() > MaxLarge {
		e.removeOp(op)
		return
	}
	if op.uploading || time.Now().Before(op.retryAt) {
		return
	}
	u := op.uploaded
	if u == nil || u.info.Size() != info.Size() || !u.info.ModTime().Equal(info.ModTime()) {
		op.uploading = true
		abs := e.abs(op.Path)
		go func() {
			e.transfers <- struct{}{}
			defer func() { <-e.transfers }()
			ptr, after, err := e.client.UploadFile(ctx, abs)
			e.post(event{upload: &uploadResult{op: op, ptr: ptr, info: after, err: err}})
		}()
		return
	}
	if f := e.st.Files[op.Path]; f != nil && f.Oid == u.ptr.Oid {
		f.Size, f.Mtime = info.Size(), info.ModTime().UnixNano()
		e.removeOp(op) // back to the synced bytes
		return
	}
	text := u.ptr.text()
	op.sentSHA, op.sentOid, op.sentSize, op.sentMt = gitSHA(text), u.ptr.Oid, info.Size(), info.ModTime().UnixNano()
	op.id = id
	e.inflight[id] = op
	e.write(ctx, saveMsg{Type: "save", ID: id, Path: op.Path, Base: op.Base, SHA: op.sentSHA, Bytes: text})
}

func (e *Engine) uploaded(ctx context.Context, r *uploadResult) {
	r.op.uploading = false
	if e.st.Outbox[r.op.Path] != r.op {
		return // dropped meanwhile
	}
	if r.err != nil {
		e.logf("could not upload %s: %v; trying again soon", r.op.Path, r.err)
		r.op.retryAt = time.Now().Add(10 * time.Second)
		return
	}
	r.op.uploaded = r
	e.logf("uploaded %s (%d bytes)", r.op.Path, r.ptr.Size)
	if e.live && r.op.id == "" {
		e.send(ctx, r.op, true)
	}
}

// ---- answers ----

func (e *Engine) accepted(m *serverMsg) {
	op := e.inflight[m.ID]
	if op == nil {
		return
	}
	switch op.Kind {
	case "save":
		e.st.Files[op.Path] = &FileState{Version: m.Version, SHA: op.sentSHA, Oid: op.sentOid, Size: op.sentSize, Mtime: op.sentMt}
		delete(e.st.Refused, op.Path)
		e.logf("sent %s (version %d)", op.Path, m.Version)
	case "delete":
		e.st.Files[op.Path] = &FileState{Version: m.Version}
		e.logf("sent the delete of %s (version %d)", op.Path, m.Version)
	case "rename":
		e.st.Files[op.From] = &FileState{Version: m.FromVersion}
		e.st.Files[op.Path] = &FileState{Version: m.Version, SHA: op.SHA, Size: -1, Mtime: -1}
		e.logf("sent the rename of %s to %s (version %d)", op.From, op.Path, m.Version)
	}
	e.removeOp(op)
	if h := e.held[op.Path]; h != nil && h.Version <= m.Version {
		delete(e.held, op.Path)
	}
	// On a live socket every version arrives in order, ours as answers.
	if e.live && m.Version > e.st.Cursor {
		e.st.Cursor = m.Version
	}
}

func (e *Engine) refused(m *serverMsg) {
	op := e.inflight[m.ID]
	if op == nil {
		return
	}
	if op.Kind == "save" {
		e.st.Refused[op.Path] = op.sentSHA
		if op.sentOid != "" {
			e.st.Refused[op.Path] = "sha256:" + op.sentOid
		}
	}
	e.removeOp(op)
	e.cfg.Log.Printf("the server refused %s: %s (%s)", m.Path, m.Message, m.Reason)
}

// stale is a lost race (409): the object had a newer version than our base.
func (e *Engine) stale(m *serverMsg) {
	op := e.inflight[m.ID]
	if op == nil {
		return
	}
	e.removeOp(op)
	cur := m.Current
	if cur == nil {
		cur = &Current{Deleted: true}
	}
	switch op.Kind {
	case "rename":
		// Split it; each half then meets its own rule.
		e.queue(&Op{Kind: "delete", Path: op.From, Base: op.Base})
		e.queue(&Op{Kind: "save", Path: op.Path, Base: op.ToBase})
		return
	case "delete":
		e.writeCurrent(op.Path, cur)
		if !cur.Deleted {
			e.cfg.Log.Printf("%s changed on %s before your delete arrived, so it is back", op.Path, cur.Machine)
		}
	case "save":
		p := op.Path
		data, err := os.ReadFile(e.abs(p))
		if err == nil && !cur.Deleted && gitSHA(data) == cur.SHA {
			e.adopt(p, cur.Version, cur.SHA, "") // the same bytes won
			break
		}
		if ptr, ok := parsePointer(cur.Bytes); err == nil && ok && op.sentOid == ptr.Oid {
			e.adopt(p, cur.Version, cur.SHA, ptr.Oid) // the same large file won
			break
		}
		copyRel := ""
		if err == nil {
			copyRel = e.freeConflictName(p)
			if _, werr := writeAtomic(e.abs(copyRel), data); werr != nil {
				e.cfg.Log.Printf("could not keep your copy of %s: %v; leaving it as it is", p, werr)
				return
			}
		}
		e.writeCurrent(p, cur)
		who := cur.Author
		if cur.Machine != "" {
			who += " on " + cur.Machine
		}
		if copyRel == "" {
			e.cfg.Log.Printf("%s: %s saved first; your file was already gone", p, who)
			break
		}
		fz := Frozen{Path: p, ConflictCopy: copyRel, Version: cur.Version, At: time.Now().UTC()}
		if err := freeze(e.cfg.Root, fz); err != nil {
			e.cfg.Log.Printf("could not freeze %s: %v", p, err)
		}
		e.frozen[p] = fz
		e.cfg.Log.Printf("conflict on %s: %s saved first. Your version is in %s. %s is frozen until: pando resolve %s", p, who, copyRel, p, p)
	}
	if h := e.held[op.Path]; h != nil && h.Version <= cur.Version {
		delete(e.held, op.Path)
	}
}

func (e *Engine) freeConflictName(rel string) string {
	now := time.Now()
	name := conflictName(rel, now)
	for i := 2; ; i++ {
		if _, err := os.Lstat(e.abs(name)); errors.Is(err, fs.ErrNotExist) {
			return name
		}
		name = conflictName(rel, now) + fmt.Sprintf("-%d", i)
	}
}

// writeCurrent makes the local file the object's current state.
func (e *Engine) writeCurrent(rel string, cur *Current) {
	e.noteWrite(rel)
	if ptr, ok := parsePointer(cur.Bytes); ok && !cur.Deleted && !e.st.TextOnly {
		// A large file: clear the way (its bytes here are kept by the caller)
		// and download the object's.
		if err := removeFile(e.cfg.Root, e.abs(rel)); err != nil {
			e.cfg.Log.Printf("could not remove %s: %v", rel, err)
			return
		}
		e.st.Files[rel] = &FileState{}
		delete(e.cache, rel)
		e.dirty = true
		e.applyOne(&serverMsg{Type: "change", Op: "save", Path: rel, Version: cur.Version, SHA: cur.SHA,
			Size: int64(len(cur.Bytes)), Bytes: cur.Bytes, Author: cur.Author, Machine: cur.Machine})
		_ = ptr
		return
	}
	if cur.Deleted {
		if err := removeFile(e.cfg.Root, e.abs(rel)); err != nil {
			e.cfg.Log.Printf("could not remove %s: %v", rel, err)
		}
		e.st.Files[rel] = &FileState{Version: cur.Version}
		delete(e.cache, rel)
		e.dirty = true
		return
	}
	info, err := writeAtomic(e.abs(rel), cur.Bytes)
	if err != nil {
		e.cfg.Log.Printf("could not write %s: %v", rel, err)
		return
	}
	e.st.Files[rel] = &FileState{Version: cur.Version, SHA: cur.SHA, Size: info.Size(), Mtime: info.ModTime().UnixNano()}
	e.cache[rel] = &seen{size: info.Size(), mtime: info.ModTime().UnixNano(), sha: cur.SHA}
	e.dirty = true
}

// adopt records the local file as synced at version (its bytes already match).
func (e *Engine) adopt(rel string, version int64, sha, oid string) {
	f := &FileState{Version: version, SHA: sha, Oid: oid}
	if sha != "" {
		if info, err := os.Lstat(e.abs(rel)); err == nil {
			f.Size, f.Mtime = info.Size(), info.ModTime().UnixNano()
		}
	}
	e.st.Files[rel] = f
	if op := e.opFor(rel); op != nil && op.id == "" {
		e.removeOp(op)
	}
	delete(e.held, rel)
	e.dirty = true
}

func (e *Engine) noteWrite(rel string) {
	if strings.HasPrefix(rel, ".pando/references/") {
		e.refsChanged[rel] = true
	}
}

// callHooks hands this pass's pointer changes to Hooks.References.
func (e *Engine) callHooks() {
	if len(e.refsChanged) == 0 || e.hooks.References == nil {
		return
	}
	select {
	case e.hookBusy <- struct{}{}:
	default:
		return // the last call is still running; these wait for the next pass
	}
	paths := make([]string, 0, len(e.refsChanged))
	for p := range e.refsChanged {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	e.refsChanged = map[string]bool{}
	go func() {
		defer func() { <-e.hookBusy }()
		e.hooks.References(e.cfg.Root, paths)
	}()
}

// ---- changes from other machines ----

func (e *Engine) apply(m *serverMsg) {
	if m.Op == "rename" && m.From != "" {
		if e.move(m) {
			return
		}
		e.applyOne(&serverMsg{
			Type: "change", Op: "delete", Path: m.From, Version: m.FromVersion, Deleted: true,
			Author: m.Author, Machine: m.Machine, At: m.At, Source: m.Source,
		})
	}
	e.applyOne(m)
}

// move applies a rename as a rename when both paths are clean here.
func (e *Engine) move(m *serverMsg) bool {
	from, to := m.From, m.Path
	if !e.rules.Receivable(from) || !e.rules.Receivable(to) {
		return false
	}
	ff, tf := e.st.Files[from], e.st.Files[to]
	if ff == nil || ff.SHA != m.SHA || ff.Version >= m.FromVersion || (tf != nil && tf.Version >= m.Version) {
		return false
	}
	if _, err := os.Lstat(e.abs(to)); err == nil {
		return false
	}
	if !e.clean(from) || e.opFor(to) != nil {
		return false
	}
	if err := os.MkdirAll(filepath.Dir(e.abs(to)), 0o755); err != nil {
		return false
	}
	if err := os.Rename(e.abs(from), e.abs(to)); err != nil {
		return false
	}
	removeFile(e.cfg.Root, e.abs(from)) // only empties folders now
	e.noteWrite(from)
	e.noteWrite(to)
	e.st.Files[from] = &FileState{Version: m.FromVersion}
	e.adopt(to, m.Version, m.SHA, ff.Oid)
	delete(e.cache, from)
	e.logf("%s moved %s to %s", who(m), from, to)
	return true
}

func who(m *serverMsg) string {
	if m.Machine != "" {
		return m.Author + " on " + m.Machine
	}
	return m.Author
}

// clean reports whether rel holds exactly what this machine last synced, with
// nothing queued or in flight for it.
func (e *Engine) clean(rel string) bool {
	if e.opFor(rel) != nil {
		return false
	}
	f := e.st.Files[rel]
	info, err := os.Lstat(e.abs(rel))
	if errors.Is(err, fs.ErrNotExist) {
		return f == nil || f.SHA == ""
	}
	if err != nil || !info.Mode().IsRegular() || f == nil || f.SHA == "" {
		return false
	}
	if info.Size() == f.Size && info.ModTime().UnixNano() == f.Mtime {
		return true
	}
	if f.Oid != "" {
		if oid, _, err := sha256File(e.abs(rel)); err == nil && oid == f.Oid {
			return true
		}
	}
	if info.Size() > MaxBytes {
		return false
	}
	data, err := os.ReadFile(e.abs(rel))
	return err == nil && gitSHA(data) == f.SHA
}

func (e *Engine) applyOne(m *serverMsg) {
	p := m.Path
	if !e.rules.Receivable(p) {
		return
	}
	f := e.st.Files[p]
	if f != nil && m.Version <= f.Version {
		delete(e.held, p)
		return // already have it
	}
	abs := e.abs(p)
	info, err := os.Lstat(abs)
	exists := err == nil
	if exists && !info.Mode().IsRegular() {
		e.held[p] = m
		return
	}
	if ptr, ok := parsePointer(m.Bytes); ok && !m.Deleted && e.wantBytes(p, exists, info) {
		e.applyLarge(m, ptr, exists, info)
		return
	}
	// The file already holds these bytes: a lost answer, or the same edit.
	if !exists && m.Deleted {
		e.adopt(p, m.Version, "", "")
		return
	}
	if exists && !m.Deleted && info.Size() == m.Size {
		if data, err := os.ReadFile(abs); err == nil && gitSHA(data) == m.SHA {
			e.adopt(p, m.Version, m.SHA, "")
			return
		}
	}
	if !e.clean(p) {
		if e.held[p] == nil {
			e.logf("holding %s from %s: it has changes here", p, who(m))
		}
		e.held[p] = m
		return
	}
	delete(e.held, p)
	e.noteWrite(p)
	if m.Deleted {
		if err := removeFile(e.cfg.Root, abs); err != nil {
			e.cfg.Log.Printf("could not remove %s: %v", p, err)
			return
		}
		e.st.Files[p] = &FileState{Version: m.Version}
		delete(e.cache, p)
		e.logf("%s deleted %s", who(m), p)
	} else {
		info, err := writeAtomic(abs, m.Bytes)
		if err != nil {
			e.cfg.Log.Printf("could not write %s: %v", p, err)
			return
		}
		e.st.Files[p] = &FileState{Version: m.Version, SHA: m.SHA, Size: info.Size(), Mtime: info.ModTime().UnixNano()}
		e.cache[p] = &seen{size: info.Size(), mtime: info.ModTime().UnixNano(), sha: m.SHA}
		e.logf("%s saved %s (version %d)", who(m), p, m.Version)
	}
	e.dirty = true
}

// ---- large files from other machines ----

// wantBytes reports whether a large file's bytes should be downloaded here:
// always, except on a --text-only clone, where only files already fetched
// (real bytes on disk, not a pointer) follow new versions.
func (e *Engine) wantBytes(rel string, exists bool, info fs.FileInfo) bool {
	if !e.st.TextOnly {
		return true
	}
	f := e.st.Files[rel]
	if !exists || f == nil || f.Oid == "" {
		return false
	}
	if info.Size() < 1024 {
		if b, err := os.ReadFile(e.abs(rel)); err == nil {
			if _, isPtr := parsePointer(b); isPtr {
				return false
			}
		}
	}
	return true
}

func (e *Engine) applyLarge(m *serverMsg, ptr Pointer, exists bool, info fs.FileInfo) {
	p := m.Path
	abs := e.abs(p)
	if exists && info.Size() == ptr.Size {
		if oid, _, err := sha256File(abs); err == nil && oid == ptr.Oid {
			e.adopt(p, m.Version, m.SHA, ptr.Oid) // already here
			return
		}
	}
	if !e.clean(p) {
		if e.held[p] == nil {
			e.logf("holding %s from %s: it has changes here", p, who(m))
		}
		e.held[p] = m
		return
	}
	if d := e.downloads[p]; d != nil && d.Version >= m.Version {
		return // already on its way
	}
	if t, ok := e.dlRetry[p]; ok && time.Now().Before(t) {
		e.held[p] = m
		return
	}
	delete(e.held, p)
	e.downloads[p] = m
	ctx := e.runCtx
	go func() {
		e.transfers <- struct{}{}
		defer func() { <-e.transfers }()
		tmp, err := e.client.DownloadTo(ctx, ptr, abs)
		e.post(event{download: &downloadResult{m: m, ptr: ptr, tmp: tmp, err: err}})
	}()
}

func (e *Engine) downloaded(r *downloadResult) {
	p := r.m.Path
	if e.downloads[p] != r.m {
		if r.tmp != "" {
			os.Remove(r.tmp) // a newer version is on its way
		}
		return
	}
	delete(e.downloads, p)
	if r.err != nil {
		e.cfg.Log.Printf("could not download %s: %v; trying again soon", p, r.err)
		e.dlRetry[p] = time.Now().Add(10 * time.Second)
		e.held[p] = r.m
		return
	}
	delete(e.dlRetry, p)
	if f := e.st.Files[p]; f != nil && r.m.Version <= f.Version {
		os.Remove(r.tmp)
		return
	}
	if !e.clean(p) {
		os.Remove(r.tmp)
		e.held[p] = r.m // edited while downloading: held, fetched again once clean
		return
	}
	abs := e.abs(p)
	if err := os.Rename(r.tmp, abs); err != nil {
		os.Remove(r.tmp)
		e.cfg.Log.Printf("could not write %s: %v", p, err)
		return
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return
	}
	e.st.Files[p] = &FileState{Version: r.m.Version, SHA: r.m.SHA, Oid: r.ptr.Oid, Size: info.Size(), Mtime: info.ModTime().UnixNano()}
	e.cache[p] = &seen{size: info.Size(), mtime: info.ModTime().UnixNano(), oid: r.ptr.Oid}
	e.noteWrite(p)
	e.dirty = true
	e.logf("%s saved %s (version %d, %d bytes from R2)", who(r.m), p, r.m.Version, r.ptr.Size)
}
