// The routes slice 3 reads and writes that @pando/contract does not have yet
// (asked of web-api through pando-ops). Each moves into the contract with a
// recording, and this file goes away. Shapes are the Worker's own
// (worker/src/monorepo/api.ts, worker/src/ci/routes.ts); only the fields a
// screen uses are listed, and unknown fields are ignored.
import { CiBuild, CiBuildDetail, CiJob, Credential, type Login, Member, MemberRole, MonorepoEntry, type MonorepoName, Timestamp } from "@pando/contract";
import * as Schema from "effect/Schema";

const enc = encodeURIComponent;

const monorepoBase = (owner: Login, name: MonorepoName) => `/v1/monorepos/${enc(owner)}/${enc(name)}`;

const ciBase = (owner: Login, name: MonorepoName) => `${monorepoBase(owner, name)}/ci`;

const buildBase = (owner: Login, name: MonorepoName, build: string) => `${ciBase(owner, name)}/builds/${enc(build)}`;

/** A write that answers 204: no body, no schema. */
const Nothing = Schema.Null;

// ── Your machines ─────────────────────────────────────────────────────────

export const CredentialList = Schema.Struct({ credentials: Schema.Array(Credential) });

/** GET /v1/user/credentials: every credential that acts as you, oldest first. */
export const listCredentials = { path: "/v1/user/credentials", response: CredentialList };

/** DELETE /v1/user/credentials/{id}: 204. */
export const revokeCredential = (id: string) => ({ method: "DELETE", path: `/v1/user/credentials/${enc(id)}`, response: Nothing }) as const;

// ── Members and invites ───────────────────────────────────────────────────

export const Invite = Schema.Struct({ email: Schema.String, role: MemberRole, invited_by: Schema.String, created_at: Timestamp });

export interface Invite extends Schema.Schema.Type<typeof Invite> {}

export const InviteList = Schema.Struct({ invites: Schema.Array(Invite) });

/** POST .../invites: a person with an account is added at once; anyone else is invited. */
export const Invited = Schema.Union([Schema.Struct({ status: Schema.Literal("added"), member: Member }), Schema.Struct({ status: Schema.Literal("invited"), invite: Invite })]);

/** GET .../invites: pending invites, oldest first. */
export const listInvites = (owner: Login, name: MonorepoName) => ({ path: `${monorepoBase(owner, name)}/invites`, response: InviteList });

/** POST .../invites {email, role}: owners only. */
export const invite = (owner: Login, name: MonorepoName) => ({ method: "POST", path: `${monorepoBase(owner, name)}/invites`, response: Invited }) as const;

/** DELETE .../invites/{email}: 204, owners only. */
export const revokeInvite = (owner: Login, name: MonorepoName, email: string) =>
  ({ method: "DELETE", path: `${monorepoBase(owner, name)}/invites/${enc(email)}`, response: Nothing }) as const;

/** DELETE .../members/{login}: 204, owners only; 409 last_owner keeps one owner. */
export const removeMember = (owner: Login, name: MonorepoName, login: Login) =>
  ({ method: "DELETE", path: `${monorepoBase(owner, name)}/members/${enc(login)}`, response: Nothing }) as const;

// ── Settings ──────────────────────────────────────────────────────────────

/** PATCH /v1/monorepos/{owner}/{name} {name}: the label moves; the old name keeps working. */
export const renameMonorepo = (owner: Login, name: MonorepoName) => ({ method: "PATCH", path: monorepoBase(owner, name), response: MonorepoEntry }) as const;

/** DELETE /v1/monorepos/{owner}/{name}?confirm=<owner/name>: 204, owners only. */
export const deleteMonorepo = (owner: Login, name: MonorepoName) =>
  ({ method: "DELETE", path: `${monorepoBase(owner, name)}?confirm=${enc(`${owner}/${name}`)}`, response: Nothing }) as const;

// ── CI ────────────────────────────────────────────────────────────────────

export const CiConnection = Schema.Struct({
  id: Schema.String,
  service: Schema.String,
  organization: Schema.String,
  /** The organization on the service. */
  web_url: Schema.String,
  /** The URL the service sends its webhooks to. */
  webhook_url: Schema.String,
  created_at: Timestamp,
  /** The last webhook that passed its check. */
  last_event: Schema.NullOr(Schema.Struct({ at: Timestamp, event: Schema.NullOr(Schema.String) })),
});

export interface CiConnection extends Schema.Schema.Type<typeof CiConnection> {}

export const CiPipeline = Schema.Struct({
  connection: Schema.String,
  service: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  repo: Schema.NullOr(Schema.String),
  repo_path: Schema.NullOr(Schema.String),
  web_url: Schema.String,
  default_branch: Schema.NullOr(Schema.String),
  /** Its repo's required checks (from `.pando/pando.toml`). */
  required_checks: Schema.Array(Schema.String),
  last_build: Schema.NullOr(CiBuild),
});

export interface CiPipeline extends Schema.Schema.Type<typeof CiPipeline> {}

export const CiOverview = Schema.Struct({
  services: Schema.Array(Schema.Struct({ service: Schema.String, name: Schema.String })),
  connections: Schema.Array(CiConnection),
  pipelines: Schema.Array(CiPipeline),
  /** Every code repo's required checks, pipeline or not. */
  required_checks: Schema.Array(Schema.Struct({ repo: Schema.String, path: Schema.String, checks: Schema.Array(Schema.String) })),
});

