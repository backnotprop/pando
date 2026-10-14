// A monorepo's code repos, members and machines: listRepos, getRepo,
// listMembers and listMachines.
import * as Schema from "effect/Schema";

import { byActivityKind } from "./feed.ts";
import { Count, FullName, Login, RepoName, Timestamp } from "./ids.ts";
import { MemberRole, MonorepoEntry, ReplacedAlias } from "./monorepo.ts";
import { ReviewSettings } from "./review.ts";
import { CredentialKind } from "./user.ts";

/**
 * When a repo's CI builds run: `every_push` (each push to a branch, the
 * default), `on_merge` (a push builds nothing; the first merge asked for a
 * head starts its build and waits for it), `main_only` (only main's merge
 * commits and pushes to main build). Main's merge commit builds under all three.
 */
export const CiPolicy = Schema.Literals(["every_push", "on_merge", "main_only"]);

export type CiPolicy = typeof CiPolicy.Type;

export const Repo = Schema.Struct({
  /** The monorepo's `owner/name`. */
  monorepo: FullName,
  /** The repo's name in URLs: its path with each `/` turned into `-`. */
  name: RepoName,
  /** `projects/web`, or `.` for a plain repo. */
  path: Schema.String,
  description: Schema.NullOr(Schema.String),
  default_branch: Schema.String,
  /** The git door URL to clone. */
  clone_url: Schema.String,
  /** Read from `.pando/pando.toml` on main; only when the repo is fetched alone (getRepo). Null while unknown (checks_unknown says why). */
  required_checks: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  /** With required_checks: why they are unknown (pando.toml unreadable or broken), else null. */
  checks_unknown: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The switch "Anyone can download releases": its release files download without signing in (never its code). Only when the repo is fetched alone (getRepo). */
  releases_public: Schema.optionalKey(Schema.Boolean),
  /** When its CI builds run (owners set it): in the list and getRepo. */
  ci_policy: Schema.optionalKey(CiPolicy),
  /** Risk-based review: on or off, its thresholds and sensitive paths. Only when the repo is fetched alone (getRepo). */
  review: Schema.optionalKey(ReviewSettings),
  created_at: Timestamp,
  created_by: Schema.NullOr(Login),
});

export interface Repo extends Schema.Schema.Type<typeof Repo> {}

/** GET .../repos: every code repo (the meta layer's own is not listed). */
export const RepoList = Schema.Struct({ repos: Schema.Array(Repo) });

export interface RepoList extends Schema.Schema.Type<typeof RepoList> {}

/** POST /v1/monorepos (201): the new monorepo (the caller is its owner), its plain repo for kind `repo`, and any old name it took over. */
export const MonorepoCreated = Schema.Struct({
  monorepo: MonorepoEntry,
  repos: Schema.Array(Repo),
  replaced_alias: Schema.NullOr(ReplacedAlias),
});

export interface MonorepoCreated extends Schema.Schema.Type<typeof MonorepoCreated> {}

/** A worktree a machine reported (pando worktree add): sparse, fuse or fskit. */
export const Worktree = Schema.Struct({
  id: Schema.String,
  /** The repo's path, `projects/web`. */
  repo: Schema.String,
  branch: Schema.String,
  /** Where it lives on the machine. */
  path: Schema.String,
  /** The credential's name: the machine as people see it. */
  machine: Schema.String,
  agent: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["sparse", "fuse", "fskit"]),
  /** The user whose credential reported it. */
  reported_by: Login,
  created_at: Timestamp,
  last_seen_at: Timestamp,
});

export interface Worktree extends Schema.Schema.Type<typeof Worktree> {}

/** GET .../worktrees[?repo=&machine=]: every worktree in the monorepo, by machine, then path. */
export const WorktreeList = Schema.Struct({ worktrees: Schema.Array(Worktree) });

export interface WorktreeList extends Schema.Schema.Type<typeof WorktreeList> {}

