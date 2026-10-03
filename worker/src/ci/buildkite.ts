// Buildkite, the first CI service (RESEARCH-2026-10-03 section 6): what
// Pando sends a build, how it reads Buildkite's webhooks, and the REST calls
// for details and actions. Everything service-specific is here; ci/store.ts
// and ci/routes.ts work on the abstract model (service, connection, pipeline,
// build, job, check).
//
// Read from Buildkite's docs (2026-10-03):
// - webhooks: X-Buildkite-Event; X-Buildkite-Token (the token as is) or
//   X-Buildkite-Signature `timestamp=<unix s>,signature=<hex HMAC-SHA256 of
//   "<timestamp>.<raw body>" keyed by the token>`. Build events carry `build`
//   and `pipeline`; job events also `job`. A webhook's build has no jobs.
// - REST (https://api.buildkite.com/v2, Bearer): 200 requests a minute per
//   organization, 50 per user (the token's owner); RateLimit-Remaining,
//   RateLimit-Reset (seconds), RateLimit-User-*; 429 past them. Pages:
//   per_page at most 100.
// - Scopes: read_builds (builds, annotations), read_build_logs,
//   read_artifacts, read_pipelines, write_builds (create, rebuild, cancel,
//   retry).

import type { StatusRecord } from "../monorepo/types";
import { isInteger, isRecord, isText, isWholeNumber, type Json, type JsonObject } from "../parse";

/**
 * A CI build's read token lives this long (pando-ops ruling, 2026-10-03):
 * Buildkite's Retry reruns a job with the build's original env, so the token
 * in it must outlive a day of retries. Read only, one repo. Artifacts allows
 * 60 s to 1 year. Minted for 25 hours and reused for at most 1, so every
 * build gets at least 24.
 */
export const CI_READ_TTL_S = 25 * 3600;

export const CI_READ_REUSE_MS = 3600_000;

export const BUILDKITE_API = "https://api.buildkite.com";

/** A webhook body larger than this is refused (job events carry the pipeline's steps). */
export const WEBHOOK_MAX_BYTES = 5 << 20;

/** A signed webhook older (or newer) than this is refused: a replay. */
export const SIGNATURE_MAX_AGE_S = 300;

/** Buildkite's REST page size, at most. */
export const PAGE_MAX = 100;

/** What Pando knows about a build it starts. */
export interface BuildFacts {
  clone_url: string;
  read_token: string;
  status_url: string;
  status_token: string | null;
  monorepo: string;
  repo: string;
  branch: string;
  head: string;
  delivery: string;
  seq: number | null;
}

/** The env a build gets (api-v1.yaml, createHook). PANDO_STATUS_TOKEN only when PANDO_STATUS_SECRET is set. */
export interface BuildEnv {
  PANDO_CLONE_URL: string;
  PANDO_READ_TOKEN: string;
  PANDO_STATUS_URL: string;
  PANDO_STATUS_TOKEN?: string;
  PANDO_MONOREPO: string;
  PANDO_REPO: string;
  PANDO_BRANCH: string;
  PANDO_HEAD: string;
  PANDO_DELIVERY: string;
  PANDO_SEQ: string;
}

/** The env Pando gives a build it starts (hook deliveries and Rebuild). */
export function pandoBuildEnv(v: BuildFacts): BuildEnv {
  const env: BuildEnv = {
    PANDO_CLONE_URL: v.clone_url,
    PANDO_READ_TOKEN: v.read_token,
    PANDO_STATUS_URL: v.status_url,
    PANDO_MONOREPO: v.monorepo,
    PANDO_REPO: v.repo,
    PANDO_BRANCH: v.branch,
    PANDO_HEAD: v.head,
    PANDO_DELIVERY: v.delivery,
    PANDO_SEQ: v.seq === null ? "" : String(v.seq),
  };

  if (v.status_token) env.PANDO_STATUS_TOKEN = v.status_token;

  return env;
}

// ── The abstract model's states ─────────────────────────────────────────────

/** One vocabulary for every CI service (RESEARCH section 6). */
export type CiState = "queued" | "running" | "blocked" | "passed" | "failed" | "canceled" | "skipped";

export const TERMINAL: ReadonlySet<CiState> = new Set(["passed", "failed", "canceled", "skipped"]);

