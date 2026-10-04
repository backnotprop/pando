// The activity log across a person's monorepos: GET /v1/events (operationId
// `listActivity`) and the person's WebSocket on the same path. One line per
// activity, discriminated by `kind`; its `summary` depends on the kind
// (worker/src/feed/out.ts pointerOf, feed/push.ts).
import * as Schema from "effect/Schema";

import { StatusState } from "./checks.ts";
import { Count, FullName, MonorepoId, RepoName, Sha, Timestamp } from "./ids.ts";
import { IssueStateReason } from "./issue.ts";
import { FeedSummary } from "./monorepo.ts";
import { NeedChange } from "./needs.ts";

/** push, branch.opened. `commits` and `head_title` arrive a moment after the push (the line is sent again, fuller). */
export const PushSummary = Schema.Struct({
  head: Schema.NullOr(Sha),
  before: Schema.NullOr(Sha),
  commits: Schema.NullOr(Count),
  head_title: Schema.NullOr(Schema.String),
  /** A first push of main with more than 250 commits. */
  commits_more: Schema.optionalKey(Schema.Boolean),
});

export interface PushSummary extends Schema.Schema.Type<typeof PushSummary> {}

export const BranchDeletedSummary = Schema.Struct({ before: Schema.NullOr(Sha) });

export interface BranchDeletedSummary extends Schema.Schema.Type<typeof BranchDeletedSummary> {}

export const MergedSummary = Schema.Struct({
  merge_commit: Schema.NullOr(Sha),
  forced: Schema.NullOr(Schema.Boolean),
  /** The branch's title. */
  title: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Sha),
  /** The issues the merge closes ("closing #34"), as the merge decided them (MergeResult.closes). */
  closes: Schema.optionalKey(Schema.Array(Count)),
});

export interface MergedSummary extends Schema.Schema.Type<typeof MergedSummary> {}

export const ReviewVerdict = Schema.Literals(["comment", "request_changes", "approve"]);

export const ReviewSummary = Schema.Struct({
  verdict: Schema.NullOr(ReviewVerdict),
  /** How many comments. */
  comments: Count,
  head: Schema.NullOr(Sha),
});

export interface ReviewSummary extends Schema.Schema.Type<typeof ReviewSummary> {}

/** Only when a check's state changes. */
export const StatusSummary = Schema.Struct({
  context: Schema.String,
  state: StatusState,
  description: Schema.NullOr(Schema.String),
  target_url: Schema.NullOr(Schema.String),
  sha: Sha,
  /** From the run's first `pending` to this state; null without one. */
  duration_s: Schema.NullOr(Count),
  /** The CI service that reported it; null when a member posted it (`actor` is then that member). */
  app: Schema.NullOr(Schema.String),
  /** The build Pando holds for it (its page, /{owner}/{name}/ci/{pipeline}/{number}); null for a status with no stored build. */
  build: Schema.NullOr(Schema.Struct({ pipeline: Schema.String, number: Count })),
});

export interface StatusSummary extends Schema.Schema.Type<typeof StatusSummary> {}

/** worktree.reported (a new worktree only), worktree.removed. */
export const WorktreeSummary = Schema.Struct({
  path: Schema.NullOr(Schema.String),
  /** The worktree's id. */
  worktree: Schema.NullOr(Schema.String),
});

export interface WorktreeSummary extends Schema.Schema.Type<typeof WorktreeSummary> {}

/** A root file saved on a machine (not files a merge brought in). */
export const MetaSavedSummary = Schema.Struct({
  path: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Count),
  deleted: Schema.Boolean,
});

export interface MetaSavedSummary extends Schema.Schema.Type<typeof MetaSavedSummary> {}

/** issue.opened, issue.commented, issue.closed (by a person; a merge's close is on its merged line), issue.reopened. The line's repo is the issue's project. */
export const IssueSummary = Schema.Struct({
  number: Count,
  title: Schema.String,
  /** issue.closed: as completed or not planned. */
  reason: Schema.NullOr(IssueStateReason),
  /** issue.commented: the comment's first 140 characters. */
  excerpt: Schema.NullOr(Schema.String),
});

export interface IssueSummary extends Schema.Schema.Type<typeof IssueSummary> {}

/** What every line carries. `(monorepo_id, seq)` is a line's identity; pages sort by `(at, monorepo_id, seq)`, newest first. */
const lineFields = {
  monorepo: FullName,
  monorepo_id: MonorepoId,
  seq: Count,
  at: Timestamp,
  /** The repo's name in URLs (`meta` for root files), and its path (`.` for root files and a plain repo). */
  repo: Schema.NullOr(RepoName),
  repo_path: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  /** The person (a login); for meta.saved, the author's name. */
  actor: Schema.NullOr(Schema.String),
  /** The credential's name: the machine or sandbox. */
  machine: Schema.NullOr(Schema.String),
};

/**
 * A union of activity lines on `kind`, each with its own summary, over the
 * given fields: the feed's lines (FeedEvent) and a machine's last activity
 * (Machine.last_activity) share it. Pipe it through Schema.toTaggedUnion("kind").
 */
