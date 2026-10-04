package meta

// Entry points for the cli lane (cli/cmd/pando/main.go and cli/internal/app):
//
//	pando clone, after root.json:  Clone(ctx, root[, opts]) the first download of the meta layer
//	pando fetch <path>...:         CmdFetch(args)           a large file's bytes on a --text-only clone
//	pando init, after root.json:   Init(ctx, root)          the first upload, .pando/ included
//	the daemon:                    Sync(ctx, root, hooks)   the live sync until ctx ends
//	pando sync [--once]:           CmdSync(args, hooks)
//	pando history <path>:          CmdHistory(args)
//	pando restore <path> --to X:   CmdRestore(args)
//	pando resolve [<path>]:        CmdResolve(args)
//
// Each Cmd takes the arguments after its command name and returns an exit code.

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"pando/internal/config"
)

// CloneOptions are pando clone's choices for the meta layer.
type CloneOptions struct {
	// TextOnly keeps large files and binaries as Git LFS pointers until
	// pando fetch <path> (agent sandboxes). It stays set for the daemon.
	TextOnly bool
}

// Clone downloads the meta layer into root, which already holds
// .pando/local/root.json, and returns once every file is written (large
// files included, unless TextOnly). It does not call Hooks.References: the
// caller sets up references after it.
func Clone(ctx context.Context, root string, opts ...CloneOptions) error {
	e, err := engineFor(root)
	if err != nil {
		return err
	}
	for _, o := range opts {
		e.textOnly = e.textOnly || o.TextOnly
	}
	return e.CatchUp(ctx)
}

// Init uploads the meta layer at root (which already holds
// .pando/local/root.json) to a new, empty monorepo: every file the live sync
// carries, plus .pando/pando.toml and the rest of .pando/ except .pando/local/.
// It returns once the server has all of it; the server then commits it as
// "Start the meta layer".
func Init(ctx context.Context, root string) error {
	e, err := engineFor(root)
	if err != nil {
		return err
	}
	c := NewClient(e.cfg)
	if err := c.initAction(ctx, "start"); err != nil {
		return fmt.Errorf("starting the first upload: %w", err)
	}
	e.rules.setFirst(true)
	e.untilSynced = true
	if err := e.Run(ctx); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return c.initAction(ctx, "done")
}

// Sync runs the live sync for root until ctx ends.
func Sync(ctx context.Context, root string, hooks Hooks) error {
	e, err := engineFor(root)
	if err != nil {
		return err
	}
	e.hooks = hooks
	return e.Run(ctx)
}

func engineFor(root string) (*Engine, error) {
	cfg, err := LoadConfig(root)
	if err != nil {
		return nil, err
	}
	return New(cfg)
}

// parseArgs parses flags placed before, between or after positional args.
func parseArgs(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		if fs.NArg() == 0 {
			return pos, nil
		}
		pos = append(pos, fs.Arg(0))
		args = fs.Args()[1:]
	}
}

func rootFor(flagRoot string) (string, error) {
	if flagRoot != "" {
		return filepath.Abs(flagRoot)
	}
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	r, err := config.FindRoot(wd)
	if err != nil {
		return "", err
	}
	return r.Dir, nil
}

// metaPath turns a path the user typed (relative to where they are) into a
// meta layer path (relative to the root, / separators).
func metaPath(root, arg string) (string, error) {
	abs, err := filepath.Abs(arg)
	if err != nil {
		return "", err
	}
	if r, err := filepath.EvalSymlinks(root); err == nil {
		if a, err := filepath.EvalSymlinks(filepath.Dir(abs)); err == nil {
			root, abs = r, filepath.Join(a, filepath.Base(abs))
		}
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("%s is not in the monorepo at %s", arg, root)
	}
	return filepath.ToSlash(rel), nil
}

func setup(name string, stderr io.Writer) (*flag.FlagSet, *string) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	root := fs.String("root", "", "the monorepo's folder (default: found from the current folder)")
	return fs, root
}

// CmdSync runs the live sync until interrupted; with --once, until this
// machine's changes are all on the server and it has every other change.
func CmdSync(args []string, hooks Hooks) int {
	fs, rootFlag := setup("sync", os.Stderr)
	once := fs.Bool("once", false, "send and receive what is waiting, then exit")
	if _, err := parseArgs(fs, args); err != nil {
		return 2
	}
	root, err := rootFor(*rootFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pando:", err)
		return 1
	}
	e, err := engineFor(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pando:", err)
		return 1
	}
	e.hooks = hooks
	e.untilSynced = *once
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := e.Run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "pando:", err)
		return 1
	}
	return 0
}

// CmdHistory prints every saved version of a path.
func CmdHistory(args []string) int {
	return cmdHistory(args, os.Stdout, os.Stderr)
}