/** Every state, in the order the API lists them. */
export const CI_STATES: readonly CiState[] = ["queued", "running", "blocked", "passed", "failed", "canceled", "skipped"];

const STATE_NAMES: ReadonlySet<string> = new Set(CI_STATES);

/** A state named in a query (?state=). */
export function isCiState(v: string): v is CiState {
  return STATE_NAMES.has(v);
}

/** Later states rank higher: an older event never moves a row back. */
export function rank(s: CiState): number {
  return TERMINAL.has(s) ? 2 : s === "queued" ? 0 : 1;
}

/** Buildkite build states (creating ... not_run) to the vocabulary. */
export function buildState(s: string): CiState {
  switch (s) {
    case "running":
    case "failing":
    case "canceling":
      return "running";
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "canceled":
      return "canceled";
    case "skipped":
    case "not_run":
      return "skipped";
    default: // creating, scheduled, waiting, and anything new
      return "queued";
  }
}

/** Buildkite job states to the vocabulary. */
export function jobState(s: string, exit: number | null): CiState {
  switch (s) {
    case "running":
    case "canceling":
    case "timing_out":
      return "running";
    case "passed":
      return "passed";
    case "failed":
    case "timed_out":
    case "expired":
    case "waiting_failed":
    case "blocked_failed":
    case "unblocked_failed":
      return "failed";
    case "finished": // older payloads
      return exit === 0 ? "passed" : "failed";
    case "canceled":
      return "canceled";
    case "skipped":
    case "broken":
      return "skipped";
    case "blocked":
      return "blocked";
    default: // pending, waiting, scheduled, assigned, accepted, limiting, limited, unblocked
      return "queued";
  }
}

// ── Payloads, normalized ────────────────────────────────────────────────────

export interface NormBuild {
  external_id: string;
  number: number;
  service_state: string;
  state: CiState;
  commit: string | null;
  branch: string | null;
  message: string | null;
  web_url: string | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  meta_data: Record<string, string>;
  rebuilt_from: string | null;
  org: string | null;
  pipeline: string;
}