export const byActivityKind = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Union([
    Schema.Struct({ ...fields, kind: Schema.tag("push"), summary: Schema.NullOr(PushSummary) }),
    Schema.Struct({ ...fields, kind: Schema.tag("branch.opened"), summary: Schema.NullOr(PushSummary) }),
    Schema.Struct({ ...fields, kind: Schema.tag("branch.deleted"), summary: Schema.NullOr(BranchDeletedSummary) }),
    Schema.Struct({ ...fields, kind: Schema.tag("merged"), summary: Schema.NullOr(MergedSummary) }),
    Schema.Struct({ ...fields, kind: Schema.tag("review"), summary: Schema.NullOr(ReviewSummary) }),
    Schema.Struct({ ...fields, kind: Schema.tag("status"), summary: Schema.NullOr(StatusSummary) }),
    Schema.Struct({ ...fields, kind: Schema.tag("worktree.reported"), summary: Schema.NullOr(WorktreeSummary) }),
    Schema.Struct({ ...fields, kind: Schema.tag("worktree.removed"), summary: Schema.NullOr(WorktreeSummary) }),
    Schema.Struct({ ...fields, kind: Schema.tag("meta.saved"), summary: Schema.NullOr(MetaSavedSummary) }),
    Schema.Struct({ ...fields, kind: Schema.tag("issue.opened"), summary: Schema.NullOr(IssueSummary) }),
    Schema.Struct({ ...fields, kind: Schema.tag("issue.commented"), summary: Schema.NullOr(IssueSummary) }),
    Schema.Struct({ ...fields, kind: Schema.tag("issue.closed"), summary: Schema.NullOr(IssueSummary) }),
    Schema.Struct({ ...fields, kind: Schema.tag("issue.reopened"), summary: Schema.NullOr(IssueSummary) }),
  ]);

/** One line of the activity log. No agent field (owner ruling: people, machines and worktrees only). */
export const FeedEvent = byActivityKind(lineFields).pipe(Schema.toTaggedUnion("kind"));

export type FeedEvent = typeof FeedEvent.Type;

export type FeedKind = FeedEvent["kind"];

/** GET /v1/events: a page, newest first. */
export const EventsPage = Schema.Struct({
  events: Schema.Array(FeedEvent),
  /** The cursor for the next (older) page; null at the end. */
  next: Schema.NullOr(Schema.String),
  /** The page went past the feed's window and read monorepos' own logs. */
  from_logs: Schema.Boolean,
  /** Monorepos (`owner/name`) not read for this page (over 20 logs); narrow with `in` to read one. */
  skipped: Schema.Array(Schema.String),
});

export interface EventsPage extends Schema.Schema.Type<typeof EventsPage> {}

/**
 * Frames the person's socket sends (`GET /v1/events` with `Upgrade:
 * websocket`). The text frame `ping` gets the text frame `pong`, which is
 * not JSON and not one of these.
 */
export const ActivityFrame = Schema.Union([
  /** Place by its display key; the same line can come again with a fuller summary: replace by `(monorepo_id, seq)`. */
  Schema.Struct({ type: Schema.tag("event"), landed: Count, event: FeedEvent }),
  Schema.Struct({ type: Schema.tag("summary"), monorepo: FullName, monorepo_id: MonorepoId, summary: FeedSummary }),
  /** `more`: over 50 changed; refetch the needs list. */
  Schema.Struct({ type: Schema.tag("needs"), monorepo: FullName, monorepo_id: MonorepoId, changed: Schema.Array(NeedChange), more: Schema.Boolean }),
  /** Refetch the first page and the list. */
  Schema.Struct({ type: Schema.tag("joined"), monorepo: FullName, monorepo_id: MonorepoId, large: Schema.Boolean }),
  Schema.Struct({ type: Schema.tag("left"), monorepo: FullName, monorepo_id: MonorepoId }),
  /** The replay is done; keep the highest `landed` and send it as `since` on reconnect. */
  Schema.Struct({ type: Schema.tag("caught_up"), landed: Count }),
  /** More than 500 lines were missed: refetch the first page. */
  Schema.Struct({ type: Schema.tag("resync"), landed: Count }),
  Schema.Struct({ type: Schema.tag("error"), message: Schema.String }),
]).pipe(Schema.toTaggedUnion("type"));

export type ActivityFrame = typeof ActivityFrame.Type;

/** What the client sends first, and on every reconnect: `since` is the highest `landed` seen. */
export const ActivityHello = Schema.Struct({
  type: Schema.tag("hello"),
  since: Schema.optionalKey(Count),
});

export interface ActivityHello extends Schema.Schema.Type<typeof ActivityHello> {}

/**
 * Frames of a monorepo's own socket opened with `?topics=feed` (`GET
 * /v1/monorepos/{owner}/{monorepo}/events`, `Upgrade: websocket`): the home
 * opens one for each large monorepo (more than 100 members), whose lines do
 * not reach the person's socket. Lines are numbered `n` in the order they go
 * out; reconnect with `feed_since=<the last n seen>`.
 */
export const MonorepoFeedFrame = Schema.Union([
  /** One activity line; the same line can come again with a fuller summary: replace by `(monorepo_id, seq)`. */
  Schema.Struct({ type: Schema.tag("feed"), n: Count, event: FeedEvent }),
  /** The replay is done. `feed_n` is the last line number sent. */
  Schema.Struct({ type: Schema.tag("caught_up"), seq: Count, feed_n: Schema.optionalKey(Count) }),
  /** More than 500 lines were missed, or an unknown `feed_since`: refetch the log, then reconnect with this `feed_n`. */
  Schema.Struct({ type: Schema.tag("feed_resync"), feed_n: Count }),
  /** The event stream itself was missed past its replay: refetch, then resume from `seq`. */
  Schema.Struct({ type: Schema.tag("resync"), seq: Count, oldest_seq: Count }),
  Schema.Struct({ type: Schema.tag("error"), message: Schema.String }),
]).pipe(Schema.toTaggedUnion("type"));

export type MonorepoFeedFrame = typeof MonorepoFeedFrame.Type;