/** A code repo's main as Pando last moved it (a merge, or the first push), from its own records. */
export const RepoHead = Schema.Struct({
  /** The repo's name in URLs. */
  repo: RepoName,
  path: Schema.String,
  default_branch: Schema.String,
  /** Main's head commit; null for an empty repo. */
  head: Schema.NullOr(Schema.String),
  /** That commit's title (its first line), when Pando recorded it as main moved; null when unknown. */
  head_title: Schema.NullOr(Schema.String),
  updated_at: Schema.NullOr(Timestamp),
});

export interface RepoHead extends Schema.Schema.Type<typeof RepoHead> {}

/** GET .../heads: every code repo's main, and the event stream's seq to resume from (null when the stream is off). */
export const HeadList = Schema.Struct({ heads: Schema.Array(RepoHead), seq: Schema.NullOr(Count) });

export interface HeadList extends Schema.Schema.Type<typeof HeadList> {}

/**
 * Where a member's access comes from: their own row in the monorepo
 * (`direct`), the org that owns it (`org`), or both.
 */
export const MemberVia = Schema.Literals(["direct", "org", "both"]);

/** A person who can open the monorepo. `role` is the higher of their own row and their org role. */
export const Member = Schema.Struct({
  login: Login,
  name: Schema.NullOr(Schema.String),
  /** Their picture, or null: the web draws initials. */
  picture_url: Schema.NullOr(Schema.String),
  role: MemberRole,
  /** From their own row when they have one, else from their org row. */
  added_at: Timestamp,
  added_by: Schema.NullOr(Schema.String),
  /** The newest use of any of their credentials; null if none was ever used. */
  last_active_at: Schema.NullOr(Timestamp),
  via: MemberVia,
});

export interface Member extends Schema.Schema.Type<typeof Member> {}

/** GET .../members. */
export const MemberList = Schema.Struct({ members: Schema.Array(Member) });

export interface MemberList extends Schema.Schema.Type<typeof MemberList> {}

/** An invite waiting for that email's first sign-in. */
export const Invite = Schema.Struct({
  email: Schema.String,
  role: MemberRole,
  /** The owner who invited them (a login). */
  invited_by: Login,
  created_at: Timestamp,
});

export interface Invite extends Schema.Schema.Type<typeof Invite> {}

/** GET .../invites: invites not yet accepted. */
export const InviteList = Schema.Struct({ invites: Schema.Array(Invite) });

export interface InviteList extends Schema.Schema.Type<typeof InviteList> {}

/**
 * POST .../invites: someone who has already signed in with that email is
 * added now (200, `added`); otherwise the invite waits (201, `invited`).
 */
export const InviteResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("added"), member: Member }),
  Schema.Struct({ status: Schema.Literal("invited"), invite: Invite }),
]);

export type InviteResult = typeof InviteResult.Type;

/** A machine's latest activity line in this monorepo: as a feed line, without its monorepo, actor and machine. */
export const MachineActivity = byActivityKind({
  seq: Count,
  at: Timestamp,
  repo: Schema.NullOr(RepoName),
  repo_path: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
}).pipe(Schema.toTaggedUnion("kind"));

export type MachineActivity = typeof MachineActivity.Type;

/** A worktree a machine's last hello named; repo, branch and path from the worktree registry. */
export const MachineWorktree = Schema.Struct({
  id: Schema.String,
  repo: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
});

export interface MachineWorktree extends Schema.Schema.Type<typeof MachineWorktree> {}

/** One machine (a credential) in a monorepo: the Machines tab's row. */
export const Machine = Schema.Struct({
  login: Login,
  /** With login, the machine's key. */
  credential_id: Schema.String,
  /** The credential's name: the machine as people see it. */
  name: Schema.String,
  kind: Schema.NullOr(CredentialKind),
  connected: Schema.Boolean,
  connected_at: Schema.NullOr(Timestamp),
  last_activity: Schema.NullOr(MachineActivity),
  worktrees: Schema.Array(MachineWorktree),
  updated_at: Timestamp,
});

export interface Machine extends Schema.Schema.Type<typeof Machine> {}

/** GET .../machines: latest activity first. */
export const MachineList = Schema.Struct({ machines: Schema.Array(Machine) });

export interface MachineList extends Schema.Schema.Type<typeof MachineList> {}
