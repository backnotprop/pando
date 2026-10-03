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

/** A monorepo in the person's list, with their role in it. */
export const MonorepoEntry = Monorepo.pipe(Schema.fieldsAssign({ role: MemberRole }));

export interface MonorepoEntry extends Schema.Schema.Type<typeof MonorepoEntry> {}

/** Branches that need someone, by state. */
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
  }),
);

export interface MonorepoSummary extends Schema.Schema.Type<typeof MonorepoSummary> {}

/** GET /v1/monorepos: by owner, then name. */
export const MonorepoList = Schema.Struct({ monorepos: Schema.Array(MonorepoEntry) });

export interface MonorepoList extends Schema.Schema.Type<typeof MonorepoList> {}

/** GET /v1/monorepos?summary=1: most recently active first. */
export const MonorepoSummaryList = Schema.Struct({ monorepos: Schema.Array(MonorepoSummary) });

export interface MonorepoSummaryList extends Schema.Schema.Type<typeof MonorepoSummaryList> {}
