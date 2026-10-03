# Formats: layout, `.pando/pando.toml`, reference pointers, large-file pointers

Owner: the cli lane. Other lanes read this file and ask pando-ops for changes.
Version 1, 2026-10-03.

This file fixes the shapes on disk that more than one lane reads: where repos
and worktrees sit, the one config file, the pointer a reference leaves in the
meta layer, the pointer a large file leaves in history, and the lines Pando
adds to commits. The `/v1` API is in `api-v1.yaml`, the meta layer's sync in
`meta-sync.md`.

## 1. The layout, with no config file

There are two kinds of Pando root.

**A monorepo.** `pando init` in a folder that is not a git repo. The folder
is the root, and the root is the meta layer.

```
<root>/
  .pando/
    pando.toml                 optional; only what differs from the defaults
    references/<path>.toml     one pointer per reference (section 4)
    local/                     this machine only, never synced (section 3)
  AGENTS.md  decisions/ ...    the meta layer: plain files, live on every machine
  projects/
    <repo>/                    a repo: its own git history on the server
      worktrees/
        main/                  main, read-only, follows every merge
        <name>/                one branch, one agent
  research/infra/<x>/          a folder with its own .git outside projects/: a reference
```

**A plain git repo.** `pando init` in a folder that is itself a git repo. No
meta layer, no references. The repo path is `.`:

```
<root>/
  .pando/
    pando.toml                 optional; in a plain repo it is committed on main
    local/                     this machine only
  worktrees/
    main/                      main, read-only
    <name>/
```

On the machine that ran `pando init` in a plain git repo, the root is that
existing checkout; `pando init` adds `.pando/local/` and `worktrees/` to its
`.git/info/exclude` and changes nothing else in it.

### The rules

- **A repo** (a project) is a folder with its own git history that sits
  directly under `projects/`, or that `projects = [...]` names. Its git
  history may be at `projects/<repo>/.git` or, in the Workspaces layout, at
  `projects/<repo>/worktrees/main/.git`.
- **A reference** is any other folder with its own `.git` (a directory or a
  `.git` file), or a folder under `projects/` that `references = [...]` names.
- **Repo path**: the folder's path from the root, with `/` separators and no
  leading or trailing slash: `projects/workspaces`. A plain repo's path is `.`.
- **Worktree path**: `<repo path>/worktrees/<folder>/`, where `<folder>` is
  the branch name with each `/` replaced by `-` (`fix/login` mounts at
  `worktrees/fix-login/`). In a plain repo: `worktrees/<folder>/`.
- **Main** is the branch named `main` on the server. `pando init` pushes the
  repo's default local branch (`main`, else `master`, else the current
  branch) to `refs/heads/main`.
- Nothing inside a repo folder or a reference folder is part of the meta
  layer. The meta layer carries a reference's pointer, never its files.

## 2. `.pando/pando.toml`

Optional. It only changes a default. Every key is optional; unknown keys are
ignored with a warning, so older clients keep working.

```toml
# Only what differs from the defaults.

# Paths that never leave this machine, in .gitignore syntax, on top of the
# local-by-default list in meta-sync.md.
local_only = ["research/operational/stress-runs/", "research/reviews/integration-*/"]

# Git repos outside projects/ that are projects, not references.
projects = ["tools/release-scripts"]

# Git repos under projects/ that are references, not projects.
references = ["projects/vendored-sdk"]

# Per repo: the checks Merge waits for.
[repos."projects/workspaces"]
required_checks = ["ci"]
```

| Key | Type | Read by | Meaning |
| --- | --- | --- | --- |
| `local_only` | array of strings | live | Extra paths the meta layer never syncs, `.gitignore` syntax: a trailing `/` matches a folder, `*` matches within one path part, a pattern with no `/` before its end matches at any depth, any other pattern is anchored at the root. |
| `projects` | array of repo paths | cli, server | Folders outside `projects/` that are repos. |
| `references` | array of paths | cli, live | Folders under `projects/` that are references. |
| `repos."<repo path>".required_checks` | array of strings | server | Status contexts that must be green before Merge (a person may force past them). |

Where it lives: in a monorepo, at `<root>/.pando/pando.toml` in the meta
layer. In a plain repo, at `.pando/pando.toml` on the repo's main branch, so it
changes through a reviewed branch like any other file. The server reads
`required_checks` from that copy; for a plain repo the table is
`[repos."."]`.

## 3. `.pando/local/`: this machine only

Never synced, never committed. The live sync skips the whole folder. Any lane
may keep machine state here under its own file name; the cli lane owns these
two files.

`.pando/local/root.json`, written by `pando init` and `pando clone`:

```json
{
  "version": 1,
  "kind": "monorepo",
  "name": "workspaces",
  "server": "https://pando-dev.example.workers.dev",
  "repos": [
    { "path": "projects/workspaces", "git_url": "https://pando-dev.example.workers.dev/git/workspaces/projects/workspaces.git" }
  ]
}
```

`kind` is `monorepo` or `repo`. `server` is the Pando server this root belongs
to. `repos` is a cache of the server's list (the server is the truth).

