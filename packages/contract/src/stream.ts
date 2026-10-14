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
import { IssueComment, IssueRow, Label, Reactions, TimelineItem } from "./issue.ts";
import { Session, SessionDeleted } from "./session.ts";
import { AgentSession } from "./agent.ts";
import { UnderstandRow } from "./understand.ts";
import { Release, Tag } from "./release.ts";
import { Artifact, ArtifactComment } from "./artifact.ts";

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

/**
 * An issue changed (topics `issues` and `issue:<n>`, and `repo:<repo>` for its project and its linked branches'
 * repos). `row` is its list row (no body); `items` are the new timeline items (a comment item's body is null over
 * 16 KB: fetch the timeline). issue.updated covers everything but opening, commenting, closing and reopening.
 */
export const IssueEvent = Schema.Struct({
  ...envelope,
  kind: Schema.Literals(["issue.opened", "issue.commented", "issue.closed", "issue.reopened", "issue.updated"]),
  collection: Schema.Literal("issues"),
  op: Schema.Literal("upsert"),
  number: Count,
  row: IssueRow,
  /** The body's version now: a page showing the body reads it again when this moves. */
  body_version: Count,
  items: Schema.Array(TimelineItem),
  /** Timeline items gone (a deleted comment's). */
  removed: Schema.optionalKey(Schema.Array(Count)),
  /** A comment edited, or whose reactions changed (its body null over 16 KB). */
  comment: Schema.optionalKey(IssueComment),
  /** The issue's own reactions, when they changed. */
  reactions: Schema.optionalKey(Reactions),
});

/** A label made or changed (`from`: its name before a rename), or deleted (`op: delete`, the row is `{name}`). Topic `issues`. */
export const LabelEvent = Schema.Union([
  Schema.Struct({ ...envelope, kind: Schema.Literal("label.updated"), collection: Schema.Literal("labels"), op: Schema.Literal("upsert"), row: Label, from: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("label.updated"), collection: Schema.Literal("labels"), op: Schema.Literal("delete"), row: Schema.Struct({ name: Schema.String }) }),
]);

/**
 * Mirror to GitHub: a run ended or a setting changed (worker/src/mirror/out.ts). `key` is the source's repo, `*` in
 * whole repository mode, or `settings`. No person did it, so the frame names none. The row is the server's own
 * record, not GET .../mirror's: a page reads GET .../mirror again.
 */
export const MirrorEvent = Schema.Struct({
  type: Schema.tag("event"),
  seq: Count,
  at: Timestamp,
  key: Schema.String,
  repo: Schema.NullOr(Schema.String),
  kind: Schema.Literal("mirror.updated"),
  collection: Schema.Literal("mirror"),
  op: Schema.Literal("upsert"),
});

/**
 * A session started, grew (a piece appended, a turn removed, a reindex), or was deleted (`op: delete`, the row is its
 * stub). Topics `sessions` and `session:<id>`, and `repo:<repo>` when it ran in a project.
 */
export const SessionEvent = Schema.Union([
  Schema.Struct({ ...envelope, kind: Schema.Literals(["session.started", "session.updated"]), collection: Schema.Literal("sessions"), op: Schema.Literal("upsert"), row: Session }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("session.deleted"), collection: Schema.Literal("sessions"), op: Schema.Literal("delete"), row: SessionDeleted }),
]);

/**
 * An agent session changed: launched, or its state as its object reports it (topics `agents`, `agent:<n>`,
 * `repo:<repo>`, and `issue:<n>` when it addresses one). `actor` is the person who launched it, on launch only.
 */
export const AgentEvent = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("agent.updated"),
  collection: Schema.Literal("agents"),
  op: Schema.Literal("upsert"),
  number: Count,
  row: AgentSession,
});

/**
 * An Understand page changed: asked, a lookup found something, the assistant placed a paragraph, it completed or
 * failed (topics `understand` and `understand:<n>`). The row is the list's; a page that is open reads GET .../understand/{n} again.
 */
export const UnderstandEvent = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("understand.updated"),
  collection: Schema.Literal("understand"),
  op: Schema.Literal("upsert"),
  number: Count,
  row: UnderstandRow,
});

