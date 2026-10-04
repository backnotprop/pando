// Issues' shapes and routes as the spec gives them (research/plans/
// issues-2026-10-04/SPEC.md, 5.1 and 5.3), with pando-ops' calls on
// reactions and the merge's `closes`. Pending: web-api's contract commit
// replaces this file with @pando/contract's own (issue.ts, stream.ts,
// routes.ts); the screens import from here until then, so the switch is a
// change of imports.
import { Count, Login, RepoName, Sha, Timestamp } from "@pando/contract";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const IssueState = Schema.Literals(["open", "closed"]);

export const IssueStateReason = Schema.Literals(["completed", "not_planned"]);

export type IssueStateReason = typeof IssueStateReason.Type;

/** A label's colour: one of eight names, set per theme in theme.css (no red, no Foxfire green). */
export const LabelColor = Schema.Literals(["gray", "orange", "yellow", "green", "teal", "blue", "purple", "pink"]);

export type LabelColor = typeof LabelColor.Type;

export const LABEL_COLORS = LabelColor.literals;

export const Label = Schema.Struct({ name: Schema.String, color: LabelColor, description: Schema.NullOr(Schema.String) });

export interface Label extends Schema.Schema.Type<typeof Label> {}

/** GitHub's eight reactions. */
export const ReactionContent = Schema.Literals(["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"]);

export type ReactionContent = typeof ReactionContent.Type;

export const REACTIONS = ReactionContent.literals;

/** One reaction on a body or a comment: how many, and who (so the page knows yours). */
export const Reaction = Schema.Struct({ content: ReactionContent, count: Count, by: Schema.Array(Login) });

export interface Reaction extends Schema.Schema.Type<typeof Reaction> {}

/** A merge that closed or named an issue. */
export const IssueMerge = Schema.Struct({ repo: RepoName, repo_path: Schema.String, branch: Schema.String, merge_commit: Sha });

export interface IssueMerge extends Schema.Schema.Type<typeof IssueMerge> {}

/** A row of the list: no body. */
export const IssueRow = Schema.Struct({
  number: Count,
  title: Schema.String,
  state: IssueState,
  state_reason: Schema.NullOr(IssueStateReason),
  project: Schema.NullOr(RepoName),
  project_path: Schema.NullOr(Schema.String),
  labels: Schema.Array(Label),
  assignees: Schema.Array(Login),
  author: Login,
  comments: Count,
  tasks: Schema.NullOr(Schema.Struct({ done: Count, total: Count })),
  linked_branches: Count,
  created_at: Timestamp,
  updated_at: Timestamp,
  closed_at: Schema.NullOr(Timestamp),
  closed_by: Schema.NullOr(Login),
  closed_by_merge: Schema.NullOr(IssueMerge),
});

export interface IssueRow extends Schema.Schema.Type<typeof IssueRow> {}

export const LinkSource = Schema.Literals(["link", "title", "commit"]);

export type LinkSource = typeof LinkSource.Type;

/** A branch linked to the issue, with every way it is linked. */
export const IssueLink = Schema.Struct({
  repo: RepoName,
  repo_path: Schema.String,
  branch: Schema.String,
  sources: Schema.Array(LinkSource),
  sha: Schema.NullOr(Sha),
  linked_by: Schema.NullOr(Login),
  branch_state: Schema.Literals(["open", "ready", "conflicts", "failing", "merged", "deleted"]),
  merged_at: Schema.NullOr(Timestamp),
  closes: Schema.Boolean,
});

export interface IssueLink extends Schema.Schema.Type<typeof IssueLink> {}

const reactions = Schema.optionalKey(Schema.Array(Reaction));

/** GET .../issues/{n}. */
export const Issue = Schema.Struct({
  ...IssueRow.fields,
  body: Schema.String,
  body_version: Count,
  machine: Schema.NullOr(Schema.String),
  links: Schema.Array(IssueLink),
  participants: Schema.Array(Login),
  reactions,
});

export interface Issue extends Schema.Schema.Type<typeof Issue> {}

export const IssueComment = Schema.Struct({
  id: Schema.String,
  body: Schema.NullOr(Schema.String),
  body_version: Count,
  author: Login,
  machine: Schema.NullOr(Schema.String),
  created_at: Timestamp,
  updated_at: Timestamp,
  reactions,
  /** In an event: the body was over 16 KB and left out; read the timeline again. */
  partial: Schema.optionalKey(Schema.Boolean),
});