export interface CiOverview extends Schema.Schema.Type<typeof CiOverview> {}

/** GET .../ci: the CI tab's top. */
export const getCi = (owner: Login, name: MonorepoName) => ({ path: ciBase(owner, name), response: CiOverview });

export const CiPipelinePage = Schema.Struct({
  pipeline: CiPipeline.pipe(
    Schema.fieldsAssign({
      configuration: Schema.NullOr(Schema.String),
      /** Why the configuration could not be read just now (the stored copy, if any, is shown). */
      configuration_error: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
    }),
  ),
  builds: Schema.Array(CiBuild),
  next_cursor: Schema.NullOr(Schema.String),
});

/** GET .../ci/pipelines/{pipeline}: its pipeline.yml (from the service) and its builds, newest first. */
export const getCiPipeline = (owner: Login, name: MonorepoName, pipeline: string) => ({ path: `${ciBase(owner, name)}/pipelines/${enc(pipeline)}`, response: CiPipelinePage });

/** GET .../ci/builds?pipeline=&number=: finds a build by its number (`number` is asked of web-api; the page is searched either way). */
export const findCiBuilds = (owner: Login, name: MonorepoName, pipeline: string, number: number, cursor: string | null) => {
  const params = new URLSearchParams({ pipeline, number: String(number), limit: "100" });

  if (cursor !== null) params.set("cursor", cursor);

  return { path: `${ciBase(owner, name)}/builds?${params}`, response: Schema.Struct({ builds: Schema.Array(CiBuild), next_cursor: Schema.NullOr(Schema.String) }) };
};

export const CiLog = Schema.Struct({
  content: Schema.String,
  /** Only the last 1 MiB is kept; the rest is in the service. */
  truncated: Schema.Boolean,
  complete: Schema.Boolean,
});

/** GET .../ci/builds/{build}/jobs/{job}/log. */
export const getCiLog = (owner: Login, name: MonorepoName, build: string, job: string) => ({ path: `${buildBase(owner, name, build)}/jobs/${enc(job)}/log`, response: CiLog });

export const CiAnnotation = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  context: Schema.NullOr(Schema.String),
  /** success, info, warning or error. */
  style: Schema.NullOr(Schema.String),
  /** HTML a pipeline wrote: shown only through SafeHtml. */
  body_html: Schema.String,
});

export interface CiAnnotation extends Schema.Schema.Type<typeof CiAnnotation> {}

/** GET .../ci/builds/{build}/annotations. */
export const listCiAnnotations = (owner: Login, name: MonorepoName, build: string) => ({
  path: `${buildBase(owner, name, build)}/annotations`,
  response: Schema.Struct({ annotations: Schema.Array(CiAnnotation), complete: Schema.Boolean }),
});

export const CiArtifact = Schema.Struct({
  id: Schema.String,
  path: Schema.NullOr(Schema.String),
  filename: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Schema.Number),
});

export interface CiArtifact extends Schema.Schema.Type<typeof CiArtifact> {}

/** GET .../ci/builds/{build}/artifacts. */
export const listCiArtifacts = (owner: Login, name: MonorepoName, build: string) => ({
  path: `${buildBase(owner, name, build)}/artifacts`,
  response: Schema.Struct({ artifacts: Schema.Array(CiArtifact), complete: Schema.Boolean }),
});

/** GET .../artifacts/{artifact}/download: a 302 to the service's short-lived URL (a plain link). */
export const ciArtifactDownloadPath = (owner: Login, name: MonorepoName, build: string, artifact: string) => `${buildBase(owner, name, build)}/artifacts/${enc(artifact)}/download`;

const BuildAnswer = Schema.Struct({ build: Schema.NullOr(CiBuildDetail) });

/** POST .../ci/builds/{build}/rebuild: a new build of the same commit, with fresh tokens. */
export const rebuild = (owner: Login, name: MonorepoName, build: string) => ({ method: "POST", path: `${buildBase(owner, name, build)}/rebuild`, response: BuildAnswer }) as const;

/** POST .../ci/builds/{build}/cancel: a running build, passed through. */
export const cancel = (owner: Login, name: MonorepoName, build: string) => ({ method: "POST", path: `${buildBase(owner, name, build)}/cancel`, response: BuildAnswer }) as const;

/** POST .../ci/builds/{build}/jobs/{job}/retry: a failed job, passed through. */
export const retry = (owner: Login, name: MonorepoName, build: string, job: string) =>
  ({ method: "POST", path: `${buildBase(owner, name, build)}/jobs/${enc(job)}/retry`, response: Schema.Struct({ job: Schema.NullOr(CiJob) }) }) as const;

/** POST .../ci/pipelines/{pipeline}/builds {branch}: a build of a branch's head, made like Rebuild (web-api is adding it). */
export const newBuild = (owner: Login, name: MonorepoName, pipeline: string) =>
  ({ method: "POST", path: `${ciBase(owner, name)}/pipelines/${enc(pipeline)}/builds`, response: BuildAnswer }) as const;

/** DELETE .../ci/connections/{connection}: 204, owners only. */
export const disconnect = (owner: Login, name: MonorepoName, connection: string) =>
  ({ method: "DELETE", path: `${ciBase(owner, name)}/connections/${enc(connection)}`, response: Nothing }) as const;
