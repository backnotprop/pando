// Hooks out: the signed JSON POST (`web`) and Buildkite's create-build call
// (`buildkite`), delivered from the pando-hooks queue (C9).
//
// The monorepo object writes each delivery row in the same step as the change
// and sends its id to the queue. This consumer reads the row, adds a read
// token for the one repo (web: 30 minutes, cached per repo for 25; Buildkite:
// 25 hours, cached for 1, so Retry in Buildkite can still clone a day later)
// and a status token for the one commit (ci/statustoken.ts), POSTs, and
// reports the attempt to the object. A failure is retried by the queue after
// 10 s, 60 s, 5 min and 30 min; then the message goes to pando-hooks-dlq,
// whose consumer marks the delivery dead. Deliveries are at least once and
// unordered: payloads carry `seq`, so a receiver can drop repeats.
// Payloads are stored without any token.

import type { Env } from "../env";
import { redact } from "../http";
import { note, timed, timedStub } from "../timing";
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

export interface DeliveryMessage {
  /** The monorepo's id (for one made before namespaces, its old name). */
  monorepo: string;
  delivery_id: string;
}

function retryDelays(env: Env): number[] {
  const v = env.HOOK_RETRY_DELAYS?.split(",").map((x) => Number(x.trim()));
  return v && v.length && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 43_200) ? v : RETRY_DELAYS_S;
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

/** The pando-hooks consumer: deliveries 6 at a time. */
export async function handleDeliveries(batch: MessageBatch<DeliveryMessage>, env: Env): Promise<void> {
  const delays = retryDelays(env);
  await pool([...batch.messages], 6, (msg) =>
    timed("queue", { route: "hooks.delivery", monorepo_id: msg.body.monorepo, delivery: msg.body.delivery_id, attempt: msg.attempts, queue_delay_ms: Math.max(0, Date.now() - msg.timestamp.getTime()) }, () => deliverOne(env, msg, delays)),
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
    p.monorepo_id ??= msg.body.monorepo; // rows from before namespaces
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
    const r = await attempt(env, d.hook, msg.body.delivery_id, p, (kind) => readToken(env, d.artifacts_name, kind));
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
export async function attempt(env: Env, hook: HookRow, deliveryId: string, p: StoredPayload, token: (kind: "web" | "ci") => Promise<{ token: string; expiresAt: string }>): Promise<AttemptResult> {
  try {
    const read = await token(hook.type === "buildkite" ? "ci" : "web");
    const status = await statusToken(env, hook, p);
    const u = urls(p);
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
