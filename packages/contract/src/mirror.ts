// Mirror to GitHub (research/plans/github-mirror-2026-10-04/SPEC.md, 5.3):
// GET/PATCH/DELETE .../mirror, PUT .../mirror/targets, POST .../mirror/run,
// GET .../mirror/github-repos, GET .../mirror/choices.
import * as Schema from "effect/Schema";

import { Count, Sha, Timestamp } from "./ids.ts";

/** Each project (and the files outside projects/) to its own GitHub repository, or the whole repository to one. */
export const MirrorMode = Schema.Literals(["projects", "whole"]);

export type MirrorMode = typeof MirrorMode.Type;

/** A row's one status. `off`: a project switched off; `paused`: the section's switch is off. */
export const MirrorStateName = Schema.Literals(["off", "not_started", "up_to_date", "waiting", "paused", "mirroring", "retrying", "no_access", "not_found", "refused"]);

export type MirrorStateName = typeof MirrorStateName.Type;

export const GithubRepo = Schema.Struct({
  /** GitHub's repository id (stable through renames). */
  id: Count,
  full_name: Schema.String,
  private: Schema.Boolean,
  url: Schema.String,
});

export interface GithubRepo extends Schema.Schema.Type<typeof GithubRepo> {}

export const GithubAccountType = Schema.Literals(["User", "Organization"]);

export const MirrorConnection = Schema.Struct({
  installation_id: Count,
  /** The GitHub account or organization the app is installed on. */
  login: Schema.String,
  type: GithubAccountType,
  repository_selection: Schema.Literals(["all", "selected"]),
  /** The installation's page on GitHub (Manage on GitHub). */
  manage_url: Schema.String,
  connected_at: Timestamp,
  connected_by: Schema.String,
});

export interface MirrorConnection extends Schema.Schema.Type<typeof MirrorConnection> {}

export const MirrorProblem = Schema.Struct({
  code: Schema.Literals(["retrying", "no_access", "not_found", "refused"]),
  /** One sentence for the row. */
  message: Schema.String,
  at: Timestamp,
});

export const MirrorTarget = Schema.Struct({
  /** Pando's repo name; `meta` for the files outside projects/; `*` in whole repository mode. */
  repo: Schema.String,
  /** projects/<name>, "." for a plain repo, "" for the files outside projects/, "*" for the whole repository. */
  path: Schema.String,
  on: Schema.Boolean,
  github: Schema.NullOr(GithubRepo),
  state: MirrorStateName,
  /** The commit last confirmed on GitHub's main, and when. */
  last: Schema.NullOr(Schema.Struct({ commit: Sha, at: Timestamp })),
  /** Commits on Pando's main not yet on GitHub (100 means 100 or more), when the row is behind. */
  behind: Schema.NullOr(Count),
  waiting_since: Schema.NullOr(Timestamp),
  next_try_at: Schema.NullOr(Timestamp),
  problem: Schema.NullOr(MirrorProblem),
});

export interface MirrorTarget extends Schema.Schema.Type<typeof MirrorTarget> {}

export const Mirror = Schema.Struct({
  /** False when this server has no GitHub App set up (the section says so). */
  app: Schema.Struct({ configured: Schema.Boolean }),
  connection: Schema.NullOr(MirrorConnection),
  mode: MirrorMode,
  /** The section's switch: on and started, not paused. */
  on: Schema.Boolean,
  /** Start mirroring was pressed (the setup finished at least once). */
  started: Schema.Boolean,
  paused: Schema.NullOr(Schema.Struct({ by: Schema.String, at: Timestamp })),
  targets: Schema.Array(MirrorTarget),
});

export interface Mirror extends Schema.Schema.Type<typeof Mirror> {}

/** PUT .../mirror/targets: saved, or the address to send the browser to first when a row says Create. */
export const MirrorSaved = Schema.Struct({ mirror: Mirror, authorize_url: Schema.NullOr(Schema.String) });

export interface MirrorSaved extends Schema.Schema.Type<typeof MirrorSaved> {}

/** POST .../mirror/run (Retry): the rows queued now. */
export const MirrorQueued = Schema.Struct({
  queued: Schema.Array(Schema.String),
  skipped: Schema.Array(Schema.Struct({ repo: Schema.String, reason: Schema.String })),
});

export interface MirrorQueued extends Schema.Schema.Type<typeof MirrorQueued> {}

/** GET .../mirror/github-repos: what Change lists. */
export const GithubRepos = Schema.Struct({
  account: Schema.String,
  repos: Schema.Array(GithubRepo),
  /** Where to give the app more repositories. */
  add_url: Schema.String,
});

export interface GithubRepos extends Schema.Schema.Type<typeof GithubRepos> {}

/** GET .../mirror/choices: the installations this browser proved, when there were several. */
export const GithubChoices = Schema.Struct({
  installations: Schema.Array(
    Schema.Struct({ installation_id: Count, login: Schema.String, type: GithubAccountType, repository_selection: Schema.Literals(["all", "selected"]) }),
  ),
});

export interface GithubChoices extends Schema.Schema.Type<typeof GithubChoices> {}
