package app

import (
	"context"
	"encoding/json"
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
)

// The follower keeps this machine's read-only mains at the server's main.
// It subscribes to the monorepo's event stream for main moving
// (GET /v1/monorepos/{m}/events?topics=main:<repo>, api-v1.yaml) and moves
// main when a frame says so. It reconnects with ?since=<last seq>, does one
// branch-list read on a resync, backs off after failures, and still reads
// the branch list every 5 minutes as a safety net. A file:// server has no
// stream, so there it reads the branch list every 15 seconds.

const (
	followSafety   = 5 * time.Minute  // the slow poll, with the stream up
	followFilePoll = 15 * time.Second // a file:// server has no stream
	followPing     = 30 * time.Second // keep the socket open; recheck which mains are here
	followSilence  = 90 * time.Second // nothing heard for this long: reconnect
	followTopicMax = 10               // the server's limit per socket
)

var followBackoff = []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second, 60 * time.Second}

// followMains brings every read-only main on this machine to the server's
// main: one branch-list call per repo, and a refresh only where main moved.
func followMains(e *Env, root *config.Root) {
	ws, err := root.LoadWorktrees()
	if err != nil || len(ws) == 0 {
		return
	}
	srv, err := e.open(root)
	if err != nil {
		e.warnf("follow: %v", err)
		return
	}
	heads := map[string]string{}
	for _, w := range ws {
		if w.Branch != "main" || !w.ReadOnly {
			continue
		}
		head, ok := heads[w.Repo]
		if !ok {
			bl, err := srv.ListBranches(e.Ctx, root.Name, repoName(root, w.Repo), "open")
			if err != nil {
				e.warnf("follow %s: %v", w.Repo, err)
				continue
			}
			head = bl.DefaultHead
			heads[w.Repo] = head
		}
		moveMain(e, root, w.Repo, head)
	}
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

// frame is one message on the event stream.
type frame struct {
	Type       string `json:"type"` // event, resync, caught_up
	Seq        int64  `json:"seq"`
	Head       int64  `json:"head"`
	Kind       string `json:"kind"`
	Collection string `json:"collection"`
	Repo       string `json:"repo"`
	Row        struct {
		Repo        string `json:"repo"`
		DefaultHead string `json:"default_head"`
	} `json:"row"`
}

// follower runs one root's subscription.
type follower struct {
	e    *Env
	root *config.Root
	last int64 // the last event seq seen; 0 before the first caught_up
}

// run follows until ctx ends. safety is the slow poll's interval.
func (f *follower) run(ctx context.Context, safety time.Duration) {
	followMains(f.e, f.root)
	if !strings.HasPrefix(f.root.Server, "http") {
		f.pollEvery(ctx, followFilePoll)
		return
	}
	fails := 0
	lastPoll := time.Now()
	for ctx.Err() == nil {
		if time.Since(lastPoll) >= safety {
			followMains(f.e, f.root)
			lastPoll = time.Now()
		}
		names := sortedKeys(mainsHere(f.root))
		var wait time.Duration
		if len(names) == 0 {
			wait = followPing // nothing to follow yet; look again soon
		} else {
			up, err := f.subscribe(ctx, names, safety, &lastPoll)
			if ctx.Err() != nil {
				return
			}
			if up >= time.Minute {
				fails = 0
			}
			if err != nil {
				if fails == 0 || fails == len(followBackoff)-1 {
					f.e.warnf("follow: the event stream: %v; trying again (the branch list is read every %s meanwhile)", err, safety)
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

// subscribe holds one socket open until it breaks, the set of mains here
// changes, or ctx ends. It returns how long the socket was up.
func (f *follower) subscribe(ctx context.Context, names []string, safety time.Duration, lastPoll *time.Time) (time.Duration, error) {
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
	if err != nil {
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
	heard := time.Now()
	for {
		select {
		case <-ctx.Done():
			conn.Close(websocket.StatusNormalClosure, "")
			return time.Since(started), nil
		case err := <-readErr:
			return time.Since(started), err
		case data := <-frames:
			heard = time.Now()
			if string(data) == "pong" {
				continue
			}
			var fr frame
			if json.Unmarshal(data, &fr) != nil {
				continue
			}
			f.handle(fr, want, lastPoll)
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
			if time.Since(*lastPoll) >= safety {
				followMains(f.e, f.root)
				*lastPoll = time.Now()
			}
			// A main added or removed here: subscribe again for the new set.
			if now := sortedKeys(mainsHere(f.root)); strings.Join(now, ",") != strings.Join(names, ",") {
				conn.Close(websocket.StatusNormalClosure, "")
				return time.Since(started), nil
			}
		}
	}
}

func (f *follower) handle(fr frame, want map[string]bool, lastPoll *time.Time) {
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
	case "resync":
		// Too much was missed to replay: read the branch lists once.
		followMains(f.e, f.root)
		*lastPoll = time.Now()
		f.last = fr.Head
	case "caught_up":
		if f.last == 0 {
			// The first connect has no since: catch up with one read, so a
			// merge just before the socket opened is not missed.
			followMains(f.e, f.root)
			*lastPoll = time.Now()
		}
		if fr.Head > f.last {
			f.last = fr.Head
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
