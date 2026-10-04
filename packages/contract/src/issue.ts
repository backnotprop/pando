// Issues: one list per monorepo, numbered #1, #2, ... (research/plans/issues-2026-10-04/SPEC.md and the
// owner's rulings). Routes under /v1/monorepos/{owner}/{monorepo}/issues and .../labels (api-v1.yaml);
// their row events are in stream.ts, their activity lines in feed.ts.
import * as Schema from "effect/Schema";

import { Count, Login, RepoName, Sha, Timestamp } from "./ids.ts";

export const IssueState = Schema.Literals(["open", "closed"]);

export type IssueState = typeof IssueState.Type;

/** Why it was closed: `completed` (a person, or a merge naming it) or `not_planned` (a person only). */
export const IssueStateReason = Schema.Literals(["completed", "not_planned"]);

export type IssueStateReason = typeof IssueStateReason.Type;

/** A label's colour is one of eight names; each theme sets them from its own tokens (no red, no Foxfire). */
export const LabelColor = Schema.Literals(["gray", "orange", "yellow", "green", "teal", "blue", "purple", "pink"]);

export type LabelColor = typeof LabelColor.Type;

export const Label = Schema.Struct({
  /** 1 to 50 characters, unique ignoring case. */
  name: Schema.String,
  color: LabelColor,
  /** Up to 100 characters. */
  description: Schema.NullOr(Schema.String),
});

export interface Label extends Schema.Schema.Type<typeof Label> {}

/** GitHub's eight reactions. */
export const ReactionContent = Schema.Literals(["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"]);

export type ReactionContent = typeof ReactionContent.Type;

/** One reaction, how many, and who gave it (each person once). */
export const ReactionGroup = Schema.Struct({ content: ReactionContent, count: Count, by: Schema.Array(Login) });

export interface ReactionGroup extends Schema.Schema.Type<typeof ReactionGroup> {}

/** An issue's or a comment's reactions: those given at least once, in GitHub's order (+1, -1, laugh, hooray, confused, heart, rocket, eyes). */
export const Reactions = Schema.Array(ReactionGroup);

/** A merge that closed or named an issue. */
export const IssueMerge = Schema.Struct({ repo: RepoName, repo_path: Schema.String, branch: Schema.String, merge_commit: Sha });

export interface IssueMerge extends Schema.Schema.Type<typeof IssueMerge> {}

/** `- [ ]` and `- [x]` lines in the body. */
export const IssueTasks = Schema.Struct({ done: Count, total: Count });

/** A row of the list: no body. */
export const IssueRow = Schema.Struct({
  number: Count,
  /** 1 to 256 characters. */
  title: Schema.String,
  state: IssueState,
  /** Null while open. */
  state_reason: Schema.NullOr(IssueStateReason),
  /** The project it is about (a repo's name and path); null for the monorepo as a whole. */
  project: Schema.NullOr(RepoName),
  project_path: Schema.NullOr(Schema.String),
  labels: Schema.Array(Label),
  /** Members' logins, up to 10. */
  assignees: Schema.Array(Login),
  author: Login,
  comments: Count,
  /** Null when the body has no task list. */
  tasks: Schema.NullOr(IssueTasks),
  /** Branches linked to it, every way. */
  linked_branches: Count,
  created_at: Timestamp,
  updated_at: Timestamp,
  closed_at: Schema.NullOr(Timestamp),
  closed_by: Schema.NullOr(Login),
  /** The merge that closed it, when one did. */
  closed_by_merge: Schema.NullOr(IssueMerge),
});

export interface IssueRow extends Schema.Schema.Type<typeof IssueRow> {}

/** How a branch is linked: `link` (explicit), `title` (a closing keyword in its title or description), `commit` (in one of its commits). */
export const IssueLinkSource = Schema.Literals(["link", "title", "commit"]);

export type IssueLinkSource = typeof IssueLinkSource.Type;

/** A branch linked to the issue, with every way it is linked. Merging it closes the issue (if open then). */
export const IssueLink = Schema.Struct({
  repo: RepoName,
  repo_path: Schema.String,
  branch: Schema.String,
  sources: Schema.Array(IssueLinkSource),
  /** `commit`: the newest commit on the branch that names it. */
  sha: Schema.NullOr(Sha),
  /** `link`: who linked it. */
  linked_by: Schema.NullOr(Login),
  /** The branch's state in one word, from its row and facts as the branch page shows them. */
  branch_state: Schema.Literals(["open", "ready", "conflicts", "failing", "merged", "deleted"]),
  merged_at: Schema.NullOr(Timestamp),
  /** This branch's merge closed the issue. */
  closed_issue: Schema.Boolean,
});

export interface IssueLink extends Schema.Schema.Type<typeof IssueLink> {}

