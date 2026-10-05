# Sessions build: running notes

The lane that records coding agents' sessions and shows them in Pando.
Branch `sessions`, worktree `projects/pando/worktrees/sessions`. Ports 8869
to 8870, inspector 9369, its own `--persist-to` state. Gated by pando-ops
one stage at a time.

The design is settled: `decisions/RULINGS.md` ("Agent sessions" and the
rulings it names), `research/plans/agent-context-2026-10-04/REVIEW-4.md`,
`DETERMINISM.md` (what every field is), PROPOSAL.md L1 (capture, secrets,
storage, API outline; its sharing boundary, undo, titles and `pando why` are
removed).

## Where it stands

| Stage | State |
| --- | --- |
| 0. Prove three things | done, accepted by pando-ops 2026-10-05 |
| 1. Server: store and read | done, reported 2026-10-05. Claude Code and Codex fixtures wait on the owner's fixture logins |
| 2. Machine: capture | done, reported; waiting for the gate (and for cloud-agents to land, then a merge of main) |
| 3. Linking | not started |
| 4. Web | waits for the owner's approval of the final screens |
| 5. Docs, limits, recorded fixtures | not started |

## Stage 0 findings (2026-10-05)

Privacy: every measurement over the owner's own session files printed counts,
sizes and field names only. Nothing of theirs was copied or saved. The scripts
streamed trimmed lines straight into a request body.

### a. The session id reaches the commit hook

A throwaway repo per agent under `/tmp/pando-s0/<agent>`, with a
`prepare-commit-msg` hook that wrote the names of the session variables it saw
(values kept in files, compared, never printed). One short prompt each:
"Run exactly this one shell command ...: git commit --allow-empty -m placeholder".

| Agent | Version | Seen in the hook | Matches the session's store |
| --- | --- | --- | --- |
| Codex | 0.160.0 | `CODEX_THREAD_ID`, `CODEX_SESSION_ID` (equal for a main session) | yes, names the rollout file |
| Pi | 0.85.1 | `PI_SESSION_ID`, `PI_SESSION_FILE`; also sets `AI_AGENT=pi` | yes, the file's name holds the id and `PI_SESSION_FILE` is the file |
| OpenCode V2 | 2.0.22, built from `origin/v2` | `OPENCODE_SESSION_ID` | yes, a `session_v2` row with that id |

