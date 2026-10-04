// Who is calling: a credential (Bearer, or the git Basic password) resolved
// by accounts on D1 (store.ts), with the caller's role in one monorepo.

import type { Env } from "../env";
import { timedStub } from "../timing";
import { credential, HttpError } from "../http";
import { hashToken } from "../monorepo/session";
import type { Identity } from "../monorepo/types";
import { Accounts, confirmed, type Auth, type MonorepoRef } from "./store";

const CACHE_MS = 15_000;

/** An unknown credential is answered from cache this long (bad tokens stop reaching the database). */
const UNKNOWN_MS = 5_000;

const cache = new Map<string, { at: number; auth: AuthResult | null }>();

export type AuthResult = Auth;

let copiedHere = false;

/**
 * C8's one-time copy of the AccountsObject's rows into D1, awaited before an
 * isolate's first query (the object answers at once after the first time).
 * A flag, not a shared promise: a promise must not cross requests. Goes after
 * launch with the object.
 */
async function copied(env: Env): Promise<void> {
  if (copiedHere) return;
  await timedStub(env.ACCOUNTS.getByName("accounts")).copyToD1();
  copiedHere = true;
}

export function accounts(env: Env): Accounts {
  return new Accounts(env.ACCOUNTS_DB, () => copied(env));
}

/**
 * Whether an answer may be cached. Only successes are: a known credential, and
 * when a monorepo was asked about, one that exists and has the caller as a
 * member. A miss is never cached, because another isolate may create the
 * monorepo or add the member a moment later and this isolate would keep
 * answering 404 or 403. A revoked credential or removed member is therefore
 * seen within CACHE_MS plus D1's replica lag.
 */
export const cacheable = confirmed;

/** The caller, or null for an unknown or revoked credential. Successes are cached briefly per isolate. */
export async function authenticate(env: Env, secret: string, monorepo: MonorepoRef | null): Promise<AuthResult | null> {
  const hash = await hashToken(secret);
  const key = `${hash}\n${monorepo ? `${monorepo.owner}/${monorepo.name}` : ""}`;
  const hit = cache.get(key);

  if (hit && Date.now() - hit.at < (hit.auth ? CACHE_MS : UNKNOWN_MS)) return hit.auth;
  const auth = await accounts(env).authenticate(hash, monorepo);

  if (cacheable(auth, monorepo) || auth === null) {
    // Successes for CACHE_MS; an unknown credential for UNKNOWN_MS (C3). Never a
    // missing monorepo or a non-member: another isolate may fix that any moment.
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
  // Bearer only (the git door, and callers that never take a browser session).
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
    credential_kind: a.credential.kind,
    role: a.role ?? "member",
  };
}

// ── Browser sessions: the cookie ────────────────────────────────────────────

/** The browser session cookie. Host-only, HttpOnly, Secure, SameSite=Lax; set by the sign-in callback. */
export const SESSION_COOKIE = "__Host-pando_session";

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");

  if (!header) return null;

  for (const part of header.split(";")) {
    const i = part.indexOf("=");

    if (i < 0) continue;

    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }

  return null;
}

/** The Worker's own origin, as a browser sends it in Origin. */
export function sameOrigin(req: Request): boolean {
  return req.headers.get("origin") === new URL(req.url).origin;
}

/**
 * The caller of a /v1 request: a Bearer credential (or none), else the
 * browser session cookie. With the cookie, a write or a WebSocket upgrade must
 * come from Pando's own origin (other Workers on the same workers.dev
 * subdomain are same-site, so SameSite alone does not stop them). A browser
 * session works only as the cookie, and the cookie only for a browser session.
 */
export async function authenticateRequest(env: Env, req: Request, monorepo: MonorepoRef | null): Promise<AuthResult | null> {
  const bearer = credential(req);

  if (bearer) {
    const auth = await authenticate(env, bearer, monorepo);

    return auth && auth.credential.kind !== "browser" ? auth : null;
  }

  const cookie = readCookie(req, SESSION_COOKIE);

  if (!cookie) throw new HttpError(401, "unauthorized", "send Authorization: Bearer <credential>, or sign in");
  const writes = !["GET", "HEAD"].includes(req.method) || req.headers.get("upgrade")?.toLowerCase() === "websocket";

  if (writes && !sameOrigin(req)) throw new HttpError(403, "bad_origin", "a signed-in browser may only write from Pando's own pages");
  const auth = await authenticate(env, cookie, monorepo);

  return auth && auth.credential.kind === "browser" ? auth : null;
}
