// Pando tokens: made here, stored as SHA-256 hashes in the monorepo object.

import type { Env } from "../env";
import { timedStub } from "../timing";

/** The monorepo object, by the monorepo's id; its calls count as object time on the request's pando.timing line. */
export function monorepoStub(env: Env, monorepoId: string) {
  return timedStub(env.MONOREPO.getByName(monorepoId));
}

export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(20));

  return "pando_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));

  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of the bootstrap secret. */
export async function isBootstrap(env: Env, secret: string | null): Promise<boolean> {
  if (!secret || !env.PANDO_BOOTSTRAP) return false;
  const [a, b] = await Promise.all([hashToken(secret), hashToken(env.PANDO_BOOTSTRAP)]);
  let diff = 0;

  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);

  return diff === 0;
}

// ── Repo records, cached per isolate (C3) ───────────────────────────────────

const REPO_CACHE_MS = 15_000;

const repoCache = new Map<string, { at: number; rec: import("./types").RepoRecord }>();

/**
 * A repo's record, cached for 15 s per isolate (found ones only), so the door
 * and the API do not ask the monorepo object on every request. A recreated
 * repo has a new created_at, which keys its tokens, so a stale record only
 * costs one refused token and a retry.
 */
export async function cachedRepo(env: Env, monorepoId: string, name: string | null): Promise<import("./types").RepoRecord | null> {
  // name null: a plain repo's one repo (its git URL has no repo name).
  const key = `${monorepoId}/${name ?? "."}`;
  const hit = repoCache.get(key);

  if (hit && Date.now() - hit.at < REPO_CACHE_MS) return hit.rec;
  const stub = monorepoStub(env, monorepoId);
  const rec = name === null ? ((await stub.listRepos()).find((r) => r.path === ".") ?? null) : await stub.getRepo(name);

  if (rec) {
    if (repoCache.size > 10_000) repoCache.clear();
    repoCache.set(key, { at: Date.now(), rec });
  } else repoCache.delete(key);

  return rec;
}

/** Forget a monorepo's cached records (it was deleted here). */
export function forgetRepos(monorepoId: string): void {
  for (const k of repoCache.keys()) if (k.startsWith(`${monorepoId}/`)) repoCache.delete(k);
}
