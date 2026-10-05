// Agent sessions (worker/src/sessions): one conversation between a person and a coding agent, recorded by `pando sync`
// and stored as sent. No titles and nothing written by a model: a session is who, which agent and model, where, when.
import * as Schema from "effect/Schema";

import { Count, RepoName, Sha, Timestamp } from "./ids.ts";

/** `s_` and 26 Crockford base32 characters, derived from the agent and its own session id. */
export const SessionId = Schema.String.check(Schema.isPattern(/^s_[0-9A-HJKMNP-TV-Z]{26}$/)).pipe(Schema.brand("SessionId"));

export type SessionId = typeof SessionId.Type;

/** The agent program, named as letta-ai/trajectory names its sources. */
export const SessionProgram = Schema.Literals(["claude-code", "codex", "pi", "opencode"]);

/** A model id as recorded, and how many answers it gave. Ordered: most answers first, then the latest used. */
export const SessionModel = Schema.Struct({ model: Schema.String, answers: Count });

/** A removed turn's mark: its prompt number, who removed it, when. */
export const SessionRemoved = Schema.Struct({ prompt: Count, by: Schema.String, at: Timestamp });

/**
 * One of a session's commits: where it is, and the model in force in the session when it was committed. Null when that
 * is unknown, or when the sessions naming the commit disagree: the same in every view.
 */
export const SessionCommit = Schema.Struct({
  repo: RepoName,
  sha: Sha,
  branch: Schema.NullOr(Schema.String),
  title: Schema.String,
  committed_at: Timestamp,
  on_main: Schema.Boolean,
  model: Schema.NullOr(Schema.String),
});

export interface SessionCommit extends Schema.Schema.Type<typeof SessionCommit> {}

/**
 * A recorded session. `state` is active while it has a record from the last 30 minutes. `repo` and `branch` are where
 * it ran (both null: the repository's own folder). `end` is where the next piece starts, in the sender's own cursor.
 */
export const Session = Schema.Struct({
  id: SessionId,
  state: Schema.Literals(["active", "inactive"]),
  person: Schema.String,
  machine: Schema.String,
  program: SessionProgram,
  models: Schema.Array(SessionModel),
  repo: Schema.NullOr(RepoName),
  branch: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(SessionId),
  subagents: Count,
  started_at: Schema.NullOr(Timestamp),
  last_at: Schema.NullOr(Timestamp),
  prompts: Count,
  tool_calls: Count,
  images: Count,
  redactions: Count,
  bytes: Count,
  end: Count,
  removed: Schema.Array(SessionRemoved),
  /**
   * Its pushed commits (at most 500), those whose message has its Pando-Session line: oldest first by committer time;
   * within one second, the branch's own order, then sha.
   */
  commits: Schema.Array(SessionCommit),
  /** The branch its row leads with: its earliest commit's branch, else where it ran (both null: the repository folder). */
  lead: Schema.Struct({ repo: Schema.NullOr(RepoName), branch: Schema.NullOr(Schema.String) }),
  /** Issues linked to that branch, lowest number first. */
  issues: Schema.Array(Schema.Struct({ number: Count, title: Schema.String, state: Schema.String })),
});

export interface Session extends Schema.Schema.Type<typeof Session> {}

/** What stays of a deleted session: who deleted it and when, for the commits that still name it. */
export const SessionDeleted = Schema.Struct({
  id: SessionId,
  state: Schema.Literal("deleted"),
  deleted_by: Schema.String,
  deleted_at: Timestamp,
  /** The commits that name it: their lines stay in git. */
  commits: Schema.Array(SessionCommit),
});

/** GET .../sessions/{id}: a session, or its stub. */
export const SessionAny = Schema.Union([Session, SessionDeleted]);

export const SessionList = Schema.Struct({
  sessions: Schema.Array(Session),
  /** For the same filters, in either state. */
  counts: Schema.Struct({ active: Count, inactive: Count }),
  next_cursor: Schema.NullOr(Schema.String),
});

/**
 * One thing in the conversation, in order. `prompt` numbers typed prompts from 1 across the session (a removed one
 * keeps its number as a `removed` mark, with `by`). A tool call keeps the first 2 KB of its input and of its result;
 * `image` is an image that was not kept; `agent_message` is a task sent by another agent (a Codex subagent's).
 */