export interface IssueComment extends Schema.Schema.Type<typeof IssueComment> {}

/** What every timeline item carries. `id` orders them (one counter per monorepo). */
const item = { id: Count, at: Timestamp, actor: Schema.NullOr(Login), machine: Schema.NullOr(Schema.String) };

const branchRef = { repo: RepoName, repo_path: Schema.String, branch: Schema.String };

export const TimelineItem = Schema.Union([
  Schema.Struct({ ...item, kind: Schema.tag("comment"), comment: IssueComment }),
  Schema.Struct({ ...item, kind: Schema.tag("labeled"), label: Label }),
  Schema.Struct({ ...item, kind: Schema.tag("unlabeled"), label: Label }),
  Schema.Struct({ ...item, kind: Schema.tag("assigned"), login: Login }),
  Schema.Struct({ ...item, kind: Schema.tag("unassigned"), login: Login }),
  Schema.Struct({ ...item, kind: Schema.tag("renamed"), from: Schema.String, to: Schema.String }),
  Schema.Struct({ ...item, kind: Schema.tag("project_changed"), from: Schema.NullOr(Schema.String), to: Schema.NullOr(Schema.String) }),
  Schema.Struct({ ...item, kind: Schema.tag("linked"), ...branchRef, source: LinkSource, sha: Schema.NullOr(Sha) }),
  Schema.Struct({ ...item, kind: Schema.tag("unlinked"), ...branchRef }),
  Schema.Struct({ ...item, kind: Schema.tag("closed"), reason: IssueStateReason, merge: Schema.NullOr(IssueMerge) }),
  Schema.Struct({ ...item, kind: Schema.tag("reopened") }),
  Schema.Struct({ ...item, kind: Schema.tag("merge_referenced"), merge: IssueMerge }),
]).pipe(Schema.toTaggedUnion("kind"));

export type TimelineItem = typeof TimelineItem.Type;

export const IssueList = Schema.Struct({
  issues: Schema.Array(IssueRow),
  counts: Schema.Struct({ open: Count, closed: Count }),
  next_cursor: Schema.NullOr(Schema.String),
});

export interface IssueList extends Schema.Schema.Type<typeof IssueList> {}

export const Timeline = Schema.Struct({
  items: Schema.Array(TimelineItem),
  next_cursor: Schema.NullOr(Schema.String),
  /** How many items in all (asked of web-api, with a read of the newest page). */
  total: Schema.optionalKey(Count),
});

export interface Timeline extends Schema.Schema.Type<typeof Timeline> {}

export const LabelRow = Schema.Struct({ ...Label.fields, open_issues: Count });

export interface LabelRow extends Schema.Schema.Type<typeof LabelRow> {}

export const LabelList = Schema.Struct({ labels: Schema.Array(LabelRow) });

export const Reactions = Schema.Struct({ reactions: Schema.Array(Reaction) });

// ── Event frames on a monorepo's event socket (topics `issues` and `issue:<n>`) ──

const envelope = {
  type: Schema.tag("event"),
  seq: Count,
  at: Timestamp,
  key: Schema.String,
  repo: Schema.NullOr(RepoName),
  actor: Schema.NullOr(Schema.String),
  machine: Schema.NullOr(Schema.String),
};

export const IssueEvent = Schema.Struct({
  ...envelope,
  kind: Schema.Literals(["issue.opened", "issue.commented", "issue.closed", "issue.reopened", "issue.updated"]),
  collection: Schema.Literal("issues"),
  op: Schema.Literal("upsert"),
  number: Count,
  row: IssueRow,
  /** The issue's body moved to this version: a page showing the body reads it again. */
  body_version: Schema.optionalKey(Count),
  items: Schema.Array(TimelineItem),
  /** Timeline items gone (a comment deleted). */
  removed: Schema.optionalKey(Schema.Array(Count)),
  /** The body's reactions changed. */
  reactions,
});

export type IssueEvent = typeof IssueEvent.Type;

export const LabelEvent = Schema.Union([
  Schema.Struct({ ...envelope, kind: Schema.Literal("label.updated"), collection: Schema.Literal("labels"), op: Schema.Literal("upsert"), row: Label }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("label.updated"), collection: Schema.Literal("labels"), op: Schema.Literal("delete"), row: Schema.Struct({ name: Schema.String }) }),
]);

