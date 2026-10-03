package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"

	"pando/internal/config"
	"pando/internal/gitx"
	"pando/internal/server"
)

// The follower keeps this machine's read-only mains at the server's main
// (api-v1.yaml). It reads every repo's main with GET /heads (no Artifacts
// read on the server), then subscribes to the event stream from that read's
// seq (GET /events?topics=main:<repo>&since=<seq>, a WebSocket) and moves
// main when a default_heads frame says so. It reads heads again on every
// reconnect, on a resync frame, and every 5 minutes as a safety net; backs
// off after failures; and stops when the monorepo is deleted (close 4404, or
// a reconnect answered 404) or this user is no longer a member (a reconnect
// answered 403). A server without the stream (501), or a file:// server, is
// read every 15 s.
// A server without /heads (404) is read through the branch list instead.

const (
	followSafety   = 5 * time.Minute  // the slow poll, with the stream up
	followFilePoll = 15 * time.Second // a file:// server has no stream
	followPing     = 30 * time.Second // keep the socket open
	followLook     = 2 * time.Second  // how often worktrees.json is checked for changes (hello)
	followSilence  = 90 * time.Second // nothing heard for this long: reconnect
	followTopicMax = 10               // the server's limit per socket
)

var followBackoff = []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second, 60 * time.Second}

// followMains brings every read-only main on this machine to the server's
// main, and returns the event stream's seq at that read (0 when unknown).
// It reads GET /heads once; on a server without it, the branch list of each
// repo that has a read-only main here.
func followMains(e *Env, root *config.Root) int64 {
	here := mainsHere(root)
	if len(here) == 0 {
		return 0
	}
	srv, err := e.open(root)
	if err != nil {
		e.warnf("follow: %v", err)
		return 0
	}
	hs, err := srv.Heads(e.Ctx, root.FullName())
	if err == nil {
		for _, h := range hs.Heads {
			if path, ok := here[h.Repo]; ok {
				moveMain(e, root, path, h.Head)
			}
		}
		if hs.Seq != nil {
			return *hs.Seq
		}
		return 0
	}
	if server.StatusOf(err) != 404 {
		e.warnf("follow: %v", err)
		return 0
	}
	for name, path := range here {
		bl, err := srv.ListBranches(e.Ctx, root.FullName(), name, "open")
		if err != nil {
			e.warnf("follow %s: %v", path, err)
			continue
		}
		moveMain(e, root, path, bl.DefaultHead)
	}
	return 0
}

// moveMain asks for a repo's read-only main here to move, unless it is at
// head already or past it (an older frame arriving late).
func moveMain(e *Env, root *config.Root, repo, head string) {
	if head == "" {
		return
	}
	ws, _ := root.LoadWorktrees()
	for _, w := range ws {
		if w.Repo != repo || w.Branch != "main" || !w.ReadOnly {
			continue
		}
		g := gitx.Cmd{Dir: root.Abs(w.Path), Env: []string{"GIT_NO_LAZY_FETCH=1"}}
		local, err := g.Run(e.Ctx, "rev-parse", "HEAD")
		if err != nil || local == head {
			return
		}
		if _, err := g.Run(e.Ctx, "merge-base", "--is-ancestor", head, local); err == nil {
			return
		}
		requestMainRefresh(e, root, repo)
		return
	}
}

// mainsHere maps each repo's URL name to its path, for the repos with a
// read-only main on this machine.
func mainsHere(root *config.Root) map[string]string {
	ws, _ := root.LoadWorktrees()
	out := map[string]string{}
	for _, w := range ws {
		if w.Branch == "main" && w.ReadOnly {
			out[repoName(root, w.Repo)] = w.Repo
		}
	}
	return out
}

