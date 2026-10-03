// "Needs you": GET /v1/branches (operationId `listNeeds`), and the changes
// the person's socket sends in its `needs` frame.
import * as Schema from "effect/Schema";

import { FullName, MonorepoId, RepoName, Sha, Timestamp } from "./ids.ts";

/** One state per branch, in this order: conflicts, failing, ready. */
export const NeedState = Schema.Literals(["ready", "conflicts", "failing"]);

export type NeedState = typeof NeedState.Type;

export const NeedRow = Schema.Struct({
  monorepo: FullName,
  monorepo_id: MonorepoId,
  repo: RepoName,
  repo_path: Schema.String,
  branch: Schema.String,
  /** The head commit's title. */
  title: Schema.NullOr(Schema.String),
  head: Sha,
  /** The user whose first push made the branch. */
  author: Schema.NullOr(Schema.String),
  /** The credential (machine) that last pushed it. */
  pushed_machine: Schema.NullOr(Schema.String),
  state: NeedState,
  checks: Schema.Struct({
    state: Schema.String,
    /** Contexts that failed or errored. */
    failing: Schema.Array(Schema.String),
  }),
  /** The last push. */
  updated_at: Schema.NullOr(Timestamp),
});

export interface NeedRow extends Schema.Schema.Type<typeof NeedRow> {}

/** GET /v1/branches: newest push first. */
export const NeedsPage = Schema.Struct({
  branches: Schema.Array(NeedRow),
  truncated: Schema.Boolean,
  /** Monorepos (`owner/name`) not asked (over 50). */
  skipped: Schema.Array(Schema.String),
});

export interface NeedsPage extends Schema.Schema.Type<typeof NeedsPage> {}

/** A branch that entered or left "needs you" (`state` null: it left). */
export const NeedChange = Schema.Struct({
  repo: RepoName,
  branch: Schema.String,
  state: Schema.NullOr(NeedState),
});

export interface NeedChange extends Schema.Schema.Type<typeof NeedChange> {}
