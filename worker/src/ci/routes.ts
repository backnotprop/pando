// CI routes (RESEARCH-2026-10-03 section 6; v3 NOTES data gap 15).
//
// Members, under /v1/monorepos/{owner}/{name}/ci:
//   GET  /ci                                   services, connections (webhook URL, last event), pipelines, required checks
//   GET  /ci/builds?repo=&branch=&sha=&pipeline=&state=&limit=&cursor=   stored builds, newest first
//   GET  /ci/builds/{build}                    a build and its jobs
//   GET  /ci/builds/{build}/jobs/{job}/log     the job's log (its last 1 MiB), from the service
//   GET  /ci/builds/{build}/annotations        from the service
//   GET  /ci/builds/{build}/artifacts          from the service
//   GET  /ci/builds/{build}/artifacts/{id}/download   302 to the service's short-lived URL
//   GET  /ci/pipelines/{pipeline}              its configuration (pipeline.yml) and its builds
//   POST /ci/builds/{build}/rebuild            a new build of the same commit, with fresh tokens
//   POST /ci/builds/{build}/cancel             passed through
//   POST /ci/builds/{build}/jobs/{job}/retry   passed through
// Owners:
//   POST   /ci/connections                     connect a service; answers the webhook URL and token
//   DELETE /ci/connections/{connection}
// The service:
//   POST /v1/integrations/buildkite/{connection}   Buildkite's webhooks (wired in index.ts)
//
// Details fetched from the service are cached in R2 (CACHE, pando-dev-cache, ci/<monorepo id>/...; 90-day expiry)
// once settled (finished over 30 s ago), and for 10 s while running. Every
// REST call asks the monorepo object for a permit first (Buildkite's limits).

import type { Context, Hono } from "hono";
import type { Env } from "../env";
import { HttpError, toErrorResponse } from "../http";
import { finishTiming, note, runTimed, startTiming } from "../timing";
import type { ApiVars } from "../monorepo/api";
import { requiredKept } from "../monorepo/checks";
import { readToken } from "../monorepo/hooks";
import { isSha } from "../monorepo/names";
import { cachedRepo, monorepoStub } from "../monorepo/session";
import type { Outcome } from "../monorepo/types";
import { pool } from "../monorepo/views";
import { p, PAGE_MAX, pandoBuildEnv, rateWaitMs, restUrl, TERMINAL, WEBHOOK_MAX_BYTES, type CiState } from "./buildkite";
import { BUILDS_PAGE, BUILDS_PAGE_MAX, type CiRef } from "./store";
import { mintStatusToken } from "./statustoken";

type C = Context<{ Bindings: Env; Variables: ApiVars }>;

/** The services Pando can connect today. */
export const SERVICES = [{ service: "buildkite", name: "Buildkite" }];
/** A job's log is kept to its last this many bytes (owner limit: the page shows the end, where failures are). */
export const LOG_TAIL_BYTES = 1 << 20;
/** A log larger than this is not read through Pando (owner limit: the Worker's CPU time); the page links to Buildkite. */
export const LOG_READ_MAX = 64 << 20;
/** Details are cached for good once the job or build finished this long ago (Buildkite finishes logs and uploads a moment later). */
const SETTLE_MS = 30_000;
/** While running, a log, annotations or artifacts are read from the service at most this often. */
const RUNNING_TTL_MS = 10_000;
/** A pipeline's configuration is read from the service at most this often. */
const CONFIG_TTL_MS = 5 * 60_000;
const STATES: CiState[] = ["queued", "running", "blocked", "passed", "failed", "canceled", "skipped"];
const ORG_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

function unwrap<T>(o: Outcome<T>): T {
  if (o.ok) return o.value;
  throw new HttpError(o.status, o.code, o.message, o.extra ?? {});
}

function bad(message: string): never {
  throw new HttpError(400, "bad_request", message);
}

function ownerOnly(c: C, what: string): void {
  if (c.get("identity").role !== "owner") throw new HttpError(403, "owner_only", `only an owner can ${what}`);
}