// workedHere is mainsHere narrowed to the repos this machine works in: it
// has a branch worktree there too. Only those follow each merge; the other
// mains move on the safety-net read of heads (and when a worktree is added
// there, which changes this set and so resubscribes, with a fresh read).
// The socket itself is held whenever there is any branch worktree here,
// for presence (C25), with topics=main when no main here is followed.
func workedHere(root *config.Root) map[string]string {
	ws, _ := root.LoadWorktrees()
	branches := map[string]bool{}
	for _, w := range ws {
		if w.Branch != "main" {
			branches[w.Repo] = true
		}
	}
	out := map[string]string{}
	for name, path := range mainsHere(root) {
		if branches[path] {
			out[name] = path
		}
	}
	return out
}

// eventsURL is the stream's WebSocket URL for these repos.
func eventsURL(root *config.Root, names []string, since int64) string {
	topics := "main"
	if len(names) > 0 && len(names) <= followTopicMax {
		ts := make([]string, len(names))
		for i, n := range names {
			ts[i] = "main:" + n
		}
		topics = strings.Join(ts, ",")
	}
	q := url.Values{"topics": {topics}}
	if since > 0 {
		q.Set("since", fmt.Sprint(since))
	}
	u := strings.TrimRight(root.Server, "/") + server.MonorepoPath(root.FullName()) + "/events?" + q.Encode()
	if strings.HasPrefix(u, "https://") {
		return "wss://" + strings.TrimPrefix(u, "https://")
	}
	return "ws://" + strings.TrimPrefix(u, "http://")
}

// debugf logs the follower's steps when PANDO_DEBUG=follow.
func (f *follower) debugf(format string, a ...any) {
	if os.Getenv("PANDO_DEBUG") == "follow" {
		fmt.Fprintf(f.e.Stderr, "%s follow: "+format+"\n", append([]any{time.Now().Format("15:04:05.000")}, a...)...)
	}
}

// frame is one message on the event stream.
type frame struct {
	Type string `json:"type"` // event, resync, caught_up
	Seq  int64  `json:"seq"`
	// Head is a commit sha on an event. Before pando-dev 08afe089 it was
	// also the stream's newest seq (a number) on caught_up and resync; it is
	// read raw so both parse, and that old number is used only when seq is
	// missing.
	Head       json.RawMessage `json:"head"`
	Kind       string          `json:"kind"`
	Collection string          `json:"collection"`
	Repo       string          `json:"repo"`
	Row        struct {
		Repo        string `json:"repo"`
		DefaultHead string `json:"default_head"`
	} `json:"row"`
}

// follower runs one root's subscription.
type follower struct {
	e    *Env
	root *config.Root
	last int64 // the newest event seq this machine has acted on
}

// errStop ends the follower: the monorepo is gone, or the stream is off.
type errStop struct{ why string }

func (e errStop) Error() string { return e.why }

// errGone is the server refusing the socket because this monorepo is not
// there for this caller any more: 404 not_found (deleted) or 403
// not_a_member (removed from it), as the Worker's members-only check
// answers. The follower stops on the second in a row, so one answer from a
// database replica that has not seen a new monorepo yet does not stop it.
type errGone struct{ why string }

func (e errGone) Error() string { return e.why }

// goneAnswer reads a refused upgrade: errGone for the Worker's answers for
// a deleted monorepo or a caller who is no longer a member, else nil. (401,
// a revoked credential, is retried: pando login writes a new one, and each
// try reads it again.)
func goneAnswer(root *config.Root, resp *http.Response) error {
	if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusForbidden {
		return nil
	}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if resp.Body != nil {
		_ = json.NewDecoder(resp.Body).Decode(&body) // the first 1,024 bytes, kept by websocket.Dial
	}
	switch {
	case resp.StatusCode == http.StatusNotFound && body.Error.Code == "not_found":
		return errGone{"the monorepo " + root.FullName() + " was deleted on the server; stopped following"}
	case resp.StatusCode == http.StatusForbidden && body.Error.Code == "not_a_member":
		why := body.Error.Message
		if why == "" {
			why = "not a member of " + root.FullName()
		}
		return errGone{why + "; stopped following"}
	}
	return nil
}

// catchUp reads heads, moves mains, and resumes the stream from that read.
func (f *follower) catchUp() {
	if seq := followMains(f.e, f.root); seq > f.last {
		f.last = seq
	}
}

