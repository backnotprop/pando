// Branches, their commits, reviews and merges: listBranches, getBranch,
// branchCommits, listReviews and mergeBranch (api-v1.yaml).
import * as Schema from "effect/Schema";

import { Checks } from "./checks.ts";
import { ReviewVerdict } from "./feed.ts";
import { Count, Login, Sha, Timestamp } from "./ids.ts";

/** From the merge engine's dry run; `pending` while not computed for the current main and head. */
export const Mergeable = Schema.Literals(["clean", "conflicts", "up_to_date", "unknown", "pending"]);

export type Mergeable = typeof Mergeable.Type;

export const BranchState = Schema.Literals(["open", "merged"]);

export const Branch = Schema.Struct({
  name: Schema.String,
  head: Sha,
  /** The merge base with the default branch. */
  base: Schema.NullOr(Sha),
  /** The user whose first push made the branch. */
  author: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  /** Commits on the branch that are not on the default branch, and the other way. */
  ahead: Schema.NullOr(Count),
  behind: Schema.NullOr(Count),
  mergeable: Mergeable,
  /** True while ahead, behind, base and mergeable are not yet for the current main and head. */
  stale: Schema.Boolean,
  /** When stale: the last known mergeable answer. */
  last_mergeable: Schema.NullOr(Mergeable),
  facts_at: Schema.NullOr(Timestamp),
  checks: Checks,
  state: BranchState,
  merge_commit: Schema.NullOr(Sha),
  merged_by: Schema.NullOr(Schema.String),
  merged_at: Schema.NullOr(Timestamp),
  merged_machine: Schema.NullOr(Schema.String),
  merged_agent: Schema.NullOr(Schema.String),
  /** The credential (machine) that last pushed the branch. */
  pushed_machine: Schema.NullOr(Schema.String),
  /** True when the merge went past red or missing checks with force=1. */
  forced: Schema.NullOr(Schema.Boolean),
  created_at: Schema.NullOr(Timestamp),
  updated_at: Schema.NullOr(Timestamp),
});

export interface Branch extends Schema.Schema.Type<typeof Branch> {}

/** GET .../repos/{repo}/branches: the default branch is not in the list; its name and head are at the top. */
export const BranchList = Schema.Struct({
  default_branch: Schema.String,
  /** Null while the repo is empty. */
  default_head: Schema.NullOr(Sha),
  branches: Schema.Array(Branch),
  /** Pass as `cursor` for the next page; null on the last. */
  next_cursor: Schema.NullOr(Schema.String),
});

export interface BranchList extends Schema.Schema.Type<typeof BranchList> {}

export const CommitPerson = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  date: Schema.NullOr(Timestamp),
});

export interface CommitPerson extends Schema.Schema.Type<typeof CommitPerson> {}

export const Commit = Schema.Struct({
  sha: Sha,
  parents: Schema.Array(Sha),
  /** The message's first line. */
  title: Schema.String,
  /** The full message, at most 4,096 characters. */
  message: Schema.String,
  author: CommitPerson,
  committer: CommitPerson,
  /** Pando's who-made-it trailers, from the message's last paragraph. */
  trailers: Schema.Struct({
    agent: Schema.NullOr(Schema.String),
    worktree: Schema.NullOr(Schema.String),
    machine: Schema.NullOr(Schema.String),
  }),
  /** `Co-authored-by` lines, each once, as git and GitHub read them. */
  co_authors: Schema.Array(Schema.Struct({ name: Schema.String, email: Schema.NullOr(Schema.String) })),
});

export interface Commit extends Schema.Schema.Type<typeof Commit> {}

/** GET .../branches/{branch}/commits: the branch's own commits, newest first. */
export const BranchCommits = Schema.Struct({
  branch: Schema.String,
  head: Sha,
  base_branch: Schema.String,
  merge_base: Schema.NullOr(Sha),
  /** Commits on the branch only; may be more than returned. */
  total: Count,
  truncated: Schema.Boolean,
  commits: Schema.Array(Commit),
});

export interface BranchCommits extends Schema.Schema.Type<typeof BranchCommits> {}

export const ReviewComment = Schema.Struct({
  path: Schema.String,
  /** A line in the new file (`side` new) or the old one. */
  line: Schema.optionalKey(Schema.NullOr(Count)),
  side: Schema.optionalKey(Schema.Literals(["new", "old"])),
  body: Schema.String,
});

export interface ReviewComment extends Schema.Schema.Type<typeof ReviewComment> {}

/** A review is comments and an approval, not a gate. */
export const Review = Schema.Struct({
  id: Schema.String,
  branch: Schema.String,
  head: Sha,
  verdict: ReviewVerdict,
  body: Schema.NullOr(Schema.String),
  comments: Schema.Array(ReviewComment),
  author: Schema.String,
  created_at: Timestamp,
});

export interface Review extends Schema.Schema.Type<typeof Review> {}

/** GET .../branches/{branch}/reviews: oldest first. */
export const ReviewList = Schema.Struct({ reviews: Schema.Array(Review) });

export interface ReviewList extends Schema.Schema.Type<typeof ReviewList> {}

/** POST .../branches/{branch}/merge: merged, or already in the default branch. */
export const MergeResult = Schema.Struct({
  status: Schema.Literals(["merged", "up_to_date"]),
  branch: Schema.String,
  /** The branch head that was merged. */
  head: Sha,
  /** The merge commit, or the default branch head for `up_to_date`. */
  sha: Schema.optionalKey(Sha),
  /** The default branch head before the merge. */
  base_before: Schema.optionalKey(Sha),
  merge_base: Schema.optionalKey(Sha),
  forced: Schema.optionalKey(Schema.Boolean),
  merged_by: Schema.optionalKey(Login),
});

export interface MergeResult extends Schema.Schema.Type<typeof MergeResult> {}
