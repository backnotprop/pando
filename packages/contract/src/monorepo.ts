// Monorepos and their one line on the home: GET /v1/monorepos (operationId
// `listMonorepos`), with and without `?summary=1`.
import * as Schema from "effect/Schema";

import { Count, FullName, Login, MonorepoId, MonorepoName, Timestamp } from "./ids.ts";

export const MemberRole = Schema.Literals(["owner", "member"]);

/** `monorepo`, or a plain git repo (`repo`): one repo at path `.`, no meta layer. */
export const MonorepoKind = Schema.Literals(["monorepo", "repo"]);

export const Monorepo = Schema.Struct({
  id: MonorepoId,
  owner: Login,
  name: MonorepoName,
  full_name: FullName,
  kind: MonorepoKind,
  created_at: Timestamp,
});

export interface Monorepo extends Schema.Schema.Type<typeof Monorepo> {}

/** Whose namespace `owner` is: a person's login (`user`) or an organization (`org`). */
export const OwnerType = Schema.Literals(["user", "org"]);

/**
 * A monorepo in the person's list, with their role in it: the higher of
 * their own row in the monorepo and, when an org owns it, their role in the
 * org (an org's owners own all its monorepos).
 */
export const MonorepoEntry = Monorepo.pipe(Schema.fieldsAssign({ role: MemberRole, owner_type: OwnerType }));

export interface MonorepoEntry extends Schema.Schema.Type<typeof MonorepoEntry> {}

/** An old `owner/name` (from a rename or transfer) that led to another monorepo and now leads to this one. */
export const ReplacedAlias = Schema.Struct({
  /** The old name, now this monorepo's. */
  full_name: FullName,
  /** The `owner/name` it led to before. */
  pointed_to: Schema.NullOr(FullName),
});

export interface ReplacedAlias extends Schema.Schema.Type<typeof ReplacedAlias> {}

/** PATCH .../{monorepo}: renamed (or moved to another owner); the old name keeps leading here. Never silent about a name it took over. */
export const MonorepoRenamed = MonorepoEntry.pipe(Schema.fieldsAssign({ replaced_alias: Schema.NullOr(ReplacedAlias) }));

export interface MonorepoRenamed extends Schema.Schema.Type<typeof MonorepoRenamed> {}

/** Branches that need someone, by state. */
/** Open issues assigned to one person in one monorepo: how many, and the most recently updated. */
export const AssignedIssues = Schema.Struct({
  count: Count,
  newest: Schema.Struct({ number: Count, title: Schema.String, updated_at: Timestamp }),
});

export interface AssignedIssues extends Schema.Schema.Type<typeof AssignedIssues> {}

export const NeedCounts = Schema.Struct({
  ready: Count,
  conflicts: Count,
  failing: Count,
});

export interface NeedCounts extends Schema.Schema.Type<typeof NeedCounts> {}

/** A monorepo's one line on the home, as the monorepo computed it (also the `summary` socket frame). */
export const FeedSummary = Schema.Struct({
  last_activity_at: Schema.NullOr(Timestamp),
  worktrees_active: Count,
  machines_active: Count,
  needs: NeedCounts,
  members: Count,
  /** More than 100 members: its lines are read on demand, not copied to feeds. */
  large: Schema.Boolean,
  /** Its projects (code repos; the meta layer's own repo is not counted). A plain repo has 1. */
  repos: Count,
  /** Open branches across those projects (not merged, not deleted, main not counted). */
  open_branches: Count,
  /** Open issues assigned to each member, by login (none: left out): the home's "Needs you" shows the person's own; this frame moves it. */
  assigned: Schema.Record(Schema.String, AssignedIssues),
  /** Its open issues, for the repository's row. */
  open_issues: Count,
  at: Timestamp,
});

export interface FeedSummary extends Schema.Schema.Type<typeof FeedSummary> {}

/** `?summary=1`: the entry and its line, nulls until the person's feed has the line. */
export const MonorepoSummary = MonorepoEntry.pipe(
  Schema.fieldsAssign({
    last_activity_at: Schema.NullOr(Timestamp),
    worktrees_active: Schema.NullOr(Count),
    machines_active: Schema.NullOr(Count),
    needs: Schema.NullOr(NeedCounts),
    members: Schema.NullOr(Count),
    large: Schema.NullOr(Schema.Boolean),
    repos: Schema.NullOr(Count),
    open_branches: Schema.NullOr(Count),
    assigned: Schema.NullOr(Schema.Record(Schema.String, AssignedIssues)),
    open_issues: Schema.NullOr(Count),
  }),
);

export interface MonorepoSummary extends Schema.Schema.Type<typeof MonorepoSummary> {}

/** GET /v1/monorepos[?owner=]: by owner (the person's own first), then name. */
export const MonorepoList = Schema.Struct({ monorepos: Schema.Array(MonorepoEntry) });

export interface MonorepoList extends Schema.Schema.Type<typeof MonorepoList> {}

/** GET /v1/monorepos?summary=1: most recently active first. */
export const MonorepoSummaryList = Schema.Struct({ monorepos: Schema.Array(MonorepoSummary) });

export interface MonorepoSummaryList extends Schema.Schema.Type<typeof MonorepoSummaryList> {}
