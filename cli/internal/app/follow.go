package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
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
// off after failures; and stops when the monorepo is deleted (close 4404). A
// server without the stream (501), or a file:// server, is read every 15 s.
// A server without /heads (404) is read through the branch list instead.

const (
	followSafety   = 5 * time.Minute  // the slow poll, with the stream up
	followFilePoll = 15 * time.Second // a file:// server has no stream
	followPing     = 30 * time.Second // keep the socket open; recheck which mains are here
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
	hs, err := srv.Heads(e.Ctx, root.Name)
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
		bl, err := srv.ListBranches(e.Ctx, root.Name, name, "open")
		if err != nil {
			e.warnf("follow %s: %v", path, err)
			continue
		}
		moveMain(e, root, path, bl.DefaultHead)
	}
	return 0
}

// moveMain refreshes a repo's read-only main here when it is not at head.
func moveMain(e *Env, root *config.Root, repo, head string) {
	if head == "" {
		return
	}
	ws, _ := root.LoadWorktrees()
	for _, w := range ws {
		if w.Repo != repo || w.Branch != "main" || !w.ReadOnly {
			continue
		}
		if local, err := gitx.In(root.Abs(w.Path)).Run(e.Ctx, "rev-parse", "HEAD"); err == nil && local != head {
			refreshMain(e, root, repo)
			return
		}
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

// eventsURL is the stream's WebSocket URL for these repos.
func eventsURL(root *config.Root, names []string, since int64) string {
	topics := "main"
	if len(names) <= followTopicMax {
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
	u := strings.TrimRight(root.Server, "/") + "/v1/monorepos/" + url.PathEscape(root.Name) + "/events?" + q.Encode()
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
	// Head is a number on caught_up and resync (the stream's newest seq),
	// and a commit sha on an event (main's new head), so it is read raw.
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
	fails := 0
	for ctx.Err() == nil {
		names := sortedKeys(mainsHere(f.root))
		var wait time.Duration
		if len(names) == 0 {
			wait = followPing // nothing to follow yet; look again soon
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
			if websocket.CloseStatus(err) == 4404 {
				return time.Since(started), errStop{"the monorepo " + f.root.Name + " was deleted on the server; stopped following"}
			}
			return time.Since(started), err
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
				return time.Since(started), err
			}
			if time.Since(lastRead) >= safety {
				f.catchUp()
				lastRead = time.Now()
			}
			// A main added or removed here: subscribe again for the new set.
			if now := sortedKeys(mainsHere(f.root)); strings.Join(now, ",") != strings.Join(names, ",") {
				conn.Close(websocket.StatusNormalClosure, "")
				return time.Since(started), nil
			}
		}
	}
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
		if path, ok := mainsHere(f.root)[name]; ok {
			moveMain(f.e, f.root, path, fr.Row.DefaultHead)
		}
	case "caught_up":
		var head int64
		if json.Unmarshal(fr.Head, &head) == nil && head > f.last {
			f.last = head
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
	go (&follower{e: e, root: root}).run(ctx, followSafety)
}
