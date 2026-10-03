// API errors. On the wire every error is `{"error": {"code", "message"}}`
// (worker/src/http.ts errorJson), sometimes with more fields. A client turns
// a non-2xx response into one of the tagged errors below with failureOf.
import * as Schema from "effect/Schema";

/** The wire body of every error response. Extra fields (such as `checks` on a refused merge) are kept by the server and ignored here. */
export const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    paths: Schema.optionalKey(Schema.Array(Schema.String)),
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