export const SessionEntry = Schema.Struct({
  id: Schema.String,
  at: Schema.NullOr(Timestamp),
  kind: Schema.Literals(["prompt", "note", "answer", "tool", "image", "agent_message", "removed"]),
  text: Schema.NullOr(Schema.String),
  prompt: Schema.NullOr(Count),
  tool: Schema.NullOr(Schema.String),
  input: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.String),
  ok: Schema.NullOr(Schema.Boolean),
  by: Schema.NullOr(Schema.String),
});

/** A page of the conversation; pass `next_cursor` back as `from` for the next. */
export const SessionEntries = Schema.Struct({
  entries: Schema.Array(SessionEntry),
  next_cursor: Schema.NullOr(Count),
  /** When the answering model changed, oldest first (on the first page): an answer's model is the last at or before it. */
  model_changes: Schema.Array(Schema.Struct({ at: Timestamp, model: Schema.String })),
});

/**
 * GET .../sessions/on-branch?repo=&branch=: the sessions a branch's commits name, numbered 1, 2, 3 by their earliest
 * commit in branch order, then those that ran in its worktree with no commit there (number null); and each commit
 * (newest first) with the numbers of its session lines, and its model only when they all agree.
 */
export const BranchSessions = Schema.Struct({
  sessions: Schema.Array(Schema.Struct({ number: Schema.NullOr(Count), id: SessionId, session: Schema.NullOr(SessionAny), commits: Schema.Array(SessionCommit) })),
  commits: Schema.Array(Schema.Struct({ sha: Sha, sessions: Schema.Array(Count), model: Schema.NullOr(Schema.String) })),
});

export interface BranchSessions extends Schema.Schema.Type<typeof BranchSessions> {}

/** GET /v1/user/session-exclusions: what the person does not record (project null: the whole repository). */
export const SessionExclusions = Schema.Struct({
  exclusions: Schema.Array(Schema.Struct({ monorepo: Schema.String, monorepo_id: Schema.String, project: Schema.NullOr(Schema.String) })),
});

/** A session store a machine reads, and how it was found (default, environment, commit hook, paths add). */
export const SessionStore = Schema.Struct({ program: SessionProgram, path: Schema.String, found: Schema.String });

/** GET /v1/user/session-machines: each of the person's machines, as it last reported its recording. */
export const SessionMachines = Schema.Struct({
  machines: Schema.Array(Schema.Struct({ credential_id: Schema.String, machine: Schema.String, kind: Schema.String, recording: Schema.Boolean, stores: Schema.Array(SessionStore), updated_at: Timestamp })),
});

/** GET .../sessions/{id}/files: the files its commits changed (at most its first 50 commits are read). */
export const SessionFiles = Schema.Struct({
  files: Schema.Array(Schema.Struct({ repo: RepoName, repo_path: Schema.String, path: Schema.String })),
});

/** GET /v1/users/{login}/sessions: a person's sessions in the repositories the viewer can open too, latest activity first. */
export const PersonSessions = Schema.Struct({
  sessions: Schema.Array(Schema.Struct({ monorepo: Schema.Struct({ id: Schema.String, full_name: Schema.String }), session: Session })),
  /** For the same filters, in either state. */
  counts: Schema.Struct({ active: Count, inactive: Count }),
  /** The repositories searched: those you both can open. */
  repositories: Schema.Array(Schema.String),
  next_cursor: Schema.NullOr(Schema.String),
});

/** One day's (or week's, from its Sunday) agent: the one behind most of the person's commits on main naming their sessions. */
export const SessionMark = Schema.Struct({ date: Schema.String, program: SessionProgram, commits: Count });

/** GET /v1/users/{login}/session-marks?tz=: the profile graph's agent marks, by day and by week, in the viewer's zone. */
export const SessionMarks = Schema.Struct({ days: Schema.Array(SessionMark), weeks: Schema.Array(SessionMark) });

/** DELETE .../sessions?repo=&older_than_days=&everyone=1: how many were deleted, at once and for good. */
export const SessionsDeleted = Schema.Struct({ deleted: Count });