// run follows until ctx ends. safety is the slow read's interval.
func (f *follower) run(ctx context.Context, safety time.Duration) {
	if !strings.HasPrefix(f.root.Server, "http") {
		f.pollEvery(ctx, followFilePoll)
		return
	}
	fails, gone := 0, 0
	f.catchUp()
	lastSafety := time.Now()
	for ctx.Err() == nil {
		names := sortedKeys(workedHere(f.root))
		var wait time.Duration
		if !hasBranchWorktree(f.root) {
			// No branch worktree here: no socket (and no presence); the
			// mains here move on the safety-net read alone. Look again
			// soon, for a worktree being added.
			if time.Since(lastSafety) >= safety {
				f.catchUp()
				lastSafety = time.Now()
			}
			wait = followLook
		} else {
			f.catchUp() // on every (re)connect
			up, err := f.subscribe(ctx, names, safety)
			if ctx.Err() != nil {
				return
			}
			var stop errStop
			if errors.As(err, &stop) {
				f.e.warnf("follow: %s", stop.why)
				if stop.why == streamOff {
					f.pollEvery(ctx, followFilePoll)
				}
				return
			}
			var g errGone
			if !errors.As(err, &g) {
				gone = 0
			} else if gone++; gone >= 2 {
				f.e.warnf("follow: %s", g.why)
				return
			}
			if up >= time.Minute {
				fails = 0
			}
			if err != nil {
				if fails == 0 || fails == len(followBackoff)-1 {
					f.e.warnf("follow: the event stream: %v; trying again", err)
				}
				wait = followBackoff[min(fails, len(followBackoff)-1)]
				fails++
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

const streamOff = "this server's event stream is off; reading main every 15 s instead"

// subscribe holds one socket open until it breaks, the set of mains here
// changes, or ctx ends. It returns how long the socket was up.
func (f *follower) subscribe(ctx context.Context, names []string, safety time.Duration) (time.Duration, error) {
	tok, err := f.e.Home.Token(f.root.Server)
	if err != nil {
		return 0, err
	}
	header := http.Header{}
	header.Set("Authorization", "Bearer "+tok)
	header.Set("User-Agent", "pando-cli/0.1")
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	conn, resp, err := websocket.Dial(dctx, eventsURL(f.root, names, f.last), &websocket.DialOptions{HTTPHeader: header})
	cancel()
	f.debugf("subscribe %v since=%d: err=%v", names, f.last, err)
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusNotImplemented {
			return 0, errStop{streamOff}
		}
		if resp != nil {
			if err := goneAnswer(f.root, resp); err != nil {
				return 0, err
			}
		}
		if resp != nil && resp.StatusCode != http.StatusSwitchingProtocols {
			return 0, fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		return 0, err
	}
	defer conn.CloseNow()
	started := time.Now()
	want := map[string]bool{}
	for _, n := range names {
		want[n] = true
	}

	frames := make(chan []byte, 64)
	readErr := make(chan error, 1)
	rctx, stopRead := context.WithCancel(ctx)
	defer stopRead()
	go func() {
		for {
			typ, data, err := conn.Read(rctx)
			if err != nil {
				readErr <- err
				return
			}
			if typ == websocket.MessageText {
				frames <- data
			}
		}
	}()

	// ended is why the socket ended: the server's 4404 (the monorepo was
	// deleted) stops the follower.
	ended := func(err error) (time.Duration, error) {
		if websocket.CloseStatus(err) == 4404 {
			return time.Since(started), errStop{"the monorepo " + f.root.FullName() + " was deleted on the server; stopped following"}
		}
		return time.Since(started), err
	}
	// writeFailed is why a write failed. Once the server has closed the
	// socket (4404 right after it opened, say) a write fails with no reason
	// given; the read side has the reason, a moment later.
	writeFailed := func(err error) (time.Duration, error) {
		select {
		case rerr := <-readErr:
			f.debugf("write error: %v; read error: %v", err, rerr)
			if websocket.CloseStatus(rerr) != -1 {
				err = rerr
			}
		case <-time.After(2 * time.Second):
		}
		return ended(err)
	}

	// Presence (C25): say which branch worktrees this machine has here, now
	// and whenever they change. Presence lives with the socket, so every
	// new socket says it again.
	ids := branchWorktreeIDs(f.root)
	if err := f.hello(ctx, conn, ids); err != nil {
		return writeFailed(err)
	}
	wtFile := filepath.Join(config.LocalDir(f.root.Dir), "worktrees.json")
	wtStamp := fileStamp(wtFile)
	look := time.NewTicker(followLook)
	defer look.Stop()

	ping := time.NewTicker(followPing)
	defer ping.Stop()
	heard, lastRead := time.Now(), time.Now()
	for {
		select {
		case <-ctx.Done():
			conn.Close(websocket.StatusNormalClosure, "")
			return time.Since(started), nil
		case err := <-readErr:
			f.debugf("read error: %v", err)
			return ended(err)
		case data := <-frames:
			heard = time.Now()
			if string(data) == "pong" {
				continue
			}
			f.debugf("frame %.200s", data)
			var fr frame
			if err := json.Unmarshal(data, &fr); err != nil {
				f.debugf("frame not understood: %v", err)
				continue
			}
			if fr.Type == "resync" {
				// Too much was missed to replay: read heads once and
				// resume from that read.
				conn.Close(websocket.StatusNormalClosure, "")
				f.last = 0
				return time.Since(started), nil
			}
			f.handle(fr, want)
		case <-ping.C:
			if time.Since(heard) > followSilence {
				return time.Since(started), fmt.Errorf("nothing heard for %s", followSilence)
			}
			wctx, c := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Write(wctx, websocket.MessageText, []byte("ping"))
			c()
			if err != nil {
				return writeFailed(err)
			}
			if time.Since(lastRead) >= safety {
				f.catchUp()
				lastRead = time.Now()
			}
		case <-look.C:
			// A worktree added or removed here (worktrees.json changed).
			if st := fileStamp(wtFile); st != wtStamp {
				wtStamp = st
				// The last branch worktree went: close, so this machine
				// stops counting as present here.
				if !hasBranchWorktree(f.root) {
					conn.Close(websocket.StatusNormalClosure, "")
					return time.Since(started), nil
				}
				// The repos followed changed: subscribe again (the new
				// socket says hello).
				if now := sortedKeys(workedHere(f.root)); strings.Join(now, ",") != strings.Join(names, ",") {
					conn.Close(websocket.StatusNormalClosure, "")
					return time.Since(started), nil
				}
				if now := branchWorktreeIDs(f.root); strings.Join(now, ",") != strings.Join(ids, ",") {
					ids = now
					if err := f.hello(ctx, conn, ids); err != nil {
						return writeFailed(err)
					}
				}
			}
		}
	}
}

// hello is the follower's presence frame on the event socket (C25): this
// machine and the ids of its branch worktrees in this monorepo. Each hello
// replaces the one before for this socket. The server answers hello_ok or
// error; handle ignores both.
func (f *follower) hello(ctx context.Context, conn *websocket.Conn, ids []string) error {
	b, err := json.Marshal(map[string]any{"type": "hello", "machine": f.e.Home.Machine, "worktrees": ids})
	if err != nil {
		return err
	}
	f.debugf("hello %d worktree(s)", len(ids))
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return conn.Write(wctx, websocket.MessageText, b)
}

var worktreeIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// branchWorktreeIDs is the ids (as sent to PutWorktree) of this machine's
// branch worktrees here, read-only mains left out, sorted, at most 1,000.
func branchWorktreeIDs(root *config.Root) []string {
	ws, _ := root.LoadWorktrees()
	ids := []string{}
	for _, w := range ws {
		if w.ReadOnly || w.Branch == "main" || !worktreeIDRe.MatchString(w.ID) {
			continue
		}
		ids = append(ids, w.ID)
	}
	sort.Strings(ids)
	if len(ids) > 1000 {
		ids = ids[:1000]
	}
	return ids
}

// hasBranchWorktree reports whether this machine has a branch worktree in
// this monorepo: the follower holds the event socket only then (C25).
func hasBranchWorktree(root *config.Root) bool {
	ws, _ := root.LoadWorktrees()
	for _, w := range ws {
		if !w.ReadOnly && w.Branch != "main" {
			return true
		}
	}
	return false
}

// fileStamp changes when the file is written.
func fileStamp(p string) string {
	st, err := os.Stat(p)
	if err != nil {
		return ""
	}
	return fmt.Sprint(st.ModTime().UnixNano(), st.Size())
}

func (f *follower) handle(fr frame, want map[string]bool) {
	switch fr.Type {
	case "event":
		if fr.Seq > f.last {
			f.last = fr.Seq
		}
		if fr.Collection != "default_heads" {
			return
		}
		name := fr.Row.Repo
		if name == "" {
			name = fr.Repo
		}
		if !want[name] {
			return
		}
		if path, ok := workedHere(f.root)[name]; ok {
			// In the background: frames keep coming while a refresh runs,
			// and coalesce (coalesce.go).
			go moveMain(f.e, f.root, path, fr.Row.DefaultHead)
		}
	case "caught_up":
		seq := fr.Seq
		if seq == 0 {
			_ = json.Unmarshal(fr.Head, &seq) // the old name, for one deploy
		}
		if seq > f.last {
			f.last = seq
		}
	}
}

func (f *follower) pollEvery(ctx context.Context, every time.Duration) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
		followMains(f.e, f.root)
	}
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// followerLock is the lock a running follower holds, so pando merge knows
// main will follow without its help.
func followerLock(root *config.Root) string {
	return filepath.Join(config.LocalDir(root.Dir), "follower.lock")
}

// holdFollowerLock takes the follower lock for as long as the process runs.
// A second follower for the same folder still runs; it just does not hold it.
func holdFollowerLock(root *config.Root) {
	f, err := os.OpenFile(followerLock(root), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return
	}
	if syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		f.Close()
		return
	}
	heldLocks = append(heldLocks, f) // kept open, and locked, until the process exits
}

var heldLocks []*os.File

// followerRunning reports whether a follower holds this folder's lock.
func followerRunning(root *config.Root) bool {
	f, err := os.OpenFile(followerLock(root), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return false
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return true
	}
	syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return false
}

// startFollowOnce moves this folder's read-only mains in a detached
// `pando worktree follow --once`, so pando merge need not wait for it. Tests
// replace it.
var startFollowOnce = func(root *config.Root) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	logf, err := os.OpenFile(filepath.Join(config.LocalDir(root.Dir), "follow-once.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer logf.Close()
	cmd := exec.Command(exe, "worktree", "follow", "--once")
	cmd.Dir = root.Dir
	cmd.Stdout, cmd.Stderr = logf, logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// Follow is `pando worktree follow [--once] [--poll 5m]`: keep this
// machine's read-only mains at the server's main until stopped.
func Follow(e *Env, args []string) error {
	fs := flags("worktree follow")
	once := fs.Bool("once", false, "read the branch lists once and stop")
	poll := fs.Duration("poll", followSafety, "the safety-net read of the branch lists, besides the event stream")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	root, err := e.root()
	if err != nil {
		return err
	}
	if *once {
		followMains(e, root)
		return nil
	}
	holdFollowerLock(root)
	(&follower{e: e, root: root}).run(e.Ctx, *poll)
	return nil
}

// StartFollower runs the follower in the background for the Pando root
// above dir, for as long as ctx lives. `pando meta sync` starts it so one
// daemon keeps a monorepo's meta layer and its mains current.
func StartFollower(ctx context.Context, dir string) {
	root, err := config.FindRoot(dir)
	if err != nil {
		return
	}
	e, err := NewEnv(ctx, strings.NewReader(""), os.Stdout, os.Stderr)
	if err != nil {
		return
	}
	holdFollowerLock(root)
	go (&follower{e: e, root: root}).run(ctx, followSafety)
}