func cmdHistory(args []string, stdout, stderr io.Writer) int {
	fs, rootFlag := setup("history", stderr)
	limit := fs.Int("limit", 50, "how many versions")
	asJSON := fs.Bool("json", false, "print JSON")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return 2
	}
	if len(pos) != 1 {
		fmt.Fprintln(stderr, "usage: pando history <path> [--limit n] [--json]")
		return 2
	}
	root, cfg, err := loadFor(*rootFlag)
	if err != nil {
		fmt.Fprintln(stderr, "pando:", err)
		return 1
	}
	p, err := metaPath(root, pos[0])
	if err != nil {
		fmt.Fprintln(stderr, "pando:", err)
		return 1
	}
	h, err := NewClient(cfg).History(context.Background(), p, *limit)
	if err != nil {
		fmt.Fprintln(stderr, "pando:", err)
		return 1
	}
	if *asJSON {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		enc.Encode(h)
		return 0
	}
	if len(h.Versions) == 0 {
		fmt.Fprintf(stdout, "%s has no saved versions\n", p)
		return 0
	}
	tw := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "VERSION\tWHEN\tWHO\tMACHINE\tWHAT\tCOMMIT")
	for _, v := range h.Versions {
		commit := "pending"
		if v.Commit != "" {
			commit = v.Commit[:min(len(v.Commit), 10)]
		}
		fmt.Fprintf(tw, "%d\t%s\t%s\t%s\t%s\t%s\n", v.Version, v.Time().Local().Format("2006-01-02 15:04:05"), v.Author, v.Machine, describe(v), commit)
	}
	tw.Flush()
	return 0
}

func describe(v Version) string {
	switch {
	case v.Source == "restore" && v.RestoredFrom != nil:
		return fmt.Sprintf("restore of %d", *v.RestoredFrom)
	case v.Source == "main":
		return "from main"
	case v.Op == "rename" && v.From != "":
		return "renamed from " + v.From
	case v.Op == "rename" && v.To != "":
		return "renamed to " + v.To
	case v.Deleted:
		return "delete"
	case v.Large != nil:
		return fmt.Sprintf("save, %s (large file)", humanBytes(v.Large.Size))
	}
	return fmt.Sprintf("save, %s", humanBytes(v.Size))
}

func humanBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 10<<10:
		return fmt.Sprintf("%d KB", n>>10)
	}
	return fmt.Sprintf("%d bytes", n)
}

func loadFor(flagRoot string) (string, Config, error) {
	root, err := rootFor(flagRoot)
	if err != nil {
		return "", Config{}, err
	}
	cfg, err := LoadConfig(root)
	if err != nil {
		return "", cfg, err
	}
	return root, cfg, cfg.check()
}

// CmdRestore writes an old version back as a new save that every machine gets.
func CmdRestore(args []string) int {
	return cmdRestore(args, os.Stdout, os.Stderr)
}

func cmdRestore(args []string, stdout, stderr io.Writer) int {
	fs, rootFlag := setup("restore", stderr)
	to := fs.String("to", "", "a version number, a time today (10:42), or a date and time (2026-10-03 10:42)")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return 2
	}
	if len(pos) != 1 || *to == "" {
		fmt.Fprintln(stderr, "usage: pando restore <path> --to <version | HH:MM | YYYY-MM-DD HH:MM>")
		return 2
	}
	root, cfg, err := loadFor(*rootFlag)
	if err != nil {
		fmt.Fprintln(stderr, "pando:", err)
		return 1
	}
	p, err := metaPath(root, pos[0])
	if err != nil {
		fmt.Fprintln(stderr, "pando:", err)
		return 1
	}
	c := NewClient(cfg)
	ctx := context.Background()
	version, err := resolveTo(ctx, c, p, *to, time.Now())
	if err != nil {
		fmt.Fprintln(stderr, "pando:", err)
		return 1
	}
	r, err := c.Restore(ctx, p, version, cfg.Author, cfg.Machine, cfg.Agent)
	if err != nil {
		fmt.Fprintln(stderr, "pando:", err)
		return 1
	}
	if r.Unchanged {
		fmt.Fprintf(stdout, "%s already holds that version (version %d); nothing to restore\n", p, r.Version)
		return 0
	}
	fmt.Fprintf(stdout, "restored %s to version %d, saved as version %d; every machine gets it\n", p, r.RestoredFrom, r.Version)
	return 0
}

// resolveTo turns --to into a version: a number as is, a time into the
// path's latest version at or before it.
func resolveTo(ctx context.Context, c *Client, path, to string, now time.Time) (int64, error) {
	if n, err := strconv.ParseInt(to, 10, 64); err == nil && n > 0 {
		return n, nil
	}
	// A time covers its whole minute or second: 10:42 is up to 10:42:59.999.
	var at time.Time
	layouts := []struct {
		layout string
		today  bool
		span   time.Duration
	}{
		{"15:04", true, time.Minute},
		{"15:04:05", true, time.Second},
		{"2006-01-02 15:04", false, time.Minute},
		{"2006-01-02 15:04:05", false, time.Second},
		{time.RFC3339Nano, false, 0},
	}
	for _, l := range layouts {
		t, err := time.ParseInLocation(l.layout, to, now.Location())
		if err != nil {
			continue
		}
		if l.today {
			t = time.Date(now.Year(), now.Month(), now.Day(), t.Hour(), t.Minute(), t.Second(), 0, now.Location())
		}
		at = t
		if l.span > 0 {
			at = t.Add(l.span - time.Millisecond)
		}
		break
	}
	if at.IsZero() {
		return 0, fmt.Errorf("--to %q is not a version, a time (10:42) or a date and time (2026-10-03 10:42)", to)
	}
	h, err := c.History(ctx, path, 1000)
	if err != nil {
		return 0, err
	}
	for _, v := range h.Versions { // newest first
		if !v.Time().After(at) {
			return v.Version, nil
		}
	}
	return 0, fmt.Errorf("%s has no version at or before %s", path, at.Format("2006-01-02 15:04:05"))
}

