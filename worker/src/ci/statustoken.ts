// PANDO_STATUS_TOKEN (FILES.md section 4): Pando mints one per hook delivery.
// It may post statuses for one commit in one repo, for 24 hours, and nothing
// else. It is HMAC-SHA256 under the Worker secret PANDO_STATUS_SECRET and is
// not stored, so verifying it is one HMAC. Rotating the secret ends every
// token at once.
//
//   pst1.<payload>.<signature>        both base64url
//   payload: {"m": monorepo id, "r": repo name, "s": sha, "a": app slug or null, "h": hook id, "x": expiry (unix seconds)}
//
// The app slug is what the status shows as its CI service (Status.app):
// `buildkite` for a Buildkite hook, a web hook's own `app`, or null.

import type { Env } from "../env";
import { HttpError } from "../http";
import { isInteger, isRecord, isText, parseJson } from "../parse";

export const STATUS_TOKEN_PREFIX = "pst1.";

/** How long a status token lives (owner limit: builds run long). */
export const STATUS_TOKEN_TTL_S = 24 * 3600;

/** An app slug: what Status.app holds and the web maps to a mark. */
export const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,38}$/;

export interface StatusClaims {
  /** The monorepo's permanent id. */
  m: string;
  /** The repo's name in URLs. */
  r: string;
  /** The commit, a full sha. */
  s: string;
  /** The app slug stamped on the status, or null (the status then names the hook). */
  a: string | null;
  /** The hook that delivered it (or `ci:<connection>` for a rebuild). */
  h: string;
  /** Expiry, unix seconds. */
  x: number;
}

/** What a verified token stamps on the status it posts. */
export interface StatusStamp {
  app: string | null;
  /** `app:<slug>`, or `hook:<hook id>` when the hook has no app. */
  creator: string;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";

  for (const b of bytes) s += String.fromCharCode(b);

  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;

  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

let keyCache: { secret: string; key: CryptoKey } | null = null;

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (keyCache?.secret === secret) return keyCache.key;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  keyCache = { secret, key };

  return key;
}

export function isStatusToken(s: string | null): boolean {
  return !!s && s.startsWith(STATUS_TOKEN_PREFIX);
}

export function stampOf(c: Pick<StatusClaims, "a" | "h">): StatusStamp {
  return { app: c.a, creator: c.a ? `app:${c.a}` : `hook:${c.h}` };
}

/** A new token. `ttlS` is for tests; deliveries use STATUS_TOKEN_TTL_S. */
export async function mintStatusToken(
  secret: string,
  c: Omit<StatusClaims, "x">,
  nowMs = Date.now(),
  ttlS = STATUS_TOKEN_TTL_S,
): Promise<{ token: string; expires_at: string }> {
  if (c.a !== null && !APP_SLUG.test(c.a)) throw new Error(`bad app slug ${c.a}`);
  const x = Math.floor(nowMs / 1000) + ttlS;
  const payload = b64url(enc.encode(JSON.stringify({ m: c.m, r: c.r, s: c.s, a: c.a, h: c.h, x })));
  const signed = STATUS_TOKEN_PREFIX + payload;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(signed)));

  return { token: `${signed}.${b64url(sig)}`, expires_at: new Date(x * 1000).toISOString() };
}

export type Verified = { ok: true; claims: StatusClaims } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/** Check the signature first, then the expiry. The caller checks monorepo, repo and sha against its route. */
export async function verifyStatusToken(secret: string, token: string, nowMs = Date.now()): Promise<Verified> {
  if (!isStatusToken(token) || token.length > 2048) return { ok: false, reason: "malformed" };
  const parts = token.split(".");

  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const payload = unb64url(parts[1]);
  const sig = unb64url(parts[2]);

  if (!payload || !sig || sig.length !== 32) return { ok: false, reason: "malformed" };
  // crypto.subtle.verify compares in constant time.
  const good = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(`${parts[0]}.${parts[1]}`));

  if (!good) return { ok: false, reason: "bad_signature" };
  // Signed by this Worker, so it is mintStatusToken's JSON; decoded all the same.
  const raw = parseJson(new TextDecoder().decode(payload));

  if (!isRecord(raw)) return { ok: false, reason: "malformed" };
  const { m, r, s, a, h, x } = raw;

  if (!isText(m) || !isText(r) || !isText(s) || !isText(h) || !isInteger(x)) return { ok: false, reason: "malformed" };

  if (a !== null && (!isText(a) || !APP_SLUG.test(a))) return { ok: false, reason: "malformed" };

  if (x * 1000 <= nowMs) return { ok: false, reason: "expired" };

  return { ok: true, claims: { m, r, s, a, h, x } };
}

/** The statuses route, the only one a status token opens: POST /v1/monorepos/{o}/{m}/repos/{r}/statuses/{sha}. */
const STATUS_ROUTE = /^\/v1\/monorepos\/[^/]+\/[^/]+\/repos\/([^/]+)\/statuses\/([^/]+)$/;

/**
 * A request carrying a status token: the stamp for its status, or an error.
 * `monorepoId` is the monorepo the path names (resolved by the caller).
 */
export async function authorizeStatusToken(env: Env, req: Request, token: string, monorepoId: string): Promise<StatusStamp> {
  const m = STATUS_ROUTE.exec(new URL(req.url).pathname);

  if (req.method !== "POST" || !m) {
    throw new HttpError(403, "status_token_route", "a status token works only on POST /v1/monorepos/{owner}/{monorepo}/repos/{repo}/statuses/{sha}");
  }

  if (!env.PANDO_STATUS_SECRET) throw new HttpError(401, "status_tokens_off", "status tokens are off: the Worker secret PANDO_STATUS_SECRET is not set");
  const v = await verifyStatusToken(env.PANDO_STATUS_SECRET, token);

  if (!v.ok) {
    if (v.reason === "expired") throw new HttpError(401, "status_token_expired", "the status token has expired (they live 24 hours); a new delivery brings a new one");
    throw new HttpError(401, "unauthorized", "the status token is not valid");
  }

  const repo = decodeURIComponent(m[1]);
  const sha = decodeURIComponent(m[2]).toLowerCase();

  if (v.claims.m !== monorepoId || v.claims.r !== repo || v.claims.s !== sha) {
    throw new HttpError(403, "status_token_scope", "this status token is for another commit or repo: it posts statuses for one commit in one repo");
  }

  return stampOf(v.claims);
}