/** A tag recorded (pushed, moved, or made by publishing a release) or deleted: on topic `kind:tag.created` or `kind:tag.deleted`. */
export const TagEvent = Schema.Union([
  Schema.Struct({ ...envelope, kind: Schema.Literal("tag.created"), collection: Schema.Literal("tags"), op: Schema.Literal("upsert"), row: Tag.pipe(Schema.fieldsAssign({ repo: RepoName })) }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("tag.deleted"), collection: Schema.Literal("tags"), op: Schema.Literal("delete"), row: Schema.Struct({ repo: RepoName, name: Schema.String }) }),
]);

/** A release made, edited, published or deleted. */
export const ReleaseEvent = Schema.Union([
  Schema.Struct({ ...envelope, kind: Schema.Literals(["release.created", "release.updated", "release.published"]), collection: Schema.Literal("releases"), op: Schema.Literal("upsert"), row: Release }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("release.deleted"), collection: Schema.Literal("releases"), op: Schema.Literal("delete"), row: Schema.Struct({ repo: RepoName, tag: Schema.String }) }),
]);

/**
 * An artifact on a branch's page was added (a new name), got its next version, or was deleted (`op: delete`, the
 * row is `{repo, branch, id, name}`). Topics `repo:<repo>` and `kind:<kind>`; `branch` is the branch's name.
 */
export const ArtifactEvent = Schema.Union([
  Schema.Struct({ ...envelope, kind: Schema.Literals(["artifact.added", "artifact.versioned"]), collection: Schema.Literal("artifacts"), op: Schema.Literal("upsert"), branch: Schema.String, row: Artifact }),
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("artifact.deleted"),
    collection: Schema.Literal("artifacts"),
    op: Schema.Literal("delete"),
    branch: Schema.String,
    row: Schema.Struct({ repo: RepoName, branch: Schema.String, id: Schema.String, name: Schema.String }),
  }),
]);

/**
 * A comment on an artifact: added (a thread or a reply), edited, its thread resolved or reopened (the row is the
 * root), or deleted: `op: delete` with `{id, artifact, thread}` when the row went, or an upsert with its body null
 * when a root with replies stays. A body over 16 KB is null here: GET .../artifact-comments/{id} reads it whole.
 */
export const ArtifactCommentEvent = Schema.Union([
  Schema.Struct({
    ...envelope,
    kind: Schema.Literals(["artifact_comment.added", "artifact_comment.edited", "artifact_comment.resolved", "artifact_comment.reopened", "artifact_comment.deleted"]),
    collection: Schema.Literal("artifact_comments"),
    op: Schema.Literal("upsert"),
    branch: Schema.String,
    row: ArtifactComment,
  }),
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("artifact_comment.deleted"),
    collection: Schema.Literal("artifact_comments"),
    op: Schema.Literal("delete"),
    branch: Schema.String,
    row: Schema.Struct({ id: Schema.String, artifact: Schema.String, thread: Schema.String }),
  }),
]);

/** The row kinds the web subscribes to, each a `kind:<kind>` topic. */
export const ROW_KINDS = ["branch.updated", "push", "branch.opened", "merged", "status", "machine.updated", "ci.build", "ci.job", "ci.connection", "mirror.updated", "agent.updated"] as const;

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
  IssueEvent,
  LabelEvent,
  MirrorEvent,
  SessionEvent,
  AgentEvent,
  UnderstandEvent,
  TagEvent,
  ReleaseEvent,
  ArtifactEvent,
  ArtifactCommentEvent,
  /** The replay after `since` is done; keep the highest `seq` and send it as `since` on reconnect. */
  Schema.Struct({ type: Schema.tag("caught_up"), seq: Count }),
  /** More was missed than the stream replays: refetch what is on screen, then reconnect from `seq`. */
  Schema.Struct({ type: Schema.tag("resync"), seq: Count, oldest_seq: Count }),
  Schema.Struct({ type: Schema.tag("error"), message: Schema.String }),
]);

export type MonorepoEventFrame = typeof MonorepoEventFrame.Type;
