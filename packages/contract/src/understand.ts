// Understand (docs/understand/DESIGN.md): a page that answers a person's
// question about the code. An agent session of kind `understand` investigates
// with lookups that run on the server; each lookup registers what it found as
// a numbered ref (r1, r2, ...) whose card the server fills from the record. The
// model writes blocks that cite those ids only. Routes under
// /v1/monorepos/{owner}/{monorepo}/understand; the row event is in stream.ts.
import * as Schema from "effect/Schema";

import { Count, Login, RepoName, Sha, Timestamp } from "./ids.ts";
import { SessionProgram } from "./session.ts";

/** What was asked about: lines of a file at a commit, one commit, or (null) the whole repository. */
export const UnderstandScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("lines"), repo: RepoName, path: Schema.String, commit: Sha, start: Count, end: Count }),
  Schema.Struct({ kind: Schema.Literal("commit"), repo: RepoName, sha: Sha }),
]);

export type UnderstandScope = typeof UnderstandScope.Type;

/** How a source was found, in the words the page shows: blame or a commit's own line; named by another source; a search. */
export const UnderstandHow = Schema.Literals(["direct", "named", "search"]);

/** A commit, as the record has it. `model`: the model in force in the session that names it, when one does. */
export const CommitCard = Schema.Struct({
  kind: Schema.Literal("commit"),
  repo: RepoName,
  sha: Sha,
  title: Schema.String,
  /** The message after its title, at most 1,000 characters. */
  body: Schema.String,
  author: Schema.Struct({ name: Schema.String, email: Schema.String }),
  /** The Pando person the author's email names, when they are a member. */
  person: Schema.NullOr(Login),
  committed_at: Timestamp,
  /** Pando's trailers: Pando-Machine and Pando-Agent. */
  machine: Schema.NullOr(Schema.String),
  agent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  /** Its Pando-Session lines. */
  sessions: Schema.Array(Schema.String),
});

/** A recorded session, and the turn that wrote the change: its prompt and the tool step, as recorded. */
export const SessionCard = Schema.Struct({
  kind: Schema.Literal("session"),
  id: Schema.String,
  program: SessionProgram,
  person: Schema.String,
  machine: Schema.String,
  model: Schema.NullOr(Schema.String),
  /**
   * `wrote`: the prompt of the turn whose tool step changed the file. `before`: no step names the file, so the last
   * prompt before the commit. `match`: the prompt a search matched.
   */
  prompt: Schema.NullOr(Schema.Struct({ number: Count, at: Schema.NullOr(Timestamp), text: Schema.String, why: Schema.Literals(["wrote", "before", "match"]) })),
  step: Schema.NullOr(Schema.Struct({ tool: Schema.String, at: Schema.NullOr(Timestamp), input: Schema.String })),
});

/** An agent session run on Cloudflare (pando-agents). `started_with` is its first message, never "what was asked". */
export const AgentCard = Schema.Struct({
  kind: Schema.Literal("agent"),
  number: Count,
  agent_kind: Schema.String,
  launched_by: Login,
  model: Schema.String,
  status: Schema.String,
  branch: Schema.NullOr(Schema.String),
});

/** A shared file (the meta layer) at a version, with the lines that were found. */
export const MetaCard = Schema.Struct({
  kind: Schema.Literal("meta"),
  path: Schema.String,
  version: Count,
  saved_by: Schema.String,
  login: Schema.NullOr(Schema.String),
  machine: Schema.String,
  agent: Schema.NullOr(Schema.String),
  saved_at: Timestamp,
  /** Up to 16 lines, from line `from`. */
  excerpt: Schema.NullOr(Schema.Struct({ from: Count, text: Schema.String })),
});

/** An issue as it reads now. */
export const IssueCard = Schema.Struct({
  kind: Schema.Literal("issue"),
  number: Count,
  title: Schema.String,
  state: Schema.String,
  author: Schema.String,
  created_at: Timestamp,
  /** The first 300 characters of its body. */
  excerpt: Schema.String,
});

export const UnderstandCard = Schema.Union([CommitCard, SessionCard, AgentCard, MetaCard, IssueCard]);

export type UnderstandCard = typeof UnderstandCard.Type;

/** A source a lookup found: its id on the page, how it was found, and its card (null once the record is gone, with `gone` saying so). */
export const UnderstandRef = Schema.Struct({
  id: Schema.String,
  how: UnderstandHow,
  /** The provenance line: "Found by blame on lines 12 to 18: 3 of 7 lines". */
  found_by: Schema.String,
  /** The lookup that found it (its index in `steps`). */
  step: Count,
  card: Schema.NullOr(UnderstandCard),
  gone: Schema.NullOr(Schema.String),
});

