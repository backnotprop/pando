# Understand: design (understand lane, 2026-10-14)

The owner: "why/provenance/etc experience needs to be innovated and
standalone as its own thing." And: "When I ask the assistant why, it does a
lineage traceback and search, and the answer should surface each plan,
prototype, artifact from git as part of the answer; that should be the
visually integrated part." And: "When you ask the codebase a question about
itself, it's probably an integrated page the assistant needs to manage,
optimized to show why, history, lineage, diagrams; generative UI with
components it can use for consistency; the surface for humans to understand
the codebase is baked in."

Provenance is one of the five pillars (decisions/RULINGS.md, "The pillars"):
every change answers who, what and why: person, machine, agent, model, and
the recorded session linked to the commit. Understand is where a person asks
that question and gets the answer as a page.

Mock: research/design/pando-understand-2026-10-14/understand.html (dark and
light; building, complete, nothing found).

Rulings it follows (decisions/RULINGS.md, "Agent sessions"): "Why?" is
strictly an AI agent action; anything shown must come from structured,
deterministic data, never a guess; a first prompt is never shown as "what
was asked"; the model shows through the session.

## What it is

A page of its own, per repository: `/{owner}/{name}/understand/{n}`. A
person asks a question about the code ("Why is the rate limit 100 a
minute?", or "Why?" on selected lines). An agent session of a new kind,
`understand`, investigates with lookup tools and builds the page while it
works, from a fixed set of components. Every card on the page is filled by
the server from a real record: a commit, a recorded session, a shared file,
an issue. The model writes only the answer's sentences and where each card
goes; it cannot write a card's facts.

The page is kept. It has a number, like an issue. Every member of the
repository can open it, so a link to it can be shared in an issue, a review
or a chat. Only its asker can ask follow-ups (it is their session).

Not a tab of the branch page, not the assistant's chat. The assistant's chat
stays for conversation and changes; Understand is for "why" and "where did
this come from", and its output is a document.

## Ways in

1. **Files changed, on a branch page.** Select lines in a file's diff (click
   a line number, shift-click another); a small bar offers **Why?**. It asks
   "Why are these lines the way they are?" with the scope: project, path,
   the side's commit (the branch head for new lines, the merge base for
   removed ones), first and last line.
2. **A commit page.** **Why?** in the commit's header asks "Why was this
   change made?" with the commit as scope.
3. **The assistant panel.** Under a chat's answer, **Open as a page** asks
   the chat's question as an Understand page (the chat stays as it is).
4. **By URL.** `/{owner}/{name}/understand` lists the repository's pages,
   newest first, with an ask box at the top for a free question.

## The page

Top to bottom, one column of about 760 px with a sources rail on the right
(collapses under 1100 px into a "N sources" row under the header):

1. **Header.** The question as the title, the asker and when, and a scope
   chip: `api/src/limit.ts · lines 12 to 18 · main@4e1f9a2`. A status line:
   "Tracing: 3 lookups, 5 sources" while building; "6 sources, 4 cited, 41 s"
   when complete. A **Copy link** button.
2. **Answer.** Two to four sentences, the model's, with numbered source chips
   inline. Labeled "Answer, written by GLM-5.3 Flash from the sources below".
   While building: a line "Writing the answer when the lookups are done".
3. **The lines asked about.** The code at that commit, with a blame gutter
   (short sha and date per run of lines), filled by the server, never by the
   model. Only for a line scope.
4. **Lineage trail.** A row of steps from the code outward: `lines 12 to 18 ->
   commit 4e1f9a2 -> session s_01J... prompt 7 -> decisions/0010-rate-limit.md
   -> issue #4`. Each step says how it was found, in words: **Direct**
   (blame on these lines; the commit's own Pando-Session line), **Named** (a
   source names it: the commit message says `decisions/0010`, the session's
   prompt says `#4`), **Found by search** (a search of the shared files or
   sessions matched words of the question).
5. **Cards.** The sources the model placed, in its order, each with one note
   line from the model ("Sets the number"), and the provenance line from the
   server ("Found by blame on lines 12 to 18, 7 of 7 lines").
6. **Notes.** At most a few callouts: **Why** (the reason, cited), **Risk**
   (the code goes against a found decision, citing both), **Open question**
   (what the records do not say).
7. **How this was found.** Every lookup that ran, with what it found and how
   long it took; lookups that found nothing are listed too. Server-written.
