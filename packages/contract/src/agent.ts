// Cloudflare-run agents: sessions launched from Pando, each one Durable Object
// in the Worker pando-agents (agents/). Routes under
// /v1/monorepos/{owner}/{monorepo}/agents (api-v1.yaml, tag agents); their row
// event is in stream.ts. A session shows only what is recorded and known
// exactly: its state as its object reports it, never a model-written title.
import * as Schema from "effect/Schema";

import { Count, Login, RepoName, Timestamp } from "./ids.ts";

/** What started it: a person's prompt, an issue ("Address with agent"), a branch to review, or the assistant's chat. */
export const AgentKind = Schema.Literals(["task", "issue", "review", "chat"]);

export type AgentKind = typeof AgentKind.Type;

/**
 * working: a run is going. waiting: the last run ended with an answer, and it waits for a person. failed: the last
 * run ended without one (`reason` says why, in the agent program's words). stopped: someone pressed Stop.
 */
export const AgentStatus = Schema.Literals(["working", "waiting", "failed", "stopped"]);

export type AgentStatus = typeof AgentStatus.Type;

export const AgentSession = Schema.Struct({
  /** The session's number in this repository (#3). */
  number: Count,
  kind: AgentKind,
  status: AgentStatus,
  reason: Schema.NullOr(Schema.String),
  /** The project it works in. */
  repo: RepoName,
  /** Its branch, made off main when it was launched. */
  branch: Schema.String,
  /** The agent program: `pi` (Pi Durable). */
  program: Schema.String,
  /** The model's id, such as `@cf/zai-org/glm-5.3-flash`. */
  model: Schema.String,
  /** The issue it addresses. */
  issue: Schema.NullOr(Count),
  /** The person who launched it; the agent acts as them. */
  launched_by: Login,
  /** Its credential's name (`cloud-3`), as the Machines tab and its comments show it. */
  machine: Schema.String,
  /** How its sandbox holds the branch, once started: through pando and ArtifactFS, or a clone. */
  workspace: Schema.NullOr(Schema.Literals(["mount", "clone"])),
  /** Its merge was refused while required checks were still running; Pando tells it when they are green, and it merges. */
  awaiting_checks: Schema.Boolean,
  created_at: Timestamp,
  updated_at: Timestamp,
});

export interface AgentSession extends Schema.Schema.Type<typeof AgentSession> {}

/** GET .../agents: newest first; pass `next_before` back as `before` for the page after. */
export const AgentSessionList = Schema.Struct({
  sessions: Schema.Array(AgentSession),
  next_before: Schema.NullOr(Count),
});

export interface AgentSessionList extends Schema.Schema.Type<typeof AgentSessionList> {}

/** One part of a transcript message. A tool call's `arguments` is its JSON as the model wrote it. */
export const AgentPart = Schema.Union([
  Schema.Struct({ type: Schema.tag("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.tag("thinking"), text: Schema.String }),
  Schema.Struct({ type: Schema.tag("tool-call"), id: Schema.String, name: Schema.String, arguments: Schema.String }),
  Schema.Struct({ type: Schema.tag("tool-result"), id: Schema.String, name: Schema.String, text: Schema.String, error: Schema.Boolean }),
]);

export type AgentPart = typeof AgentPart.Type;

export const AgentMessage = Schema.Struct({
  /** The agent program's entry id. */
  id: Schema.String,
  role: Schema.Literals(["user", "assistant", "tool"]),
  parts: Schema.Array(AgentPart),
  /** Unix milliseconds, as the agent program recorded it. */
  at: Schema.Number,
  stop_reason: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  /** An answer's tokens as the model's provider counted them: input (cache reads included), cache reads, output. */
  usage: Schema.optionalKey(Schema.Struct({ input: Count, cache_read: Count, output: Count })),
});

export interface AgentMessage extends Schema.Schema.Type<typeof AgentMessage> {}

/** GET .../agents/{n}/transcript: every message, oldest first. */
export const AgentTranscript = Schema.Struct({ messages: Schema.Array(AgentMessage) });

export interface AgentTranscript extends Schema.Schema.Type<typeof AgentTranscript> {}
