// Hooks out: the signed JSON POST (`web`) and Buildkite's create-build call
// (`buildkite`), delivered from the pando-hooks queue (C9).
//
// The monorepo object writes each delivery row in the same step as the change
// and sends its id to the queue. This consumer reads the row, adds a read
// token for the one repo (30 minutes, cached per repo for 25), POSTs, and
// reports the attempt to the object. A failure is retried by the queue after
// 10 s, 60 s, 5 min and 30 min; then the message goes to pando-hooks-dlq,
// whose consumer marks the delivery dead. Deliveries are at least once and
// unordered: payloads carry `seq`, so a receiver can drop repeats.
// Payloads are stored without any token.

import type { Env } from "../env";
import { redact } from "../http";
import { note, timed, timedStub } from "../timing";
import { deliveryReadToken, withRepo } from "./artifacts";
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

export interface DeliveryMessage {
  monorepo: string;
  delivery_id: string;
}

function retryDelays(env: Env): number[] {
  const v = env.HOOK_RETRY_DELAYS?.split(",").map((x) => Number(x.trim()));
  return v && v.length && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 43_200) ? v : RETRY_DELAYS_S;
}

async function readToken(env: Env, artifactsName: string): Promise<{ token: string; expiresAt: string }> {
  const hit = readTokens.get(artifactsName);
  if (hit && Date.now() - hit.at < READ_TOKEN_REUSE_MS) return hit;
  const t = await deliveryReadToken(env, artifactsName);
  if (readTokens.size > 5000) readTokens.clear();
  readTokens.set(artifactsName, { ...t, at: Date.now() });
  return t;
}

/** The pando-hooks consumer: deliveries 6 at a time. */
export async function handleDeliveries(batch: MessageBatch<DeliveryMessage>, env: Env): Promise<void> {
  const delays = retryDelays(env);
  await pool([...batch.messages], 6, (msg) =>
    timed("queue", { route: "hooks.delivery", monorepo: msg.body.monorepo, delivery: msg.body.delivery_id, attempt: msg.attempts, queue_delay_ms: Math.max(0, Date.now() - msg.timestamp.getTime()) }, () => deliverOne(env, msg, delays)),
  );
}

async function deliverOne(env: Env, msg: Message<DeliveryMessage>, delays: number[]): Promise<void> {
  {
    const stub = timedStub(env.MONOREPO.getByName(msg.body.monorepo));
    let d;
    try {
      d = await stub.deliveryToSend(msg.body.delivery_id);
    } catch (err) {
      msg.retry({ delaySeconds: 5 });
      return;
    }
    if (!d || d.status === "delivered") {
      msg.ack(); // gone, or already delivered (a repeat of the same message)
      return;
    }
    const p = d.payload;
    if (p.base === null && p.head !== ZERO && p.event !== "merged") {
      // The merge base with main, computed here (the object makes no Artifacts reads).
      try {
        const main = await stub.currentMain(p.repo);
        if (main) p.base = (await withRepo(env, d.artifacts_name, (repo) => compareWith(commitReader(repo), main, p.head))).mergeBase;
      } catch {
        p.base = null;
      }
    }
    note({ repo: p.repo, event: p.event, hook_type: d.hook.type, seq: p.seq ?? null });
    const t0 = Date.now();
    const r = await attempt(env, d.hook, msg.body.delivery_id, p, () => readToken(env, d.artifacts_name));
    note({ receiver_ms: Date.now() - t0, receiver_code: r.code, delivered: r.ok });
    const n = msg.attempts; // 1 on the first try
    const retryIn = r.ok ? null : (delays[n - 1] ?? null);
    await stub.recordAttempt(msg.body.delivery_id, { ...r, ms: Date.now() - t0 }, n, retryIn).catch(() => {});
    if (r.ok) msg.ack();
    else if (retryIn !== null) msg.retry({ delaySeconds: retryIn });
    else msg.retry(); // out of retries: the queue moves it to pando-hooks-dlq
  }
}

/** The pando-hooks-dlq consumer: mark the deliveries dead (visible in the API; redeliver to try again). */
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
  monorepo: string;
  origin: string;
}

export function hookView(h: HookRow) {
  const config = h.config ? JSON.parse(h.config) : null;
  return {
    id: h.id,
    type: h.type,
    url: h.url,
    events: JSON.parse(h.events) as string[],
    buildkite: h.type === "buildkite" ? { organization: config?.organization, pipeline: config?.pipeline } : null,
    active: h.active === 1,
    created_at: h.created_at,
    created_by: h.created_by,
  };
}

function urls(p: StoredPayload) {
  const repoBase = `${p.origin}/v1/monorepos/${p.monorepo}/repos/${p.repo}`;
  return {
    clone_url: `${p.origin}/${p.monorepo}/${p.repo}.git`,
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
export async function attempt(env: Env, hook: HookRow, deliveryId: string, p: StoredPayload, token: () => Promise<{ token: string; expiresAt: string }>): Promise<AttemptResult> {
  try {
    const read = await token();
    const u = urls(p);
    if (hook.type === "web") {
      const { origin: _origin, ...rest } = p;
      const body = JSON.stringify({
        ...rest,
        delivery_id: deliveryId,
        ...u,
        read_token: read.token,
        read_token_expires_at: read.expiresAt,
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
      env: {
        PANDO_CLONE_URL: u.clone_url,
        PANDO_READ_TOKEN: read.token,
        PANDO_STATUS_URL: u.status_url,
        PANDO_MONOREPO: p.monorepo,
        PANDO_REPO: p.repo,
        PANDO_BRANCH: p.branch,
        PANDO_HEAD: p.head,
        PANDO_DELIVERY: deliveryId,
        PANDO_SEQ: String(p.seq ?? ""),
      },
      meta_data: { pando_delivery: deliveryId },
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
