// Hooks out: the signed JSON POST (`web`) and Buildkite's create-build call
// (`buildkite`), sent by the HooksDrain entrypoint (C9, C25-LIVE-HOME.md step 3).
//
// The monorepo object writes each delivery row in the same step as the change
// and hands due rows at once to HooksDrain by RPC (hooks-out.ts). HooksDrain
// adds a read token for the one repo (web: 30 minutes, cached per repo for 25;
// Buildkite: 25 hours, cached for 1, so Retry in Buildkite can still clone a
// day later) and a status token for the one commit (ci/statustoken.ts), POSTs,
// and answers each result; the object records it and retries a failure after
// 10 s, 60 s, 5 min and 30 min, then marks the delivery dead. Deliveries are
// at least once and unordered: payloads carry `seq`, so a receiver can drop
// repeats. Payloads are stored without any token.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env";
import { redact } from "../http";
import { isInteger, isRecord, isText, isTextList, parseJson, type Json } from "../parse";
import { note, timed } from "../timing";
import type { CancelJob, CancelResult, HookJob, HookResult } from "./hooks-out";
import type { HookEvent } from "./types";
import { deliveryReadToken, withRepo } from "./artifacts";
import { CI_READ_REUSE_MS, CI_READ_TTL_S, pandoBuildEnv } from "../ci/buildkite";
import { mintStatusToken, type StatusClaims } from "../ci/statustoken";
import { commitReader, compareWith } from "./graph";
import { DEFAULT_BRANCH, ZERO } from "./names";
import type { RepoEvent } from "./types";
import { pool } from "./views";

/** Retry delays in seconds; attempts = 1 + this many (owner limit: 5 tries over about 36 minutes). */
export const RETRY_DELAYS_S = [10, 60, 300, 1800];

const TIMEOUT_MS = 10_000;

/** A read token is reused for this long (it lives 30 minutes, so a receiver gets at least 5). */
const READ_TOKEN_REUSE_MS = 25 * 60_000;

const readTokens = new Map<string, { token: string; expiresAt: string; at: number }>();

/** A read token for one repo: `ci` (Buildkite) lives CI_READ_TTL_S, `web` 30 minutes. Reused per isolate. */
export async function readToken(env: Env, artifactsName: string, kind: "web" | "ci" = "web"): Promise<{ token: string; expiresAt: string }> {
  const key = `${kind}\n${artifactsName}`;
  const hit = readTokens.get(key);

  if (hit && Date.now() - hit.at < (kind === "ci" ? CI_READ_REUSE_MS : READ_TOKEN_REUSE_MS)) return hit;
  const t = await deliveryReadToken(env, artifactsName, kind === "ci" ? CI_READ_TTL_S : 1800);

  if (readTokens.size > 5000) readTokens.clear();
  readTokens.set(key, { ...t, at: Date.now() });

  return t;
}

/** A hook's stored config: Buildkite's organization and pipeline (and a test api_url), or a web hook's own app. */
interface HookConfig {
  organization: string | null;
  pipeline: string | null;
  api_url: string | null;
  app: string | null;
}

/** The hook's config, read from its stored JSON (a field that is missing or not text reads as null). */
function hookConfig(h: HookRow): HookConfig {
  const c = h.config ? parseJson(h.config) : null;
  const text = (v: Json | undefined) => (isText(v) ? v : null);

  if (!isRecord(c)) return { organization: null, pipeline: null, api_url: null, app: null };

  return { organization: text(c.organization), pipeline: text(c.pipeline), api_url: text(c.api_url), app: text(c.app) };
}

/** The events a hook can take. */
export const EVENTS: HookEvent[] = ["push", "branch.opened", "merged", "tag"];

/** One of them: a request's, or a stored hook's read back from its JSON column. */
export function isHookEvent(v: Json): v is HookEvent {
  return v === "push" || v === "branch.opened" || v === "merged" || v === "tag";
}

/** What a CI builds: one commit, on one branch. */
export interface BuildTarget {
  commit: string;
  branch: string;
}

/**
 * The commit and branch a CI builds for an event: a merge builds main's new
 * merge commit on main (the commit people get), never the branch head again;
 * everything else builds its head on its own branch (a tag: its commit, on the tag's name).
 */
