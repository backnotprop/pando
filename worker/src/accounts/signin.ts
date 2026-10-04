// How a person gets a Pando user and a machine credential. Every sign-in
// route lives in this module.
//
// - `pando login`: WorkOS AuthKit's CLI Auth (the OAuth device flow). The
//   Worker talks to WorkOS itself, so it receives the signed-in user straight
//   from api.workos.com and needs no token verification. WorkOS only proves
//   identity: its access and refresh tokens are dropped, and Pando keeps its
//   own users, credentials and membership (accounts/object.ts).
// - A browser: AuthKit's hosted page with PKCE (GET /v1/login/browser, then
//   GET /v1/login/callback). The session is a credential of kind "browser" for
//   the same Pando user, sent as the __Host-pando_session cookie; sign-out
//   (POST /v1/logout) revokes it and ends the WorkOS session too.
// - Self-hosted, single user: PANDO_BOOTSTRAP makes a user (POST /v1/users).
//
// Secrets read here, never logged: WORKOS_API_KEY (the code exchange),
// PANDO_BOOTSTRAP. WORKOS_CLIENT_ID is public. WORKOS_API_BASE points the
// Worker at a stand-in WorkOS for tests; only a localhost address is honoured.

import { Hono } from "hono";
import type * as Contract from "@pando/contract";
import type { Env } from "../env";
import { credential, hasControl, HttpError, toErrorResponse } from "../http";
import { isRecord, isText, parseJson, type Json, type JsonObject } from "../parse";
import { hashToken, isBootstrap, newToken } from "../monorepo/session";
import { namespaceProblem } from "../monorepo/names";
import { accounts, forgetCachedAuth, readCookie, sameOrigin, SESSION_COOKIE } from "./auth";
import type { SignedIn } from "./object";

export const signin = new Hono<{ Bindings: Env }>();

signin.onError((err) => toErrorResponse(err));

/** Make a user and their first credential (bootstrap secret only). */
signin.post("/v1/users", async (c) => {
  if (!c.env.PANDO_BOOTSTRAP) throw new HttpError(503, "bootstrap_not_configured", "the Worker secret PANDO_BOOTSTRAP is not set");

  if (!(await isBootstrap(c.env, credential(c.req.raw)))) throw new HttpError(401, "unauthorized", "making users needs the bootstrap secret until sign-in exists");
  const b = await c.req.json<Json>().catch(() => null);

  if (!isRecord(b)) throw new HttpError(400, "bad_request", "the body must be a JSON object");
  // A login is a namespace (NAMESPACES.md): matched without case, kept lower case.
  const login = isText(b.login) ? b.login.toLowerCase() : null;
  const problem = namespaceProblem(login);

  if (problem === "reserved") throw new HttpError(400, "reserved_name", `${login} is reserved`);

  if (problem) throw new HttpError(400, "bad_request", "login: letters, digits and single hyphens, at most 39, no hyphen at either end");

  const opt = (v: Json | undefined, field: string) => {
    if (v === undefined || v === null) return null;

    if (!isText(v) || v.length > 200) throw new HttpError(400, "bad_request", `${field} must be a short string`);

    return v;
  };

  const secret = newToken();

  const out = await accounts(c.env).createUser(
    { login: login!, name: opt(b.name, "name"), email: opt(b.email, "email") },
    { hash: await hashToken(secret), name: opt(b.credential_name, "credential_name") ?? "bootstrap", kind: "bootstrap" },
  );

  if (!out.ok) throw new HttpError(out.status, out.code, out.message);

  return c.json({ user: out.value.user, credential: { ...out.value.credential, secret } }, 201);
});

// ── pando login: WorkOS CLI Auth ─────────────────────────────────────────

/** WorkOS's API, or a stand-in on this machine for tests (never anything else). */
function workosBase(env: Env): string {
  const t = env.WORKOS_API_BASE;

  if (t && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(t)) return t;

  return "https://api.workos.com";
}

function workosClient(env: Env): string {
  if (!env.WORKOS_CLIENT_ID) throw new HttpError(503, "sign_in_not_configured", "the Worker secret WORKOS_CLIENT_ID is not set");

  return env.WORKOS_CLIENT_ID;
}

/** A WorkOS answer: its status, and its JSON body (an empty object when it sent none). */
interface WorkosAnswer {
  ok: boolean;
  status: number;
  data: JsonObject;
}

