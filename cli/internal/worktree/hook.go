package worktree

import (
	"context"
	"os"
	"path/filepath"

	"pando/internal/gitx"
)

// hookScript adds who made a commit as git trailers (formats.md, section 6).
//
// It is installed twice. As prepare-commit-msg it acts when the message came
// from -m or -F, so the trailers are there with no editor. As commit-msg it
// acts on the final message after any editor, so a message a person empties
// in the editor still aborts the commit as usual. `--if-exists replace`
// makes the second run, an --amend and a rebase replace Pando's lines
// instead of adding them twice. `--no-divider` keeps a "---" line the author
// wrote from being taken for a patch separator. The author's own lines are
// never changed.
const hookScript = `#!/bin/sh
# Pando: adds Pando-Agent, Pando-Worktree and Pando-Machine trailers.
# See docs/contracts/formats.md, section 6.
msg_file="$1"
case "$(basename "$0")" in
  prepare-commit-msg)
    [ "$2" = "message" ] || exit 0
    ;;
esac
[ -n "$msg_file" ] && [ -f "$msg_file" ] || exit 0
# A message with no text of its own (an emptied editor) stays empty, so git
# still aborts the commit. Comment lines and a "commit -v" diff do not count.
cc=$(git config --get core.commentChar 2>/dev/null)
[ "${#cc}" -eq 1 ] || cc='#'
awk -v cc="$cc" '
  index($0, cc " ------------------------ >8 ------------------------") == 1 { exit }
  substr($0, 1, 1) != cc && $0 ~ /[^[:space:]]/ { found = 1; exit }
  END { exit !found }' "$msg_file" || exit 0
worktree=$(git config --get pando.worktree)
machine=$(git config --get pando.machine)
agent="${PANDO_AGENT:-$(git config --get pando.agent)}"
set --
[ -n "$agent" ] && set -- "$@" --trailer "Pando-Agent: $agent"
[ -n "$worktree" ] && set -- "$@" --trailer "Pando-Worktree: $worktree"
[ -n "$machine" ] && set -- "$@" --trailer "Pando-Machine: $machine"
[ $# -gt 0 ] || exit 0
exec git interpret-trailers --in-place --no-divider --if-exists replace --where end "$@" "$msg_file"
`

// Identity is what the hook reads from the worktree's git config.
type Identity struct {
	Root     string // absolute Pando root
	Worktree string // worktree path from the root
	Machine  string
	Agent    string // optional
	Kind     string // fuse, sparse

	// The signed-in person (pando login): commits are authored as them.
	UserName  string
	UserEmail string
}

// InstallHook writes the hooks into gitDir/hooks, points core.hooksPath at
// them (so a global hooks folder does not hide them), and sets the pando.*
// config the hook reads.
func InstallHook(ctx context.Context, gitDir string, id Identity) error {
	hooks := filepath.Join(gitDir, "hooks")
	if err := os.MkdirAll(hooks, 0o755); err != nil {
		return err
	}
	for _, name := range []string{"prepare-commit-msg", "commit-msg"} {
		if err := os.WriteFile(filepath.Join(hooks, name), []byte(hookScript), 0o755); err != nil {
			return err
		}
	}
	g := gitx.Cmd{Env: []string{"GIT_DIR=" + gitDir}}
	set := [][2]string{
		{"core.hooksPath", hooks},
		{"pando.root", id.Root},
		{"pando.worktree", id.Worktree},
		{"pando.machine", id.Machine},
		{"pando.kind", id.Kind},
	}
	if id.Agent != "" {
		set = append(set, [2]string{"pando.agent", id.Agent})
	}
	if id.UserName != "" {
		set = append(set, [2]string{"user.name", id.UserName})
	}
	if id.UserEmail != "" {
		set = append(set, [2]string{"user.email", id.UserEmail})
	}
	for _, kv := range set {
		if _, err := g.Run(ctx, "config", kv[0], kv[1]); err != nil {
			return err
		}
	}
	return nil
}
