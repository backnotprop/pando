// A person's contributions (profile SPEC sections 2 and 3, with the owner's
// answers in decisions/RULINGS.md, "Profiles"): GET
// /v1/users/{login}/contributions (operationId `getContributions`). A
// contribution is a commit that reached a repository's main (credited to its
// author and every Co-authored-by person, by their sign-in email), a branch
// opened, a review, or a repository created. A viewer sees only the work in
// repositories they can open; nothing else is counted for them.
import * as Schema from "effect/Schema";

import { Count, FullName, Login, Timestamp } from "./ids.ts";

/** A day in the viewer's time zone, `2026-10-03`. */
export const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));

/** A calendar month, `2026-10`, or one day, `2026-10-03`. */
export const Period = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}(-\d{2})?$/));

/** What counts, as the graph splits it. `created`: repositories made. */
export const ContributionKinds = Schema.Struct({ commit: Count, branch: Count, review: Count, created: Count });

export interface ContributionKinds extends Schema.Schema.Type<typeof ContributionKinds> {}

/** One square of the graph that is not empty: its total and the split. */
export const ContributionDay = Schema.Struct({
  date: Day,
  n: Count,
  commit: Count,
  branch: Count,
  review: Count,
  created: Count,
});

export interface ContributionDay extends Schema.Schema.Type<typeof ContributionDay> {}

/** A monorepo or plain repo the profile shows: shared with the viewer, or with the person's work in it. */
export const ContributionMonorepo = Schema.Struct({
  full_name: FullName,
  owner_type: Schema.Literals(["user", "org"]),
  kind: Schema.Literals(["monorepo", "repo"]),
  /** The person's contributions in it over the window. */
  n: Count,
  /** The same by calendar month, oldest first: one number for each month the window touches. */
  months: Schema.Array(Count),
});

export interface ContributionMonorepo extends Schema.Schema.Type<typeof ContributionMonorepo> {}

/** A count in one repository. */
export const MonorepoCount = Schema.Struct({ full_name: FullName, n: Count });

export interface MonorepoCount extends Schema.Schema.Type<typeof MonorepoCount> {}

/**
 * A month of the activity timeline, or one day of it (a click on a square).
 * Each list is in one kind's line: "Created 339 commits in 4 repositories",
 * then one row per repository, most first.
 */
export const ContributionPeriod = Schema.Struct({
  period: Period,
  commit: Schema.Array(MonorepoCount),
  branch: Schema.Array(MonorepoCount),
  review: Schema.Array(MonorepoCount),
  /** Repositories the person made, oldest first. */
  created: Schema.Array(Schema.Struct({ full_name: FullName, at: Timestamp })),
  /** Organizations the person made (`created`) or joined, shared with the viewer. Not counted on the graph. */
  joined: Schema.Array(Schema.Struct({ org: Login, name: Schema.NullOr(Schema.String), at: Timestamp, created: Schema.Boolean })),
});

export interface ContributionPeriod extends Schema.Schema.Type<typeof ContributionPeriod> {}

/** The graph and the timeline for one viewer. */
export const Contributions = Schema.Struct({
  login: Login,
  /** The viewer's time zone as asked: minutes east of UTC (`-420` for California in summer). Days are counted in it. */
  tz: Schema.Int,
  /** The first square (a Sunday, 52 weeks before this week's) and the last (today). */
  from: Day,
  to: Day,
  /** Everything this viewer is shown, from `from` to `to`. */
  total: Count,
  /** The lowest count of shades 1 to 4: the quartiles of the person's own non-empty days. */
  levels: Schema.Tuple([Count, Count, Count, Count]),
  /** Non-empty days only, oldest first. */
  days: Schema.Array(ContributionDay),
  /** Repositories shared with the viewer or with the person's work in them, most first. */
  monorepos: Schema.Array(ContributionMonorepo),
  kinds: ContributionKinds,
  /** Months with any activity, newest first. */
  months: Schema.Array(ContributionPeriod),
});

export interface Contributions extends Schema.Schema.Type<typeof Contributions> {}

/** A person's links on their profile: at most 4, each an https URL. */
export const PROFILE_LIMITS = { name: 100, bio: 160, location: 100, links: 4, link: 2048 } as const;