export function buildTarget(p: RepoEvent): BuildTarget {
  if (p.event === "merged" && p.merge_commit) return { commit: p.merge_commit, branch: p.main_branch ?? DEFAULT_BRANCH };

  return { commit: p.head, branch: p.branch };
}

function hookEvents(h: HookRow): HookEvent[] {
  const events = parseJson(h.events);

  return isTextList(events) ? events.filter(isHookEvent) : [];
}

/** The delivery's status token, or null when PANDO_STATUS_SECRET is not set or there is no commit. */
async function statusToken(env: Env, hook: HookRow, p: StoredPayload): Promise<{ token: string; expires_at: string } | null> {
  // A Buildkite build reports on the commit it builds (a merge: main's merge commit); a web hook's token is for the head it is sent.
  const sha = hook.type === "buildkite" ? buildTarget(p).commit : p.head;

  if (!env.PANDO_STATUS_SECRET || !p.monorepo_id || !/^[0-9a-f]{40}$/.test(sha)) return null;
  const app = hook.type === "buildkite" ? "buildkite" : hookConfig(hook).app;
  const claims: Omit<StatusClaims, "x"> = { m: p.monorepo_id, r: p.repo, s: sha, a: app, h: hook.id };

  return mintStatusToken(env.PANDO_STATUS_SECRET, claims);
}

/**
 * The hooks drain: the monorepo object's outbox calls this by RPC with due
 * deliveries (one per call today), sent 6 at once. Answers each try's result,
 * in order; never throws for a receiver's failure.
 */
export class HooksDrain extends WorkerEntrypoint<Env> {
  async run(jobs: HookJob[]): Promise<HookResult[]> {
    const out: HookResult[] = jobs.map(() => ({ ok: false, code: null, error: "not sent", ms: 0 }));
    await pool(jobs.map((_, i) => i), 6, async (i) => {
      const j = jobs[i];
      out[i] = await timed(
        "drain",
        { route: "hooks.delivery", monorepo_id: j.monorepo, delivery: j.delivery_id, attempt: j.attempt, delivery_wait_ms: Math.max(0, Date.now() - j.due) },
        () => deliverOne(this.env, j),
      ).catch((err) => ({ ok: false, code: null, error: redact(err instanceof Error ? err.message : String(err)).slice(0, 300), ms: 0 }));
    });

    return out;
  }

  /** Cancel superseded builds (hooks-out.ts sendCancels), 6 at once; never throws. */
  async cancel(jobs: CancelJob[]): Promise<CancelResult[]> {
    const out: CancelResult[] = jobs.map(() => ({ outcome: "failed", error: "not sent" }));
    await pool(jobs.map((_, i) => i), 6, async (i) => {
      out[i] = await cancelBuild(this.env, jobs[i].hook, jobs[i].number);
    });

    return out;
  }
}

/**
 * Buildkite's create-build URL for a hook: its pipeline's builds (a test
 * api_url stands in for it); a build's cancel is `<this>/<number>/cancel`.
 */
function buildsUrl(hook: HookRow): string {
  const config = hookConfig(hook);

  return (
    config.api_url ??
    `https://api.buildkite.com/v2/organizations/${encodeURIComponent(config.organization ?? "")}/pipelines/${encodeURIComponent(config.pipeline ?? "")}/builds`
  );
}

/**
 * Cancel one build Pando started (Buildkite REST: PUT .../builds/{number}/cancel,
 * scope write_builds). Buildkite cancels a build that is scheduled, running or
 * failing, and answers 422 for any other: it had finished, which is no failure.
 */
