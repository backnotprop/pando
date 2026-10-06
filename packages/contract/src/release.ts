// Builds of main, tags and releases (research/plans/releases-2026-10-04): a
// project's summary (main's commit, its checks or "not built", the newest
// build on main, the latest release), its tags, and its releases.
import * as Schema from "effect/Schema";

import { Checks, ChecksState } from "./checks.ts";
import { CiBuild } from "./ci.ts";
import { Count, Login, RepoName, Sha, Timestamp } from "./ids.ts";

/**
 * A commit's state where a build state is shown: the checks' combined state,
 * or `not_built` when nothing reported on it and nothing is required (never
 * green). The merge gate reads `success` there.
 */
export const BuildState = Schema.Union([ChecksState, Schema.Literal("not_built")]);

export type BuildState = typeof BuildState.Type;

/** The latest published release, as the project page's strip shows it. */
export const ReleaseBrief = Schema.Struct({
  tag: Schema.String,
  title: Schema.String,
  sha: Sha,
  published_at: Timestamp,
  published_by: Login,
});

export interface ReleaseBrief extends Schema.Schema.Type<typeof ReleaseBrief> {}

/** GET .../repos/{r}/summary: the project's main and its latest release. */
export const RepoSummary = Schema.Struct({
  repo: RepoName,
  main: Schema.Struct({
    /** Main's name. */
    branch: Schema.String,
    /** Main's commit; null for an empty repo. */
    sha: Schema.NullOr(Sha),
    /** That commit's title, when Pando recorded it as main moved. */
    title: Schema.NullOr(Schema.String),
    state: BuildState,
    /** The commit's checks (null for an empty repo). */
    checks: Schema.NullOr(Checks),
    /** The newest build on main, whatever its commit (null when none was recorded). */
    build: Schema.NullOr(CiBuild),
  }),
  latest_release: Schema.NullOr(ReleaseBrief),
});

export interface RepoSummary extends Schema.Schema.Type<typeof RepoSummary> {}

/** A tag, recorded by the git door from refs/tags/* as pushes land. */
export const Tag = Schema.Struct({
  name: Schema.String,
  /** The commit it names (an annotated tag peeled to its commit); null until Pando has read it. */
  sha: Schema.NullOr(Sha),
  annotated: Schema.Boolean,
  /** Who pushed it; null when Pando found it in the repo rather than seeing it pushed. */
  created_by: Schema.NullOr(Login),
  created_at: Timestamp,
  updated_at: Timestamp,
  /** A published release holds it: git can't move or delete it until the release is deleted. */
  frozen: Schema.Boolean,
});

export interface Tag extends Schema.Schema.Type<typeof Tag> {}

/** GET .../repos/{r}/tags: newest first. */
export const TagList = Schema.Struct({ tags: Schema.Array(Tag) });

export interface TagList extends Schema.Schema.Type<typeof TagList> {}

/** A file of a release. Its bytes are in R2; GET .../releases/{tag}/files/{name} downloads it. */
export const ReleaseFile = Schema.Struct({
  /** Letters, digits, `.`, `_`, `+` and `-`; at most 200 characters. */
  name: Schema.String,
  /** In bytes; at most 100,000,000. */
  size: Count,
  /** The SHA-256 of its bytes, as Pando computed it on upload (hex). */
  sha256: Schema.String,
  content_type: Schema.String,
  uploaded_by: Login,
  uploaded_at: Timestamp,
});

export interface ReleaseFile extends Schema.Schema.Type<typeof ReleaseFile> {}

/** A release: a tag on the project's main, with a title, notes and files. */
export const Release = Schema.Struct({
  repo: RepoName,
  tag: Schema.String,
  /** Its commit, on main. */
  sha: Sha,
  title: Schema.String,
  /** Markdown. */
  notes: Schema.String,
  draft: Schema.Boolean,
  /** Published past red or missing required checks. */
  forced: Schema.Boolean,
  created_by: Login,
  created_at: Timestamp,
  updated_at: Timestamp,
  published_by: Schema.NullOr(Login),
  published_at: Schema.NullOr(Timestamp),
  /** At most 20, by name. */
  files: Schema.Array(ReleaseFile),
  /** Its commit's checks: on GET .../releases/{tag} only. */
  checks: Schema.optionalKey(Checks),
});

export interface Release extends Schema.Schema.Type<typeof Release> {}

/** GET .../repos/{r}/releases: newest first (a draft by when it was made, a published release by when it was published), 30 a page. */
export const ReleaseList = Schema.Struct({
  releases: Schema.Array(Release),
  next_cursor: Schema.NullOr(Schema.String),
});

export interface ReleaseList extends Schema.Schema.Type<typeof ReleaseList> {}

/** GET .../releases/{tag}/notes[?generate=1]: the release's notes, or notes written from the merges since the last release. */
export const ReleaseNotes = Schema.Struct({
  tag: Schema.String,
  sha: Sha,
  markdown: Schema.String,
  generated: Schema.Boolean,
  /** Generated: the merges listed (at most 500), the ones past that, and the release they start from (null: from the start). */
  merges: Schema.NullOr(Count),
  more: Schema.NullOr(Count),
  since: Schema.NullOr(Schema.String),
});

export interface ReleaseNotes extends Schema.Schema.Type<typeof ReleaseNotes> {}

/** A deployment: a commit (and its release, if any) reached an environment. Recorded only: the CI deploys and posts it. */
export const Deployment = Schema.Struct({
  id: Schema.String,
  repo: RepoName,
  /** pando-dev, production. */
  environment: Schema.String,
  sha: Sha,
  /** The published release at that commit (named when posted, or found), else null. */
  release: Schema.NullOr(Schema.String),
  state: Schema.Literals(["in_progress", "success", "failure"]),
  url: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  created_by: Login,
  created_at: Timestamp,
});

export interface Deployment extends Schema.Schema.Type<typeof Deployment> {}

/** GET .../repos/{r}/deployments[?environment=]: newest first. */
export const DeploymentList = Schema.Struct({ deployments: Schema.Array(Deployment) });

export interface DeploymentList extends Schema.Schema.Type<typeof DeploymentList> {}