function webhookUrl(c: C, service: string, id: string): string {
  return `${new URL(c.req.url).origin}/v1/integrations/${service}/${encodeURIComponent(id)}`;
}

async function refOf(c: C, job = false): Promise<CiRef> {
  const ref = await c.get("stub").ciRef(c.req.param("build")!, job ? c.req.param("job")! : null);
  if (!ref) throw new HttpError(404, "not_found", job ? "no such build or job" : "no such build");
  return ref;
}

// ── Calling the service ─────────────────────────────────────────────────────

function serviceToken(env: Env, conn: CiRef["connection"]): string {
  if (conn.token_source !== "worker") throw new HttpError(501, "not_built", "per-connection CI tokens come with C21");
  const t = env.BUILDKITE_API_TOKEN;
  if (!t) throw new HttpError(503, "ci_token_missing", "the Worker secret BUILDKITE_API_TOKEN is not set");
  return t;
}

/** One REST call, after a permit. Turns the service's refusals into Pando's errors; never puts the token in one. */
async function call(
  c: C,
  conn: CiRef["connection"],
  method: string,
  path: string,
  o: { body?: unknown; accept?: string; manual?: boolean } = {},
): Promise<Response> {
  const token = serviceToken(c.env, conn);
  const stub = c.get("stub");
  const permit = await stub.ciPermit(conn.id);
  if (!permit.ok) {
    throw new HttpError(503, "ci_rate_limited", `holding to Buildkite's rate limit; try again in ${Math.ceil(permit.retry_after_ms / 1000)} s`, { retry_after_ms: permit.retry_after_ms });
  }
  const res = await fetch(restUrl(conn, path), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: o.accept ?? "application/json",
      "user-agent": "Pando-CI/1",
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    redirect: o.manual ? "manual" : "follow",
    signal: AbortSignal.timeout(20_000),
  });
  note({ ci_call: `${method} ${res.status}` });
  const wait = rateWaitMs(res);
  if (wait) await stub.ciRateWait(conn.id, wait);
  if (res.ok || (o.manual && res.status >= 300 && res.status < 400)) return res;
  const text = (await res.text().catch(() => "")).slice(0, 300);
  let message = text;
  try {
    message = (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {}
  if (res.status === 429) throw new HttpError(503, "ci_rate_limited", "Buildkite's rate limit was reached; try again shortly", { retry_after_ms: wait ?? 60_000 });
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(502, "ci_unauthorized", "Buildkite refused the token: BUILDKITE_API_TOKEN needs read_builds, read_build_logs, read_artifacts, read_pipelines and write_builds");
  }
  if (res.status === 404) throw new HttpError(404, "not_found", "Buildkite has no such build, job, artifact or pipeline");
  if (res.status === 400 || res.status === 409 || res.status === 422) throw new HttpError(409, "ci_refused", `Buildkite refused: ${message}`);
  throw new HttpError(502, "ci_service", `Buildkite answered ${res.status}`);
}

// ── The R2 cache of details ─────────────────────────────────────────────────

function settled(finishedAt: string | null): boolean {
  return !!finishedAt && Date.now() - Date.parse(finishedAt) > SETTLE_MS;
}

function cacheKey(c: C, ref: CiRef, what: string): string {
  return `ci/${c.get("m")}/${ref.connection.id}/${ref.build.external_id}/${what}`;
}

/** A cached detail, if complete or fresh enough. */
async function fromCache(env: Env, key: string): Promise<{ text: string; meta: Record<string, string> } | null> {
  const obj = await env.CACHE.get(key);
  if (!obj) return null;
  const meta = obj.customMetadata ?? {};
  if (meta.complete !== "1" && Date.now() - Date.parse(meta.fetched_at ?? "") > RUNNING_TTL_MS) {
    await obj.body.cancel();
    return null;
  }
  return { text: await obj.text(), meta };
}