export type UnderstandRef = typeof UnderstandRef.Type;

/** One lookup that ran: what it looked for, what it found, how long it took. */
export const UnderstandStep = Schema.Struct({
  tool: Schema.String,
  /** What it looked for, in words. */
  asked: Schema.String,
  /** What it found, in words ("nothing" when nothing). */
  found: Schema.String,
  refs: Schema.Array(Schema.String),
  ms: Count,
  /** Pando's first pass (no model) or the assistant's own lookup. */
  by: Schema.Literals(["first_pass", "assistant"]),
  error: Schema.NullOr(Schema.String),
});

export type UnderstandStep = typeof UnderstandStep.Type;

/**
 * The blocks the assistant places (DESIGN.md, "Blocks"): the answer as paragraphs. Text cites a ref inline as [r3];
 * the page draws the ref's name there (its path, its short sha, its issue) and shows each record once, under the
 * first paragraph that cites it. `nothing`: no record explains what was asked; its text says what was checked.
 */
export const UnderstandBlock = Schema.Union([
  Schema.Struct({ id: Schema.String, type: Schema.Literal("paragraph"), text: Schema.String, cites: Schema.Array(Schema.String), revision: Count }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("nothing"), text: Schema.String, cites: Schema.Array(Schema.String), revision: Count }),
]);

export type UnderstandBlock = typeof UnderstandBlock.Type;

/** The lines asked about, at the scope's commit, with the commit that last changed each (null: not traced, `older` says why). */
export const UnderstandLines = Schema.Struct({
  repo: RepoName,
  path: Schema.String,
  commit: Sha,
  start: Count,
  lines: Schema.Array(Schema.Struct({ n: Count, text: Schema.String, sha: Schema.NullOr(Sha), at: Schema.NullOr(Timestamp), by: Schema.NullOr(Schema.String) })),
  /** Lines the walk stopped before explaining, and why. */
  older: Schema.NullOr(Schema.String),
});

/** Where the question was asked: Why? on lines in Files changed (on a branch), Why? on a commit, or the assistant's Open as a page. */
export const UnderstandFrom = Schema.Struct({ kind: Schema.Literals(["files_changed", "commit", "assistant"]), branch: Schema.NullOr(Schema.String) });

/** building: lookups or the assistant are at work. complete: the session settled. failed: it failed or was stopped (`reason`). */
export const UnderstandStatus = Schema.Literals(["building", "complete", "failed"]);

/** A page as a list shows it and as its row event carries it. */
export const UnderstandRow = Schema.Struct({
  number: Count,
  question: Schema.String,
  scope: Schema.NullOr(UnderstandScope),
  from: Schema.NullOr(UnderstandFrom),
  status: UnderstandStatus,
  reason: Schema.NullOr(Schema.String),
  asked_by: Login,
  /** Its agent session (`cloud-<n>` is its machine). Null before it launched. */
  session: Schema.NullOr(Count),
  model: Schema.String,
  revision: Count,
  sources: Count,
  cited: Count,
  created_at: Timestamp,
  updated_at: Timestamp,
  completed_at: Schema.NullOr(Timestamp),
});

export interface UnderstandRow extends Schema.Schema.Type<typeof UnderstandRow> {}

/** GET .../understand/{n}: the page, with every card filled from the record. */
export const UnderstandPage = Schema.Struct({
  ...UnderstandRow.fields,
  lines: Schema.NullOr(UnderstandLines),
  blocks: Schema.Array(UnderstandBlock),
  refs: Schema.Array(UnderstandRef),
  steps: Schema.Array(UnderstandStep),
});

export interface UnderstandPage extends Schema.Schema.Type<typeof UnderstandPage> {}

/** GET .../understand: the repository's pages, newest first. */
export const UnderstandList = Schema.Struct({
  pages: Schema.Array(UnderstandRow),
  next_before: Schema.NullOr(Count),
});

/** POST .../understand/{n}/lookups (the page's own session only): the text the model reads, and the refs it may cite. */
export const UnderstandLookup = Schema.Struct({ text: Schema.String, refs: Schema.Array(Schema.String) });

/** POST .../understand/{n}/blocks (the page's own session only): which blocks were placed, and each refusal with its reason. */
export const UnderstandPlaced = Schema.Struct({
  placed: Schema.Array(Schema.String),
  refused: Schema.Array(Schema.Struct({ id: Schema.String, reason: Schema.String })),
});
