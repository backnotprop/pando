// Checks and statuses: what CI services and members report on a commit, and
// the merge gate's combined answer (api-v1.yaml Status and Checks).
import * as Schema from "effect/Schema";

import { Sha, Timestamp } from "./ids.ts";

/**
 * GitHub's four, and `superseded`: Pando's own, when a newer push cancelled
 * the build that was reporting the check. A superseded check counts as not
 * reported (the gate's `missing` when it is required). Clients post only the four.
 */
export const StatusState = Schema.Literals(["pending", "success", "failure", "error", "superseded"]);

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

/**
 * `success` when the merge gate passes; `missing` when a required context has
 * not reported; `unknown` while the required checks are (`checks_unknown`
 * says why): an unforced merge is refused until they can be read.
 */
export const ChecksState = Schema.Literals(["success", "pending", "failure", "error", "missing", "unknown"]);

/** GitHub's combined status, plus the required contexts and which are missing. */
export const Checks = Schema.Struct({
  sha: Schema.NullOr(Sha),
  state: ChecksState,
  /** Null while unknown: .pando/pando.toml could not be read, or does not parse. */
  required: Schema.NullOr(Schema.Array(Schema.String)),
  missing: Schema.Array(Schema.String),
  /** The latest status per context. */
  statuses: Schema.Array(Status),
  /** Why the required checks are unknown, in plain words ("pando.toml line 3: expected comma or end of structure; fix it on main, or merge with force"); null otherwise. */
  checks_unknown: Schema.NullOr(Schema.String),
});

export interface Checks extends Schema.Schema.Type<typeof Checks> {}