// CmdResolve unfreezes a path after a conflict, or lists the frozen paths.
func CmdResolve(args []string) int {
	return cmdResolve(args, os.Stdout, os.Stderr)
}

func cmdResolve(args []string, stdout, stderr io.Writer) int {
	fs, rootFlag := setup("resolve", stderr)
	pos, err := parseArgs(fs, args)
	if err != nil {
		return 2
	}
	root, err := rootFor(*rootFlag)
	if err != nil {
		fmt.Fprintln(stderr, "pando:", err)
		return 1
	}
	if len(pos) == 0 {
		list, err := ListFrozen(root)
		if err != nil {
			fmt.Fprintln(stderr, "pando:", err)
			return 1
		}
		if len(list) == 0 {
			fmt.Fprintln(stdout, "nothing is frozen")
			return 0
		}
		for _, f := range list {
			fmt.Fprintf(stdout, "%s  frozen since %s; your copy: %s\n", f.Path, f.At.Local().Format("2006-01-02 15:04"), f.ConflictCopy)
		}
		return 0
	}
	code := 0
	for _, arg := range pos {
		p, err := metaPath(root, arg)
		if err != nil {
			fmt.Fprintln(stderr, "pando:", err)
			code = 1
			continue
		}
		var copyRel string
		if list, _ := ListFrozen(root); list != nil {
			for _, f := range list {
				if f.Path == p {
					copyRel = f.ConflictCopy
				}
			}
		}
		ok, err := Unfreeze(root, p)
		switch {
		case err != nil:
			fmt.Fprintln(stderr, "pando:", err)
			code = 1
		case !ok:
			fmt.Fprintf(stderr, "pando: %s is not frozen\n", p)
			code = 1
		default:
			fmt.Fprintf(stdout, "%s syncs again; if you edited it, your version goes out now.", p)
			if copyRel != "" {
				fmt.Fprintf(stdout, " %s stays on this machine; delete it when you are done.", copyRel)
			}
			fmt.Fprintln(stdout)
		}
	}
	return code
}

// CmdStatus prints the object's summary (a debugging aid).
func CmdStatus(args []string) int {
	fs, rootFlag := setup("status", os.Stderr)
	if _, err := parseArgs(fs, args); err != nil {
		return 2
	}
	_, cfg, err := loadFor(*rootFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pando:", err)
		return 1
	}
	s, err := NewClient(cfg).Status(context.Background())
	if err != nil {
		fmt.Fprintln(os.Stderr, "pando:", err)
		return 1
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.Encode(s)
	return 0
}

// CmdClone and CmdInit are Clone and Init as commands, for the pando-meta dev
// binary and for setting up a folder by hand.
func CmdClone(args []string) int {
	textOnly := false
	return cmdRoot("clone", args, func(fs *flag.FlagSet) {
		fs.BoolVar(&textOnly, "text-only", false, "keep large files as pointers until pando fetch")
	}, func(ctx context.Context, root string) error {
		return Clone(ctx, root, CloneOptions{TextOnly: textOnly})
	})
}

func CmdInit(args []string) int { return cmdRoot("init", args, nil, Init) }

// CmdFetch downloads the bytes of large files kept as pointers.
func CmdFetch(args []string) int {
	fs, rootFlag := setup("fetch", os.Stderr)
	pos, err := parseArgs(fs, args)
	if err != nil {
		return 2
	}
	if len(pos) == 0 {
		fmt.Fprintln(os.Stderr, "usage: pando fetch <path>...")
		return 2
	}
	root, err := rootFor(*rootFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pando:", err)
		return 1
	}
	var paths []string
	for _, a := range pos {
		p, err := metaPath(root, a)
		if err != nil {
			fmt.Fprintln(os.Stderr, "pando:", err)
			return 1
		}
		paths = append(paths, p)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := Fetch(ctx, root, paths, os.Stdout); err != nil {
		return 1
	}
	return 0
}

func cmdRoot(name string, args []string, flags func(*flag.FlagSet), run func(context.Context, string) error) int {
	fs, rootFlag := setup(name, os.Stderr)
	if flags != nil {
		flags(fs)
	}
	if _, err := parseArgs(fs, args); err != nil {
		return 2
	}
	root, err := rootFor(*rootFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pando:", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, root); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, "pando:", err)
		return 1
	}
	return 0
}
