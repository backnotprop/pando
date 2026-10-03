// Scalar values shared by every record: branded strings, so a login cannot be
// passed where a monorepo id is expected. Patterns are the server's own
// (api-v1.yaml, components/schemas); the rest are only non-empty.
import * as Schema from "effect/Schema";

/** A person's login, which is also their namespace (api-v1.yaml `Login`). */
export const Login = Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/)).pipe(Schema.brand("Login"));

export type Login = typeof Login.Type;

/** A monorepo's name, unique within its owner (api-v1.yaml `Name`). */
export const MonorepoName = Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9._]|-(?!-)){0,38}$/)).pipe(Schema.brand("MonorepoName"));

export type MonorepoName = typeof MonorepoName.Type;

/** A monorepo's permanent id: `m_` and 16 hex characters, or an old name for a monorepo made before namespaces. */
export const MonorepoId = Schema.NonEmptyString.pipe(Schema.brand("MonorepoId"));

export type MonorepoId = typeof MonorepoId.Type;

/**
 * A monorepo's `owner/name` label. Not pattern-checked: a socket replay can
 * carry the id when the feed has not heard the label yet.
 */
export const FullName = Schema.NonEmptyString.pipe(Schema.brand("FullName"));

export type FullName = typeof FullName.Type;

/** A repo's name in URLs: its path with each `/` turned into `-` (`projects-web`), or `meta`. */
export const RepoName = Schema.NonEmptyString.pipe(Schema.brand("RepoName"));

export type RepoName = typeof RepoName.Type;

/** A git object id, 40 lower-case hex characters. */
export const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)).pipe(Schema.brand("Sha"));

export type Sha = typeof Sha.Type;

/** An ISO 8601 time in UTC, as the server writes it (`new Date().toISOString()`). Kept as a string. */
export const Timestamp = Schema.String;

/** A count or a sequence number. */
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