export type LabelEvent = typeof LabelEvent.Type;

const decodeIssueFrame = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Union([IssueEvent, LabelEvent])), { onExcessProperty: "ignore" });

/** An issue or label frame, or null for anything else (the contract's own decode reads the rest). */
export const issueFrameOf = (data: string): IssueEvent | LabelEvent | null => Option.getOrNull(decodeIssueFrame(data));

// ── Routes (SPEC.md 5.1), under /v1/monorepos/{owner}/{name} ──

/** The list's query: what the address keeps (?state=closed&label=bug). */
export interface IssueFilters {
  state: "open" | "closed";
  labels: readonly string[];
  assignee: string | null;
  author: string | null;
  project: string | null;
  linked: string | null;
  q: string;
  sort: "created" | "updated" | "comments";
  order: "desc" | "asc";
}

const enc = encodeURIComponent;

const base = (owner: string, name: string) => `/v1/monorepos/${enc(owner)}/${enc(name)}`;

const issueBase = (owner: string, name: string, n: number) => `${base(owner, name)}/issues/${n}`;

export const listIssues = (owner: string, name: string, f: IssueFilters | "all-states", cursor: string | null, limit = 30) => {
  const params = new URLSearchParams();

  if (f === "all-states") {
    params.set("state", "all");
  } else {
    params.set("state", f.state);

    for (const l of f.labels) params.append("label", l);

    if (f.assignee) params.set("assignee", f.assignee);

    if (f.author) params.set("author", f.author);

    if (f.project) params.set("project", f.project);

    if (f.linked) params.set("linked", f.linked);

    if (f.q.trim()) params.set("q", f.q.trim());

    if (f.sort !== "created") params.set("sort", f.sort);

    if (f.order !== "desc") params.set("order", f.order);
  }

  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(limit));

  return { path: `${base(owner, name)}/issues?${params}`, response: IssueList };
};

export const linkedIssues = (owner: string, name: string, repo: RepoName, branch: string) => ({
  path: `${base(owner, name)}/issues?${new URLSearchParams({ state: "all", linked: `${repo}:${branch}`, limit: "100" })}`,
  response: IssueList,
});

export const createIssue = (owner: string, name: string) => ({ method: "POST", path: `${base(owner, name)}/issues`, response: Issue }) as const;

export const getIssue = (owner: string, name: string, n: number) => ({ path: issueBase(owner, name, n), response: Issue });

export const editIssue = (owner: string, name: string, n: number) => ({ method: "PATCH", path: issueBase(owner, name, n), response: Issue }) as const;

export const getTimeline = (owner: string, name: string, n: number, cursor: string | null) => ({
  path: `${issueBase(owner, name, n)}/timeline?limit=100${cursor ? `&cursor=${enc(cursor)}` : ""}`,
  response: Timeline,
});

export const addComment = (owner: string, name: string, n: number) => ({ method: "POST", path: `${issueBase(owner, name, n)}/comments`, response: IssueComment }) as const;

export const editComment = (owner: string, name: string, n: number, id: string) =>
  ({ method: "PATCH", path: `${issueBase(owner, name, n)}/comments/${enc(id)}`, response: IssueComment }) as const;

export const deleteComment = (owner: string, name: string, n: number, id: string) => ({ method: "DELETE", path: `${issueBase(owner, name, n)}/comments/${enc(id)}` }) as const;

/** PUT adds your reaction, DELETE takes it back; both answer the reactions as they are now. `comment` null: the issue's body. */
export const reaction = (owner: string, name: string, n: number, comment: string | null, content: ReactionContent, method: "PUT" | "DELETE") =>
  ({ method, path: `${issueBase(owner, name, n)}${comment ? `/comments/${enc(comment)}` : ""}/reactions/${enc(content)}`, response: Reactions }) as const;

export const listLabels = (owner: string, name: string) => ({ path: `${base(owner, name)}/labels`, response: LabelList });

export const createLabel = (owner: string, name: string) => ({ method: "POST", path: `${base(owner, name)}/labels`, response: Label }) as const;

export const editLabel = (owner: string, name: string, label: string) => ({ method: "PATCH", path: `${base(owner, name)}/labels/${enc(label)}`, response: Label }) as const;

export const deleteLabel = (owner: string, name: string, label: string) => ({ method: "DELETE", path: `${base(owner, name)}/labels/${enc(label)}` }) as const;