async function toCache(env: Env, key: string, text: string, meta: Record<string, string>): Promise<void> {
  await env.CACHE.put(key, text, { customMetadata: meta }).catch((err) => console.warn("ci: caching a detail failed:", err instanceof Error ? err.message : String(err)));
}

/** A finished detail never changes, so the browser may keep it; a running one is re-read. */
function cacheHeader(complete: boolean): Record<string, string> {
  return { "cache-control": complete ? "private, max-age=31536000, immutable" : "private, no-store" };
}

/** Read a body, keeping only its last `max` bytes. */
async function tail(res: Response, max: number): Promise<{ bytes: Uint8Array; total: number }> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    kept += value.length;
    total += value.length;
    if (total > LOG_READ_MAX) {
      await reader.cancel();
      throw new HttpError(413, "log_too_large", `the log is over ${LOG_READ_MAX >> 20} MiB; open it in Buildkite`);
    }
    while (chunks.length > 1 && kept - chunks[0].length >= max) kept -= chunks.shift()!.length;
  }
  const all = new Uint8Array(kept);
  let o = 0;
  for (const ch of chunks) {
    all.set(ch, o);
    o += ch.length;
  }
  return { bytes: all.length > max ? all.subarray(all.length - max) : all, total };
}

const hasNext = (res: Response) => /rel="next"/.test(res.headers.get("link") ?? "");

async function annotationsOf(c: C, ref: CiRef): Promise<{ list: Record<string, unknown>[]; truncated: boolean; complete: boolean; fetched_at: string; cached: boolean }> {
  const key = cacheKey(c, ref, "annotations.json");
  const hit = await fromCache(c.env, key);
  if (hit) return { list: JSON.parse(hit.text), truncated: hit.meta.truncated === "1", complete: hit.meta.complete === "1", fetched_at: hit.meta.fetched_at, cached: true };
  const res = await call(c, ref.connection, "GET", `/pipelines/${p(ref.build.pipeline)}/builds/${ref.build.number}/annotations?per_page=${PAGE_MAX}`);
  const raw = (await res.json()) as Record<string, unknown>[];
  const list = (Array.isArray(raw) ? raw : []).map((a) => ({
    id: a.id ?? null, context: a.context ?? null, style: a.style ?? null, body_html: a.body_html ?? "", created_at: a.created_at ?? null, updated_at: a.updated_at ?? null,
  }));
  const complete = settled(ref.build.finished_at);
  const fetched_at = new Date().toISOString();
  await toCache(c.env, key, JSON.stringify(list), { complete: complete ? "1" : "0", fetched_at, truncated: hasNext(res) ? "1" : "0" });
  return { list, truncated: hasNext(res), complete, fetched_at, cached: false };
}

async function artifactsOf(c: C, ref: CiRef): Promise<{ list: Record<string, unknown>[]; truncated: boolean; complete: boolean; fetched_at: string; cached: boolean }> {
  const key = cacheKey(c, ref, "artifacts.json");
  const hit = await fromCache(c.env, key);
  if (hit) return { list: JSON.parse(hit.text), truncated: hit.meta.truncated === "1", complete: hit.meta.complete === "1", fetched_at: hit.meta.fetched_at, cached: true };
  const res = await call(c, ref.connection, "GET", `/pipelines/${p(ref.build.pipeline)}/builds/${ref.build.number}/artifacts?per_page=${PAGE_MAX}`);
  const raw = (await res.json()) as Record<string, unknown>[];
  const list = (Array.isArray(raw) ? raw : []).map((a) => ({
    id: a.id ?? null, job: a.job_id ?? null, path: a.path ?? null, filename: a.filename ?? null, dirname: a.dirname ?? null,
    mime_type: a.mime_type ?? null, size: typeof a.file_size === "number" ? a.file_size : null, sha1sum: a.sha1sum ?? null, state: a.state ?? null,
  }));
  const complete = settled(ref.build.finished_at);
  const fetched_at = new Date().toISOString();
  await toCache(c.env, key, JSON.stringify(list), { complete: complete ? "1" : "0", fetched_at, truncated: hasNext(res) ? "1" : "0" });
  return { list, truncated: hasNext(res), complete, fetched_at, cached: false };
}

