package app

import (
	"bufio"
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"time"

	"pando/internal/gitx"
	"pando/internal/worktree"
)

// A history too large for one push goes up in steps (pando init, the first
// push of main). One push carries at most worktree.PushLimit (64 MiB,
// Artifacts' limit), and main takes only its first push, so the older
// commits go first to a side ref, StepsRef, oldest first, each step under
// the limit. main's own push then carries only what is left: git leaves out
// what the server's refs already reach.
//
// Steps follow main's first-parent line. They are planned from the size of
// the files each commit adds (their size on disk, a rough guide) to about a
// quarter of the limit (stepTarget), and each is measured exactly with the
// pre-push check before it goes: a step over the limit is cut in two. A
// single commit over the limit sends its files ahead of it on FilesRef: a
// tree holding one tree per share of the files, each share at most
// stepTarget, the tree growing by one share a push. git leaves out of a
// push everything inside a tree a server ref names, so the commit then
// carries only its own trees. (A commit a ref names does not do that: git
// walks only commits on main's own line.)
//
// Both refs are outside refs/heads, so the door records no branch, event or
// hook for them, and both are deleted once main is pushed. Each push to them
// is forced, to a ref only init writes, so sending one again after a failure
// is always safe.
const (
	StepsRef = "refs/pando/import"
	FilesRef = "refs/pando/import-files"
)

// stepTarget is the size a step aims at: a quarter of the limit (16 MiB).
// Smaller than one push can carry, because a long upload is the one a bad
// network breaks: from one Wi-Fi network, 10 MB pushes went 9 of 9 and
// 24 MB ones 5 of 8 (TLS "bad record mac" mid-upload), and a broken step is
// cheaper to send again.
func stepTarget(limit int64) int64 { return limit / 4 }

// pushSteps sends the history of `head` ahead of main's push until what is
// left fits one push. It answers the side refs it wrote (to delete after
// main's push): none when the whole history fits one push.
func pushSteps(e *Env, g gitx.Cmd, label, cloneURL, head string) ([]string, error) {
	if fits, err := fitsOnePush(e, g, head, ""); err != nil || fits {
		return nil, err
	}
	limit := worktree.PushLimitNow()
	line, err := firstParents(e, g, head)
	if err != nil {
		return nil, err
	}
	tips := planSteps(line, stepTarget(limit))
	e.printf("%-44s history over %s, the most one push carries: pushing it in about %d steps\n", label, sizeText(limit), len(tips))
	var wrote []string
	push := func(src, ref string) error {
		if !slices.Contains(wrote, ref) {
			wrote = append(wrote, ref)
		}
		return pushRef(e, g, cloneURL, src, ref)
	}
	prev := ""
	from := -1 // line[from] is the newest commit already on the server
	for len(tips) > 0 {
		at := tips[0]
		tip := line[at].sha
		fits, err := fitsOnePush(e, g, tip, prev)
		if err != nil {
			return wrote, err
		}
		if !fits && at-from > 1 {
			tips = append([]int{from + (at-from)/2}, tips...) // a step over the limit, cut in two
			continue
		}
		if !fits {
			if err := sendFiles(e, g, label, tip, prev, stepTarget(limit), limit, push); err != nil {
				return wrote, err
			}
		}
		if at == len(line)-1 {
			return wrote, nil // the last step is main's own push
		}
		if err := push(tip, StepsRef); err != nil {
			return wrote, err
		}
		e.printf("%-44s pushed a step: %s (%d of %d commits)\n", label, short(tip), at+1, len(line))
		prev, from, tips = tip, at, tips[1:]
	}
	return wrote, nil
}

type lineCommit struct {
	sha  string
	size int64 // the disk size of the files it adds; 0 if none
}

// firstParents is head's first-parent line, oldest first, each commit with
// the disk size of the files it adds against its first parent (a merge's
// whole side branch). A file met before is not counted again.
func firstParents(e *Env, g gitx.Cmd, head string) ([]lineCommit, error) {
	out, err := g.Run(e.Ctx, "log", "--no-color", "--first-parent", "--reverse", "--root", "--diff-merges=first-parent", "--raw", "--no-abbrev", "--no-renames", "--format=@%H", head)
	if err != nil {
		return nil, err
	}
	var line []lineCommit
	added := map[string][]int{} // blob -> the commits adding it, in order
	for _, l := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(l, "@"):
			line = append(line, lineCommit{sha: l[1:]})
		case strings.HasPrefix(l, ":") && len(line) > 0:
			f := strings.Fields(l) // :old-mode new-mode old new status path
			if len(f) >= 5 && f[1] != "000000" && f[1] != "160000" {
				added[f[3]] = append(added[f[3]], len(line)-1)
			}
		}
	}
	if len(line) == 0 {
		return nil, fmt.Errorf("no commits in %s", short(head))
	}
	blobs := make([]string, 0, len(added))
	for b := range added {
		blobs = append(blobs, b)
	}
	sizes, err := blobSizes(e, g, blobs, "%(objectsize:disk)")
	if err != nil {
		return nil, err
	}
	for blob, at := range added {
		line[at[0]].size += sizes[blob]
	}
	return line, nil
}

// planSteps cuts the line into steps of about `target` bytes: the index of
// each step's newest commit, the last always head.
func planSteps(line []lineCommit, target int64) []int {
	var tips []int
	var sum int64
	for i, c := range line {
		if sum > 0 && sum+c.size > target {
			tips = append(tips, i-1)
			sum = 0
		}
		sum += c.size
	}
	return append(tips, len(line)-1)
}

