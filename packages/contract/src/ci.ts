// CI builds as Pando stores them, on one model for every CI service
// (api-v1.yaml CiBuild, CiJob): GET .../ci/builds and .../ci/builds/{build}.
import * as Schema from "effect/Schema";

import { Count, Login, RepoName, Sha, Timestamp } from "./ids.ts";

/** One vocabulary for every service; `service_state` keeps the service's own word. */
export const CiState = Schema.Literals(["queued", "running", "blocked", "passed", "failed", "canceled", "skipped"]);

export type CiState = typeof CiState.Type;

export const CiBuild = Schema.Struct({
  /** Pando's id (`cib_...`). */
  id: Schema.String,
  /** The CI service (`buildkite`), for its mark. */
  service: Schema.String,
  connection: Schema.String,
  pipeline: Schema.String,
  number: Count,
  repo: RepoName,
  repo_path: Schema.NullOr(Schema.String),
  /** Null when the service built no fixed commit. */
  sha: Schema.NullOr(Sha),
  branch: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  state: CiState,
  service_state: Schema.String,
  web_url: Schema.NullOr(Schema.String),
  /** Who pushed the commit (a login), from Pando's own records. */
  pushed_by: Schema.NullOr(Login),
  created_at: Schema.NullOr(Timestamp),
  started_at: Schema.NullOr(Timestamp),
  finished_at: Schema.NullOr(Timestamp),
  duration_s: Schema.NullOr(Count),
  /** The service's id of the build this one rebuilt. */
  rebuilt_from: Schema.NullOr(Schema.String),
});

export interface CiBuild extends Schema.Schema.Type<typeof CiBuild> {}

/** GET .../ci/builds: newest first. */
export const CiBuildList = Schema.Struct({
  builds: Schema.Array(CiBuild),
  next_cursor: Schema.NullOr(Schema.String),
});

export interface CiBuildList extends Schema.Schema.Type<typeof CiBuildList> {}

/** One job of a build, as Pando stores it. */
export const CiJob = Schema.Struct({
  /** The service's job id. */
  id: Schema.String,
  /** The service's build id. */
  build: Schema.String,
  name: Schema.NullOr(Schema.String),
  step_key: Schema.NullOr(Schema.String),
  /** `script`, `trigger` or `manual`. */
  type: Schema.String,
  state: CiState,
  service_state: Schema.String,
  /** The process's exit code; Buildkite reports -1 for a job it stopped. */
  exit_status: Schema.NullOr(Schema.Int),
  soft_failed: Schema.Boolean,
  /** A newer job replaced it (Retry). */
  retried: Schema.Boolean,
  web_url: Schema.NullOr(Schema.String),
  created_at: Schema.NullOr(Timestamp),
  started_at: Schema.NullOr(Timestamp),
  finished_at: Schema.NullOr(Timestamp),
  duration_s: Schema.NullOr(Count),
  /** The check (status context) it reports, its step key; null for jobs that report none. */
  check: Schema.NullOr(Schema.String),
});

export interface CiJob extends Schema.Schema.Type<typeof CiJob> {}

/** GET .../ci/builds/{build}: a build and its jobs, first scheduled first (wait steps left out). */
export const CiBuildDetail = CiBuild.pipe(Schema.fieldsAssign({ jobs: Schema.Array(CiJob) }));

export interface CiBuildDetail extends Schema.Schema.Type<typeof CiBuildDetail> {}