// ── Routes ──────────────────────────────────────────────────────────────────

export function ciRoutes(api: Hono<{ Bindings: Env; Variables: ApiVars }>): void {
  const base = "/v1/monorepos/:o/:m/ci";

  api.get(base, async (c) => {
    const stub = c.get("stub");
    const [o, repos] = await Promise.all([stub.ciOverview(), stub.listRepos()]);
    const info = c.get("info");
    const lists = await pool(repos, 4, (r) => requiredKept(c.env, info, r));
    const required = new Map(repos.map((r, i) => [r.name, lists[i]]));
    return c.json({
      services: SERVICES,
      connections: o.connections.map((x) => ({ ...x, webhook_url: webhookUrl(c, x.service as string, x.id as string) })),
      pipelines: o.pipelines.map((x) => ({ ...x, required_checks: x.repo ? (required.get(x.repo as string) ?? []) : [] })),
      required_checks: repos.map((r) => ({ repo: r.name, path: r.path, checks: required.get(r.name) ?? [] })),
    });
  });

  api.get(`${base}/builds`, async (c) => {
    const limit = Number(c.req.query("limit") ?? BUILDS_PAGE);
    if (!Number.isInteger(limit) || limit < 1 || limit > BUILDS_PAGE_MAX) bad(`limit is 1 to ${BUILDS_PAGE_MAX}`);
    const state = c.req.query("state");
    if (state && !STATES.includes(state as CiState)) bad(`state is one of ${STATES.join(", ")}`);
    const sha = c.req.query("sha");
    if (sha && !isSha(sha)) bad("sha must be a full 40-character sha");
    return c.json(unwrap(await c.get("stub").ciBuilds({
      repo: c.req.query("repo"), branch: c.req.query("branch"), sha: sha?.toLowerCase(), pipeline: c.req.query("pipeline"),
      connection: c.req.query("connection"), state, limit, cursor: c.req.query("cursor") ?? null,
    })));
  });

  api.get(`${base}/builds/:build`, async (c) => {
    const b = await c.get("stub").ciBuild(c.req.param("build"));
    if (!b) throw new HttpError(404, "not_found", "no such build");
    return c.json(b);
  });

  api.get(`${base}/builds/:build/jobs/:job/log`, async (c) => {
    const ref = await refOf(c, true);
    const job = ref.job!;
    const key = cacheKey(c, ref, `log/${job.external_id}`);
    const hit = await fromCache(c.env, key);
    if (hit) {
      const complete = hit.meta.complete === "1";
      return c.json({ job: job.external_id, content: hit.text, bytes: Number(hit.meta.bytes), total_bytes: Number(hit.meta.total_bytes), truncated: hit.meta.truncated === "1", complete, fetched_at: hit.meta.fetched_at, cached: true }, 200, cacheHeader(complete));
    }
    const res = await call(c, ref.connection, "GET", `/pipelines/${p(ref.build.pipeline)}/builds/${ref.build.number}/jobs/${p(job.external_id)}/log`, { accept: "text/plain" });
    const { bytes, total } = await tail(res, LOG_TAIL_BYTES);
    const content = new TextDecoder().decode(bytes);
    const complete = settled(job.finished_at);
    const fetched_at = new Date().toISOString();
    const truncated = total > bytes.length;
    await toCache(c.env, key, content, { complete: complete ? "1" : "0", fetched_at, bytes: String(bytes.length), total_bytes: String(total), truncated: truncated ? "1" : "0" });
    return c.json({ job: job.external_id, content, bytes: bytes.length, total_bytes: total, truncated, complete, fetched_at, cached: false }, 200, cacheHeader(complete));
  });

  api.get(`${base}/builds/:build/annotations`, async (c) => {
    const a = await annotationsOf(c, await refOf(c));
    return c.json({ annotations: a.list, truncated: a.truncated, complete: a.complete, fetched_at: a.fetched_at, cached: a.cached }, 200, cacheHeader(a.complete));
  });

  api.get(`${base}/builds/:build/artifacts`, async (c) => {
    const a = await artifactsOf(c, await refOf(c));
    return c.json({ artifacts: a.list, truncated: a.truncated, complete: a.complete, fetched_at: a.fetched_at, cached: a.cached }, 200, cacheHeader(a.complete));
  });

  api.get(`${base}/builds/:build/artifacts/:artifact/download`, async (c) => {
    const ref = await refOf(c);
    // Only an artifact of this build: the token could reach any build in the organization.
    const a = (await artifactsOf(c, ref)).list.find((x) => x.id === c.req.param("artifact"));
    if (!a || typeof a.job !== "string") throw new HttpError(404, "not_found", "no such artifact in this build");
    const res = await call(c, ref.connection, "GET", `/pipelines/${p(ref.build.pipeline)}/builds/${ref.build.number}/jobs/${p(a.job)}/artifacts/${p(a.id as string)}/download`, { manual: true });
    const to = res.headers.get("location");
    await res.body?.cancel();
    if (!to) throw new HttpError(502, "ci_service", "Buildkite gave no download URL");
    // Buildkite's URL is good for about 60 seconds.
    return new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });
  });

  api.get(`${base}/pipelines/:pipeline`, async (c) => {
    const stub = c.get("stub");
    const slug = c.req.param("pipeline");
    const pl = unwrap(await stub.ciPipeline(slug, c.req.query("connection") ?? null));
    let configuration = pl.configuration;
    let fetchedAt = pl.configuration_fetched_at;
    let error: { code: string; message: string } | null = null;
    if (!fetchedAt || Date.now() - Date.parse(fetchedAt) > CONFIG_TTL_MS) {
      try {
        const res = await call(c, pl.connection, "GET", `/pipelines/${p(slug)}`);
        const j = (await res.json()) as Record<string, unknown>;
        configuration = typeof j.configuration === "string" ? j.configuration : null;
        await stub.ciSavePipeline(pl.connection.id, slug, (pl.pipeline.repo as string | null) ?? null, {
          configuration,
          name: typeof j.name === "string" ? j.name : null,
          web_url: typeof j.web_url === "string" ? j.web_url : null,
          default_branch: typeof j.default_branch === "string" ? j.default_branch : null,
        });
        fetchedAt = new Date().toISOString();
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        error = { code: err.code, message: err.message }; // the stored copy (if any) is shown, with why it is old
      }
    }
    const limit = Number(c.req.query("limit") ?? BUILDS_PAGE);
    if (!Number.isInteger(limit) || limit < 1 || limit > BUILDS_PAGE_MAX) bad(`limit is 1 to ${BUILDS_PAGE_MAX}`);
    const page = unwrap(await stub.ciBuilds({ pipeline: slug, connection: pl.connection.id, limit, cursor: c.req.query("cursor") ?? null }));
    const repo = (await stub.listRepos()).find((r) => r.name === pl.pipeline.repo);
    const required = repo ? await requiredKept(c.env, c.get("info"), repo) : [];
    return c.json({
      pipeline: { ...pl.pipeline, required_checks: required, configuration, configuration_fetched_at: fetchedAt, configuration_error: error },
      ...page,
    });
  });

  // A new build of the same commit with fresh tokens: Buildkite's own rebuild would reuse the old env and its expired tokens.
  api.post(`${base}/builds/:build/rebuild`, async (c) => {
    const ref = await refOf(c);
    const b = ref.build;
    if (!b.sha) throw new HttpError(409, "no_commit", "this build has no commit to build again");
    const r = await cachedRepo(c.env, c.get("m"), b.repo);
    if (!r) throw new HttpError(404, "not_found", `no repo ${b.repo}`);
    const m = c.get("m");
    const full = c.get("full");
    const origin = new URL(c.req.url).origin;
    const read = await readToken(c.env, r.artifacts_name, "ci");
    const status = c.env.PANDO_STATUS_SECRET
      ? await mintStatusToken(c.env.PANDO_STATUS_SECRET, { m, r: b.repo, s: b.sha, a: "buildkite", h: `ci:${ref.connection.id}` })
      : null;
    const who = c.get("identity");
    const res = await call(c, ref.connection, "POST", `/pipelines/${p(b.pipeline)}/builds`, {
      body: {
        commit: b.sha,
        branch: b.branch ?? r.default_branch,
        message: b.message ?? `Rebuild of #${b.number}`,
        author: { name: who.name ?? who.login, ...(who.email ? { email: who.email } : {}) },
        env: pandoBuildEnv({
          clone_url: c.get("info").kind === "repo" ? `${origin}/${full}.git` : `${origin}/${full}/${b.repo}.git`,
          read_token: read.token,
          status_url: `${origin}/v1/monorepos/${full}/repos/${b.repo}/statuses/${b.sha}`,
          status_token: status?.token ?? null,
          monorepo: full, repo: b.repo, branch: b.branch ?? r.default_branch, head: b.sha, delivery: "", seq: null,
        }),
        meta_data: { pando_monorepo: m, pando_repo: b.repo, pando_rebuild_of: b.external_id },
      },
    });
    const out = unwrap(await c.get("stub").ciIngestBuild(ref.connection.id, await res.json()));
    const build = out.build ? await c.get("stub").ciBuild(out.build) : null;
    return c.json({ build }, 201);
  });

  api.post(`${base}/builds/:build/cancel`, async (c) => {
    const ref = await refOf(c);
    if (TERMINAL.has(ref.build.state)) throw new HttpError(409, "ci_finished", `build #${ref.build.number} has finished (${ref.build.state})`);
    const res = await call(c, ref.connection, "PUT", `/pipelines/${p(ref.build.pipeline)}/builds/${ref.build.number}/cancel`);
    unwrap(await c.get("stub").ciIngestBuild(ref.connection.id, await res.json()));
    return c.json({ build: await c.get("stub").ciBuild(ref.build.id) }, 202);
  });

  api.post(`${base}/builds/:build/jobs/:job/retry`, async (c) => {
    const ref = await refOf(c, true);
    const res = await call(c, ref.connection, "PUT", `/pipelines/${p(ref.build.pipeline)}/builds/${ref.build.number}/jobs/${p(ref.job!.external_id)}/retry`);
    const job = await c.get("stub").ciIngestJob(ref.build.id, await res.json());
    return c.json({ job }, 202);
  });

  api.post(`${base}/connections`, async (c) => {
    ownerOnly(c, "connect a CI service");
    let b: Record<string, unknown>;
    try {
      b = (await c.req.json()) as Record<string, unknown>;
    } catch {
      bad("the body must be JSON");
    }
    if (b.service !== "buildkite") bad("service: buildkite (the one CI service Pando connects today)");
    const organization = typeof b.organization === "string" ? b.organization.toLowerCase() : "";
    if (!ORG_SLUG.test(organization)) bad("organization: the Buildkite organization's slug (as in buildkite.com/<slug>)");
    let token: string | null = null;
    if (b.webhook_token !== undefined) {
      if (typeof b.webhook_token !== "string" || b.webhook_token.length < 16 || b.webhook_token.length > 200) bad("webhook_token: 16 to 200 characters (or leave it out and Pando makes one)");
      token = b.webhook_token;
    }
    let apiBase: string | null = null;
    if (b.api_url !== undefined) {
      // Tests only: the token is never sent anywhere but Buildkite or this machine.
      const m = typeof b.api_url === "string" ? /^(http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)\/?$/.exec(b.api_url) : null;
      if (!m) bad("api_url may only point at localhost (for tests)");
      apiBase = m[1];
    }
    const out = unwrap(await c.get("stub").ciConnect({ service: "buildkite", organization, api_base: apiBase, webhook_token: token }, c.get("identity")));
    const conn = out.connection as { id: string; service: string };
    // The webhook token is shown once: paste it into Buildkite's webhook settings.
    return c.json({ connection: { ...out.connection, webhook_url: webhookUrl(c, conn.service, conn.id) }, webhook_token: out.webhook_token }, 201);
  });

  api.delete(`${base}/connections/:connection`, async (c) => {
    ownerOnly(c, "disconnect a CI service");
    const id = c.req.param("connection");
    if (!(await c.get("stub").ciDisconnect(id, c.get("identity")))) throw new HttpError(404, "not_found", "no such CI connection");
    // Its cached details.
    const prefix = `ci/${c.get("m")}/${id}/`;
    for (let more = true; more; ) {
      const listed = await c.env.CACHE.list({ prefix, limit: 1000 });
      if (listed.objects.length) await c.env.CACHE.delete(listed.objects.map((o) => o.key));
      more = listed.truncated;
    }
    return c.body(null, 204);
  });
}

