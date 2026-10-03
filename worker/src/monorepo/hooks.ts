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
import { note, timed, timedStub } from "../timing";
import type { HookJob, HookResult } from "./hooks-out";
import { deliveryReadToken, withRepo } from "./artifacts";
import { CI_READ_REUSE_MS, CI_READ_TTL_S, pandoBuildEnv } from "../ci/buildkite";
import { mintStatusToken, type StatusClaims } from "../ci/statustoken";
import { commitReader, compareWith } from "./graph";
import { ZERO } from "./names";
import type { RepoEvent } from "./types";
import { pool } from "./views";

/** Retry delays in seconds; attempts = 1 + this many (owner limit: 5 tries over about 36 minutes). */
export const RETRY_DELAYS_S = [10, 60, 300, 1800];
const TIMEOUT_MS = 10_000;
/** A read token is reused for this long (it lives 30 minutes, so a receiver gets at least 5). */
const READ_TOKEN_REUSE_MS = 25 * 60_000;
const readTokens = new Map<string, { token: string; expiresAt: string; at: number }>();

/** A pando-hooks message (sent before the outbox; the queue stays bound until the outbox is measured). */
export interface DeliveryMessage {
  /** The monorepo's id (for one made before namespaces, its old name). */
  monorepo: string;
  delivery_id: string;
}

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

/** The delivery's status token, or null when PANDO_STATUS_SECRET is not set or there is no commit. */
async function statusToken(env: Env, hook: HookRow, p: StoredPayload): Promise<{ token: string; expires_at: string } | null> {
  if (!env.PANDO_STATUS_SECRET || !p.monorepo_id || !/^[0-9a-f]{40}$/.test(p.head)) return null;
  const app = hook.type === "buildkite" ? "buildkite" : ((JSON.parse(hook.config ?? "{}") as { app?: string }).app ?? null);
  const claims: Omit<StatusClaims, "x"> = { m: p.monorepo_id, r: p.repo, s: p.head, a: app, h: hook.id };
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

/**
 * The pando-hooks consumer, for messages sent before the outbox: the outbox
 * now sends every delivery, so a message only wakes its monorepo's outbox.
 */
export async function handleDeliveries(batch: MessageBatch<DeliveryMessage>, env: Env): Promise<void> {
  const monorepos = new Set(batch.messages.map((m) => m.body.monorepo));
  await Promise.all([...monorepos].map((m) => timedStub(env.MONOREPO.getByName(m)).sendDueDeliveries().catch(() => {})));
  batch.ackAll();
}

/** The pando-hooks-dlq consumer, for messages sent before the outbox: mark the deliveries dead. */
export async function handleDeadDeliveries(batch: MessageBatch<DeliveryMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    await env.MONOREPO.getByName(msg.body.monorepo).markDead(msg.body.delivery_id);
    msg.ack();
  }
}

export interface HookRow {
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
}

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
}

export function hookView(h: HookRow) {
  const config = h.config ? (JSON.parse(h.config) as { organization?: string; pipeline?: string; app?: string }) : null;
  return {
    id: h.id,
    type: h.type,
    url: h.url,
    events: JSON.parse(h.events) as string[],
    buildkite: h.type === "buildkite" ? { organization: config?.organization, pipeline: config?.pipeline } : null,
    // The CI service its status tokens stamp: buildkite, a web hook's own app, or null.
    app: h.type === "buildkite" ? "buildkite" : (config?.app ?? null),
    active: h.active === 1,
    created_at: h.created_at,
    created_by: h.created_by,
  };
}

function urls(p: StoredPayload) {
  const repoBase = `${p.origin}/v1/monorepos/${p.monorepo}/repos/${p.repo}`;
  return {
    clone_url: p.plain ? `${p.origin}/${p.monorepo}.git` : `${p.origin}/${p.monorepo}/${p.repo}.git`,
    diff_url: `${repoBase}/branches/${encodeURIComponent(p.branch)}/diff?format=patch`,
    status_url: `${repoBase}/statuses/${p.head}`,
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
}

/** One delivery attempt. Never throws; never logs the token. */
export async function attempt(env: Env, hook: HookRow, deliveryId: string, p: StoredPayload, token: (kind: "web" | "ci") => Promise<{ token: string; expiresAt: string }>, due?: number): Promise<AttemptResult> {
  try {
    const read = await token(hook.type === "buildkite" ? "ci" : "web");
    const status = await statusToken(env, hook, p);
    const u = urls(p);
    if (due !== undefined) note({ post_wait_ms: Math.max(0, Date.now() - due) }); // from the row being due to the POST leaving
    if (hook.type === "web") {
      const { origin: _origin, plain: _plain, ...rest } = p;
      const body = JSON.stringify({
        ...rest,
        delivery_id: deliveryId,
        ...u,
        read_token: read.token,
        read_token_expires_at: read.expiresAt,
        ...(status ? { status_token: status.token, status_token_expires_at: status.expires_at } : {}),
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
    const config = JSON.parse(hook.config ?? "{}") as { organization: string; pipeline: string; api_url?: string };
    if (!env.BUILDKITE_API_TOKEN) return { ok: false, code: null, error: "the Worker secret BUILDKITE_API_TOKEN is not set" };
    const url =
      config.api_url ??
      `https://api.buildkite.com/v2/organizations/${encodeURIComponent(config.organization)}/pipelines/${encodeURIComponent(config.pipeline)}/builds`;
    const body = JSON.stringify({
      commit: p.head,
      branch: p.branch,
      message: p.title ?? `${p.event} ${p.branch}`,
      author: { name: p.pusher },
      env: pandoBuildEnv({
        clone_url: u.clone_url, read_token: read.token, status_url: u.status_url, status_token: status?.token ?? null,
        monorepo: p.monorepo, repo: p.repo, branch: p.branch, head: p.head, delivery: deliveryId, seq: p.seq ?? null,
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
    let error: string | null = null;
    if (!res.ok) error = `Buildkite answered ${res.status}: ${redact((await res.text()).slice(0, 300))}`;
    else await res.body?.cancel();
    return { ok: res.ok, code: res.status, error };
  } catch (err) {
    return { ok: false, code: null, error: redact(err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}

/** Which events a hook receives, and whether this event applies. */
export function wants(hook: HookRow, e: RepoEvent): boolean {
  if (hook.active !== 1) return false;
  const events = JSON.parse(hook.events) as string[];
  if (!events.includes(e.event)) return false;
  // A build needs a commit: no Buildkite build for a deleted branch.
  if (hook.type === "buildkite" && e.head === ZERO) return false;
  return true;
}
