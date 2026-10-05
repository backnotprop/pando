// Agent sessions (worker/src/sessions): one conversation between a person and a coding agent, recorded by `pando sync`
// and stored as sent. No titles and nothing written by a model: a session is who, which agent and model, where, when.
import * as Schema from "effect/Schema";

import { Count, RepoName, Timestamp } from "./ids.ts";

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
});

export interface Session extends Schema.Schema.Type<typeof Session> {}

/** What stays of a deleted session: who deleted it and when, for the commits that still name it. */
export const SessionDeleted = Schema.Struct({
  id: SessionId,
  state: Schema.Literal("deleted"),
  deleted_by: Schema.String,
  deleted_at: Timestamp,
});

/** GET .../sessions/{id}: a session, or its stub. */
export const SessionAny = Schema.Union([Session, SessionDeleted]);

export const SessionList = Schema.Struct({
  sessions: Schema.Array(Session),
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
});
