// A project's files at any ref (FILES.md): getTree, getLastCommits and
// getHistory (api-v1.yaml).
import * as Schema from "effect/Schema";

import { Count, Sha, Timestamp } from "./ids.ts";

/** One entry of a folder; folders first, then by name. */
export const TreeEntry = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["dir", "file", "symlink", "submodule"]),
  /** git's mode: 100644, 100755 (executable), 120000, 40000 or 160000. */
  mode: Schema.String,
  /** The object's hash (a blob for files; read it with raw). */
  oid: Sha,
});

export interface TreeEntry extends Schema.Schema.Type<typeof TreeEntry> {}

/** GET .../repos/{repo}/tree: a folder at a ref, a page of up to 1,000 entries. */
export const TreePage = Schema.Struct({
  ref: Schema.String,
  /** The commit the ref resolved to. */
  commit: Sha,
  path: Schema.String,
  entries: Schema.Array(TreeEntry),
  total: Count,
  /** Pass as `cursor` for the next page; null on the last. */
  next: Schema.NullOr(Schema.String),
});

export interface TreePage extends Schema.Schema.Type<typeof TreePage> {}

/** A commit as the file pages show it (first parents: on main, a change merged from a branch is the merge). */
export const CommitLine = Schema.Struct({
  sha: Sha,
  /** The message's first line. */
  title: Schema.String,
  author: Schema.Struct({ name: Schema.String, email: Schema.String }),
  /** The author date. */
  at: Timestamp,
  /** On a merge into main: the branch it merged, and that branch's title. */
  merged_branch: Schema.NullOr(Schema.Struct({ branch: Schema.String, title: Schema.NullOr(Schema.String) })),
});

export interface CommitLine extends Schema.Schema.Type<typeof CommitLine> {}

/** GET .../repos/{repo}/tree/last-commits: the last commit that changed each entry of a folder. */
export const LastCommits = Schema.Struct({
  ref: Schema.String,
  commit: Sha,
  path: Schema.String,
  /** False while a walk is unfinished: ask again after retry_after_ms; null entries are not known yet. */
  complete: Schema.Boolean,
  /** By entry name; null when not known (yet, or older than `older.before`). */
  entries: Schema.Record(Schema.String, Schema.NullOr(CommitLine)),
  /** Entries unchanged within 10,000 commits stay null: they are older than this. */
  older: Schema.NullOr(Schema.Struct({ before: Timestamp })),
  retry_after_ms: Schema.NullOr(Count),
});

export interface LastCommits extends Schema.Schema.Type<typeof LastCommits> {}

/** GET .../repos/{repo}/history: commits that changed a path, newest first. */
export const HistoryPage = Schema.Struct({
  /** Null on a page asked with a cursor. */
  ref: Schema.NullOr(Schema.String),
  path: Schema.String,
  commits: Schema.Array(CommitLine),
  /** Pass as `cursor` for the next page; null on the last. */
  next: Schema.NullOr(Schema.String),
  /** The walk stopped at 10,000 commits from the ref. */
  capped: Schema.Boolean,
  /** False when the page stopped short of `limit` because its walk spent its budget: ask again with `next`. */
  complete_page: Schema.Boolean,
});

export interface HistoryPage extends Schema.Schema.Type<typeof HistoryPage> {}
