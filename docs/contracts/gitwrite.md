# Contract: server-side git writes (`worker/src/gitwrite/`)

Owner: the merge-engine lane. Callers: server-git (the merge endpoint in the
monorepo object) and live (commits of meta layer saves). Ask pando-ops for
changes.

## What it does

Two functions write commits to an Artifacts repo from inside the Worker,
without a clone:

- `mergeCommit` lands a branch on main with a two-parent merge commit.
- `commitChanges` writes one commit on a branch from a list of file changes.

## How it writes

The Artifacts Workers binding can read objects (`readCommit`, `readTree`,
`readBlob`, `log`) but has no call that writes a commit, a tree or a ref
(checked against the live docs on 2026-10-02). So gitwrite writes through
git's own push:

1. It reads trees and commits through the binding, only along the paths that
   changed.
2. It builds the new blob, tree and commit objects in the Worker and packs
   them into a small PACK v2 (zlib-deflated, no deltas).
3. It mints a short-lived write token with `repo.createToken("write", ...)`,
   sends one `old new ref` command plus the pack to the repo's
   `git-receive-pack`, and revokes the token afterwards.

It never clones. Memory grows with the number of changed directories and the
size of new file contents, not with the size of the repo.

## Calling it

```ts
import { mergeCommit, commitChanges, GitWriteError } from "../gitwrite";

const repo = { artifacts: env.ARTIFACTS, name: "pando-acme-web" };
```

`repo.artifacts` is the Artifacts namespace binding; `repo.name` is the repo
in that namespace. gitwrite opens and releases its own repo handle.

A person is `{ name, email, date? }`. `date` is a `Date` and defaults to now;
times are written in UTC (`+0000`).

### `mergeCommit(repo, opts)`

```ts
const result = await mergeCommit(repo, {
  base: "main",              // the branch that receives the merge
  head: "agent/ana/login",   // the branch to merge: a branch name or a full sha
  baseSha: "3f1c...",        // optional: the sha the caller expects main at
  message: "Login form\n\nReviewed on Pando.\n",
  author: { name: "Ana", email: "ana@example.com" },
  committer: { name: "Pando", email: "pando@example.com" }, // optional, defaults to author
  dryRun: false,             // optional: compute only, write nothing
});
```

It always writes a merge commit, even when main has not moved (like
`git merge --no-ff`): parent 1 is main's head, parent 2 is the branch head.

The merge is tree-level and three-way against the merge base:

- a path changed on one side only is taken from that side;
- a path changed identically on both sides is taken;
- a path changed differently on both sides is a conflict;
- a file's mode and content merge separately, so a mode change on one side
  and a content change on the other both land.

There is no text merging. A file both sides edited is a conflict even when
the edits touch different lines. The fix is on the branch: merge main into
it (`git pull origin main`), push, and merge again.

When there is more than one merge base (a criss-cross history, rare), the
newest is used.

Results (`status` tells them apart; every result also carries `stats`, see
below):

| `status` | Fields | Meaning |
| --- | --- | --- |
| `merged` | `sha`, `tree`, `old`, `mergeBase` | The merge commit `sha` is on `base`; `old` is the sha `base` was at. |
| `mergeable` | `tree`, `old`, `mergeBase` | Only with `dryRun: true`: it would merge cleanly. Nothing written. |
| `up_to_date` | `sha` | The branch head is already in `base`. Nothing written. |
| `conflict` | `paths`, `mergeBase` | Paths changed differently on both sides, sorted. Nothing written. |
| `ref_moved` | `expected`, `actual` | `base` is not at `baseSha`, or it moved while the merge was being written. Nothing was overwritten. Re-read and retry. |

### `commitChanges(repo, branch, opts)`

```ts
const result = await commitChanges(repo, "main", {
  parent: "9a0b...",         // the sha the branch is at now; null for a new branch with no history
  changes: [
    { path: "decisions/RULINGS.md", content: "# Rulings\n..." },
    { path: "scripts/run.sh", content: bytes, mode: "100755" },
    { path: "old/notes.md", delete: true },
  ],
  message: "Save decisions/RULINGS.md\n",
  author: { name: "Ana", email: "ana@example.com", date: savedAt },
  committer: { name: "Pando", email: "pando@example.com" }, // optional, defaults to author
});
```

- `parent` is both the new commit's parent and the expected current head of
  `branch`. If the branch does not exist yet, it is created at the new
  commit (on top of `parent`, or as a root commit when `parent` is `null`).
- `content` is a `string` (written as UTF-8) or a `Uint8Array`.
- `mode` is `"100644"` (a file), `"100755"` (an executable) or `"120000"` (a
  symlink; the content is its target). Without `mode`, an existing file keeps
  its mode and a new file is `"100644"`.
- Deleting a path that does not exist is not an error. A directory left empty
  disappears, as in git.
- Paths are repository-relative with `/` separators: no leading `/`, no
  empty, `.` or `..` segments, no `.git` segment, each path at most once.
- Branch names (here and in `mergeCommit`) are short names such as `main` or
  `agent/ana/login`, checked like `git check-ref-format`. A name that is 40
  hex characters is refused, because it reads as a sha.

Results:

| `status` | Fields | Meaning |
| --- | --- | --- |
| `committed` | `sha`, `tree` | The new commit is the head of `branch`. |
| `unchanged` | `sha` | The changes leave the tree as it was. Nothing written; `sha` is `parent`. |
| `ref_moved` | `expected`, `actual` | `branch` is not at `parent` (or moved during the push). Nothing was overwritten. |

`actual` is the sha the branch was seen at, or `null` when it does not exist
or is unknown.

### `stats`

Every result has `stats: { commitsRead, treesRead, objectsWritten, packBytes }`
for logs and tests. It is not part of the decision; read `status`.

## Errors

Anything that is not one of the results above throws a `GitWriteError` with a
`code` and a plain message:

| `code` | When |
| --- | --- |
| `invalid_input` | A bad path, mode, sha or a missing field; a change puts a file where a directory is or the reverse. |
| `not_found` | The repo, a branch, or a commit does not exist. |
| `no_merge_base` | The two histories share no commit. |
| `too_large` | The merge base search passed its budget (5,000 commits read). |
| `push_failed` | Artifacts' receive-pack refused the pack for a reason other than a moved ref. The message holds its words. |
| `artifacts` | An Artifacts call or request failed (status and message included; never the token). |

## Concurrency

Callers serialize writes per repo (merges in the monorepo object, saves in
the meta layer object). gitwrite does not lock anything. Every write sends a
real `old` sha, so if the ref moved in between, Artifacts refuses the update
and gitwrite returns `ref_moved`. A moved ref is never overwritten.

Tested on Artifacts: an update whose `old` is not the ref's current sha, or
that creates a ref which already exists, is answered `ng <ref> stale ref`,
and the ref stays where it was.

## Limits

- One file is at most 32 MB (Artifacts' blob limit).
- The merge base search reads at most 5,000 commits.
- A merge reads three trees (merge base, main, branch) for each directory
  that both sides changed. A directory changed on one side only is taken
  whole, unread. Tested: a merge in a 3,000-file repo where both sides
  changed `pkg-010/src/` read 9 trees.
- `commitChanges` reads one tree per directory on a changed path.
- Each call also makes a few Artifacts requests: resolve the branch with
  `log()`, `info()` for the remote, mint and revoke the write token, and the
  push itself.
