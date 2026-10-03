// Pando tokens: made here, stored as SHA-256 hashes in the monorepo object.

import type { Env } from "../env";

export function monorepoStub(env: Env, monorepo: string) {
  return env.MONOREPO.getByName(monorepo);
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
