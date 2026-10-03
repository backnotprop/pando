// CI builds as Pando stores them, on one model for every CI service
// (api-v1.yaml CiBuild): GET .../ci/builds.
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
