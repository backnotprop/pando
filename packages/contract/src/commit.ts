// One commit's page: getCommit and commitDiffStream (api-v1.yaml).
import * as Schema from "effect/Schema";

import { Commit, DiffEndLine, DiffErrorLine, DiffFileLine } from "./branch.ts";
import { Checks } from "./checks.ts";
import { Count, Login, Sha } from "./ids.ts";

/** A branch as a commit's page names it. `deleted`: the branch is gone (its name stays, with no page). */
export const CommitBranch = Schema.Struct({
  name: Schema.String,
  title: Schema.NullOr(Schema.String),
  state: Schema.Literals(["open", "merged", "deleted"]),
  /** Its merge into the default branch, once merged. */
  merge_commit: Schema.NullOr(Sha),
});

export interface CommitBranch extends Schema.Schema.Type<typeof CommitBranch> {}

/**
 * GET .../repos/{repo}/commits/{sha}: one commit (a full sha, or 7 to 39 of
 * its first hex characters when Pando knows only one commit that starts so).
 */
export const CommitPage = Schema.Struct({
  commit: Commit,
  /** The person the author's email names (their sign-in email, or <login>@users.pando.invalid), when they can open this repository. */
  author_person: Schema.NullOr(Schema.Struct({ login: Login, picture_url: Schema.NullOr(Schema.String) })),
  /**
   * The branch it was pushed on, when Pando knows it: a branch's head, or one
   * of the newest 250 commits of a branch Pando compared with main. The
   * earliest such branch; null when none is known.
   */
  branch: Schema.NullOr(CommitBranch),
  /** When the commit is Pando's merge of a branch into the default branch: that branch. */
  merge_of: Schema.NullOr(CommitBranch),
  /** Its checks, against the repo's required checks. */
  checks: Checks,
});

export interface CommitPage extends Schema.Schema.Type<typeof CommitPage> {}

/**
 * GET .../repos/{repo}/commits/{sha}/diff: what the commit changed against
 * its first parent, as NDJSON with Files changed's limits: "start", one
 * "file" per changed file in tree order (at most 5,000), then "end"; "error"
 * if the diff fails after its start. Patches stop at 32 MiB in all.
 */
export const CommitDiffLine = Schema.Union([
  Schema.Struct({
    type: Schema.tag("start"),
    sha: Sha,
    /** The first parent it is compared with; null for a first commit (compared with nothing). */
    parent: Schema.NullOr(Sha),
    /** Every changed file, listed or not. */
    files_total: Count,
    /** More than 5,000 files changed: the first 5,000 by path are listed. */
    too_many_files: Schema.Boolean,
  }),
  DiffFileLine,
  DiffEndLine,
  DiffErrorLine,
]);

export type CommitDiffLine = typeof CommitDiffLine.Type;