async function workos(env: Env, path: string, form: URLSearchParams): Promise<WorkosAnswer> {
  const res = await fetch(`${workosBase(env)}/user_management${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
  });

  const data = await res.json<Json>().catch(() => null);

  return { ok: res.ok, status: res.status, data: isRecord(data) ? data : {} };
}

/** A non-empty string. */
const isName = (v: Json | undefined): v is string => isText(v) && v.length > 0;

/** Who WorkOS says signed in (its User object): id, email, display name, picture. */
function signedInFrom(data: JsonObject): SignedIn {
  const u = data.user;

  if (!isRecord(u) || !isName(u.id) || !isName(u.email)) throw new HttpError(502, "workos", "WorkOS returned no user");

  return {
    workos_id: u.id,
    email: u.email,
    email_verified: u.email_verified === true,
    name: [u.first_name, u.last_name].filter(isName).join(" ") || null,
    picture_url: pictureUrl(u.profile_picture_url),
  };
}

/** A picture the web may put in an <img>: an https URL of at most 2,048 characters, else null. Never fetched here. */
export function pictureUrl(v: Json | undefined): string | null {
  if (!isText(v) || v.length > 2048) return null;

  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

/** Step 1: a code for the person to confirm in the browser, and a device code for the CLI to poll with. */
signin.post("/v1/login/device", async (c) => {
  const r = await workos(c.env, "/authorize/device", new URLSearchParams({ client_id: workosClient(c.env) }));

  if (!r.ok) {
    throw new HttpError(502, "workos", `WorkOS refused to start the sign-in (${r.status}): ${String(r.data.error ?? r.data.message ?? "")}`.trim());
  }

  const d = r.data;

  return c.json({
    device_code: d.device_code,
    user_code: d.user_code,
    verification_uri: d.verification_uri,
    verification_uri_complete: d.verification_uri_complete,
    expires_in: d.expires_in,
    interval: d.interval,
  });
});

const PENDING = new Set(["authorization_pending", "slow_down", "access_denied", "expired_token", "invalid_grant"]);

/** Step 2, polled: once the person confirmed, the Pando user and a new machine credential. */
signin.post("/v1/login/token", async (c) => {
  const clientId = workosClient(c.env);
  const b = await c.req.json<Json>().catch(() => null);

  if (!isRecord(b) || !isName(b.device_code)) throw new HttpError(400, "bad_request", "device_code is required");
  const name = b.credential_name;

  if (!isName(name) || name.length > 200) throw new HttpError(400, "bad_request", "credential_name (the machine name) is required");
  const kind = b.kind ?? "machine";

  if (kind !== "machine" && kind !== "sandbox") throw new HttpError(400, "bad_request", "kind is machine or sandbox");

  const r = await workos(c.env, "/authenticate", new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: b.device_code,
    client_id: clientId,
  }));

  if (!r.ok) {
    const code = String(r.data.error ?? "sign_in_failed");
    const message = String(r.data.error_description ?? "the sign-in did not complete");
    throw new HttpError(400, PENDING.has(code) ? code : "sign_in_failed", message);
  }

  const who = signedInFrom(r.data);
  const secret = newToken();

  const out = await accounts(c.env).signIn(
    who,
    { hash: await hashToken(secret), name, kind },
  );

  return c.json({ user: out.user, credential: { ...out.credential, secret }, joined: out.joined.map((j) => j.full_name) });
});

// ── A browser: AuthKit's hosted page, PKCE, Pando's own session cookie ──────

const LOGIN_COOKIE = "__Host-pando_login";

const LOGIN_TTL_S = 600;

/** The cookie outlives the session: the server decides when it ends (SESSION_IDLE_DAYS). 400 days is browsers' cap. */
const SESSION_COOKIE_MAX_AGE_S = 400 * 86_400;

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomB64url(n = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** Only a path on this host: starts with one "/", no "//" or "/\\", no backslash or control characters. */
export function safeReturnTo(v: string | null | undefined): string {
  if (!v || v.length > 1000 || !v.startsWith("/") || v.startsWith("//") || v.includes("\\") || hasControl(v)) return "/";

  return v;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** "Chrome on macOS", for the session's name in the credentials list. */
export function browserName(ua: string | null): string {
  const u = ua ?? "";
  const browser = /Edg\//.test(u) ? "Edge" : /Firefox\//.test(u) ? "Firefox" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "a browser";
  const os = /iPhone|iPad/.test(u) ? "iOS" : /Android/.test(u) ? "Android" : /Mac OS X|Macintosh/.test(u) ? "macOS" : /Windows/.test(u) ? "Windows" : /Linux/.test(u) ? "Linux" : null;

  return `browser: ${browser}${os ? ` on ${os}` : ""}`;
}

/** Base64url text as a string (UTF-8). Throws when it is not base64. */
function fromB64url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");

  return new TextDecoder().decode(Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (ch) => ch.charCodeAt(0)));
}

/** The WorkOS session id (sid) from an access token WorkOS just gave us over TLS. */
function sessionIdOf(accessToken: Json | undefined): string | null {
  if (!isText(accessToken)) return null;

  try {
    const claims = parseJson(fromB64url(accessToken.split(".")[1]));

    return isRecord(claims) && isText(claims.sid) ? claims.sid : null;
  } catch {
    return null;
  }
}

/** The sign-in cookie: what step 1 saved for step 2. Fields read as null when the cookie is missing or not ours. */
interface LoginStart {
  state: string | null;
  verifier: string | null;
  returnTo: string | null;
}

function loginStart(raw: string | null | undefined): LoginStart {
  let saved: Json = null;

  try {
    saved = raw ? parseJson(fromB64url(raw)) : null;
  } catch {
    saved = null;
  }

  const text = (v: Json | undefined) => (isText(v) ? v : null);

  return isRecord(saved) ? { state: text(saved.state), verifier: text(saved.verifier), returnTo: text(saved.return_to) } : { state: null, verifier: null, returnTo: null };
}

/** Step 1: send the browser to AuthKit, remembering state, the PKCE verifier and where to come back to. */
signin.get("/v1/login/browser", async (c) => {
  const clientId = workosClient(c.env);
  const origin = new URL(c.req.url).origin;
  const state = randomB64url();
  const verifier = randomB64url();
  const returnTo = safeReturnTo(c.req.query("return_to"));
  const url = new URL(`${workosBase(c.env)}/user_management/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: `${origin}/v1/login/callback`,
    provider: "authkit",
    state,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
  }).toString();
  const login = b64url(new TextEncoder().encode(JSON.stringify({ state, verifier, return_to: returnTo })));

  return new Response(null, {
    status: 302,
    headers: { location: url.toString(), "set-cookie": cookie(LOGIN_COOKIE, login, LOGIN_TTL_S), "cache-control": "no-store" },
  });
});

