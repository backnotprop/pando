// The monorepo object's CI records, on the abstract model (RESEARCH-2026-10-03
// section 6): a connection (one CI service account: for Buildkite, an
// organization), its pipelines (each builds one repo), builds and jobs, and
// each job's check, which is a status in the one statuses table (a job keyed
// `ci` is the check `ci`).
//
// One instance lives in each MonorepoObject and shares its SQLite. Webhooks
// are verified and written here in one step with their events on the
// monorepo's stream, before the webhook is answered (record before ack). It
// never calls the CI service; ci/routes.ts does, after asking permit().

import type { Env } from "../env";
import { HttpError, now } from "../http";
import type { Identity, ObjectInfo, StatusRecord, StreamEvent } from "../monorepo/types";
import {
  CHECK_TYPES, duration, jobCheck, normalizeBuild, normalizeJob, normalizePipeline, rank, TERMINAL, verifyWebhook,
  type CiState, type NormBuild, type NormJob, type NormPipeline,
} from "./buildkite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ci_connections (
  id TEXT PRIMARY KEY, service TEXT NOT NULL, organization TEXT NOT NULL, api_base TEXT,
  token_source TEXT NOT NULL, token_ref TEXT, token_enc TEXT, webhook_secret TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  last_event_at TEXT, last_event TEXT, last_result TEXT, last_refused_at TEXT, last_refused TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS ci_connections_org ON ci_connections (service, organization);
CREATE TABLE IF NOT EXISTS ci_pipelines (
  connection_id TEXT NOT NULL, slug TEXT NOT NULL, repo TEXT, name TEXT, web_url TEXT, default_branch TEXT,
  configuration TEXT, config_fetched_at TEXT, last_build_id TEXT, PRIMARY KEY (connection_id, slug));