Nesting is real: each run started from inside Claude Code also carried
`CLAUDE_CODE_SESSION_ID` and `AI_AGENT=claude-code_...` from the outer
session. Codex and OpenCode do not set `AI_AGENT`. So the hook must pick the
nearest agent by walking its parent processes (PROPOSAL's rule), never by
which variable is present.

### b. OpenCode V2

- Not released: npm `opencode-ai` latest is 1.18.34. Built from
  `~/oss-agents/opencode` `origin/v2` (498b1deda3) by exporting it to
  `/tmp/pando-s0/oc2src` (the owner's clone untouched), `bun install`, then
  `script/build.ts --single --skip-install --skip-web-ui` with bun 1.4.2
  (installed privately in `/tmp/pando-s0/bun14`; the build refuses 1.3) and
  `OPENCODE_CHANNEL=latest OPENCODE_VERSION=2.0.22`, so it behaves like the
  release. Run with `XDG_*_HOME` pointed at scratch folders and a free model
  (`opencode/big-pickle`), so nothing of the owner's was read or written.
- Database: `<data>/opencode/opencode.db`, data being
  `$XDG_DATA_HOME` or `~/.local/share`; `OPENCODE_DB` overrides it. A
  non-release channel uses `opencode-<channel>.db`. The release uses the same
  file as V1 and migrates V1 into it, so V2 is told apart by the
  `session_v2` table (V1 already has a `session_message` table). WAL mode.
- Tables Pando reads:
  - `session_v2`: `id` (`ses_...`), `parent_id`, `directory` (absolute),
    `version`, `model` (JSON `{id, providerID, variant}`), `time_created`,
    `time_updated`, `title` (written by a model: never shown).
  - `session_message`: `id` (`msg_...`), `session_id`, `type`, `seq`
    (per session, unique, with gaps), `time_created`, `time_updated`, `data`
    (JSON). Types: user, assistant, synthetic, system, skill, shell,
    compaction, idle, agent-switched, model-switched, location-switched.
    An assistant row carries `model {id, providerID, variant}`,
    `content[]` of text, reasoning and tool parts (tool `state.input`,
    `state.content[]`), and `time.completed` when done.
- Rows change after insert: an assistant row is written at once and filled
  while it streams. OpenCode's own fork code copies only settled rows: an
  assistant row with `time.completed`, a shell or compaction row not
  `running`. Pando reads rows by `seq` in order and stops at the first
  unsettled row, resuming there. A revert deletes rows from a point on;
  what Pando already sent stays.

### c. The parser inside the Worker

Measured in a scratch Worker (`/tmp/pando-s0/wk`, workerd through wrangler
4.147.0, compatibility date 2026-10-01, `nodejs_compat`) with
`@letta-ai/trajectory` 0.4.3, on the largest real sessions, after the
machine's planned trim (strings of 200+ base64 or hex characters and `data:`
URLs become `[opaque N]`, strings cut at 64 KB, reasoning objects dropped).

| Session | Raw | Trimmed (what is sent) | Pieces of 8 MB | Parse time in workerd | Records |
| --- | --- | --- | --- | --- | --- |
| Claude Code, largest | 580 MB | 435 MB | 55, all parsed | 1.7 s (4.0 ms/MB) | 56,872 |
| Claude Code, 2nd | 316 MB | 228 MB | 29 | 1.0 s (4.5 ms/MB) | 35,680 |
| Claude Code, 3rd | 129 MB | 11 MB | 2 | 86 ms (7.6 ms/MB) | 1,716 |
| Codex, largest | 3,909 MB | 485 MB | 61 | 1.9 s (3.9 ms/MB) | 35,144 |
| Codex, 2nd | 1,989 MB | 397 MB | 49 | 1.4 s (3.5 ms/MB) | 12,984 |
| Codex, 3rd | 1,729 MB | 142 MB | 18 | 0.9 s (6.2 ms/MB) | 21,796 |

Memory (Node, same V8; local workerd does not enforce the cap): the piece's
text plus its parse peaks at about 5 times the piece. 2 MB: 11 MB. 8 MB:
42 MB. 16 MB: 74 to 84 MB. 32 MB: 116 to 148 MB, over a Worker's 128 MB.
The largest trimmed line is 1.2 MB (Codex), 0.17 MB (Claude Code).

What must be chunked:
- A session is parsed one piece at a time, never whole. Pieces are at most
  8 MB of trimmed text, cut at line ends. A line over the cap is replaced by
  a marker line on the machine.
- A long session is hundreds of MB even trimmed. Most of it is in records
  trajectory drops (Claude Code: queue operations, attachments, the
  `toolUseResult` copies; Codex: `item_completed` output kept three times,
  compacted history). The page reads the pieces it shows, not the session.
- `normalizeToCanonical` (stable record ids, needed to join Pando's
  per-answer model to records) costs about 40% more and needs the session id
  passed in for Codex pieces after the first.

The Codex gap: 381 Codex files here fail a whole-file parse (266 newer
subagents with `missing_user_records`, plus main sessions with a prompt and no
answer). All 381 parse in partial mode, which Pando uses for every piece
anyway. A subagent's task arrives as `response_item` `agent_message`
(`author`, `recipient`, text blocks), which trajectory skips; Pando's pass
shows it as a message from the parent agent (a few lines, reading one field
trajectory leaves). No change to the library and no private parser.

DETERMINISM row 31, checked on the Codex run above: its only tool call is
`exec` with shell code in `input`, so a Codex session shows shell lines and no
"Read N files". Also: Codex 0.160 writes no `event_msg user_message` line,
so a Codex prompt count comes from trajectory's user records, not from
`user_message` (row 12 needs that change).

## Stage 1: the server (store and read)

Code: `worker/src/sessions/` (ids, parse, pieces, store, append, read, routes),
wired in `monorepo/object.ts` (SessionStore and its RPC methods),
`monorepo/api.ts` (routes; the repository delete clears `sessions/<id>/` in
BLOBS), `monorepo/stream.ts` (topics `sessions`, `session:<id>`). Contract:
`packages/contract/src/session.ts`, the frames in `stream.ts`, `end` on
`ErrorBody`; `docs/contracts/api-v1.yaml` tag `sessions`. trajectory 0.4.3 is
pinned exactly in `worker/package.json`; credited in NOTICE.

- R2: the existing BLOBS bucket, `sessions/<monorepo id>/<session id>/<at, 16
  digits>-<random>.ndjson.gz`. No new bucket or binding.
- Index (the monorepo object's SQLite): `sessions` (one row each; a deleted
  one keeps only id, deleted_by, deleted_at), `session_pieces` (start, next,
  key, bytes of lines, times, the carry for the next parse, prompt numbering,
  counts), `session_piece_models` (answers per model per piece, last use),
  `session_model_changes` (when the answering model changed: stage 3's
  model per commit reads these), `session_removals`.
- Parsing: at append, the Worker parses the new piece once for the index; a
  page of the conversation parses only its pieces (about 2 MB of lines a
  page). The model of each answer is Pando's own pass: Claude Code
  `message.model` by message id (`<synthetic>` skipped), Codex the
  `turn_context` model in force at each assistant message, Pi
  `message.model`, OpenCode `data.model.id`.
- Prompts are trajectory's user records minus the non-prompts of
  DETERMINISM row 12 (shown as notes). Images are their own entries ("Image,
  not kept"). A Codex subagent's task (`agent_message`) is an entry of its
  own. A Codex subagent's parent comes from `session_meta`.
- Remove a turn: lines from the prompt up to the next prompt (or up to the
  removal, for the last) are cut by their own time from the stored pieces,
  which are written again; the mark keeps the prompt's number, who and when.
- Reindex (`POST .../sessions/{id}/reindex`) reads every stored piece again.
- Server secret check: fixed prefixes and private key blocks, replaced by
  `[pando:redacted]`, the same mark the machine writes; counted per session.
- Events: `session.started`, `session.updated` (every piece; the machine
  sends at most one piece per 30 s per session), `session.deleted`.

### The append function (for the Cloudflare agents lane)

`worker/src/sessions/append.ts`:

```ts
appendPiece(env, monorepoId, { login, machine }, {
  session,  // sessionIdFor(program, agentId) from worker/src/sessions/ids.ts
  at,       // where this piece starts: the session's end (0 for a new one)
  next,     // where the next starts; any growing number of the writer's own
  start: { program, agent_id, repo, branch, parent },
  lines,    // whole lines, each ending "\n", at most 8,000,000 bytes, in the agent's own format
}): Promise<SessionView>
```

It throws HttpError 409 `not_at_end` (with `extra.end`), 410
`session_deleted`, 403 `not_your_session`, 400, 413. A server-side writer for
Pi passes `program: "pi"` and Pi's own JSONL lines, exactly as Pi writes
them.

### Tests

- `worker/test/sessions.mjs`: 46 checks. Run as in its header on port 8869:
  `npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to /tmp/pando-sessions-state`,
  `npx wrangler dev --port 8869 --inspector-port 9369 --persist-to /tmp/pando-sessions-state --var FEED_TICK_MS:500`,
  then `PANDO_URL=http://localhost:8869 node test/sessions.mjs`. It needs
  `worker/.dev.vars` with a local `PANDO_BOOTSTRAP` (any random value; this
  worktree has one, gitignored) and a `web/dist` folder (an empty
  index.html is enough for the API).
  It also writes the contract recordings `packages/contract/recorded/session*.json`;
  then `npm run check -w @pando/contract`.
- Fixtures: `worker/test/sessions/fixtures/pi.jsonl` (Pi 0.85.1,
  `--session-dir` scratch, no context files) and `opencode.jsonl` (OpenCode
  V2 2.0.22 rows in the line format `pando sync` sends: a first line
  `{"type":"session", id, directory, parent_id, version, time_created}`, then
  `{id, type, seq, time_created, data}` per settled row). Two placeholder
  prompts each, one commit.
- Claude Code and Codex fixtures: blocked on the owner logging each into a
  folder kept for fixtures (asked of pando-ops 2026-10-05):
  `CLAUDE_CONFIG_DIR=$HOME/.pando-fixtures/claude claude` then /login;
  `CODEX_HOME=$HOME/.pando-fixtures/codex codex login`.

## Stage 2: the machine (capture)

Code: `cli/internal/session/` (id, stores, find, tail, opencode, trim, redact,
state, run, trailer), `cli/internal/app/session.go` (`pando session`, the
login question, the hidden `pando session trailer` the hook calls),
`cli/internal/server/sessions.go` (the client calls), `cmd/pando/main.go`
(`pando sync` starts the recorder beside the shared files), the hook in
`cli/internal/worktree/hook.go`, `[sessions]` in `config.Settings`. Server:
`worker/migrations/0009_sessions.sql` and `worker/src/sessions/user-routes.ts`.

- **Two jobs apart.** `session.Start` runs its own goroutine with its own
  recover; every error is logged as `pando sync (sessions): ...` and the pass
  is tried again. The shared files' engine never sees it. A plain git repo,
  where `pando sync` used to exit at once ("no shared files"), now keeps
  running: it follows main and records sessions.
- **Where sessions are found:** defaults (`~/.claude/projects`,
  `~/.codex/sessions` and `archived_sessions`, `~/.pi/agent/sessions`,
  `~/.local/share/opencode/opencode.db`), the same moved by `pando sync`'s own
  environment (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`,
  `PI_CODING_AGENT_SESSION_DIR`, `OPENCODE_DB`, `XDG_DATA_HOME`), what the
  commit hook saw in an agent's shell (`~/.pando/session-stores`), and
  `pando session paths add <folder> --program <name>` (`~/.pando/sessions.toml`).
- **Only sessions in this Pando folder:** a file's header (Claude Code
  `cwd`/`sessionId`; Codex `session_meta`; Pi `session`) decides, and a file
  elsewhere is never opened again (`skip` in the state). Claude Code's project
  directories are filtered by name first, so other projects' files are never
  opened at all.
- **Tailing:** whole lines from the byte offset the server's end is at, up to
  8 MB of trimmed lines a piece; a partial last line waits. A line alone over
  8 MB becomes a marker line. Lines that are all reasoning are read and not
  sent; an empty piece still moves the end (the server accepts it). On 409 the
  machine takes the server's end; with no state at all it asks the server
  for the end first. A file shorter than what was sent, or whose first line
  changed, stops being recorded (`pando session status` counts them).
- **OpenCode V2:** read-only, `session_v2` must exist; settled rows by
  `seq`, stopping at the first unsettled one; the first piece starts with the
  session's own row.
- **Trim and redact, per string:** opaque strings and `data:` URLs become
  `[opaque N]`, strings are cut at 64 KB, reasoning blocks and Codex reasoning
  lines are dropped. Redaction: exact values (the Pando credential, secret-named
  environment variables, `.env*` and `.dev.vars*` values in the folder and its
  worktrees), betterleaks v1.8.1's default rules, then Pando's own (private
  keys, URL passwords, `NAME=value` with a secret-looking name, long mixed
  tokens over 4.5 bits a character). If betterleaks cannot load, nothing is
  sent.
- **Cadence:** stores are looked at every 5 s; a session sends at most one
  piece per 30 s, except right after a commit names it (the hook writes
  `.pando/local/session-nudge`). A backlog goes piece after piece at once.
  `PANDO_SESSIONS_EVERY` shortens both, for tests.
- **Exclusions:** the person's own list on the server (D1
  `session_exclusions`, `pando session exclude|include [<owner/name>]
  [--project <path>]`), read every 5 minutes and cached for the hook in
  `~/.pando/session-exclusions.json`; the repository's `[sessions]` table in
  `.pando/pando.toml` (`record = false`, `exclude = [...]`). The server also
  refuses an upload for a place in the person's list (403
  `sessions_excluded`).
- **What the machine tells the server** (rows 12 and 13): `PUT
  /v1/user/session-machine` with recording on or off and the stores it reads,
  when either changes; `GET /v1/user/session-machines` lists them for Settings.
- **The hook:** `pando session trailer` walks the parent processes to the
  nearest agent program (`ps -axww` on a Mac, `/proc` on Linux; node, bun,
  deno and shell scripts read by the script they run) and uses only that
  agent's own variable. No line when recording is off, during a rebase or a
  cherry-pick, when the place is excluded, or when the nearest agent set no
  variable. Added with `addIfDifferent`. The hook finds pando through `git
  config pando.bin` (set only when the program installing it is named pando,
  so a test binary is never called), else `PATH`.
- `pando login` asks once, only at a terminal, default no.
- Binary: 11.4 MB to 31.6 MB (betterleaks about 14.6 MB, as measured before
  the decision; pure-Go SQLite the rest). NOTICE credits both.

### Stage 2 tests

- `worker/test/sessions-cli.mjs`, 36 checks: the real `pando` binary, `pando
  sync`, a real worktree and its hook, stand-in agent programs (shell scripts
  named `codex` and `claude`), a Pi session file and an OpenCode V2 database
  under the test's own HOME, every agent data variable cleared. Run on the
  plain server: `PANDO_URL=http://localhost:8869 node test/sessions-cli.mjs`.
  It writes `session-machines.json` and `session-exclusions.json` recordings.
- Go unit tests, `cli/internal/session/session_test.go`: the id vectors
  (also in `worker/test/units.test.ts`), the offset protocol, trim, the
  trailer rule, the agent table, redaction, exclusions.
- A real run, done once (2026-10-05): real Codex 0.160.0 started from inside
  this Claude Code session, committing through Pando's hook in a throwaway
  repo with a scratch PANDO_HOME: the line named Codex's own thread, not the
  outer Claude Code session.

## Decisions taken here, and why

- Sessions store under a prefix of the existing BLOBS bucket: no new
  Cloudflare resource.
- Pieces are budgeted by bytes of lines, not gzip size: memory follows the
  text, and repeated lines gzip too well to bound a page.
- The machine's folder path is never stored: it sends `repo` and `branch`
  (DETERMINISM row 23 only needs the worktree).

- The append cursor is in the agent's own coordinates: the byte offset in the
  session file, or the last `seq` read for OpenCode. A piece says where it
  starts; the server takes it only when that equals the end it holds, and
  answers with the new end. After a crash the machine asks the server for the
  end and resumes there, so nothing is sent twice and the machine keeps only
  numbers. A server-side writer (the Cloudflare agents lane) uses any
  growing cursor of its own.

## How to rerun stage 0

- 0a and 0b: `/tmp/pando-s0/hook.sh` is the hook; each agent's command is in
  the table above. Costs one short model call each (OpenCode's is a free
  model).
- 0c: `/tmp/pando-s0/bench/{trim,post,mem,maxline}.mjs` with the scratch
  Worker started by
  `npx wrangler dev --port 8869 --inspector-port 9369 --persist-to /tmp/pando-s0/wk/state`
  in `/tmp/pando-s0/wk`. Stop it with `pkill -f /tmp/pando-s0/wk/node_modules`.
  These read the owner's files and print numbers only; they stay out of the
  repo.

## Fixture material made so far (own runs, placeholder prompts)

- Pi: `/tmp/pando-s0/pi-sessions/*.jsonl`.
- OpenCode V2: `/tmp/pando-s0/oc2data/opencode/opencode.db`.
- Codex: the run's file is in `~/.codex/sessions` (named by the thread id in
  `/tmp/pando-s0/codex/.git/seen`). Codex writes the person's global
  instructions into a session, so a committed fixture must be made with a
  scratch `CODEX_HOME` or scrubbed. Stage 5.