/** Step 2: AuthKit sends the browser back with a code; exchange it, sign in, set the session cookie. */
signin.get("/v1/login/callback", async (c) => {
  const clientId = workosClient(c.env);
  const saved = loginStart(readCookie(c.req.raw, LOGIN_COOKIE));

  const code = c.req.query("code");
  const state = c.req.query("state");

  if (c.req.query("error")) throw new HttpError(400, "sign_in_failed", `WorkOS: ${c.req.query("error_description") ?? c.req.query("error")}`);

  if (!code || !state || !saved.state || !saved.verifier || state !== saved.state) {
    throw new HttpError(400, "bad_state", "this sign-in did not start here, or it took longer than 10 minutes; start again at /v1/login/browser");
  }

  const form = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: saved.verifier });

  if (c.env.WORKOS_API_KEY) form.set("client_secret", c.env.WORKOS_API_KEY);
  const r = await workos(c.env, "/authenticate", form);

  if (!r.ok) {
    throw new HttpError(400, "sign_in_failed", `WorkOS refused the code (${r.status}): ${String(r.data.error_description ?? r.data.message ?? r.data.error ?? "")}`.trim());
  }

  const who = signedInFrom(r.data);
  const secret = newToken();
  await accounts(c.env).signIn(
    who,
    { hash: await hashToken(secret), name: browserName(c.req.header("user-agent") ?? null), kind: "browser", workos_sid: sessionIdOf(r.data.access_token) },
  );
  const headers = new Headers({ location: safeReturnTo(saved.returnTo), "cache-control": "no-store" });
  headers.append("set-cookie", cookie(SESSION_COOKIE, secret, SESSION_COOKIE_MAX_AGE_S));
  headers.append("set-cookie", cookie(LOGIN_COOKIE, "", 0));

  return new Response(null, { status: 302, headers });
});

/** Opened in a browser: the app, where the name menu signs out (a GET never ends a session). */
signin.get("/v1/logout", (c) => new Response(null, { status: 303, headers: { location: `${new URL(c.req.url).origin}/`, "cache-control": "no-store" } }));

/**
 * Sign out: revoke this browser session, clear the cookie, and end the WorkOS
 * session too (so a shared computer asks for the password again). Answers the
 * WorkOS logout URL as JSON, or sends the browser there (303) for a form post.
 */
signin.post("/v1/logout", async (c) => {
  const req = c.req.raw;

  if (!sameOrigin(req)) throw new HttpError(403, "bad_origin", "sign out from Pando's own pages");
  const origin = new URL(req.url).origin;
  const secret = readCookie(req, SESSION_COOKIE);
  let sid: string | null = null;

  if (secret) {
    sid = (await accounts(c.env).endBrowserSession(await hashToken(secret))).workos_sid;
    forgetCachedAuth();
  }

  const next = sid
    ? `${workosBase(c.env)}/user_management/sessions/logout?${new URLSearchParams({ session_id: sid, return_to: `${origin}/` })}`
    : `${origin}/`;

  const headers = new Headers({ "set-cookie": cookie(SESSION_COOKIE, "", 0), "cache-control": "no-store" });

  if ((c.req.header("accept") ?? "").includes("application/json")) {
    headers.set("content-type", "application/json");

    return new Response(JSON.stringify({ signed_out: !!secret, logout_url: next } satisfies typeof Contract.SignedOut.Encoded), { headers });
  }

  headers.set("location", next);

  return new Response(null, { status: 303, headers });
});