/** GET .../issues/{n}. */
export const Issue = Schema.Struct({
  ...IssueRow.fields,
  /** Markdown, up to 65,536 characters. */
  body: Schema.String,
  /** Goes up by one on every body edit; send it back as `base_version` to edit without overwriting someone else's. */
  body_version: Count,
  /** The machine (credential name) that opened it. */
  machine: Schema.NullOr(Schema.String),
  links: Schema.Array(IssueLink),
  /** Everyone in its timeline: the author, commenters, and whoever changed it. */
  participants: Schema.Array(Login),
  reactions: Reactions,
});

export interface Issue extends Schema.Schema.Type<typeof Issue> {}

export const IssueComment = Schema.Struct({
  /** `ic_` and 16 hex characters. */
  id: Schema.String,
  /** Markdown, up to 65,536 characters. In a live event, null over 16 KB: fetch the timeline. */
  body: Schema.NullOr(Schema.String),
  body_version: Count,
  author: Login,
  /** The machine (credential name) that wrote it. */
  machine: Schema.NullOr(Schema.String),
  created_at: Timestamp,
  updated_at: Timestamp,
  reactions: Reactions,
});

export interface IssueComment extends Schema.Schema.Type<typeof IssueComment> {}

/** What every timeline item carries. `id` orders items (one counter per monorepo); `actor` is null for no person. */
const itemFields = { id: Count, at: Timestamp, actor: Schema.NullOr(Login), machine: Schema.NullOr(Schema.String) };

/** One timeline item, by kind; comments and events together, oldest first. */
export const TimelineItem = Schema.Union([
  Schema.Struct({ ...itemFields, kind: Schema.tag("comment"), comment: IssueComment }),
  /** The label as it was then. */
  Schema.Struct({ ...itemFields, kind: Schema.tag("labeled"), label: Label }),
  Schema.Struct({ ...itemFields, kind: Schema.tag("unlabeled"), label: Label }),
  Schema.Struct({ ...itemFields, kind: Schema.tag("assigned"), assignee: Login }),
  Schema.Struct({ ...itemFields, kind: Schema.tag("unassigned"), assignee: Login }),
  Schema.Struct({ ...itemFields, kind: Schema.tag("renamed"), from: Schema.String, to: Schema.String }),
  Schema.Struct({
    ...itemFields,
    kind: Schema.tag("project_changed"),
    from: Schema.NullOr(RepoName),
    from_path: Schema.NullOr(Schema.String),
    to: Schema.NullOr(RepoName),
    to_path: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...itemFields,
    kind: Schema.tag("linked"),
    repo: RepoName,
    repo_path: Schema.String,
    branch: Schema.String,
    source: IssueLinkSource,
    sha: Schema.NullOr(Sha),
  }),
  Schema.Struct({ ...itemFields, kind: Schema.tag("unlinked"), repo: RepoName, repo_path: Schema.String, branch: Schema.String, source: IssueLinkSource }),
  /** `merge`: the merge that closed it as completed; null when a person closed it. */
  Schema.Struct({ ...itemFields, kind: Schema.tag("closed"), reason: IssueStateReason, merge: Schema.NullOr(IssueMerge) }),
  Schema.Struct({ ...itemFields, kind: Schema.tag("reopened") }),
  /** A merge named the issue after it was closed. */
  Schema.Struct({ ...itemFields, kind: Schema.tag("merge_referenced"), merge: IssueMerge }),
]).pipe(Schema.toTaggedUnion("kind"));

export type TimelineItem = typeof TimelineItem.Type;

/** GET .../issues: a page, and the counts for the same filters in either state ("9 Open 31 Closed"). */
export const IssueList = Schema.Struct({
  issues: Schema.Array(IssueRow),
  counts: Schema.Struct({ open: Count, closed: Count }),
  /** Pass as `cursor` for the next page, as it came; null on the last. */
  next_cursor: Schema.NullOr(Schema.String),
});

export interface IssueList extends Schema.Schema.Type<typeof IssueList> {}

/**
 * GET .../issues/{n}/timeline: oldest first. `?cursor=` continues after a page; `?last=N` is the newest N (still
 * oldest first), so a long timeline shows its first page, "Show N more", then its last page.
 */
export const Timeline = Schema.Struct({
  items: Schema.Array(TimelineItem),
  /** Every item in the timeline. */
  total: Count,
  /** The items after this page; null on the last. */
  next_cursor: Schema.NullOr(Schema.String),
});

export interface Timeline extends Schema.Schema.Type<typeof Timeline> {}

/** GET .../labels: by name, each with its open issues. */
export const LabelList = Schema.Struct({ labels: Schema.Array(Schema.Struct({ ...Label.fields, open_issues: Count })) });

export interface LabelList extends Schema.Schema.Type<typeof LabelList> {}

/** PUT or DELETE .../reactions/{content}: the reactions now. */
export const ReactionsAnswer = Schema.Struct({ reactions: Reactions });

export interface ReactionsAnswer extends Schema.Schema.Type<typeof ReactionsAnswer> {}