8. **Follow-ups.** Up to three suggested questions (the model's), and a
   composer: "Ask a follow-up. The page updates." Asker only.

Sources rail: every source found, numbered in citation order; "Found, not
used" below for sources the lookups registered that no block cited.

### Card faces (all filled by the server from the record)

| Ref kind | Card shows | Opens |
| --- | --- | --- |
| `commit` | title, short sha, date; person (avatar, login), machine, agent (Pando-Agent), model (from the session that names it, only when the sessions agree), its Pando-Session lines; branch it came from | the commit page |
| `session` (recorded) | program mark, person, machine, model; the turn that wrote it: "Prompt 7, 14:02" with the prompt's first 400 characters, and the step (the tool call that wrote the file: `Edit api/src/limit.ts`) | the session page at that prompt |
| `agent` (Cloudflare-run) | kind, number, who launched it, model, status; for a task, its first message is shown as "Started with", never as "what was asked" | the agent page |
| `meta` | path, version, who saved it (person, machine, agent) and when; an excerpt of up to 12 lines around the match, with line numbers | the shared file at that version |
| `issue` | number, title, state, author, opened date, first 300 characters of its body | the issue |
| `review` (phase 2) | verdict, reviewer (person or reviewer agent with its session), the comment on these lines | the branch page's review |
| `artifact` (phase 2) | title, version, who added it, an inert thumbnail of its document | the artifact viewer |

A card whose ref no longer resolves (a deleted session, a removed issue)
shows a muted line: "This source is gone: session s_01J... was deleted by
ana on Oct 12". Never the model's words in its place.

## The honesty rule

**The model cites reference ids; the server fills every card from the real
record.**

- Every lookup tool runs on the server, for this page, and registers what
  it found as numbered refs on the page: `r1`, `r2`, ... Each ref is a
  locator the server made (`commit:projects-api@4e1f9a2...`,
  `session:s_01J...#p7`, `meta:decisions/0010-rate-limit.md@v12#L3-9`,
  `issue:4`) plus how it was found. The tool's text answer to the model
  lists the ids with short excerpts.
- The model writes the page with one tool, `place`, whose blocks cite only
  those ids. An id this page's lookups did not register is refused, and the
  tool says so; the model cannot make a card for something no lookup found.
- `answer` and `note` blocks must cite at least one id, except an answer
  that says nothing was found (`found: false`).
- A card's facts are read from the record when the page is read (cheap: the
  page holds at most 40 refs), with the excerpt kept on the page as it was
  found (a shared file changes; the excerpt is what the lookup saw, labeled
  with its version).
- Nothing found means nothing found. When the lookups find nothing that
  explains the lines, the model places `answer {found: false}`, and the page
  says "No record explains these lines" in the server's words, lists every
  lookup that ran, and offers "Ask in the assistant instead" (a chat reads the
  code and explains what it does, as a chat). The page does not guess. If the
  session ends without placing an answer, the page says "The assistant
  finished without writing an answer" and shows what was found.

## How the assistant builds it

1. **Ask.** `POST /v1/monorepos/{owner}/{name}/understand` with
   `{question, scope?, from?, model?}`. Pando records the page (number,
   status `building`), answers 201 at once, and in the background runs the
   **first pass** (no model, about a second): blame on the scoped lines, the
   commits found, the sessions their Pando-Session lines name, the issues
   (`#n`) and shared-file paths their messages name. Each finding is a ref and
   a step on the page, so the person reads real sources before the model
   has spoken.
2. **Launch.** Pando launches an agent session of kind `understand` (the
   normal launch: a credential for the asker, `cloud-<n>`, no sandbox, no
   container) whose first prompt is the question, the scope, and the first
   pass's refs with excerpts.