// ── The webhook receiver (no member credential: the service's own token or signature) ──

const INTEGRATION_RE = /^\/v1\/integrations\/buildkite\/([^/]+)$/;
const exists = new Map<string, number>();

export function isIntegrationPath(path: string): boolean {
  return path.startsWith("/v1/integrations/");
}

/** The monorepo exists (D1), so a made-up id never creates an object. Cached 60 s per isolate. */
async function monorepoExists(env: Env, id: string): Promise<boolean> {
  const at = exists.get(id);
  if (at && Date.now() - at < 60_000) return true;
  const row = await env.ACCOUNTS_DB.withSession("first-unconstrained").prepare("SELECT id FROM monorepos WHERE id = ?1").bind(id).first();
  const found = row ?? (await env.ACCOUNTS_DB.withSession("first-primary").prepare("SELECT id FROM monorepos WHERE id = ?1").bind(id).first());
  if (!found) return false;
  if (exists.size > 10_000) exists.clear();
  exists.set(id, Date.now());
  return true;
}

export async function handleIntegration(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const t = startTiming("api", { method: request.method, path, monorepo: null, repo: null });
  const res = await runTimed(t, async () => {
    try {
      const m = INTEGRATION_RE.exec(path);
      if (!m) throw new HttpError(404, "not_found", "no such integration route");
      if (request.method !== "POST") throw new HttpError(405, "method", "POST only");
      const conn = decodeURIComponent(m[1]);
      const i = conn.indexOf("--");
      const monorepo = i > 0 ? conn.slice(0, i) : "";
      if (!monorepo || !/^cic_[0-9a-f]{12}$/.test(conn.slice(i + 2))) throw new HttpError(404, "not_found", "no such CI connection");
      if (Number(request.headers.get("content-length") ?? 0) > WEBHOOK_MAX_BYTES) throw new HttpError(413, "too_large", "the body is over 5 MiB");
      if (!(await monorepoExists(env, monorepo))) throw new HttpError(404, "not_found", "no such CI connection");
      note({ monorepo_id: monorepo, event: request.headers.get("x-buildkite-event") });
      const body = await request.text();
      if (body.length > WEBHOOK_MAX_BYTES) throw new HttpError(413, "too_large", "the body is over 5 MiB");
      const out = unwrap(
        await monorepoStub(env, monorepo).ciWebhook(
          conn,
          { event: request.headers.get("x-buildkite-event"), token: request.headers.get("x-buildkite-token"), signature: request.headers.get("x-buildkite-signature") },
          body,
          Date.now(),
        ),
      );
      note({ ci_result: out.result });
      return Response.json(out);
    } catch (err) {
      return toErrorResponse(err);
    }
  });
  finishTiming(t, { status: res.status });
  return res;
}