export async function cancelBuild(env: Env, hook: HookRow, number: number): Promise<CancelResult> {
  if (!env.BUILDKITE_API_TOKEN) return { outcome: "failed", error: "the Worker secret BUILDKITE_API_TOKEN is not set" };

  try {
    const res = await fetch(`${buildsUrl(hook)}/${number}/cancel`, {
      method: "PUT",
      headers: { authorization: `Bearer ${env.BUILDKITE_API_TOKEN}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = (await res.text()).slice(0, 300);

    if (res.ok) return { outcome: "canceled", error: null };

    if (res.status === 422) return { outcome: "finished", error: null };

    return { outcome: "failed", error: `Buildkite answered ${res.status}: ${redact(text)}` };
  } catch (err) {
    return { outcome: "failed", error: redact(err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}

async function deliverOne(env: Env, j: HookJob): Promise<HookResult> {
  const p = j.payload;

  if (p.base === null && p.head !== ZERO && p.event !== "merged" && j.main) {
    // The merge base with main, computed here (the object makes no Artifacts reads).
    try {
      p.base = (await withRepo(env, j.artifacts_name, (repo) => compareWith(commitReader(repo), j.main!, p.head))).mergeBase;
    } catch {
      p.base = null;
    }
  }

  note({ repo: p.repo, event: p.event, hook_type: j.hook.type, seq: p.seq ?? null });
  const t0 = Date.now();
  const r = await attempt(env, j.hook, j.delivery_id, p, (kind) => readToken(env, j.artifacts_name, kind), j.due);
  note({ receiver_ms: Date.now() - t0, receiver_code: r.code, delivered: r.ok });

  return { ...r, ms: Date.now() - t0 };
}

/** A hooks row (a type, not an interface, so SQLite's typed exec can return it). */
export type HookRow = {
  id: string;
  repo: string;
  type: "web" | "buildkite";
  url: string | null;
  secret: string | null;
  events: string; // JSON array
  config: string | null; // JSON
  active: number;
  created_at: string;
  created_by: string;
};

/** The stored payload: the round 3 body minus the token, which is added per attempt. `seq` is the stream's. */
export interface StoredPayload extends RepoEvent {
  occurred_at: string;
  /** owner/name when the delivery was made (rows from before namespaces: the old name). */
  monorepo: string;
  /** The permanent id: a stable key for receivers across renames. */
  monorepo_id?: string;
  /** A plain repo: its git URL is /owner/name.git. */
  plain?: boolean;
  origin: string;
  /** A build a merge asked for (the repo's CI policy is on_merge): Buildkite only. */
  for_merge?: boolean;
}

export function hookView(h: HookRow) {
  const config = hookConfig(h);

  return {
    id: h.id,
    type: h.type,
    url: h.url,
    events: hookEvents(h),
    // A Buildkite hook is made with both (api.ts); a stored config missing one shows none.
    buildkite: h.type === "buildkite" && config.organization !== null && config.pipeline !== null ? { organization: config.organization, pipeline: config.pipeline } : null,
    // The CI service its status tokens stamp: buildkite, a web hook's own app, or null.
    app: h.type === "buildkite" ? "buildkite" : config.app,
    active: h.active === 1,
    created_at: h.created_at,
    created_by: h.created_by,
  };
}

/**
 * The address a receiver clones from and reports to: the one the change came in on, except a
 * `.internal` host (a cloud agent's gateway, http://pando.internal, reachable only from its
 * sandbox), where it is PUBLIC_ORIGIN, the Worker's public address. Anything else, no origin
 * included, stays as it was: a local server never sends CI to the public address.
 */
function hookOrigin(origin: string, publicOrigin: string | undefined): string {
  if (!publicOrigin || !URL.canParse(origin)) return origin;

  return new URL(origin).hostname.endsWith(".internal") ? publicOrigin.replace(/\/+$/, "") : origin;
}

function urls(env: Env, p: StoredPayload, statusSha = p.head) {
  const origin = hookOrigin(p.origin, env.PUBLIC_ORIGIN);
  const repoBase = `${origin}/v1/monorepos/${p.monorepo}/repos/${p.repo}`;

  return {
    clone_url: p.plain ? `${origin}/${p.monorepo}.git` : `${origin}/${p.monorepo}/${p.repo}.git`,
    diff_url: `${repoBase}/branches/${encodeURIComponent(p.branch)}/diff?format=patch`,
    status_url: `${repoBase}/statuses/${statusSha}`,
  };
}

export async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));

  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AttemptResult {
  ok: boolean;
  code: number | null;
  error: string | null;
  /** The build Buildkite made (its number in the pipeline), so a newer push can cancel it. */
  build_number?: number | null;
}

/** One delivery attempt. Never throws; never logs the token. */
export async function attempt(env: Env, hook: HookRow, deliveryId: string, p: StoredPayload, token: (kind: "web" | "ci") => Promise<{ token: string; expiresAt: string }>, due?: number): Promise<AttemptResult> {
  try {
    const read = await token(hook.type === "buildkite" ? "ci" : "web");
    const status = await statusToken(env, hook, p);
    const target = buildTarget(p);
    const u = urls(env, p, hook.type === "buildkite" ? target.commit : p.head);

    if (due !== undefined) note({ post_wait_ms: Math.max(0, Date.now() - due) }); // from the row being due to the POST leaving

    if (hook.type === "web") {
      const { origin: _origin, plain: _plain, ...rest } = p;

      const body = JSON.stringify({
        ...rest,
        delivery_id: deliveryId,
        ...u,
        read_token: read.token,
        read_token_expires_at: read.expiresAt,
        // Left out of the JSON when there is no status token (stringify drops undefined).
        status_token: status?.token,
        status_token_expires_at: status?.expires_at,
      });

      const signature = await hmacHex(hook.secret ?? "", body);

      const res = await fetch(hook.url!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Pando-Hooks/1",
          "x-pando-event": p.event,
          "x-pando-delivery": deliveryId,
          "x-pando-signature-256": `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      await res.body?.cancel();

      return { ok: res.ok, code: res.status, error: res.ok ? null : `answered ${res.status}` };
    }

    // buildkite
    if (!env.BUILDKITE_API_TOKEN) return { ok: false, code: null, error: "the Worker secret BUILDKITE_API_TOKEN is not set" };

    const url = buildsUrl(hook);

    const message =
      p.event === "merged" ? `Merge ${p.branch}${p.title ? `: ${p.title}` : ""}`
      : p.for_merge ? `Checks for merging ${p.branch}${p.title ? `: ${p.title}` : ""}`
      : (p.title ?? `${p.event} ${p.branch}`);

    const body = JSON.stringify({
      commit: target.commit,
      branch: target.branch,
      message,
      author: { name: p.pusher ?? "" },
      env: pandoBuildEnv({
        clone_url: u.clone_url, read_token: read.token, status_url: u.status_url, status_token: status?.token ?? null,
        monorepo: p.monorepo, repo: p.repo, branch: target.branch, head: target.commit, delivery: deliveryId, seq: p.seq ?? null,
      }),
      // How Pando's Buildkite webhook (ci/) maps the build back: this monorepo, this repo, this delivery.
      meta_data: { pando_delivery: deliveryId, pando_monorepo: p.monorepo_id ?? "", pando_repo: p.repo },
    });

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.BUILDKITE_API_TOKEN}` },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = await res.text();

    if (!res.ok) return { ok: false, code: res.status, error: `Buildkite answered ${res.status}: ${redact(text.slice(0, 300))}` };
    // The build's number, kept so a newer push to the branch can cancel it.
    const made = parseJson(text);

    return { ok: true, code: res.status, error: null, build_number: isRecord(made) && isInteger(made.number) ? made.number : null };
  } catch (err) {
    return { ok: false, code: null, error: redact(err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}

/** Which events a hook receives, and whether this event applies. */
export function wants(hook: HookRow, e: RepoEvent): boolean {
  if (hook.active !== 1) return false;

  if (!hookEvents(hook).includes(e.event)) return false;

  // A build needs a commit: no Buildkite build for a deleted branch.
  if (hook.type === "buildkite" && e.head === ZERO) return false;

  return true;
}

/** Tests only (HOOKS_TEST=1, the bootstrap secret): POST /v1/_hooks/test {monorepo, crash}. */
export async function hooksTestRoute(request: Request, env: Env): Promise<Response> {
  if (env.HOOKS_TEST !== "1") return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
  const { credential } = await import("../http");
  const { isBootstrap } = await import("./session");

  if (!(await isBootstrap(env, credential(request)))) return Response.json({ error: { code: "unauthorized", message: "the bootstrap secret only" } }, { status: 401 });
  const b = request.method === "POST" ? await request.json<Json>().catch(() => null) : null;
  const monorepo = isRecord(b) && isText(b.monorepo) ? b.monorepo : null;

  if (!monorepo) return Response.json({ error: { code: "bad_request", message: "monorepo (its id)" } }, { status: 400 });
  const crash = isRecord(b) && (b.crash === true || b.crash === false) ? b.crash : undefined;

  return Response.json(await env.MONOREPO.getByName(monorepo).testHooksOutbox(crash === undefined ? {} : { crash }));
}