CREATE TABLE IF NOT EXISTS ci_builds (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, external_id TEXT NOT NULL, pipeline TEXT NOT NULL, number INTEGER NOT NULL,
  repo TEXT NOT NULL, sha TEXT, branch TEXT, message TEXT, state TEXT NOT NULL, service_state TEXT NOT NULL, web_url TEXT,
  pushed_by TEXT, delivery_id TEXT, rebuilt_from TEXT, created_at TEXT, started_at TEXT, finished_at TEXT,
  sort_at TEXT NOT NULL, event_ms INTEGER NOT NULL, first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ci_builds_ext ON ci_builds (connection_id, external_id);
CREATE INDEX IF NOT EXISTS ci_builds_sort ON ci_builds (sort_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ci_builds_sha ON ci_builds (repo, sha);
CREATE TABLE IF NOT EXISTS ci_jobs (
  build_id TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT, step_key TEXT, type TEXT NOT NULL,
  state TEXT NOT NULL, service_state TEXT NOT NULL, exit_status INTEGER, soft_failed INTEGER NOT NULL, retried INTEGER NOT NULL,
  web_url TEXT, created_at TEXT, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (build_id, external_id));
`;

/** Buildkite REST calls one connection makes a minute (owner limit): Buildkite allows 50 per token; 10 are left for create-build deliveries. */
export const READS_PER_MIN = 40;
/** Builds per page of the CI tab. */
export const BUILDS_PAGE = 30;
export const BUILDS_PAGE_MAX = 100;
/** How far back "who pushed" looks in the event log for a commit's push. */
const PUSH_SCAN = 5_000;
/** A refused webhook is recorded at most this often per connection (unauthenticated writes stay bounded). */
const REFUSED_EVERY_MS = 10_000;
/** The app every Buildkite check carries. */
const BUILDKITE = { app: "buildkite", creator: "app:buildkite" };

type Row = Record<string, SqlStorageValue>;

export interface ConnectionRow {
  id: string;
  service: string;
  organization: string;
  api_base: string | null;
  token_source: string;
  token_ref: string | null;
  token_enc: string | null;
  webhook_secret: string;
  created_at: string;
  created_by: string;
  last_event_at: string | null;
  last_event: string | null;
  last_result: string | null;
  last_refused_at: string | null;
  last_refused: string | null;
}

export interface BuildRow {
  id: string;
  connection_id: string;
  external_id: string;
  pipeline: string;
  number: number;
  repo: string;
  sha: string | null;
  branch: string | null;
  message: string | null;
  state: CiState;
  service_state: string;
  web_url: string | null;
  pushed_by: string | null;
  delivery_id: string | null;
  rebuilt_from: string | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  sort_at: string;
  event_ms: number;
  first_seen_at: string;
  updated_at: string;
}

export interface JobRow {
  build_id: string;
  external_id: string;
  name: string | null;
  step_key: string | null;
  type: string;
  state: CiState;
  service_state: string;
  exit_status: number | null;
  soft_failed: number;
  retried: number;
  web_url: string | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

/** What a route needs to call the service about one build (and job): never the webhook secret. */
export interface CiRef {
  connection: { id: string; service: string; organization: string; api_base: string | null; token_source: string; token_ref: string | null };
  build: BuildRow;
  job: JobRow | null;
}

export interface CiHost {
  info(): ObjectInfo | null;
  publish(e: StreamEvent): number;
  addStatus(repo: string, sha: string, s: { state: StatusRecord["state"]; context: string; target_url: string | null; description: string | null }, identity: Identity | null, stamp: { app: string | null; creator: string } | null): StatusRecord;
}

export type IngestResult = { result: "recorded" | "ignored"; reason?: string; build?: string };

export interface ConnectionView {
  id: string;
  service: string;
  organization: string;
  web_url: string;
  token: "worker_secret" | "stored";
  created_at: string;
  created_by: string;
  last_event: { at: string; event: string | null; result: string | null } | null;
  last_refused: { at: string; reason: string | null } | null;
}

export interface BuildView {
  id: string;
  service: string;
  connection: string;
  pipeline: string;
  number: number;
  repo: string;
  repo_path: string | null;
  sha: string | null;
  branch: string | null;
  message: string | null;
  state: CiState;
  service_state: string;
  web_url: string | null;
  pushed_by: string | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_s: number | null;
  rebuilt_from: string | null;
}

export interface JobView {
  id: string;
  build: string;
  name: string | null;
  step_key: string | null;
  type: string;
  state: CiState;
  service_state: string;
  exit_status: number | null;
  soft_failed: boolean;
  retried: boolean;
  web_url: string | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_s: number | null;
  check: string | null;
}

export interface PipelineView {
  connection: string;
  service: string;
  slug: string;
  name: string;
  repo: string | null;
  repo_path: string | null;
  web_url: string;
  default_branch: string | null;
  hook_id: string | null;
  last_build: BuildView | null;
}

function fail(status: number, code: string, message: string, extra?: Record<string, unknown>): never {
  throw new HttpError(status, code, message, extra);
}

function hexId(prefix: string, bytes: number): string {
  return prefix + [...crypto.getRandomValues(new Uint8Array(bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function encodeCursor(sortAt: string, id: string): string {
  return btoa(`${sortAt}|${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(s: string): { sort_at: string; id: string } | null {
  try {
    const [sort_at, id] = atob(s.replace(/-/g, "+").replace(/_/g, "/")).split("|");
    return sort_at && id && !Number.isNaN(Date.parse(sort_at)) ? { sort_at, id } : null;
  } catch {
    return null;
  }
}

export class CiStore {
  /** Per connection: REST calls in the last minute, and how long Buildkite told us to wait. In memory: a restart forgets a minute at most. */
  private rate = new Map<string, { at: number[]; until: number }>();

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
    private sql: SqlStorage,
    private host: CiHost,
  ) {}

  private rows<T>(q: string, ...args: unknown[]): T[] {
    return this.sql.exec<Row>(q, ...args).toArray() as unknown as T[];
  }

  private row<T>(q: string, ...args: unknown[]): T | null {
    return this.rows<T>(q, ...args)[0] ?? null;
  }

  ensureSchema(): void {
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
  }

  // ── Connections ──────────────────────────────────────────────────────────

  connect(c: { service: "buildkite"; organization: string; api_base: string | null; webhook_token: string | null }, by: Identity): { connection: ConnectionView; webhook_token: string } {
    const m = this.host.info() ?? fail(404, "not_found", "no such monorepo");
    if (this.row("SELECT id FROM ci_connections WHERE service = ? AND organization = ?", c.service, c.organization)) {
      fail(409, "ci_connection_exists", `${c.service} organization ${c.organization} is connected already`);
    }
    // The id carries the monorepo's id, so the webhook route finds the object without a lookup table.
    const id = `${m.id}--${hexId("cic_", 6)}`;
    const token = c.webhook_token ?? hexId("", 24);
    // Secrets: the webhook's is stored "plain:" until C21 encrypts hook secrets ("aesgcm1:..."). The REST
    // token is the Worker secret named in token_ref at launch; token_source "stored" (token_enc) comes with C21.
    this.sql.exec(
      `INSERT INTO ci_connections (id, service, organization, api_base, token_source, token_ref, token_enc, webhook_secret, created_at, created_by)
       VALUES (?, ?, ?, ?, 'worker', 'BUILDKITE_API_TOKEN', NULL, ?, ?, ?)`,
      id, c.service, c.organization, c.api_base, `plain:${token}`, now(), by.login,
    );
    const view = this.connectionView(this.connection(id)!);
    this.host.publish({ kind: "ci.connection", collection: "ci_connections", key: id, op: "upsert", repo: null, actor: by.login, machine: by.credential_name, agent: null, row: view });
    return { connection: view, webhook_token: token };
  }

  disconnect(id: string, by: Identity): boolean {
    if (!this.connection(id)) return false;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM ci_jobs WHERE build_id IN (SELECT id FROM ci_builds WHERE connection_id = ?)", id);
      this.sql.exec("DELETE FROM ci_builds WHERE connection_id = ?", id);
      this.sql.exec("DELETE FROM ci_pipelines WHERE connection_id = ?", id);
      this.sql.exec("DELETE FROM ci_connections WHERE id = ?", id);
      this.host.publish({ kind: "ci.connection", collection: "ci_connections", key: id, op: "delete", repo: null, actor: by.login, machine: by.credential_name, agent: null, row: { id } });
    });
    this.rate.delete(id);
    return true;
  }

  private connection(id: string): ConnectionRow | null {
    return this.row<ConnectionRow>("SELECT * FROM ci_connections WHERE id = ?", id);
  }

  private connectionView(c: ConnectionRow): ConnectionView {
    return {
      id: c.id,
      service: c.service,
      organization: c.organization,
      web_url: `https://buildkite.com/${encodeURIComponent(c.organization)}`,
      token: c.token_source === "worker" ? "worker_secret" : "stored",
      created_at: c.created_at,
      created_by: c.created_by,
      last_event: c.last_event_at ? { at: c.last_event_at, event: c.last_event, result: c.last_result } : null,
      last_refused: c.last_refused_at ? { at: c.last_refused_at, reason: c.last_refused } : null,
    };
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────

  /** A webhook from the service: verified, then written with its events in one step. */
  async webhook(connId: string, h: { event: string | null; token: string | null; signature: string | null }, body: string, nowMs: number): Promise<IngestResult> {
    const c = this.connection(connId) ?? fail(404, "not_found", "no such CI connection (it may have been disconnected)");
    const secret = c.webhook_secret.startsWith("plain:") ? c.webhook_secret.slice(6) : fail(501, "not_built", "encrypted webhook secrets come with C21");
    const auth = await verifyWebhook(secret, h, body, Math.floor(nowMs / 1000));
    if (!auth.ok) {
      const last = Date.parse(c.last_refused_at ?? "") || 0;
      if (nowMs - last > REFUSED_EVERY_MS) this.sql.exec("UPDATE ci_connections SET last_refused_at = ?, last_refused = ? WHERE id = ?", now(), auth.reason, connId);
      fail(401, "unauthorized", auth.reason);
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch {
      fail(400, "bad_request", "the body is not JSON");
    }
    const event = h.event ?? (typeof payload.event === "string" ? payload.event : "");
    // The signature's time orders events Buildkite sent; with a plain token, the time they arrived. Both in whole seconds.
    const at = (auth.ts ?? Math.floor(nowMs / 1000)) * 1000;
    let out: IngestResult = { result: "ignored" };
    this.ctx.storage.transactionSync(() => {
      out = this.ingest(c, event, payload, at);
      this.sql.exec(
        "UPDATE ci_connections SET last_event_at = ?, last_event = ?, last_result = ? WHERE id = ?",
        now(), event.slice(0, 60), out.result === "recorded" ? "recorded" : `ignored: ${out.reason}`, connId,
      );
    });
    return out;
  }

  /** A build the service returned to one of our calls (Rebuild, Cancel): recorded at once, before its webhooks. */
  ingestBuild(connId: string, build: unknown): IngestResult {
    const c = this.connection(connId) ?? fail(404, "not_found", "no such CI connection");
    const b = (build ?? {}) as Record<string, unknown>;
    let out: IngestResult = { result: "ignored" };
    this.ctx.storage.transactionSync(() => {
      out = this.ingest(c, "build.api", { build: b, pipeline: b.pipeline }, Math.floor(Date.now() / 1000) * 1000);
    });
    return out;
  }

  /** A job the service returned (Retry): recorded at once under its build. */
  ingestJob(buildId: string, job: unknown): JobRow | null {
    const b = this.buildRow(buildId);
    const j = normalizeJob(job);
    if (!b || !j || j.type === "waiter") return null;
    this.ctx.storage.transactionSync(() => this.upsertJob(b, j));
    return this.row<JobRow>("SELECT * FROM ci_jobs WHERE build_id = ? AND external_id = ?", b.id, j.external_id);
  }

  private ingest(c: ConnectionRow, event: string, payload: Record<string, unknown>, at: number): IngestResult {
    if (event === "ping") return { result: "recorded" };
    const isJob = event.startsWith("job.");
    if (!isJob && !event.startsWith("build.")) return { result: "ignored", reason: `event ${event || "(none)"} is not used` };
    const pipe = normalizePipeline(payload.pipeline);
    const b = normalizeBuild(payload.build, pipe);
    if (!b) return { result: "ignored", reason: "no build in the payload" };
    if (b.org && b.org !== c.organization) return { result: "ignored", reason: `a build of organization ${b.org}` };
    const existing = this.row<BuildRow>("SELECT * FROM ci_builds WHERE connection_id = ? AND external_id = ?", c.id, b.external_id);
    let build: BuildRow;
    if (existing) build = this.updateBuild(existing, b, at, isJob);
    else {
      const mapped = this.map(c, b);
      if ("ignore" in mapped) return { result: "ignored", reason: mapped.ignore };
      build = this.insertBuild(c, b, mapped, at);
    }
    this.upsertPipeline(c, pipe, b, build);
    if (isJob) {
      const j = normalizeJob(payload.job);
      if (j && j.type !== "waiter") this.upsertJob(build, j);
    }
    return { result: "recorded", build: build.id };
  }

  /**
   * Which repo a build is for, and who pushed its commit. Only Pando's own
   * records name a person: the delivery that started it, else the push or
   * merge that made the commit. A build carrying another monorepo's marks is
   * not ours (one Buildkite organization can serve several monorepos).
   */
  private map(c: ConnectionRow, b: NormBuild): { repo: string; delivery: string | null; pushed_by: string | null } | { ignore: string } {
    const me = this.host.info()!.id;
    const md = b.meta_data;
    if (md.pando_monorepo && md.pando_monorepo !== me) return { ignore: "another monorepo's build" };
    let repo: string | null = null;
    let delivery: string | null = null;
    let pushedBy: string | null = null;
    if (md.pando_delivery) {
      const d = this.row<{ repo: string; payload: string }>("SELECT repo, payload FROM deliveries WHERE id = ?", md.pando_delivery);
      if (d) {
        repo = d.repo;
        delivery = md.pando_delivery;
        const p = JSON.parse(d.payload) as { head?: string; pusher?: string };
        if (p.head === b.commit) pushedBy = p.pusher ?? null;
      } else if (!md.pando_monorepo) return { ignore: "another monorepo's build (its delivery is not here)" };
    }
    if (!repo && md.pando_monorepo === me) repo = md.pando_repo ?? null;
    if (!repo && !md.pando_monorepo && !md.pando_delivery) repo = this.pipelineRepo(c, b.pipeline);
    if (!repo || !this.row("SELECT name FROM repos WHERE name = ?", repo)) {
      return { ignore: `pipeline ${b.pipeline} builds no repo here (register a buildkite hook for it, or start its builds from Pando)` };
    }
    if (md.pando_rebuild_of && !pushedBy) {
      pushedBy = this.row<{ pushed_by: string | null }>("SELECT pushed_by FROM ci_builds WHERE connection_id = ? AND external_id = ?", c.id, md.pando_rebuild_of)?.pushed_by ?? null;
    }
    if (!pushedBy && b.commit) pushedBy = this.pusherOf(repo, b.commit);
    return { repo, delivery, pushed_by: pushedBy };
  }

  /** A pipeline's repo when one buildkite hook (or an earlier mapped build) says so, and only one repo. */
  private pipelineRepo(c: ConnectionRow, slug: string): string | null {
    const known = this.row<{ repo: string | null }>("SELECT repo FROM ci_pipelines WHERE connection_id = ? AND slug = ?", c.id, slug)?.repo;
    if (known) return known;
    const repos = new Set(this.hookPipelines(c).filter((h) => h.pipeline === slug).map((h) => h.repo));
    return repos.size === 1 ? [...repos][0] : null;
  }

  /** Buildkite hooks of this connection's organization: (pipeline, repo, hook). */
  private hookPipelines(c: ConnectionRow): { pipeline: string; repo: string; hook_id: string }[] {
    return this.rows<{ id: string; repo: string; config: string | null }>("SELECT id, repo, config FROM hooks WHERE type = 'buildkite' AND active = 1 ORDER BY created_at")
      .map((h) => ({ h, cfg: JSON.parse(h.config ?? "{}") as { organization?: string; pipeline?: string } }))
      .filter(({ cfg }) => (cfg.organization ?? "").toLowerCase() === c.organization && !!cfg.pipeline)
      .map(({ h, cfg }) => ({ pipeline: cfg.pipeline!, repo: h.repo, hook_id: h.id }));
  }

  /** Who pushed a commit, from Pando's push events (the last PUSH_SCAN) or the merge that made it. */
  private pusherOf(repo: string, sha: string): string | null {
    const head = this.row<{ s: number | null }>("SELECT MAX(seq) AS s FROM events")?.s ?? 0;
    const push = this.row<{ actor: string | null }>(
      `SELECT json_extract(body, '$.actor') AS actor FROM events
       WHERE seq > ? AND kind IN ('push', 'branch.opened') AND json_extract(body, '$.repo') = ? AND json_extract(body, '$.head') = ?
       ORDER BY seq DESC LIMIT 1`,
      head - PUSH_SCAN, repo, sha,
    );
    if (push?.actor) return push.actor;
    return this.row<{ merged_by: string }>("SELECT merged_by FROM merges WHERE repo = ? AND merge_commit = ? ORDER BY id DESC LIMIT 1", repo, sha)?.merged_by ?? null;
  }

  private insertBuild(c: ConnectionRow, b: NormBuild, m: { repo: string; delivery: string | null; pushed_by: string | null }, at: number): BuildRow {
    const id = hexId("cib_", 8);
    const t = now();
    const sha = b.commit && /^[0-9a-f]{40}$/.test(b.commit) ? b.commit : null;
    this.sql.exec(
      `INSERT INTO ci_builds (id, connection_id, external_id, pipeline, number, repo, sha, branch, message, state, service_state, web_url,
         pushed_by, delivery_id, rebuilt_from, created_at, started_at, finished_at, sort_at, event_ms, first_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, c.id, b.external_id, b.pipeline, b.number, m.repo, sha, b.branch, b.message, b.state, b.service_state, b.web_url,
      m.pushed_by, m.delivery, b.meta_data.pando_rebuild_of ?? b.rebuilt_from, b.created_at, b.started_at, b.finished_at,
      b.created_at ?? t, at, t, t,
    );
    const row = this.buildRow(id)!;
    this.publishBuild(row);
    return row;
  }

  /**
   * A later event for a stored build. Build events apply in the order the
   * service sent them (signed) or arrived (token), except that one in the
   * same second never moves a finished build back. A job event's copy of
   * the build never moves it back at all (a retry's build.running does).
   */
  private updateBuild(s: BuildRow, b: NormBuild, at: number, fromJob: boolean): BuildRow {
    const fresh = fromJob
      ? !TERMINAL.has(s.state) && rank(b.state) >= rank(s.state)
      : at > s.event_ms || (at === s.event_ms && !(TERMINAL.has(s.state) && !TERMINAL.has(b.state)));
    if (!fresh) return s;
    this.sql.exec(
      `UPDATE ci_builds SET state = ?, service_state = ?, web_url = COALESCE(?, web_url), message = COALESCE(?, message), branch = COALESCE(?, branch),
         started_at = COALESCE(?, started_at), finished_at = ?, event_ms = MAX(event_ms, ?), updated_at = ? WHERE id = ?`,
      b.state, b.service_state, b.web_url, b.message, b.branch, b.started_at, TERMINAL.has(b.state) ? (b.finished_at ?? now()) : null, at, now(), s.id,
    );
    const row = this.buildRow(s.id)!;
    if (JSON.stringify(this.buildView(row)) !== JSON.stringify(this.buildView(s))) this.publishBuild(row);
    return row;
  }

  private upsertPipeline(c: ConnectionRow, pipe: NormPipeline | null, b: NormBuild, build: BuildRow): void {
    this.sql.exec(
      `INSERT INTO ci_pipelines (connection_id, slug, repo, name, web_url, default_branch, last_build_id) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, slug) DO UPDATE SET repo = COALESCE(ci_pipelines.repo, excluded.repo),
         name = COALESCE(excluded.name, ci_pipelines.name), web_url = COALESCE(excluded.web_url, ci_pipelines.web_url),
         default_branch = COALESCE(excluded.default_branch, ci_pipelines.default_branch)`,
      c.id, b.pipeline, build.repo, pipe?.name ?? null, pipe?.web_url ?? null, pipe?.default_branch ?? null, build.id,
    );
    // The pipeline's last build: the newest by when it was created.
    const last = this.row<{ sort_at: string }>(
      "SELECT b.sort_at FROM ci_pipelines p JOIN ci_builds b ON b.id = p.last_build_id WHERE p.connection_id = ? AND p.slug = ?", c.id, b.pipeline,
    );
    if (!last || build.sort_at >= last.sort_at) this.sql.exec("UPDATE ci_pipelines SET last_build_id = ? WHERE connection_id = ? AND slug = ?", build.id, c.id, b.pipeline);
  }

  private upsertJob(build: BuildRow, j: NormJob): void {
    const s = this.row<JobRow>("SELECT * FROM ci_jobs WHERE build_id = ? AND external_id = ?", build.id, j.external_id);
    const t = now();
    if (!s) {
      this.sql.exec(
        `INSERT INTO ci_jobs (build_id, external_id, name, step_key, type, state, service_state, exit_status, soft_failed, retried, web_url, created_at, started_at, finished_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        build.id, j.external_id, j.name, j.step_key, j.type, j.state, j.service_state, j.exit_status, j.soft_failed ? 1 : 0, j.retried ? 1 : 0,
        j.web_url, j.created_at ?? t, j.started_at, j.finished_at, t,
      );
    } else {
      // A job's states only move forward; a retry is a new job, and the old one is marked retried.
      const fresh = !TERMINAL.has(s.state) && rank(j.state) >= rank(s.state);
      if (!fresh && (s.retried === 1 || !j.retried)) return;
      if (fresh) {
        this.sql.exec(
          `UPDATE ci_jobs SET name = COALESCE(?, name), state = ?, service_state = ?, exit_status = ?, soft_failed = ?, retried = MAX(retried, ?),
             web_url = COALESCE(?, web_url), started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at), updated_at = ?
           WHERE build_id = ? AND external_id = ?`,
          j.name, j.state, j.service_state, j.exit_status, j.soft_failed ? 1 : 0, j.retried ? 1 : 0, j.web_url, j.started_at, j.finished_at, t, build.id, j.external_id,
        );
      } else this.sql.exec("UPDATE ci_jobs SET retried = 1, updated_at = ? WHERE build_id = ? AND external_id = ?", t, build.id, j.external_id);
    }
    const row = this.row<JobRow>("SELECT * FROM ci_jobs WHERE build_id = ? AND external_id = ?", build.id, j.external_id)!;
    this.host.publish({
      kind: "ci.job", collection: "ci_jobs", key: `${build.id}/${j.external_id}`, op: "upsert", repo: build.repo,
      actor: null, machine: null, agent: null, row: this.jobView(row),
    });
    this.check(build, row);
  }

  /**
   * The job's check: a status whose context is the job's step key, stamped
   * buildkite. Only the newest job with that key in the newest build of this
   * pipeline for this commit reports (a retry or a rebuild supersedes), and
   * only a change is written.
   */
  private check(build: BuildRow, job: JobRow): void {
    if (!job.step_key || !CHECK_TYPES.has(job.type) || !build.sha || job.retried === 1) return;
    const newestJob = this.row<{ external_id: string }>(
      "SELECT external_id FROM ci_jobs WHERE build_id = ? AND step_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", build.id, job.step_key,
    );
    if (newestJob?.external_id !== job.external_id) return;
    const newestBuild = this.row<{ n: number }>(
      "SELECT MAX(number) AS n FROM ci_builds WHERE connection_id = ? AND pipeline = ? AND repo = ? AND sha = ?", build.connection_id, build.pipeline, build.repo, build.sha,
    );
    if ((newestBuild?.n ?? build.number) > build.number) return;
    const c = jobCheck(this.normJob(job), build.number);
    const target = job.web_url ?? build.web_url;
    const last = this.row<{ state: string; description: string | null; app: string | null; target_url: string | null }>(
      "SELECT state, description, app, target_url FROM statuses WHERE repo = ? AND sha = ? AND context = ? ORDER BY id DESC LIMIT 1", build.repo, build.sha, job.step_key,
    );
    if (last && last.state === c.state && last.description === c.description && last.app === BUILDKITE.app && last.target_url === target) return;
    this.host.addStatus(build.repo, build.sha, { state: c.state, context: job.step_key, target_url: target, description: c.description }, null, BUILDKITE);
  }

  private normJob(j: JobRow): NormJob {
    return {
      external_id: j.external_id, name: j.name, step_key: j.step_key, type: j.type, service_state: j.service_state, state: j.state,
      exit_status: j.exit_status, soft_failed: j.soft_failed === 1, retried: j.retried === 1, web_url: j.web_url,
      created_at: j.created_at, started_at: j.started_at, finished_at: j.finished_at,
    };
  }

  private publishBuild(b: BuildRow): void {
    this.host.publish({ kind: "ci.build", collection: "ci_builds", key: b.id, op: "upsert", repo: b.repo, actor: null, machine: null, agent: null, row: this.buildView(b) });
  }

  // ── Views ────────────────────────────────────────────────────────────────

  private repoPaths(): Map<string, string> {
    return new Map(this.rows<{ name: string; path: string }>("SELECT name, path FROM repos").map((r) => [r.name, r.path]));
  }

  private connectionServices(): Map<string, string> {
    return new Map(this.rows<{ id: string; service: string }>("SELECT id, service FROM ci_connections").map((r) => [r.id, r.service]));
  }

  buildView(b: BuildRow, paths = this.repoPaths(), services?: Map<string, string>): BuildView {
    return {
      id: b.id,
      service: services?.get(b.connection_id) ?? "buildkite",
      connection: b.connection_id,
      pipeline: b.pipeline,
      number: b.number,
      repo: b.repo,
      repo_path: paths.get(b.repo) ?? null,
      sha: b.sha,
      branch: b.branch,
      message: b.message,
      state: b.state,
      service_state: b.service_state,
      web_url: b.web_url,
      pushed_by: b.pushed_by,
      created_at: b.created_at,
      started_at: b.started_at,
      finished_at: b.finished_at,
      duration_s: duration(b.started_at, b.finished_at),
      rebuilt_from: b.rebuilt_from,
    };
  }

  jobView(j: JobRow): JobView {
    return {
      id: j.external_id,
      build: j.build_id,
      name: j.name,
      step_key: j.step_key,
      type: j.type,
      state: j.state,
      service_state: j.service_state,
      exit_status: j.exit_status,
      soft_failed: j.soft_failed === 1,
      retried: j.retried === 1,
      web_url: j.web_url,
      created_at: j.created_at,
      started_at: j.started_at,
      finished_at: j.finished_at,
      duration_s: duration(j.started_at, j.finished_at),
      // The check it reports: its step key (scripts and triggers only).
      check: j.step_key && CHECK_TYPES.has(j.type) ? j.step_key : null,
    };
  }

  private buildRow(id: string): BuildRow | null {
    return this.row<BuildRow>("SELECT * FROM ci_builds WHERE id = ?", id);
  }

  /** The CI tab's top: connections (with webhook health) and pipelines (each with its last build). */
  overview(): { connections: ConnectionView[]; pipelines: PipelineView[] } {
    const conns = this.rows<ConnectionRow>("SELECT * FROM ci_connections ORDER BY created_at");
    const paths = this.repoPaths();
    const services = this.connectionServices();
    const pipelines: PipelineView[] = [];
    for (const c of conns) {
      const stored = this.rows<{ slug: string; repo: string | null; name: string | null; web_url: string | null; default_branch: string | null; last_build_id: string | null }>(
        "SELECT slug, repo, name, web_url, default_branch, last_build_id FROM ci_pipelines WHERE connection_id = ? ORDER BY slug", c.id,
      );
      const hooks = this.hookPipelines(c);
      const seen = new Set<string>();
      for (const p of stored) {
        seen.add(p.slug);
        const last = p.last_build_id ? this.buildRow(p.last_build_id) : null;
        const hook = hooks.find((h) => h.pipeline === p.slug && h.repo === p.repo);
        pipelines.push(this.pipelineView(c, { ...p, hook_id: hook?.hook_id ?? null }, paths, last ? this.buildView(last, paths, services) : null));
      }
      for (const h of hooks) {
        if (seen.has(h.pipeline)) continue;
        seen.add(h.pipeline);
        pipelines.push(this.pipelineView(c, { slug: h.pipeline, repo: h.repo, name: null, web_url: null, default_branch: null, hook_id: h.hook_id }, paths, null));
      }
    }
    return { connections: conns.map((c) => this.connectionView(c)), pipelines };
  }

  private pipelineView(
    c: ConnectionRow,
    p: { slug: string; repo: string | null; name: string | null; web_url: string | null; default_branch: string | null; hook_id: string | null },
    paths: Map<string, string>,
    last: BuildView | null,
  ): PipelineView {
    return {
      connection: c.id,
      service: c.service,
      slug: p.slug,
      name: p.name ?? p.slug,
      repo: p.repo,
      repo_path: p.repo ? (paths.get(p.repo) ?? null) : null,
      web_url: p.web_url ?? `https://buildkite.com/${encodeURIComponent(c.organization)}/${encodeURIComponent(p.slug)}`,
      default_branch: p.default_branch,
      hook_id: p.hook_id,
      last_build: last,
    };
  }

  /** Stored builds, newest first. */
  builds(q: { repo?: string; branch?: string; sha?: string; pipeline?: string; connection?: string; state?: string; limit: number; cursor: string | null }): { builds: BuildView[]; next_cursor: string | null } {
    const limit = Math.min(Math.max(q.limit, 1), BUILDS_PAGE_MAX);
    const where: string[] = [];
    const args: unknown[] = [];
    for (const [col, v] of [["repo", q.repo], ["branch", q.branch], ["sha", q.sha], ["pipeline", q.pipeline], ["connection_id", q.connection], ["state", q.state]] as const) {
      if (v) {
        where.push(`${col} = ?`);
        args.push(v);
      }
    }
    if (q.cursor) {
      const k = decodeCursor(q.cursor) ?? fail(400, "bad_request", "cursor: pass back next_cursor as it came");
      where.push("(sort_at < ? OR (sort_at = ? AND id < ?))");
      args.push(k.sort_at, k.sort_at, k.id);
    }
    const rows = this.rows<BuildRow>(
      `SELECT * FROM ci_builds ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY sort_at DESC, id DESC LIMIT ?`, ...args, limit + 1,
    );
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const paths = this.repoPaths();
    const services = this.connectionServices();
    return {
      builds: page.map((b) => this.buildView(b, paths, services)),
      next_cursor: more ? encodeCursor(page[page.length - 1].sort_at, page[page.length - 1].id) : null,
    };
  }

  /** One build with its jobs (first scheduled first). */
  build(id: string): (BuildView & { jobs: JobView[] }) | null {
    const b = this.buildRow(id);
    if (!b) return null;
    const jobs = this.rows<JobRow>("SELECT * FROM ci_jobs WHERE build_id = ? ORDER BY created_at, rowid", id);
    return { ...this.buildView(b, this.repoPaths(), this.connectionServices()), jobs: jobs.map((j) => this.jobView(j)) };
  }

  /** What a route needs to call the service about a build and maybe a job. */
  ref(buildId: string, jobId: string | null): CiRef | null {
    const b = this.buildRow(buildId);
    if (!b) return null;
    const c = this.connection(b.connection_id);
    if (!c) return null;
    const job = jobId ? this.row<JobRow>("SELECT * FROM ci_jobs WHERE build_id = ? AND external_id = ?", buildId, jobId) : null;
    if (jobId && !job) return null;
    return { connection: this.refConnection(c), build: b, job };
  }

  private refConnection(c: ConnectionRow): CiRef["connection"] {
    return { id: c.id, service: c.service, organization: c.organization, api_base: c.api_base, token_source: c.token_source, token_ref: c.token_ref };
  }

  /** A pipeline this monorepo knows (stored or from a hook), with its stored configuration. */
  pipeline(slug: string, connection: string | null): { connection: CiRef["connection"]; pipeline: PipelineView; configuration: string | null; configuration_fetched_at: string | null } {
    const { pipelines } = this.overview();
    const hits = pipelines.filter((p) => p.slug === slug && (!connection || p.connection === connection));
    if (!hits.length) fail(404, "not_found", `no pipeline ${slug} here`);
    if (hits.length > 1) fail(409, "ambiguous", `pipeline ${slug} is in more than one connection; add ?connection=<id>`);
    const p = hits[0];
    const c = this.connection(p.connection)!;
    const stored = this.row<{ configuration: string | null; config_fetched_at: string | null }>(
      "SELECT configuration, config_fetched_at FROM ci_pipelines WHERE connection_id = ? AND slug = ?", c.id, slug,
    );
    return { connection: this.refConnection(c), pipeline: p, configuration: stored?.configuration ?? null, configuration_fetched_at: stored?.config_fetched_at ?? null };
  }

  savePipeline(connId: string, slug: string, repo: string | null, p: { configuration: string | null; name: string | null; web_url: string | null; default_branch: string | null }): void {
    this.sql.exec(
      `INSERT INTO ci_pipelines (connection_id, slug, repo, name, web_url, default_branch, configuration, config_fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, slug) DO UPDATE SET configuration = excluded.configuration, config_fetched_at = excluded.config_fetched_at,
         name = COALESCE(excluded.name, ci_pipelines.name), web_url = COALESCE(excluded.web_url, ci_pipelines.web_url),
         default_branch = COALESCE(excluded.default_branch, ci_pipelines.default_branch), repo = COALESCE(ci_pipelines.repo, excluded.repo)`,
      connId, slug, repo, p.name, p.web_url, p.default_branch, p.configuration, now(),
    );
  }

  // ── The service's rate limit, per connection ─────────────────────────────

  /** One REST call may go now, or not for retry_after_ms. */
  permit(connId: string, nowMs = Date.now()): { ok: true } | { ok: false; retry_after_ms: number } {
    const r = this.rate.get(connId) ?? { at: [], until: 0 };
    this.rate.set(connId, r);
    if (r.until > nowMs) return { ok: false, retry_after_ms: r.until - nowMs };
    r.at = r.at.filter((t) => t > nowMs - 60_000);
    if (r.at.length >= READS_PER_MIN) return { ok: false, retry_after_ms: r.at[0] + 60_000 - nowMs };
    r.at.push(nowMs);
    return { ok: true };
  }

  /** The service said to wait (a 429, or a spent RateLimit-Remaining). */
  rateWait(connId: string, ms: number): void {
    const r = this.rate.get(connId) ?? { at: [], until: 0 };
    r.until = Math.max(r.until, Date.now() + Math.min(ms, 3600_000));
    this.rate.set(connId, r);
  }
}
