package meta

// Entry points for cli/cmd/pando/main.go (owned by the cli lane):
//
//	pando meta sync               CmdSync     the live sync, in the foreground
//	pando history <path>          CmdHistory
//	pando restore <path> --to X   CmdRestore
//	pando resolve [<path>]        CmdResolve
//	pando clone (after root.json) Download    the first download of the meta layer
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
)

// Download fetches the meta layer into root, which already holds
// .pando/local/root.json. pando clone calls it.
func Download(ctx context.Context, root string) error {
	cfg, err := LoadConfig(root)
	if err != nil {
		return err
	}
	e, err := New(cfg)
	if err != nil {
		return err
	}
	return e.CatchUp(ctx)
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
	return FindRoot(wd)
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
		return "", fmt.Errorf("%s is not in the meta layer at %s", arg, root)
	}
	return filepath.ToSlash(rel), nil
}

func setup(name string, args []string, stderr io.Writer) (*flag.FlagSet, *string, []string, error) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	root := fs.String("root", "", "the monorepo root (default: found from the current folder)")
	return fs, root, args, nil
}

// CmdSync runs the live sync until interrupted.
func CmdSync(args []string) int {
	fs, rootFlag, _, _ := setup("sync", args, os.Stderr)
	if _, err := parseArgs(fs, args); err != nil {
		return 2
	}
	root, err := rootFor(*rootFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pando:", err)
		return 1
	}
	cfg, err := LoadConfig(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pando:", err)
		return 1
	}
	e, err := New(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pando:", err)
		return 1
	}
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
	fs, rootFlag, _, _ := setup("history", args, stderr)
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
		who := v.Author
		if v.Agent != "" && !strings.Contains(who, v.Agent) {
			who += " (" + v.Agent + ")"
		}
		commit := "pending"
		if v.Commit != "" {
			commit = v.Commit[:min(len(v.Commit), 10)]
		}
		fmt.Fprintf(tw, "%d\t%s\t%s\t%s\t%s\t%s\n", v.Version, v.Time().Local().Format("2006-01-02 15:04:05"), who, v.Machine, describe(v), commit)
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
	}
	return fmt.Sprintf("save, %d bytes", v.Size)
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
	fs, rootFlag, _, _ := setup("restore", args, stderr)
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
	fs, rootFlag, _, _ := setup("resolve", args, stderr)
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
	fs, rootFlag, _, _ := setup("status", args, os.Stderr)
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

// CmdDownload is Download as a command, for setting up a folder by hand.
func CmdDownload(args []string) int {
	fs, rootFlag, _, _ := setup("download", args, os.Stderr)
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
	if err := Download(ctx, root); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, "pando:", err)
		return 1
	}
	return 0
}
