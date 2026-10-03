// Who is calling: a credential (Bearer, or the git Basic password) resolved
// by the accounts object, with the caller's role in one monorepo.

import type { Env } from "../env";
import { credential, HttpError } from "../http";
import { hashToken } from "../monorepo/session";
import type { Identity } from "../monorepo/types";
import type { Auth } from "./object";

const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; auth: AuthResult | null }>();

export type AuthResult = Auth;

export function accounts(env: Env) {
  return env.ACCOUNTS.getByName("accounts");
}

/**
 * Whether an answer may be cached. Only successes are: a known credential, and
 * when a monorepo was asked about, one that exists and has the caller as a
 * member. A miss is never cached, because another isolate may create the
 * monorepo or add the member a moment later and this isolate would keep
 * answering 404 or 403. A revoked credential or removed member is therefore
 * seen within CACHE_MS.
 */
export function cacheable(auth: Auth | null, monorepo: string | null): boolean {
  if (!auth) return false;
  if (monorepo === null) return true;
  return auth.monorepo !== null && auth.role !== null;
}

/** The caller, or null for an unknown or revoked credential. Successes are cached briefly per isolate. */
export async function authenticate(env: Env, secret: string, monorepo: string | null): Promise<AuthResult | null> {
  const hash = await hashToken(secret);
  const key = `${hash}\n${monorepo ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.auth;
  const auth = (await accounts(env).authenticate(hash, monorepo)) as AuthResult | null;
  if (cacheable(auth, monorepo)) {
    if (cache.size > 10_000) cache.clear();
    cache.set(key, { at: Date.now(), auth });
  } else {
    cache.delete(key);
  }
  return auth;
}

/** Forget cached answers, after a credential is revoked or a member changes. */
export function forgetCachedAuth(): void {
  cache.clear();
}

/** The caller's credential from the request, or 401. */
export function requireSecret(req: Request): string {
  const secret = credential(req);
  if (!secret) throw new HttpError(401, "unauthorized", "send Authorization: Bearer <credential>");
  return secret;
}

export function identityOf(a: Auth): Identity {
  return {
    login: a.user.login,
    name: a.user.name,
    email: a.user.email,
    credential_id: a.credential.id,
    credential_name: a.credential.name,
    role: a.role ?? "member",
  };
}
