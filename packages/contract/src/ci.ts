// CI builds as Pando stores them, on one model for every CI service
// (api-v1.yaml CiBuild, CiJob): GET .../ci/builds and .../ci/builds/{build}.
import * as Schema from "effect/Schema";

import { Count, Login, RepoName, Sha, Timestamp } from "./ids.ts";

/** One vocabulary for every service; `service_state` keeps the service's own word. */
export const CiState = Schema.Literals(["queued", "running", "blocked", "passed", "failed", "canceled", "skipped"]);

export type CiState = typeof CiState.Type;

export const CiBuild = Schema.Struct({
  /** Pando's id (`cib_...`). */
  id: Schema.String,
  /** The CI service (`buildkite`), for its mark. */
  service: Schema.String,
  connection: Schema.String,
  pipeline: Schema.String,
  number: Count,
  repo: RepoName,
  repo_path: Schema.NullOr(Schema.String),
  /** Null when the service built no fixed commit. */
  sha: Schema.NullOr(Sha),
  branch: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  state: CiState,
  service_state: Schema.String,
  web_url: Schema.NullOr(Schema.String),
  /** Who pushed the commit (a login), from Pando's own records. */
  pushed_by: Schema.NullOr(Login),
  created_at: Schema.NullOr(Timestamp),
  started_at: Schema.NullOr(Timestamp),
  finished_at: Schema.NullOr(Timestamp),
  duration_s: Schema.NullOr(Count),
  /** The service's id of the build this one rebuilt. */
  rebuilt_from: Schema.NullOr(Schema.String),
});

export interface CiBuild extends Schema.Schema.Type<typeof CiBuild> {}

/** GET .../ci/builds: newest first. */
export const CiBuildList = Schema.Struct({
  builds: Schema.Array(CiBuild),
  next_cursor: Schema.NullOr(Schema.String),
});

export interface CiBuildList extends Schema.Schema.Type<typeof CiBuildList> {}

/** One job of a build, as Pando stores it. */
export const CiJob = Schema.Struct({
  /** The service's job id. */
  id: Schema.String,
  /** The build's Pando id (`cib_...`), as in .../ci/builds/{build}. */
  build: Schema.String,
  name: Schema.NullOr(Schema.String),
  step_key: Schema.NullOr(Schema.String),
  /** `script`, `trigger` or `manual`. */
  type: Schema.String,
  state: CiState,
  service_state: Schema.String,
  /** The process's exit code; Buildkite reports -1 for a job it stopped. */
  exit_status: Schema.NullOr(Schema.Int),
  soft_failed: Schema.Boolean,
  /** A newer job replaced it (Retry). */
  retried: Schema.Boolean,
  web_url: Schema.NullOr(Schema.String),
  created_at: Schema.NullOr(Timestamp),
  started_at: Schema.NullOr(Timestamp),
  finished_at: Schema.NullOr(Timestamp),
  duration_s: Schema.NullOr(Count),
  /** The check (status context) it reports, its step key; null for jobs that report none. */
  check: Schema.NullOr(Schema.String),
});

export interface CiJob extends Schema.Schema.Type<typeof CiJob> {}

/** GET .../ci/builds/{build}: a build and its jobs, first scheduled first (wait steps left out). */
export const CiBuildDetail = CiBuild.pipe(Schema.fieldsAssign({ jobs: Schema.Array(CiJob) }));

export interface CiBuildDetail extends Schema.Schema.Type<typeof CiBuildDetail> {}

/** A CI service Pando can connect. */
export const CiService = Schema.Struct({ service: Schema.String, name: Schema.String });

export interface CiService extends Schema.Schema.Type<typeof CiService> {}

/** One account of a CI service (a Buildkite organization) connected to the monorepo, as the event stream carries it. */
export const CiConnectionRow = Schema.Struct({
  id: Schema.String,
  service: Schema.Literals(["buildkite"]),
  organization: Schema.String,
  /** The organization on the service. */
  web_url: Schema.String,
  /** Where its REST token comes from: the Worker secret at launch. */
  token: Schema.Literals(["worker_secret", "stored"]),
  created_at: Timestamp,
  created_by: Login,
  /** The last webhook that passed its check: `result` is `recorded`, or `ignored: <reason>`. */
  last_event: Schema.NullOr(Schema.Struct({ at: Timestamp, event: Schema.NullOr(Schema.String), result: Schema.NullOr(Schema.String) })),
  /** The last webhook refused (a wrong token or signature), recorded at most every 10 s. */
  last_refused: Schema.NullOr(Schema.Struct({ at: Timestamp, reason: Schema.NullOr(Schema.String) })),
});

export interface CiConnectionRow extends Schema.Schema.Type<typeof CiConnectionRow> {}

/** A connection as the CI routes answer it: the row, and the URL to paste into the service's webhook settings. */
export const CiConnection = CiConnectionRow.pipe(Schema.fieldsAssign({ webhook_url: Schema.String }));

export interface CiConnection extends Schema.Schema.Type<typeof CiConnection> {}

/** A pipeline: one its builds named, or one a buildkite hook names. */
export const CiPipeline = Schema.Struct({
  connection: Schema.String,
  service: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  /** The repo it builds. */
  repo: Schema.NullOr(RepoName),
  repo_path: Schema.NullOr(Schema.String),
  web_url: Schema.String,
  default_branch: Schema.NullOr(Schema.String),
  /** The buildkite hook that starts its builds on push, if any. */
  hook_id: Schema.NullOr(Schema.String),
  /** Its repo's required checks, from `.pando/pando.toml`; null while they are unknown (the file unreadable or broken). */
  required_checks: Schema.NullOr(Schema.Array(Schema.String)),
  last_build: Schema.NullOr(CiBuild),
});

