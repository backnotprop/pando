// API errors. On the wire every error is `{"error": {"code", "message"}}`
// (worker/src/http.ts errorJson), sometimes with more fields. A client turns
// a non-2xx response into one of the tagged errors below with failureOf.
import * as Schema from "effect/Schema";

import { Checks } from "./checks.ts";
import { ArtifactComment } from "./artifact.ts";
import { Issue, IssueComment } from "./issue.ts";
import { BranchReview } from "./review.ts";

/**
 * The wire body of every error response. A refused merge carries `checks` (412 checks_not_green, with
 * `checks_started` when the refusal started them: the repo's CI policy is on_merge), `review` (412 review_required,
 * 412 risk_pending: the head's risk-based review) or `paths` (409 conflicts); a stale body edit (409 edited) carries
 * `current`, the issue or comment (or artifact comment) as it is now.
 */
export const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    paths: Schema.optionalKey(Schema.Array(Schema.String)),
    checks: Schema.optionalKey(Checks),
    checks_started: Schema.optionalKey(Schema.Boolean),
    review: Schema.optionalKey(BranchReview),
    current: Schema.optionalKey(Schema.Union([Issue, IssueComment, ArtifactComment])),
    /** 409 not_at_end on a session's piece: where the session ends; resume from there. */
    end: Schema.optionalKey(Schema.Int),
  }),
});

export interface ErrorBody extends Schema.Schema.Type<typeof ErrorBody> {}

/** 401: no credential, or an unknown, expired or revoked one. The web shows its sign-in button. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  code: Schema.String,
  message: Schema.String,
}) {}

/** 404: the monorepo, path, version or route is not there, or not among the person's. */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  code: Schema.String,
  message: Schema.String,
}) {}

/** Any other error status, with the server's code (`bad_origin`, `invalid_input`, `internal`, ...). */
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  status: Schema.Int,
  code: Schema.String,
  message: Schema.String,
}) {}

/** A response that did not match its schema (a 2xx body, or an error body without the envelope). */
export class BadResponse extends Schema.TaggedError<BadResponse>()("BadResponse", {
  status: Schema.Int,
  path: Schema.String,
  message: Schema.String,
}) {}

export type ApiFailure = Unauthorized | NotFound | ApiError | BadResponse;

/** The tagged error for a non-2xx status and its decoded body (null when the body was not the error envelope). */
export function failureOf(status: number, path: string, body: ErrorBody | null): ApiFailure {
  if (body === null) return new BadResponse({ status, path, message: `HTTP ${status} without an error body` });

  const { code, message } = body.error;

  if (status === 401) return new Unauthorized({ code, message });

  if (status === 404) return new NotFound({ code, message });

  return new ApiError({ status, code, message });
}
