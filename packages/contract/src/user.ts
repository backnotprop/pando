// The signed-in person: GET /v1/user (operationId `me`).
import * as Schema from "effect/Schema";

import { Login, Timestamp } from "./ids.ts";

export const CredentialKind = Schema.Literals(["machine", "sandbox", "bootstrap", "browser"]);

export const User = Schema.Struct({
  login: Login,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  /** Their WorkOS picture (https), or null: the web draws initials. */
  picture_url: Schema.NullOr(Schema.String),
  created_at: Timestamp,
});

export interface User extends Schema.Schema.Type<typeof User> {}

/** A credential as listed: never its secret. */
export const Credential = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: CredentialKind,
  created_at: Timestamp,
  last_used_at: Schema.NullOr(Timestamp),
  /** Browser sessions only: the end unless used before then. */
  expires_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
});

export interface Credential extends Schema.Schema.Type<typeof Credential> {}

/** GET /v1/user: the user, and the credential that asked. */
export const Me = User.pipe(Schema.fieldsAssign({ credential: Credential }));

export interface Me extends Schema.Schema.Type<typeof Me> {}
