// Organizations, and the owner of a namespace: GET /v1/users/{name}
// (operationId `getOwner`), /v1/orgs/... and GET /v1/user/orgs. An org is a
// namespace like a login, so its monorepos are `org/name`. Every member of an
// org can open and push to all of its monorepos; its owners own them all.
import * as Schema from "effect/Schema";

import { Count, Login, Timestamp } from "./ids.ts";
import { MemberRole } from "./monorepo.ts";
import { Invite } from "./repo.ts";

/** An org named in a list: its login and display name. */
export const OrgRef = Schema.Struct({ login: Login, name: Schema.NullOr(Schema.String) });

export interface OrgRef extends Schema.Schema.Type<typeof OrgRef> {}

/** An org's page header. `role` and `members` depend on who asks. */
export const OrgProfile = Schema.Struct({
  type: Schema.tag("org"),
  login: Login,
  /** The display name ("Plannotator"); null when none was given. */
  name: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  /** An https URL, or null. */
  website: Schema.NullOr(Schema.String),
  created_at: Timestamp,
  /** The asker's role in the org; null when they are not in it. */
  role: Schema.NullOr(MemberRole),
  /** How many people are in it; null for someone who is not in it. */
  members: Schema.NullOr(Count),
});

export interface OrgProfile extends Schema.Schema.Type<typeof OrgProfile> {}

/** GET /v1/orgs/{org}, POST /v1/orgs, PATCH /v1/orgs/{org}: the same shape as the org's header. */
export const Org = OrgProfile;

export interface Org extends OrgProfile {}

/**
 * A person's answer to GET /v1/users/{name}, and to PATCH /v1/user (their
 * own): the profile's header. No email: an address is never shown to others.
 */
export const Profile = Schema.Struct({
  type: Schema.tag("user"),
  login: Login,
  name: Schema.NullOr(Schema.String),
  /** At most 160 characters. */
  bio: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  /** At most 4 https URLs, in the person's order. */
  links: Schema.Array(Schema.String),
  /** Their picture, or null: the web draws initials. */
  picture_url: Schema.NullOr(Schema.String),
  created_at: Timestamp,
  /** The organizations the person is in that the viewer is in too (all of them on your own), by login. */
  orgs: Schema.Array(OrgRef),
});

export interface Profile extends Schema.Schema.Type<typeof Profile> {}

/** GET /v1/users/{name}: whose namespace `/{name}` is, a person (`type: "user"`) or an org (`type: "org"`). 404 for neither. */
export const Owner = Schema.Union([Profile, OrgProfile]).pipe(Schema.toTaggedUnion("type"));

export type Owner = typeof Owner.Type;

/** A person in an org. */
export const OrgMember = Schema.Struct({
  login: Login,
  name: Schema.NullOr(Schema.String),
  /** Their picture, or null: the web draws initials. */
  picture_url: Schema.NullOr(Schema.String),
  role: MemberRole,
  added_at: Timestamp,
  /** Who added them; null for the org's creator. */
  added_by: Schema.NullOr(Login),
  /** The newest use of any of their credentials; null if none was ever used. */
  last_active_at: Schema.NullOr(Timestamp),
});

export interface OrgMember extends Schema.Schema.Type<typeof OrgMember> {}

/** GET /v1/orgs/{org}/members: its people, by login. */
export const OrgMemberList = Schema.Struct({ members: Schema.Array(OrgMember) });

export interface OrgMemberList extends Schema.Schema.Type<typeof OrgMemberList> {}

/** GET /v1/user/orgs: the orgs the person is in, with their role in each, by login. */
export const OrgList = Schema.Struct({ orgs: Schema.Array(Org) });

export interface OrgList extends Schema.Schema.Type<typeof OrgList> {}

/**
 * POST /v1/orgs/{org}/invites: someone who has already signed in with that
 * email is added now (200, `added`); otherwise the invite waits for that
 * email's first sign-in (201, `invited`).
 */
export const OrgInviteResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("added"), member: OrgMember }),
  Schema.Struct({ status: Schema.Literal("invited"), invite: Invite }),
]);

export type OrgInviteResult = typeof OrgInviteResult.Type;