export interface NormJob {
  external_id: string;
  name: string | null;
  step_key: string | null;
  type: string;
  service_state: string;
  state: CiState;
  exit_status: number | null;
  soft_failed: boolean;
  retried: boolean;
  web_url: string | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface NormPipeline {
  slug: string;
  name: string | null;
  web_url: string | null;
  default_branch: string | null;
  org: string | null;
}

// Buildkite's JSON is decoded here, once, at the boundary: webhooks
// (ci/store.ts) and REST answers (ci/routes.ts) arrive as Json and leave as
// the types above.

/** A non-empty string, cut to `max` characters; null for anything else. */
const str = (v: Json | undefined, max = 2000): string | null => (isText(v) && v ? v.slice(0, max) : null);

/** A string or null, as it is. */
const textOrNull = (v: Json | undefined): string | null => (isText(v) ? v : null);

/** A time Date can read, as ISO 8601. */
const time = (v: Json | undefined): string | null => (isText(v) && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/** An object, or null. */
const obj = (v: Json | undefined): JsonObject | null => (isRecord(v) ? v : null);

/** The organization's slug from an API URL (`/v2/organizations/<org>/...`) or a web URL (`buildkite.com/<org>/...`). */
export function orgFromUrl(url: string | null): string | null {
  if (url === null) return null;
  const api = /\/organizations\/([^/?#]+)/.exec(url);

  if (api) return decodeURIComponent(api[1]).toLowerCase();
  const web = /^https:\/\/buildkite\.com\/([^/?#]+)/.exec(url);

  return web ? decodeURIComponent(web[1]).toLowerCase() : null;
}

export function normalizePipeline(p: Json | undefined): NormPipeline | null {
  const o = obj(p);
  const slug = str(o?.slug, 200);

  if (!o || !slug) return null;

  return {
    slug,
    name: str(o.name, 200),
    web_url: str(o.web_url),
    default_branch: str(o.default_branch, 300),
    org: orgFromUrl(textOrNull(o.url)) ?? orgFromUrl(textOrNull(o.web_url)),
  };
}

export function normalizeBuild(b: Json | undefined, pipeline: NormPipeline | null): NormBuild | null {
  const o = obj(b);
  const id = str(o?.id, 100);
  const number = o?.number;
  const url = textOrNull(o?.url);
  // A build's pipeline: the payload's, else the one in its own URL.
  const pipe = pipeline?.slug ?? (url === null ? null : (/\/pipelines\/([^/]+)\/builds\//.exec(url)?.[1] ?? null));

  if (!o || !id || !isInteger(number) || !pipe) return null;
  const md: Record<string, string> = {};
  const raw = obj(o.meta_data);

  for (const k of ["pando_delivery", "pando_monorepo", "pando_repo", "pando_rebuild_of"]) {
    const v = str(raw?.[k], 200);

    if (v) md[k] = v;
  }

  const service_state = str(o.state, 40) ?? "scheduled";
  const commit = str(o.commit, 200);

  return {
    external_id: id,
    number,
    service_state,
    state: buildState(service_state),
    commit: commit ? commit.toLowerCase() : null,
    branch: str(o.branch, 300),
    message: str(o.message, 1000),
    web_url: str(o.web_url),
    created_at: time(o.created_at),
    started_at: time(o.started_at),
    finished_at: time(o.finished_at),
    meta_data: md,
    rebuilt_from: str(obj(o.rebuilt_from)?.id, 100),
    org: orgFromUrl(url) ?? orgFromUrl(textOrNull(o.web_url)) ?? pipeline?.org ?? null,
    pipeline: pipe,
  };
}

export function normalizeJob(j: Json | undefined): NormJob | null {
  const o = obj(j);
  const id = str(o?.id, 100);

  if (!o || !id) return null;
  const exit = isInteger(o.exit_status) ? o.exit_status : null;
  const service_state = str(o.state, 40) ?? "pending";

  return {
    external_id: id,
    name: str(o.name, 300) ?? str(o.label, 300),
    step_key: str(o.step_key, 200),
    type: str(o.type, 40) ?? "script",
    service_state,
    state: jobState(service_state, exit),
    exit_status: exit,
    soft_failed: o.soft_failed === true,
    retried: o.retried === true,
    web_url: str(o.web_url),
    created_at: time(o.created_at),
    started_at: time(o.started_at),
    finished_at: time(o.finished_at),
  };
}

/** A build's annotation (REST: list annotations). `body_html` is the pipeline's HTML: sanitise it before showing it. */
export interface Annotation {
  id: string | null;
  context: string | null;
  style: string | null;
  body_html: string;
  created_at: string | null;
  updated_at: string | null;
}

/** A build's artifact (REST: list artifacts). */
export interface Artifact {
  id: string | null;
  job: string | null;
  path: string | null;
  filename: string | null;
  dirname: string | null;
  mime_type: string | null;
  size: number | null;
  sha1sum: string | null;
  state: string | null;
}

/** A pipeline's details (REST: get a pipeline). `configuration` is its YAML. */
export interface PipelineDetails {
  configuration: string | null;
  name: string | null;
  web_url: string | null;
  default_branch: string | null;
}

/** The objects of a JSON list; nothing when it is not a list. */
const objects = (v: Json | null): JsonObject[] => (Array.isArray(v) ? v.filter(isRecord) : []);

export function decodeAnnotations(v: Json | null): Annotation[] {
  return objects(v).map((a) => ({
    id: textOrNull(a.id), context: textOrNull(a.context), style: textOrNull(a.style), body_html: textOrNull(a.body_html) ?? "",
    created_at: textOrNull(a.created_at), updated_at: textOrNull(a.updated_at),
  }));
}

export function decodeArtifacts(v: Json | null): Artifact[] {
  return objects(v).map((a) => ({
    id: textOrNull(a.id), job: textOrNull(a.job_id), path: textOrNull(a.path), filename: textOrNull(a.filename), dirname: textOrNull(a.dirname),
    mime_type: textOrNull(a.mime_type), size: isWholeNumber(a.file_size) ? a.file_size : null, sha1sum: textOrNull(a.sha1sum), state: textOrNull(a.state),
  }));
}

export function decodePipelineDetails(v: Json | null): PipelineDetails {
  const o = obj(v ?? undefined);

  return { configuration: textOrNull(o?.configuration), name: textOrNull(o?.name), web_url: textOrNull(o?.web_url), default_branch: textOrNull(o?.default_branch) };
}

/** The `message` of an error answer, else null. */
export function errorMessage(v: Json | null): string | null {
  return textOrNull(obj(v ?? undefined)?.message);
}

// ── A job's check (a job keyed `ci` is the check `ci`) ──────────────────────

/** Job types that report a check: commands and triggered builds. Waits and blocks do not. */
export const CHECK_TYPES = new Set(["script", "trigger"]);

export function duration(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;

  return Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
}

export function humanDuration(s: number | null): string {
  if (s === null) return "";

  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);

  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/**
 * The check a job reports, GitHub's states: a skipped job passes (a step
 * that chose not to run), a job that never ran because something before it
 * failed ("broken") or that no agent took ("expired") does not.
 */
/** The status a job's check writes. */
export interface JobCheck {
  state: StatusRecord["state"];
  description: string;
}

export function jobCheck(j: NormJob, buildNumber: number): JobCheck {
  const n = `#${buildNumber}`;
  const exit = j.exit_status === null ? "" : `, exit status ${j.exit_status}`;
  const took = humanDuration(duration(j.started_at, j.finished_at));

  switch (j.service_state) {
    case "broken":
      return { state: "error", description: `${n} not run` };
    case "expired":
      return { state: "error", description: `${n} expired: no agent took it` };
    case "timed_out":
      return { state: "failure", description: `${n} timed out` };
  }

  switch (j.state) {
    case "passed":
      return { state: "success", description: `${n} passed${took ? ` in ${took}` : ""}` };
    case "failed":
      return j.soft_failed ? { state: "success", description: `${n} soft failed${exit}` } : { state: "failure", description: `${n} failed${exit}` };
    case "canceled":
      return { state: "error", description: `${n} canceled` };
    case "skipped":
      return { state: "success", description: `${n} skipped` };
    default:
      return { state: "pending", description: `${n} ${j.state}` };
  }
}

// ── Webhook verification ────────────────────────────────────────────────────

const enc = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (equal lengths compared in full). */
export function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;

  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);

  return d === 0;
}

export async function signBody(secret: string, ts: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${body}`)));
}

export type WebhookAuth = { ok: true; ts: number | null } | { ok: false; reason: string };

/** X-Buildkite-Signature when present (and then required to be right), else X-Buildkite-Token. */
export async function verifyWebhook(secret: string, h: { token: string | null; signature: string | null }, body: string, nowS: number): Promise<WebhookAuth> {
  if (h.signature) {
    // "timestamp=<unix s>,signature=<hex>": each part is a name, "=", and a value.
    const parts = new Map(
      h.signature.split(",").map((part) => {
        const i = part.indexOf("=");

        return i < 0 ? [part.trim(), ""] : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
      }),
    );

    const ts = Number(parts.get("timestamp"));
    const sig = parts.get("signature") ?? "";

    if (!Number.isSafeInteger(ts) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: "malformed X-Buildkite-Signature" };

    if (Math.abs(nowS - ts) > SIGNATURE_MAX_AGE_S) return { ok: false, reason: "X-Buildkite-Signature is older than 5 minutes" };

    if (!same(await signBody(secret, ts, body), sig)) return { ok: false, reason: "X-Buildkite-Signature does not match" };

    return { ok: true, ts };
  }

  if (h.token) return same(h.token, secret) ? { ok: true, ts: null } : { ok: false, reason: "X-Buildkite-Token does not match" };

  return { ok: false, reason: "no X-Buildkite-Signature or X-Buildkite-Token" };
}

// ── REST ────────────────────────────────────────────────────────────────────

export interface BkTarget {
  organization: string;
  /** Tests only: a stand-in for api.buildkite.com on this machine. */
  api_base: string | null;
}

export function restUrl(t: BkTarget, path: string): string {
  return `${t.api_base ?? BUILDKITE_API}/v2/organizations/${encodeURIComponent(t.organization)}${path}`;
}

export const p = encodeURIComponent;

/** How long Buildkite says to wait, from a 429 or a spent RateLimit-*-Remaining; null when it is fine. */
export function rateWaitMs(res: Response): number | null {
  const reset = Math.max(Number(res.headers.get("ratelimit-reset") ?? 0) || 0, Number(res.headers.get("ratelimit-user-reset") ?? 0) || 0);
  const spent = res.headers.get("ratelimit-remaining") === "0" || res.headers.get("ratelimit-user-remaining") === "0";

  if (res.status === 429 || spent) return Math.max(1, reset || 60) * 1000;

  return null;
}
