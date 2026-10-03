# Contract: meta layer sync (`worker/src/live/`, `cli/internal/meta/`)

Owner: the live lane. Callers: the Pando daemon on every machine (Go,
`cli/internal/meta`), `pando clone`, `pando history`, `pando restore`,
`pando resolve`, and the monorepo object (updates that arrive on the meta
layer's main through a reviewed branch). Ask pando-ops for changes.

## What it does

The meta layer is the monorepo's root: every file outside `projects/` and
outside references. It is plain files on every machine. A save on one machine
reaches every other machine within about a second, and becomes a git commit
on the meta layer's `main` after about 10 seconds of quiet.

One `MetaLayerObject` (a Durable Object with SQLite) per monorepo holds every
saved version. Each machine keeps one WebSocket to it.

## Words

- **version**: a number the object gives each accepted change. It counts up
  across the whole meta layer (1, 2, 3, ...), so it is also the cursor a
  machine uses to say what it has seen. A path's **current version** is the
  version of its latest change. A path that never existed, or whose latest
  change is a delete, is **absent**.
- **base version**: the version of the path a change was made on top of. `0`
  means "I had no such file".
- **sha**: the git blob id of the bytes: SHA-1 of `blob <size>\0<bytes>`,
  40 lowercase hex characters. The object checks it.
- **bytes**: file contents, base64 in JSON.

## What may be saved

The object refuses, and the client never sends:

| Rule | Paths | `reason` | `status` |
| --- | --- | --- | --- |
| Machine only | `.pando/local/**` (see `formats.md`, section 3) | `local_only` | 403 |
| Protected | the rest of `.pando/**` (changes only through a reviewed branch, or in `pando init`'s first upload), except reference pointers `.pando/references/**`, which are live | `protected` | 403 |
| Code | `projects/**` (code repos are not live) | `not_meta` | 403 |
| Local only | dependencies and build output: any `node_modules/`, `.pnpm-store/`, `dist/`, `build/`, `.wrangler/`, `.next/`, `.cache/`, `__pycache__/`, `.venv/` folder; event captures `*.ndjson`, `*.jsonl`; secrets: `.env*`, `.dev.vars*`, `.secrets/`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.mobileprovision`, `*.provisionprofile`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`; databases: `*.sqlite`, `*.sqlite3`, `*.db` and their `-wal`, `-shm`, `-journal` files; noise: `.git/`, `.DS_Store`, `*.swp`, `*~`, `.#*`; Pando's own files: `*.conflict-local-*`, `.*.pando-tmp-*` | `local_only` | 403 |
| Too large | more than 1.5 MiB (1,572,864 bytes) inline: send a pointer (below) | `too_large` | 413 |
| Binary | a NUL byte in the first 8,000 bytes (git's test) inline: send a pointer | `binary` | 415 |
| Missing blob | a Git LFS pointer whose bytes are not in R2 | `missing_blob` | 400 |
| Bad path | empty, absolute, `\`, NUL, `.` or `..` segments, empty segments, longer than 1,024 bytes | `bad_path` | 400 |
| Bad sha | `sha` does not match `bytes` | `bad_sha` | 400 |

The client also skips everything inside a folder with its own `.git` (a
directory or a file): such a folder is a repo or a reference, and only its
pointer under `.pando/references/` syncs (`formats.md`, section 4). It skips
symlinks, and anything matched by `local_only` in `.pando/pando.toml`
(`.gitignore` syntax, `formats.md` section 2). Binaries and files over
1.5 MiB go through R2 (below), up to 100 MB; a larger file stays on the
machine that made it.

## The WebSocket

`GET /v1/monorepos/{monorepo}/meta/socket` with `Upgrade: websocket`.
Every message is one JSON text frame. The text frame `ping` gets the text
frame `pong` without waking the object (send one every 30 s).

### Connecting and catching up

1. Client sends `hello`:

   ```json
   {"type": "hello", "since": 412, "author": "Ana <ana@example.com>", "machine": "ana-mbp", "agent": "agent-3", "client": "pando/0.1"}
   ```

   `since` is the last version this machine has seen in order (`0` on a new
   clone). `agent` is optional (`PANDO_AGENT`); when set, it is kept on every
   version this socket saves.

2. The object answers `welcome`:

   ```json
   {"type": "welcome", "head": 431, "monorepo": "acme", "max_bytes": 1572864}
   ```

   then the **latest** change of every path whose current version is above
   `since`, in version order, as `change` messages (below). Superseded
   versions are skipped. It sends at most about 4 MiB of bytes per page,
   then:

   ```json
   {"type": "caught_up", "head": 430, "more": true}
   ```

3. While `more` is `true`, the client applies the page, sets its cursor to
   `head`, and sends `hello` again with that `since`. The last page ends with
   `"more": false`. From then on the socket is **live**: it receives every
   new change as it is accepted. A socket that has not finished catching up
   gets no live changes, so nothing arrives twice or out of order.

The initial download on `pando clone` is this same catch-up with `since: 0`.

### Saving, deleting, renaming

Client to object. `id` is the client's own name for the request; the answer
carries it back.

```json
{"type": "save",   "id": "a1", "path": "decisions/HISTORY.md", "base_version": 412, "sha": "4b82...", "bytes": "IyBIaXN0b3J5Cg=="}
{"type": "delete", "id": "a2", "path": "notes/old.md", "base_version": 300}
{"type": "rename", "id": "a3", "from": "notes/a.md", "base_version": 301, "path": "notes/b.md", "to_base_version": 0, "sha": "9c1e..."}
```

The object accepts a change only if `base_version` equals the path's current
version, or the path is absent and `base_version` is `0`. A rename also needs
`to_base_version` to match `path` the same way, and `sha` to be `from`'s
current sha (a rename moves bytes unchanged; edited bytes are a delete and a
save). A rename takes two versions: a delete of `from`, then a save of
`path`.

**Accepted** (to the sender only):

```json
{"type": "accepted", "id": "a1", "path": "decisions/HISTORY.md", "version": 432, "sha": "4b82..."}
```

For a rename it also carries `"from": "notes/a.md", "from_version": 433`.

**Stale, 409** (the base did not match; to the sender only). It carries the
current state, bytes included, so the client can act without asking again:

```json
{"type": "stale", "id": "a1", "status": 409, "path": "decisions/HISTORY.md", "base_version": 412,
 "current": {"version": 431, "sha": "77aa...", "deleted": false, "author": "Ben <ben@example.com>",
             "machine": "ben-mbp", "at": 1790000000000, "bytes": "..."}}
```

**Refused** (to the sender only), with `reason` and `status` from the table
above:

```json
{"type": "refused", "id": "a1", "status": 403, "path": ".pando/pando.toml", "reason": "protected", "message": ".pando/ changes only through a reviewed branch"}
```

**Broadcast** (to every live socket except the sender's):

```json
{"type": "change", "op": "save", "path": "decisions/HISTORY.md", "version": 432, "sha": "4b82...", "size": 9,
 "bytes": "IyBIaXN0b3J5Cg==", "deleted": false, "author": "Ana <ana@example.com>", "machine": "ana-mbp",
 "agent": null, "at": 1790000000000, "source": "live"}
```

- `op` is `save`, `delete` or `rename`. A delete has `deleted: true`, no
  `sha` and no `bytes`. A rename carries `from` and `from_version` and the
  bytes.
- `source` is `live` (a save from a machine), `restore` (`pando restore`) or
  `main` (a reviewed branch merged into the meta layer's `main`; this is how
  `.pando/` changes reach machines).
- `at` is milliseconds since 1970, UTC.

**Error** (bad JSON, an unknown type, a save before `hello`):
`{"type": "error", "message": "..."}`. The socket stays open.

## The client's rules

- **Never overwrite unguarded.** Every change carries its base version.
- **Clean or dirty.** A local file is clean when its bytes are the bytes of
  the version this machine last synced, and no change of it is queued or in
  flight. A change from the object is written only over a clean file.
  Otherwise it is held.
- **Writing a received change** is what an editor does: the bytes go to a
  temporary file `.<name>.pando-tmp-<random>` in the same folder, which is
  then renamed over the file. A delete removes the file and any folder left
  empty. A rename moves the file when it is clean.
- **Sending a local change.** The daemon polls the folder (twice a second by
  default). A changed file is sent once it has stopped changing for one
  poll, or after 5 minutes of continuous change (the maximum hold). One
  change per path is in flight at a time; later edits go out after the
  answer, on top of the new version.
- **Renames are never guessed.** A delete and a create seen in one pass are
  sent as a rename only when the bytes are identical. Otherwise they go as a
  delete and a save.
- **Offline.** Changes wait in the outbox (kept on disk) with their original
  base versions and go out when the socket returns. Reconnects back off: 5,
  10, 30, then every 60 seconds.
- **A lost answer.** If a change arrives whose sha equals the local file's
  bytes, the client adopts it as synced and drops its own queued change. This
  covers an `accepted` lost to a dropped socket, and two machines making the
  same edit.
- **A lost race (409).** The client keeps its local bytes in
  `<name>.conflict-local-<UTC timestamp>.<ext>` beside the file (for example
  `HISTORY.conflict-local-20261003T104200Z.md`), writes the object's current
  bytes to the file (or removes it if the current state is a delete), and
  **freezes** the path. A losing delete just brings the file back, with no
  copy and no freeze. Conflict copies are local only.
- **Frozen.** A frozen path sends nothing. Changes from the object are written
  only while the file is untouched since the conflict, otherwise held.
  `pando resolve <path>` unfreezes it: if the file was edited, its bytes go
  out as a save on top of the version it was last synced to (a newer remote
  change makes a fresh conflict, never a silent overwrite).
- **Refused.** A refused change is dropped and not retried until the file
  changes again.

## The first upload (`pando init`)

`pando init` in a folder that is not a git repo uploads the folder's meta
layer to the new, empty monorepo. The first commit of a meta layer is not a
live edit, so it may carry `.pando/pando.toml` and the rest of `.pando/`
(never `.pando/local/`).

1. `POST /v1/monorepos/{monorepo}/meta/init` with `{"action": "start"}`
   opens the window. Only on an empty meta layer: otherwise 409
   `not_empty` ("use pando clone").
2. The client sends every file as ordinary `save` messages (base version 0).
   While the window is open the object accepts `.pando/` paths and makes no
   commits.
3. `{"action": "done"}` closes the window. Everything uploaded is committed
   at once, titled `Start the meta layer`.

A window left open closes by itself after 30 minutes.

## History and restore (HTTP)

All under `/v1/monorepos/{monorepo}/meta/`.

**`GET history?path=<path>&limit=50&before=<version>`**: every version of a
path, newest first. Without `path`, `GET history?since=<version>` lists every
change in the meta layer after that version, oldest first (an agent's "what
changed since I last looked").

```json
{"path": "decisions/HISTORY.md", "head": 440,
 "versions": [
   {"version": 432, "path": "decisions/HISTORY.md", "op": "save", "sha": "4b82...", "size": 9, "deleted": false,
    "author": "Ana <ana@example.com>", "machine": "ana-mbp", "agent": null, "at": 1790000000000, "source": "live",
    "from": null, "restored_from": null, "commit": "e1f0..."}
 ]}
```

`commit` is the meta layer commit that carries the version, or `null` until
it is committed. `large` is `{"oid", "size"}` when the version is a large
file's pointer (then `size` and `sha` are the pointer's), else `null`.

**`GET file?path=<path>&version=<version>`**: the bytes of the path as it
was at that version, that is its latest change at or before it (`version`
defaults to now). Headers `X-Pando-Version` (the change's own version) and
`X-Pando-Sha`. 404 when the path is absent then.

**`POST restore`** with `{"path": "...", "version": 420, "author": "...", "machine": "..."}`:
writes the path as it was at version 420 back as a new change on top of the current one
(`source: "restore"`, `restored_from: 420`), broadcast to every socket,
including the machine that asked. History is never rewritten. Restoring a
delete removes the file. Answers `{"path", "version", "sha", "restored_from"}`,
or `{"unchanged": true, "version"}` when the file already holds those bytes.

**`GET status`**: `{"head", "files", "uncommitted", "sockets", "last_commit", "commit_error"}`.

The CLI:

```sh
pando history decisions/HISTORY.md                # every version: who, when, from which machine
pando restore decisions/HISTORY.md --to 420       # a version number
pando restore decisions/HISTORY.md --to 10:42     # the latest version at or before 10:42 today, local time
pando resolve decisions/HISTORY.md                # unfreeze after a conflict
```

## Commits after quiet

When a path has had no change for 10 seconds, the object commits it to the
meta layer's `main` (the Artifacts repo `<monorepo>--meta`) through
gitwrite's `commitChanges` (see `gitwrite.md`). Paths that become due within
2 seconds of each other and share an author, machine and agent go in one
commit.

- A commit holds at most 1,000 files and about 24 MiB, so a big first
  upload becomes several commits.
- Message: `Save decisions/HISTORY.md` (also `Delete <path>`,
  `Rename <from> to <path>`, `Restore <path> to version <n>`; several paths:
  `Save 3 files`, the first 50 listed in the body), then the who-made-it trailers from
  `formats.md` section 6 (`Pando-Agent` when set, `Pando-Machine`; a save
  has no worktree) and `Pando-Version: <n>`.
- Author: whoever made the latest change, at the time they made it. The
  committer is the same person (gitwrite's default).
- The object keeps the last commit it wrote as the parent. On `ref_moved` it
  retries once with `actual` as the parent. Other failures leave the versions
  uncommitted and retry later; nothing live is lost, since the object holds
  every version.
- Changes with `source: "main"` are already on `main` and are not committed
  again.

## Updates from `main`

When a reviewed branch merges into the meta layer's `main`, the monorepo
object calls the meta layer object (a Durable Object RPC, not public):

```ts
await env.META.get(id).applyFromMain({
  monorepo: "acme",
  commit: "e1f0...",
  author: "Ana <ana@example.com>",
  changes: [{ path: ".pando/pando.toml", bytes: Uint8Array | null }],  // null: deleted
});
```

Each change becomes a version with `source: "main"`, with no base check (main
wins), and is broadcast. This is the only way `.pando/**` changes.

## Identity

Every request, the WebSocket upgrade included, carries
`Authorization: Bearer <pando token>` (`api-v1.yaml`). The Worker checks the
token and passes who it is to the object: the author is the token's name and
email, and an agent token's name is also the `agent`. The machine is always
the client's own word, from `hello` or the `restore` body. Until the Worker
checks tokens, the object takes `author` and `agent` from `hello` too.

Errors on the HTTP routes have the `/v1` shape:
`{"error": {"code": "...", "message": "..."}}`.

## Large files and binaries through R2

A binary, or a file over 1.5 MiB, has its bytes in R2 (bucket
`pando-dev-blobs`, key `meta/<monorepo>/<sha256>`) and a Git LFS pointer in
the meta layer (`formats.md`, section 5). The pointer is what is saved,
broadcast, kept in history and committed to git:

```
version https://git-lfs.github.com/spec/v1
oid sha256:<64 hex>
size <bytes>
```

The bytes move through the Worker. No machine holds R2 keys.

| Route | What |
| --- | --- |
| `HEAD /v1/monorepos/{monorepo}/meta/blobs/{sha256}` | 200 when the bytes are there |
| `PUT  /v1/monorepos/{monorepo}/meta/blobs/{sha256}` | upload, `Content-Length` required, at most 100 MB (413 above, the largest request a Worker takes); R2 checks the SHA-256 (400 `bad_sha`); 200 if already there |
| `GET  /v1/monorepos/{monorepo}/meta/blobs/{sha256}` | download |

- **Saving.** The client hashes the file (SHA-256), uploads it if `HEAD`
  says it is missing, then sends a `save` whose bytes are the pointer. The
  object accepts a pointer only if its bytes are in R2 with that size
  (`missing_blob` otherwise). Uploads run in the background, two at a time.
- **Receiving.** A change whose bytes are a pointer is downloaded in the
  background, checked against the SHA-256, and written over the file only
  if the file is still clean; until then the old bytes stay in place.
- **Clean.** A local large file is clean when its SHA-256 is the synced
  pointer's.
- **A lost race** on a large file keeps the local bytes in a conflict copy,
  as for text, then downloads the winner's bytes.
- **`pando clone --text-only`** (agent sandboxes) writes the pointer text in
  place of each large file and remembers the choice. `pando fetch <path>`
  downloads the bytes; a fetched file then follows new versions, the rest
  stay pointers.
- Files over 100 MB stay on the machine that made them. Bytes in R2 are
  kept, like every version.
