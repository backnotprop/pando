// Artifacts: documents uploaded to a branch's page (the pull request), never in git: a Markdown file or an HTML
// file with the images it uses, or an image (research/plans/artifacts-2026-10-12/SPEC.md). The same name again is
// the next version; every version is kept. Comments are Plannotator's annotations (the anchor, opaque to the
// server) with Pando's thread state. Routes are in routes.ts, their row events in stream.ts.
import * as Schema from "effect/Schema";

import { Count, Login, RepoName, Timestamp } from "./ids.ts";

export const ArtifactKind = Schema.Literals(["markdown", "html", "image"]);

export type ArtifactKind = typeof ArtifactKind.Type;

/** One file of a version: the document (or the image), or an image it uses, kept by its relative path (`img/hero.png`). */
export const ArtifactFile = Schema.Struct({
  path: Schema.String,
  /** In bytes. */
  size: Count,
  /** The SHA-256 of its bytes, as Pando computed it on upload (hex). */
  sha256: Schema.String,
  /** Its content type, from its extension (`text/markdown; charset=utf-8`, `image/png`). */
  type: Schema.String,
});

export interface ArtifactFile extends Schema.Schema.Type<typeof ArtifactFile> {}

export const ArtifactVersion = Schema.Struct({
  /** 1, 2, 3, ... */
  n: Count,
  /** All its files, in bytes; at most 10 MiB. */
  size: Count,
  /** The main file's SHA-256. */
  sha256: Schema.String,
  /** The main file first, then its images by path. At most 20. */
  files: Schema.Array(ArtifactFile),
  uploaded_by: Login,
  /** The credential's machine; `web` from the browser. */
  machine: Schema.NullOr(Schema.String),
  via: Schema.Literals(["web", "cli"]),
  created_at: Timestamp,
});

export interface ArtifactVersion extends Schema.Schema.Type<typeof ArtifactVersion> {}

/** Threads on an artifact (every version), or on a branch's artifacts. */
export const ArtifactCommentCounts = Schema.Struct({ open: Count, resolved: Count });

export interface ArtifactCommentCounts extends Schema.Schema.Type<typeof ArtifactCommentCounts> {}

export const Artifact = Schema.Struct({
  /** `art_` and 16 hex characters. */
  id: Schema.String,
  repo: RepoName,
  branch: Schema.String,
  /** The main file's name (`refresh-plan.md`): letters, digits, `.`, `_`, `+`, `-`; unique on the branch. */
  name: Schema.String,
  kind: ArtifactKind,
  /** The document's first heading or `<title>` (at most 200 characters); null for an image or when it has none. */
  title: Schema.NullOr(Schema.String),
  /** The newest version. */
  latest: ArtifactVersion,
  /** How many versions there are (the newest is `latest.n`). */
  versions: Count,
  comments: ArtifactCommentCounts,
  created_by: Login,
  created_at: Timestamp,
  updated_at: Timestamp,
});

export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}

/** GET .../artifacts/{id}: one artifact with every version, oldest first. */
export const ArtifactDetail = Schema.Struct({ ...Artifact.fields, all_versions: Schema.Array(ArtifactVersion) });

export interface ArtifactDetail extends Schema.Schema.Type<typeof ArtifactDetail> {}

/** GET .../branches/{branch}/artifacts: newest first (by its newest version); at most 100. */
export const ArtifactList = Schema.Struct({ branch: Schema.String, artifacts: Schema.Array(Artifact), total: Count });

export interface ArtifactList extends Schema.Schema.Type<typeof ArtifactList> {}

export const ArtifactCommentState = Schema.Literals(["open", "resolved"]);

export type ArtifactCommentState = typeof ArtifactCommentState.Type;

export const ArtifactComment = Schema.Struct({
  /** `ac_` and 16 hex characters. */
  id: Schema.String,
  /** The artifact's id. */
  artifact: Schema.String,
  /** The version it was made on. */
  version: Count,
  /** The thread's first comment's id (its own on a root). */
  thread: Schema.String,
  /** Null on a root. Replies are one level deep: always the root. */
  in_reply_to: Schema.NullOr(Schema.String),
  /**
   * Plannotator's placing fields (`type`, `originalText`, `blockId`, offsets, `htmlAnchor`, ...) and Pando's
   * `context` ({prefix, suffix}), as the browser wrote them; opaque to the server. Null: the whole artifact.
   * Roots only; at most 16,384 bytes.
   */
  anchor: Schema.NullOr(Schema.Unknown),
  /** Markdown, at most 65,536 characters. Null once deleted (a root that has replies stays); in a live event, null over 16 KB. */
  body: Schema.NullOr(Schema.String),
  /** Goes up by one with each edit: send it back as `base_version`. */
  body_version: Count,
  author: Login,
  machine: Schema.NullOr(Schema.String),
  /** Members named with `@` in the body, at most 10. */
  mentions: Schema.Array(Login),
  /** The thread's state, on roots; a reply's is always open. */
  state: ArtifactCommentState,
  resolved_by: Schema.NullOr(Login),
  resolved_at: Schema.NullOr(Timestamp),
  created_at: Timestamp,
  updated_at: Timestamp,
});

export interface ArtifactComment extends Schema.Schema.Type<typeof ArtifactComment> {}

/** A root comment and its replies, oldest first. */
export const ArtifactThread = Schema.Struct({ ...ArtifactComment.fields, replies: Schema.Array(ArtifactComment) });

export interface ArtifactThread extends Schema.Schema.Type<typeof ArtifactThread> {}

/** GET .../artifacts/{id}/comments and .../branches/{branch}/artifact-comments: threads oldest first, filtered by `?state=`; counts are of all. */
export const ArtifactThreads = Schema.Struct({
  threads: Schema.Array(ArtifactThread),
  counts: ArtifactCommentCounts,
});

export interface ArtifactThreads extends Schema.Schema.Type<typeof ArtifactThreads> {}