export interface CiPipeline extends Schema.Schema.Type<typeof CiPipeline> {}

/** GET .../ci: the CI tab's top. */
export const CiOverview = Schema.Struct({
  /** The services Pando can connect. */
  services: Schema.Array(CiService),
  connections: Schema.Array(CiConnection),
  pipelines: Schema.Array(CiPipeline),
  /** Every repo's required checks (a repo with no pipeline is here too); `checks` null while unknown. */
  required_checks: Schema.Array(Schema.Struct({ repo: RepoName, path: Schema.String, checks: Schema.NullOr(Schema.Array(Schema.String)) })),
});

export interface CiOverview extends Schema.Schema.Type<typeof CiOverview> {}

/** GET .../ci/pipelines/{pipeline}: the pipeline with its configuration (YAML, fetched at most every few minutes), and a page of its builds. */
export const CiPipelinePage = Schema.Struct({
  pipeline: CiPipeline.pipe(
    Schema.fieldsAssign({
      configuration: Schema.NullOr(Schema.String),
      configuration_fetched_at: Schema.NullOr(Timestamp),
      /** Why the configuration shown is the stored one (the service could not be read); null when it is current. */
      configuration_error: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
    }),
  ),
  builds: Schema.Array(CiBuild),
  next_cursor: Schema.NullOr(Schema.String),
});

export interface CiPipelinePage extends Schema.Schema.Type<typeof CiPipelinePage> {}

/** How a list read from the service was got: its first page, kept until the build finished. */
const fetched = {
  /** More than one page on the service: only the first is shown. */
  truncated: Schema.Boolean,
  /** The build had finished when it was read: it will not change. */
  complete: Schema.Boolean,
  fetched_at: Timestamp,
  cached: Schema.Boolean,
  /** Set when this is the last copy because Buildkite's rate limit is held: ask again after this long. Null otherwise. */
  retry_after_ms: Schema.NullOr(Count),
};

/** GET .../ci/builds/{build}/jobs/{job}/log: the log's end (at most 1 MiB, where failures are). */
export const CiJobLog = Schema.Struct({
  /** The service's job id. */
  job: Schema.String,
  content: Schema.String,
  /** The bytes in `content`. */
  bytes: Count,
  /** The whole log's size. */
  total_bytes: Count,
  /** True when `content` is the log's last 1 MiB only. */
  truncated: Schema.Boolean,
  complete: Schema.Boolean,
  fetched_at: Timestamp,
  cached: Schema.Boolean,
  /** Set when this is the last copy because Buildkite's rate limit is held: ask again after this long. Null otherwise. */
  retry_after_ms: Schema.NullOr(Count),
});

export interface CiJobLog extends Schema.Schema.Type<typeof CiJobLog> {}

/** A build's annotation: HTML a pipeline wrote (sanitize it before showing it). */
export const CiAnnotation = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  context: Schema.NullOr(Schema.String),
  /** success, info, warning or error. */
  style: Schema.NullOr(Schema.String),
  body_html: Schema.String,
  created_at: Schema.NullOr(Timestamp),
  updated_at: Schema.NullOr(Timestamp),
});

export interface CiAnnotation extends Schema.Schema.Type<typeof CiAnnotation> {}

/** GET .../ci/builds/{build}/annotations. */
export const CiAnnotationList = Schema.Struct({ annotations: Schema.Array(CiAnnotation), ...fetched });

export interface CiAnnotationList extends Schema.Schema.Type<typeof CiAnnotationList> {}

/** A file a job uploaded; download it through `ciArtifactDownloadPath`. */
export const CiArtifact = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  /** The job that uploaded it. */
  job: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  filename: Schema.NullOr(Schema.String),
  dirname: Schema.NullOr(Schema.String),
  mime_type: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Count),
  sha1sum: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
});

export interface CiArtifact extends Schema.Schema.Type<typeof CiArtifact> {}

/** GET .../ci/builds/{build}/artifacts. */
export const CiArtifactList = Schema.Struct({ artifacts: Schema.Array(CiArtifact), ...fetched });

export interface CiArtifactList extends Schema.Schema.Type<typeof CiArtifactList> {}

/** Rebuild (201) and Cancel (202): the build as Pando now has it; null if the service's answer named no build Pando keeps. */
export const CiBuildAnswer = Schema.Struct({ build: Schema.NullOr(CiBuildDetail) });

export interface CiBuildAnswer extends Schema.Schema.Type<typeof CiBuildAnswer> {}

/** Retry (202): the new job; null if the service's answer was not a job. */
export const CiJobAnswer = Schema.Struct({ job: Schema.NullOr(CiJob) });

export interface CiJobAnswer extends Schema.Schema.Type<typeof CiJobAnswer> {}

/** A hook: a `web` POST, or a `buildkite` one that starts a pipeline's builds (Add pipeline). Never its secret. */
export const Hook = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["web", "buildkite"]),
  url: Schema.NullOr(Schema.String),
  events: Schema.Array(Schema.Literals(["push", "branch.opened", "merged", "tag"])),
  buildkite: Schema.NullOr(Schema.Struct({ organization: Schema.String, pipeline: Schema.String })),
  /** The app its status tokens stamp: buildkite for a buildkite hook, a web hook's own app, or null. */
  app: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
  created_at: Timestamp,
  created_by: Login,
});

export interface Hook extends Schema.Schema.Type<typeof Hook> {}

/** Connect (201): the connection, and its webhook token, shown this once (paste it into the service's webhook settings). */
export const CiConnected = Schema.Struct({ connection: CiConnection, webhook_token: Schema.String });

export interface CiConnected extends Schema.Schema.Type<typeof CiConnected> {}
