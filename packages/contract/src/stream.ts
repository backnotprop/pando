// A monorepo's own event socket for row updates (`GET .../events?topics=...&since=<seq>`, `Upgrade: websocket`):
// each event is the changed row, in the shape its REST route answers, for the web to patch its cache instead of
// polling. Frames as the monorepo object's publish() sends them, discriminated by `kind` (and `collection` for a
// push of main). The text frame `ping` gets the text frame `pong`, which is not JSON and not one of these.
import * as Schema from "effect/Schema";

import { Branch, MergeResult } from "./branch.ts";
import { Status } from "./checks.ts";
import { CiBuild, CiConnectionRow, CiJob } from "./ci.ts";
import { Count, RepoName, Sha, Timestamp } from "./ids.ts";
import { Machine } from "./repo.ts";

/** What every event frame carries: its place in the stream, its key, and who did it (null when no person did). */
const envelope = {
  type: Schema.tag("event"),
  seq: Count,
  at: Timestamp,
  key: Schema.String,
  repo: Schema.NullOr(RepoName),
  actor: Schema.NullOr(Schema.String),
  machine: Schema.NullOr(Schema.String),
  agent: Schema.NullOr(Schema.String),
};

/** A branch's stored fields (no facts, no checks): the rows push, branch.opened, merged and a title edit carry. Refetch the branch for its facts. */
export const BranchEventRow = Schema.Struct({
  repo: RepoName,
  name: Schema.String,
  head: Sha,
  author: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  state: Schema.Literals(["open", "merged"]),
  merge_commit: Schema.NullOr(Sha),
  merged_by: Schema.NullOr(Schema.String),
  merged_at: Schema.NullOr(Timestamp),
  merged_machine: Schema.NullOr(Schema.String),
  merged_agent: Schema.NullOr(Schema.String),
  forced: Schema.NullOr(Schema.Boolean),
  pushed_machine: Schema.NullOr(Schema.String),
  created_at: Schema.NullOr(Timestamp),
  updated_at: Schema.NullOr(Timestamp),
});

export interface BranchEventRow extends Schema.Schema.Type<typeof BranchEventRow> {}

/** A branch's full row (facts, checks and gate as getBranch answers it), with its repo: replace the cached branch. */
export const BranchRowEvent = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("branch.updated"),
  collection: Schema.Literal("branches"),
  op: Schema.Literal("upsert"),
  partial: Schema.Literal(false),
  row: Branch.pipe(Schema.fieldsAssign({ repo: RepoName })),
});

/** A branch's stored fields changed (a push, a new branch, a merge, a title edit): merge them in, then refetch the branch's facts. */
export const BranchPartialEvent = Schema.Struct({
  ...envelope,
  kind: Schema.Literals(["push", "branch.opened", "merged", "branch.updated"]),
  collection: Schema.Literal("branches"),
  op: Schema.Literal("upsert"),
  partial: Schema.Literal(true),
  row: BranchEventRow,
  /** push and branch.opened: the head before and after. */
  before: Schema.optionalKey(Sha),
  head: Schema.optionalKey(Sha),
  /** merged: the merge. */
  merge: Schema.optionalKey(MergeResult),
});

/** A push to main (the default branch): its new head, and the head before. */
export const MainPushEvent = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("push"),
  collection: Schema.Literal("default_heads"),
  op: Schema.Literal("upsert"),
  row: Schema.Struct({ repo: RepoName, default_branch: Schema.String, default_head: Schema.NullOr(Sha) }),
  before: Sha,
  head: Sha,
});

/** A status arrived on a commit (the branches at it follow as branch.updated with their new gate). */
export const StatusEvent = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("status"),
  collection: Schema.Literal("statuses"),
  op: Schema.Literal("upsert"),
  row: Status,
});

/** A machine's row on the Machines tab changed (connected, its worktrees, its latest activity). */
export const MachineEvent = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("machine.updated"),
  collection: Schema.Literal("machines"),
  op: Schema.Literal("upsert"),
  row: Machine,
});

/** A CI build changed (its row as GET .../ci/builds answers it). */
export const CiBuildEvent = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("ci.build"),
  collection: Schema.Literal("ci_builds"),
  op: Schema.Literal("upsert"),
  row: CiBuild,
});

/** A CI job changed; `row.build` is its build's Pando id (`cib_...`). */
export const CiJobEvent = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("ci.job"),
  collection: Schema.Literal("ci_jobs"),
  op: Schema.Literal("upsert"),
  row: CiJob,
});

/** A CI connection was made or changed (no webhook_url here: GET .../ci has it), or removed (`op: delete`, the row is `{id}`). */
export const CiConnectionEvent = Schema.Union([
  Schema.Struct({ ...envelope, kind: Schema.Literal("ci.connection"), collection: Schema.Literal("ci_connections"), op: Schema.Literal("upsert"), row: CiConnectionRow }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("ci.connection"), collection: Schema.Literal("ci_connections"), op: Schema.Literal("delete"), row: Schema.Struct({ id: Schema.String }) }),
]);

/** The row kinds the web subscribes to, each a `kind:<kind>` topic. */
export const ROW_KINDS = ["branch.updated", "push", "branch.opened", "merged", "status", "machine.updated", "ci.build", "ci.job", "ci.connection"] as const;

/** Frames of a monorepo's event socket opened with row topics. */
export const MonorepoEventFrame = Schema.Union([
  BranchRowEvent,
  BranchPartialEvent,
  MainPushEvent,
  StatusEvent,
  MachineEvent,
  CiBuildEvent,
  CiJobEvent,
  CiConnectionEvent,
  /** The replay after `since` is done; keep the highest `seq` and send it as `since` on reconnect. */
  Schema.Struct({ type: Schema.tag("caught_up"), seq: Count }),
  /** More was missed than the stream replays: refetch what is on screen, then reconnect from `seq`. */
  Schema.Struct({ type: Schema.tag("resync"), seq: Count, oldest_seq: Count }),
  Schema.Struct({ type: Schema.tag("error"), message: Schema.String }),
]);

export type MonorepoEventFrame = typeof MonorepoEventFrame.Type;
