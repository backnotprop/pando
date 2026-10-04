// Branches, their commits, files changed, reviews and merges: listBranches,
// getBranch, branchCommits, branchDiff, listReviews and mergeBranch (api-v1.yaml).
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
  /** The paths changed differently on both sides, from the dry run behind `mergeable` (or `last_mergeable` while stale); null unless that answer is `conflicts`. */
  conflict_paths: Schema.NullOr(Schema.Array(Schema.String)),
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

/**
 * GET .../repos/{repo}/branches: newest first (an open branch by its last
 * push, a merged one by its merge; ties by name). The default branch is not
 * in the list; its name and head are at the top.
 */
export const BranchList = Schema.Struct({
  default_branch: Schema.String,
  /** Null while the repo is empty. */
  default_head: Schema.NullOr(Sha),
  branches: Schema.Array(Branch),
  /** Pass as `cursor` for the next page, as it came (the last row's time and name); null on the last. */
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

/** One changed file in Files changed, with its own unified patch. */
export const ChangedFile = Schema.Struct({
  path: Schema.String,
  /** For a rename: the path on main's side. */
  old_path: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
  /** The blob and mode on each side; null on the side the file is missing from. */
  old_sha: Schema.NullOr(Sha),
  new_sha: Schema.NullOr(Sha),
  old_mode: Schema.NullOr(Schema.String),
  new_mode: Schema.NullOr(Schema.String),
  binary: Schema.Boolean,
  /** Null for a binary or a file too large to diff. */
  additions: Schema.NullOr(Count),
  deletions: Schema.NullOr(Count),
  /** Why `patch` is null: a binary, over 8 MiB a side, or past the budget of patches in all (2 MiB; 32 MiB streamed). */
  patch_omitted: Schema.optionalKey(Schema.Literals(["binary", "too_large", "budget"])),
  /** This file's unified patch in git's format (for @pierre/diffs' processFile); null when `patch_omitted` is set. */
  patch: Schema.NullOr(Schema.String),
});

export interface ChangedFile extends Schema.Schema.Type<typeof ChangedFile> {}

/**
 * GET .../branches/{branch}/diff?patches=1: Files changed, the branch's head
 * against its merge base with the default branch. Kept by (base, head); the
 * ETag is the two shas.
 */
export const BranchDiff = Schema.Struct({
  base_branch: Schema.String,
  /** The default branch's head the diff was taken against; for a branch Pando merged at this head, main just before that merge. */
  base: Sha,
  head: Sha,
  merge_base: Sha,
  /** Some patches were left out past 2 MiB in all (`patch_omitted: budget`). */
  truncated: Schema.Boolean,
  /** More than 1,000 files changed: the first 1,000 by path are listed. */
  too_many_files: Schema.Boolean,
  /** Every changed file, listed or not. */
  files_total: Count,
  /** Of the listed files. */
  stats: Schema.Struct({ files: Count, additions: Count, deletions: Count }),
  files: Schema.Array(ChangedFile),
});

export interface BranchDiff extends Schema.Schema.Type<typeof BranchDiff> {}

/**
 * GET .../branches/{branch}/diff?patches=1&stream=1: Files changed for a large
 * branch, as NDJSON, one line as each part is known: "start", then one "file"
 * per changed file in path order (at most 5,000), then "end"; "error" if the
 * diff fails after its start. Patches stop at 32 MiB in all.
 */
export const BranchDiffLine = Schema.Union([
  Schema.Struct({
    type: Schema.tag("start"),
    base_branch: Schema.String,
    base: Sha,
    head: Sha,
    merge_base: Sha,
    /** Every changed file, listed or not. */
    files_total: Count,
    /** More than 5,000 files changed: the first 5,000 by path are listed. */
    too_many_files: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.tag("file"), ...ChangedFile.fields }),
  Schema.Struct({
    type: Schema.tag("end"),
    /** Some patches were left out past the budget (`patch_omitted: budget`). */
    truncated: Schema.Boolean,
    /** Of the listed files. */
    stats: Schema.Struct({ files: Count, additions: Count, deletions: Count }),
  }),
  Schema.Struct({ type: Schema.tag("error"), code: Schema.String, message: Schema.String }),
]);

export type BranchDiffLine = typeof BranchDiffLine.Type;

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
  /**
   * `merged`: the open issues this merge closes, decided as it lands: the branch's links (explicit, its title or
   * description, its commits) and closing keywords in the merge message and the merged commits. Each closes about
   * a second later, in its own step (an `issue.closed` naming the merge); one closed by someone meanwhile is left.
   */
  closes: Schema.optionalKey(Schema.Array(Count)),
});

export interface MergeResult extends Schema.Schema.Type<typeof MergeResult> {}