// fitsOnePush runs the pre-push check on `tip`, with what StepsRef already
// holds (`prev`) left out: whether it fits one push. A file over Artifacts'
// limit is an error, with the check's own words.
func fitsOnePush(e *Env, g gitx.Cmd, tip, prev string) (bool, error) {
	if prev == "" {
		prev = strings.Repeat("0", len(tip))
	}
	check := gitx.Cmd{Dir: g.Dir, Env: g.Env, Stdin: strings.NewReader(fmt.Sprintf("%s %s %s %s\n", StepsRef, tip, StepsRef, prev))}
	_, err := check.RunShell(e.Ctx, worktree.PrePushScript(), "pando", "")
	var ge *gitx.Error
	var exit *exec.ExitError
	switch {
	case err == nil:
		return true, nil
	case errors.As(err, &ge) && errors.As(err, &exit) && exit.ExitCode() == 2:
		return false, nil
	case errors.As(err, &ge):
		e.Stderr.Write([]byte(ge.Stderr))
		return false, errors.New("main is not pushed")
	}
	return false, err
}

// sendFiles pushes the files `tip` adds (beyond what `prev` reaches) to
// FilesRef in shares of `target` bytes or less by their whole size (one
// file over it goes alone): each push names a tree of one tree per share so
// far, so it carries one new share.
func sendFiles(e *Env, g gitx.Cmd, label, tip, prev string, target, limit int64, push func(src, ref string) error) error {
	args := []string{"rev-list", "--objects", "--no-object-names", tip}
	if prev != "" {
		args = append(args, "^"+prev)
	}
	out, err := g.Run(e.Ctx, args...)
	if err != nil {
		return err
	}
	objects := strings.Fields(out)
	sizes, err := blobSizes(e, g, objects, "%(objecttype) %(objectsize)")
	if err != nil {
		return err
	}
	var shares [][]string
	var sum int64
	for _, sha := range objects {
		size, ok := sizes[sha]
		if !ok {
			continue // a commit or a tree
		}
		if size > limit {
			return fmt.Errorf("a file in %s (%s) is over %s, the most one push carries", short(tip), sizeText(size), sizeText(limit))
		}
		if len(shares) == 0 || sum+size > target {
			shares, sum = append(shares, nil), 0
		}
		shares[len(shares)-1] = append(shares[len(shares)-1], sha)
		sum += size
	}
	e.printf("%-44s commit %s is over one push: sending its files ahead of it in %d parts\n", label, short(tip), len(shares))
	var top strings.Builder
	for i, share := range shares {
		var entries strings.Builder
		for n, sha := range share {
			fmt.Fprintf(&entries, "100644 blob %s\t%d\n", sha, n)
		}
		tree, err := mktree(e, g, entries.String())
		if err != nil {
			return err
		}
		fmt.Fprintf(&top, "040000 tree %s\t%d\n", tree, i)
		all, err := mktree(e, g, top.String())
		if err != nil {
			return err
		}
		if err := push(all, FilesRef); err != nil {
			return err
		}
	}
	return nil
}

func mktree(e *Env, g gitx.Cmd, entries string) (string, error) {
	return gitx.Cmd{Dir: g.Dir, Env: g.Env, Stdin: strings.NewReader(entries)}.Run(e.Ctx, "mktree")
}

// blobSizes reads the size in `format` (its last field) of each blob among
// `shas`; with a format that starts with %(objecttype), other objects are
// left out. Missing objects are left out.
func blobSizes(e *Env, g gitx.Cmd, shas []string, format string) (map[string]int64, error) {
	sizes := make(map[string]int64, len(shas))
	if len(shas) == 0 {
		return sizes, nil
	}
	in := gitx.Cmd{Dir: g.Dir, Env: g.Env, Stdin: strings.NewReader(strings.Join(shas, "\n") + "\n")}
	out, err := in.Run(e.Ctx, "cat-file", "--batch-check=%(objectname) "+format)
	if err != nil {
		return nil, err
	}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 2 || f[1] == "missing" || (len(f) == 3 && f[1] != "blob") {
			continue
		}
		if n, err := strconv.ParseInt(f[len(f)-1], 10, 64); err == nil {
			sizes[f[0]] = n
		}
	}
	return sizes, nil
}

// pushRef force-pushes `src` to `ref`. A push sent twice is harmless there,
// so it is tried again (up to 5 times, waiting 1, 2, 4 and 8 s) after a
// transport failure, the door's "push again", or the "not found" of a repo
// made a moment ago.
func pushRef(e *Env, g gitx.Cmd, cloneURL, src, ref string) error {
	args := append(worktree.AgentHeaderArgs(cloneURL, e.agentFor(nil)), "push", "--quiet", "--no-verify", "pando", "+"+src+":"+ref)
	for try, wait := 1, time.Second; ; try, wait = try+1, wait*2 {
		_, err := g.Run(e.Ctx, args...)
		if err == nil {
			return nil
		}
		msg := err.Error()
		if try == 5 || !(transportFailure(err) || strings.Contains(msg, "push again") || strings.Contains(msg, "not found")) {
			return err
		}
		e.warnf("a step of the history did not go (%s); trying again", firstLine(err))
		select {
		case <-e.Ctx.Done():
			return e.Ctx.Err()
		case <-time.After(wait):
		}
	}
}

// sizeText is a byte count as people read it: MiB from 1 MiB, else bytes.
func sizeText(n int64) string {
	if n >= 1<<20 {
		return fmt.Sprintf("%.0f MiB", float64(n)/(1<<20))
	}
	return fmt.Sprintf("%d bytes", n)
}
