// Checks and statuses: what CI services and members report on a commit, and
// the merge gate's combined answer (api-v1.yaml Status and Checks).
import * as Schema from "effect/Schema";

import { Sha, Timestamp } from "./ids.ts";

export const StatusState = Schema.Literals(["pending", "success", "failure", "error"]);

export type StatusState = typeof StatusState.Type;

/** The latest report of one context on a commit. */
export const Status = Schema.Struct({
  sha: Sha,
  context: Schema.String,
  state: StatusState,
  target_url: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  /** The member who posted it (a login), `app:<slug>` for a CI service, or `hook:<hook id>` for a web hook with no app. */
  creator: Schema.String,
  /** The CI service that reported it (`buildkite`), for its mark; null when a member posted it. */
  app: Schema.NullOr(Schema.String),
  created_at: Timestamp,
});

export interface Status extends Schema.Schema.Type<typeof Status> {}

/** `success` when the merge gate passes; `missing` when a required context has not reported. */
export const ChecksState = Schema.Literals(["success", "pending", "failure", "error", "missing"]);

/** GitHub's combined status, plus the required contexts and which are missing. */
export const Checks = Schema.Struct({
  sha: Schema.NullOr(Sha),
  state: ChecksState,
  required: Schema.Array(Schema.String),
  missing: Schema.Array(Schema.String),
  /** The latest status per context. */
  statuses: Schema.Array(Status),
});

export interface Checks extends Schema.Schema.Type<typeof Checks> {}