3. **Investigate.** The session's tools, each one call to Pando's API with
   the session's credential, for this page only:

   | Tool | What it does | Returns |
   | --- | --- | --- |
   | `blame` | which commit last changed each of lines a to b of a file at a commit, walked through Pando's own history (first parents; the walk stops at 200 commits) | refs for the commits, with their line ranges |
   | `history` | the commits that changed a file, newest first (Pando's file history) | refs for up to 20 commits |
   | `commit` | one commit's message, trailers and the sessions it names | refs for it and its sessions |
   | `search_shared` | the repository's shared files (plans, decisions, notes) for words, read in the meta layer object: text files only, at most 2,000 files and 256 KB each, 20 hits | refs to each file at its version, with the matched lines |
   | `search_sessions` | recorded sessions' prompts for words: the sessions that name the found commits first, then the newest 30 of the project | refs to the session's prompt |
   | `issue` | one issue | a ref to it |
   | `read_file` | a file of a project or a shared file (as the chat's tool) | text, no ref |
   | `place` | add or replace blocks on the page | which blocks were taken, and why any was refused |

   `search_shared` is a lookup scoped to one page's question, not the
   repository search that the files ruling keeps out for the contest
   (2026-10-12, "server-side search"); it reads the meta layer object's own
   current files, bounded as above.
4. **Write.** The model calls `place` as it goes: the answer when it has
   one, the trail, the cards, notes and follow-ups. Each call is validated
   (known block types, length limits, cites known ids), stored, and sent to
   the open page.
5. **Done.** When the session settles (its state report says `waiting`),
   the page's status becomes `complete` (or `failed` with the session's
   reason). A follow-up from the asker is a message to the same session,
   with the page's current outline; the page's revision goes up by one and
   the blocks it changes are marked "Updated".

The model is the session's (GLM-5.3 Flash on Workers AI by default). The
scripted model drives the end-to-end test.

### Blocks (the component set)

All blocks are `{id, type, ...}`; `id` is the model's, stable across
follow-ups (placing the same id replaces the block). Text is plain text with
inline cites written `[r3]`, at most 1,200 characters per block.

| Block | Fields | Rule |
| --- | --- | --- |
| `answer` | `text`, `cites[]`, `found` | one per page, shown first; `found: false` needs no cite |
| `trail` | `steps: [{ref, how}]`, 2 to 9 | `how`: direct, named, search |
| `source` | `ref`, `note?` | the card for the ref; at most one per ref |
| `note` | `tone` (why, risk, question), `title`, `text`, `cites[]` | at least one cite |
| `followups` | `questions[]`, 1 to 3, 160 characters each | one per page |

The lines block and "How this was found" are the server's, not blocks.
Phase 2 adds `timeline` (dated sources in order, for "what happened to this
file") and `diagram` (Mermaid, quoted from a found file or drawn by the
model and labeled as drawn).

## The record and the live page

In the monorepo object's SQLite, beside issues and agent sessions:

```
understand_pages(number PK, question, scope JSON, status, session, model,
  asked_by, revision, blocks JSON, refs JSON, steps JSON, error,
  created_at, updated_at, completed_at)
```

`refs` holds each ref's locator, how it was found, its excerpt and the step
that found it; at most 40 refs, 30 steps, 24 blocks per page.

API (members only; `docs/contracts/api-v1.yaml`, `packages/contract/src/understand.ts`):

| Route | What |
| --- | --- |
| `POST .../understand` | ask: `{question, scope?, from?, model?}`; 201, the page |
| `GET .../understand` | the repository's pages, newest first (`?before`, `?limit`) |
| `GET .../understand/{n}` | the page with its cards resolved |
| `POST .../understand/{n}/follow-ups` | `{question}`, asker only |
| `POST .../understand/{n}/lookups` | the session's tools (only this page's own session's credential): `{tool, args}` |
| `POST .../understand/{n}/blocks` | the session's `place`: `{blocks}` |

Scope: `{kind: "lines", repo, path, commit, start, end}`,
`{kind: "commit", repo, sha}`, or none (the whole repository).

Live: each change publishes `understand.updated` on the monorepo's event
socket (topics `understand`, `understand:<n>`) carrying the page row; the
open page patches its cache from it, and reads the page again (cards
resolved) when a new ref arrives. No new socket.

## Thin slice for today (October 14)

In:

- The route `/{owner}/{name}/understand/{n}` and the list with the ask box,
  light and dark with Pando's tokens.
- The `understand` session kind with `blame`, `history`, `commit`,
  `search_shared`, `search_sessions`, `issue`, `read_file`, `place`.
- The first pass (blame, commits, their sessions, named issues and files).
- Cards: commit, session (recorded), agent (Cloudflare-run), meta, issue.
- Blocks: answer, trail, source, note, followups. The lines block with blame.
- Ways in: Why? on selected lines in Files changed; Why? on the commit page;
  Open as a page from the assistant panel; the URL.
- Follow-ups from the asker.
- The stored page; members can open it.
- Contract with recordings, a docs page, a changelog entry, an end-to-end
  suite on this lane's ports with its own pando-agents and the scripted
  model, and a browser check of the page.

Out (phase 2, named): review and artifact cards; timeline and diagram
blocks; `pando why` in the CLI; Why? on the file view and the leaf's panel;
comments on a page; revisions shown read-only; asking about a free range of
history ("what happened to this folder in October").

## Limits (for the owner to see, each with its reason)

- Blame walks at most 200 commits of a file's history and stops: the cost of
  reading two versions of the file per commit; the lines still unexplained
  at the stop say "older than 200 changes".
- `search_shared` reads at most 2,000 shared files, each at most 256 KB, and
  returns 20 hits: one lookup must answer within a second or two.
- `search_sessions` reads at most 30 sessions' prompts per lookup: their
  pieces are read from R2.
- A page holds at most 40 refs, 30 lookups and 24 blocks: a page is read
  whole and sent whole on every change.
- The question is at most 2,000 characters.
