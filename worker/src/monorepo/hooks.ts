// Hooks out: the signed JSON POST (`web`) and Buildkite's create-build call
// (`buildkite`). Payloads are stored without any token; each attempt mints a
// fresh 30-minute read token for the one repo.

import type { Env } from "../env";
import { redact } from "../http";
import { deliveryReadToken } from "./artifacts";
import { ZERO } from "./names";
import type { RepoEvent } from "./types";

export const RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 1_800_000];
const TIMEOUT_MS = 10_000;

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

/** The stored payload: the round 3 body minus the token, which is added per attempt. */
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
export async function attempt(env: Env, hook: HookRow, deliveryId: string, artifactsName: string, p: StoredPayload): Promise<AttemptResult> {
  try {
    const read = await deliveryReadToken(env, artifactsName);
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
