// Records the web reads that @pando/contract does not have yet (asked of the
// quality lane): only the heads route now. It moves into the contract with a
// recording, and this file goes away.
import * as Schema from "effect/Schema";

/** GET .../heads: each code repo's main head as Pando last moved it. */
export const Heads = Schema.Struct({
  heads: Schema.Array(Schema.Struct({ repo: Schema.String, path: Schema.String, head: Schema.NullOr(Schema.String), updated_at: Schema.NullOr(Schema.String) })),
});

export type Head = (typeof Heads.Type)["heads"][number];

// ── Slice 2: a project's files at a ref, its worktrees, a build's jobs ──

const NullStr = Schema.NullOr(Schema.String);

const NullNum = Schema.NullOr(Schema.Number);

/** The last commit that touched a path (first parents): api-v1.yaml CommitLine. */
export const CommitLine = Schema.Struct({
  sha: Schema.String,
  title: Schema.String,
  author: Schema.Struct({ name: Schema.optionalKey(Schema.String) }),
  at: Schema.String,
});

export interface CommitLine extends Schema.Schema.Type<typeof CommitLine> {}

/** GET .../tree?ref=&path=: one folder at a ref. */
export const CodeTree = Schema.Struct({
  ref: Schema.String,
  commit: Schema.String,
  path: Schema.String,
  entries: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.Literals(["dir", "file", "symlink", "submodule"]) })),
  next: NullStr,
});

export interface CodeTree extends Schema.Schema.Type<typeof CodeTree> {}

/** GET .../tree/last-commits: each entry's last commit; `complete: false` while a job finishes the walk. */
export const LastCommits = Schema.Struct({
  complete: Schema.Boolean,
  entries: Schema.Record(Schema.String, Schema.NullOr(CommitLine)),
  retry_after_ms: NullNum,
});

/** GET .../history?ref=&path=: commits that changed a path, newest first. */
export const CodeHistory = Schema.Struct({ commits: Schema.Array(CommitLine), next: NullStr });

/** GET .../worktrees?repo=: worktrees and the machines they are on. */
export const Worktrees = Schema.Struct({
  worktrees: Schema.Array(Schema.Struct({ repo: Schema.String, branch: Schema.String, path: Schema.String, machine: Schema.String, kind: Schema.String, reported_by: Schema.String })),
});

/** GET .../ci/builds/{build}: its jobs, each a check's run (its time and its link). */
export const CiJobs = Schema.Struct({
  jobs: Schema.Array(Schema.Struct({ check: NullStr, duration_s: NullNum, web_url: NullStr, retried: Schema.optionalKey(Schema.Boolean) })),
});