`.pando/local/worktrees.json`: the worktrees this machine has made under this
root.

```json
{
  "version": 1,
  "worktrees": [
    {
      "id": "wt_3f2a9c1d7b6e4a50",
      "repo": "projects/workspaces",
      "branch": "decision-chips",
      "path": "projects/workspaces/worktrees/decision-chips",
      "kind": "fuse",
      "agent": "agent-1",
      "created_at": "2026-10-03T18:20:00Z"
    }
  ]
}
```

`kind` is `fuse` (ArtifactFS on Linux), `sparse` (the blobless sparse clone,
the Mac fallback today) or `fskit` (the Mac mount, later). `id` is made by the
client and is the key in the server's worktree registry.

## 4. The reference pointer

One file per reference, in the meta layer, at
`.pando/references/<reference path>.toml`. The reference at
`research/infra/cloudflare/workers-oauth-provider` has its pointer at
`.pando/references/research/infra/cloudflare/workers-oauth-provider.toml`:

```toml
# A reference: someone else's git repo, kept here to read.
# Pando syncs this pointer, never the files.
url = "https://github.com/cloudflare/workers-oauth-provider.git"
ref = "refs/heads/main"
commit = "0123456789abcdef0123456789abcdef01234567"
```

| Key | Required | Meaning |
| --- | --- | --- |
| `url` | yes | Where any machine fetches it. Never carries credentials: `pando init` strips a user or token from the URL before writing it. A local path or `file://` URL cannot be a reference. |
| `ref` | yes | The upstream ref `pando reference update` follows; the remote's default branch when the pointer is made. |
| `commit` | yes | The exact commit every machine shows, 40 or 64 hex characters, lower case. |

What a machine does with it:

- **The machine that has the real repo** keeps it as it is.
- **Every other machine** shows the folder read-only at `commit`: on Linux an
  ArtifactFS mount, on a Mac a blobless clone with read-only files until the
  FSKit mount lands. Every file is listed; contents come from `url`.
- **A machine that cannot fetch it** (a private repo, no access) makes the
  folder with one file, `PANDO-UNAVAILABLE.txt`, that says which URL failed
  and why. It is never left empty.
- **`pando reference update <path>`** asks `url` for the newest commit of
  `ref` and rewrites `commit`. The live sync carries the new pointer, and every
  machine moves its folder to that commit.

## 5. The large-file pointer (Git LFS format)

When the meta layer stores a binary, or a file over 1.5 MiB, outside git (R2,
in the live lane's M7 work), the file's place in the meta layer's history
holds a Git LFS pointer, byte for byte as the Git LFS spec v1 writes it:

```
version https://git-lfs.github.com/spec/v1
oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393
size 12345
```

- Exactly three lines, each `key value` and a `\n`, in this order (`version`
  first, the rest sorted by key). No other keys.
- `oid` is the SHA-256 of the file's bytes, 64 lower-case hex characters.
  `size` is its length in bytes, in decimal.
- A file is a pointer only if it parses exactly this way and is under 1024
  bytes; otherwise it is an ordinary file.
- The bytes are stored and served by content hash; how they move is in
  `meta-sync.md`. Because the format is Git LFS's own, `git lfs` and other git
  tools recognise these files.

## 6. Who made a commit: trailers

Every Pando worktree has a `prepare-commit-msg` hook that adds these lines to
the end of each commit message, as git trailers. Meta layer saves carry the
same lines.

```
Pando-Agent: agent-3
Pando-Worktree: projects/workspaces/worktrees/oauth
Pando-Machine: ramos-mbp
```

| Trailer | Value | When |
| --- | --- | --- |
| `Pando-Agent` | `PANDO_AGENT` from the environment at commit time, else the `--agent` given to `pando worktree add` | only when one of them is set |
| `Pando-Worktree` | the worktree path from the root (section 1) | always |
| `Pando-Machine` | the machine name (section 7) | always |

The hook uses `git interpret-trailers --if-exists replace`: it never changes
the lines the author wrote, and on `--amend` or a rebase it replaces its own
lines instead of adding them twice.

The worktree's git config holds the values the hook reads: `pando.worktree`,
`pando.machine`, `pando.agent` (optional), plus `pando.root` (the root's
absolute path) and `pando.kind` (`fuse`, `sparse`).

## 7. `~/.pando/`: the machine's config

| Path | What |
| --- | --- |
| `~/.pando/config.toml` | `server = "https://..."` (the default server for `pando init` and `pando clone`), `machine = "..."` (optional; default: the host name up to its first dot) |
| `~/.pando/token` | the API token, mode 600. Written by `pando login` from standard input; never printed, logged, or passed on a command line. Git gets it through `pando credential`, a git credential helper. |
| `~/.pando/afs/` | ArtifactFS state on Linux: one folder per repo, each with its own daemon |

Environment overrides, for sandboxes: `PANDO_HOME` (instead of `~/.pando`),
`PANDO_SERVER`, `PANDO_TOKEN` (never printed), `PANDO_MACHINE`, `PANDO_AGENT`.
