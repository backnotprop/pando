// A monorepo's root files (the meta layer), read-only in the web at launch:
// GET /v1/monorepos/{owner}/{monorepo}/meta/tree, .../history and .../file
// (docs/contracts/meta-sync.md, "History and restore"). Versions count up per
// monorepo; `at` is milliseconds since 1970, unlike the ISO times elsewhere.
import { Schema } from "effect";

import { Count, Sha } from "./ids.ts";

export const MetaOp = Schema.Literals(["save", "delete", "rename"]);

/** Where a version came from: a machine's save, a restore, or a merge into the meta repo's main. */
export const MetaSource = Schema.Literals(["live", "restore", "main"]);

/** One version of one path (a history entry; a tree lists each path's current one). */
export const MetaVersion = Schema.Struct({
  version: Count,
  path: Schema.String,
  op: MetaOp,
  /** git's blob id of the bytes; null on a delete. */
  sha: Schema.NullOr(Sha),
  size: Schema.NullOr(Count),
  deleted: Schema.Boolean,
  /** `Name <email>`. */
  author: Schema.String,
  machine: Schema.String,
  agent: Schema.NullOr(Schema.String),
  /** Milliseconds since 1970. */
  at: Count,
  source: MetaSource,
  /** A rename's other path: `from` on the save side, `to` on the delete side. */
  from: Schema.NullOr(Schema.String),
  to: Schema.NullOr(Schema.String),
  restored_from: Schema.NullOr(Count),
  /** The meta repo commit that carries this version; null until it is committed. */
  commit: Schema.NullOr(Sha),
  /** A large file's own SHA-256 and size, when this version is its pointer. */
  large: Schema.NullOr(Schema.Struct({ oid: Schema.String, size: Count })),
});

export interface MetaVersion extends Schema.Schema.Type<typeof MetaVersion> {}

/** A folder with how many files it holds (on a `dir=` listing's first page). */
export const MetaFolder = Schema.Struct({ name: Schema.String, files: Count });

export interface MetaFolder extends Schema.Schema.Type<typeof MetaFolder> {}

/** GET .../meta/tree: current paths, sorted, a page at a time. `dir` and `folders` come with `?dir=` only. */
export const MetaTree = Schema.Struct({
  head: Count,
  prefix: Schema.String,
  files: Schema.Array(MetaVersion),
  /** Pass back as `after`; null on the last page. */
  next: Schema.NullOr(Schema.String),
  dir: Schema.optionalKey(Schema.String),
  folders: Schema.optionalKey(Schema.Array(MetaFolder)),
});

export interface MetaTree extends Schema.Schema.Type<typeof MetaTree> {}

/** GET .../meta/history: a path's versions newest first (`?path=`), or every change after `?since=`, oldest first. */
export const MetaHistory = Schema.Struct({
  path: Schema.NullOr(Schema.String),
  head: Count,
  versions: Schema.Array(MetaVersion),
});

export interface MetaHistory extends Schema.Schema.Type<typeof MetaHistory> {}

/** GET .../meta/file answers raw bytes; these headers say which version they are. */
export const MetaFileHeaders = Schema.Struct({
  "x-pando-version": Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  "x-pando-sha": Sha,
});

export interface MetaFileHeaders extends Schema.Schema.Type<typeof MetaFileHeaders> {}
