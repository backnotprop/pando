// Pando's own OAuth authorization server for its MCP endpoint (MCP 2026-07-28 "Authorization"; OAuth
// 2.1 with PKCE, RFC 9728, RFC 8414, RFC 8707, RFC 9207, RFC 7009, and RFC 7591 kept for 2025-era hosts).
// WorkOS stays behind it: a person who is not signed in goes through the normal browser sign-in
// (accounts/signin.ts) and comes back here. The token an MCP host gets is a Pando credential of kind
// "mcp" named after the client, owned by the person who clicked Allow, revocable in Settings.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]       RFC 9728 document   (CORS *)
//   GET  /.well-known/oauth-authorization-server[/mcp]     RFC 8414 document   (CORS *)
//   POST /oauth/register                                   RFC 7591            (CORS *)
//   GET  /oauth/authorize, POST /oauth/authorize           sign-in bounce, consent page, the click (no CORS)
//   POST /oauth/token                                      code + PKCE verifier for a credential (CORS *)
//   POST /oauth/revoke                                     RFC 7009            (no CORS)
//
// No refresh token: the credential lasts until revoked, like `pando login`'s, and the token answer says
// expires_in ten years because hosts read a missing value as one hour and ask again every hour.
// Nothing here reads a cookie or an Authorization header on a door that has CORS.

import type { Env } from "../env";
import { hasControl } from "../http";
import { isRecord, isText, parseJson } from "../parse";
import { hashToken, newToken } from "../monorepo/session";
import { accounts, authenticate, forgetCachedAuth, readCookie, sameOrigin, SESSION_COOKIE } from "../accounts/auth";
import { cleanName, fetchCimd, isCimdId, OAuthStore, redirectList, redirectMatches, type GrantRequest, type OAuthClient } from "./clients";
import { consentPage, problemPage } from "./consent";

/** The one scope: everything the person can do, through /mcp. */
export const SCOPE = "mcp";

/** What the token answer says for expires_in: ten years (the credential lasts until revoked). */
export const TOKEN_EXPIRES_IN_S = 10 * 365 * 86_400;

const CONSENT_COOKIE = "pando_mcp_consent";

const CORS_HEADERS = "authorization, content-type, accept, mcp-protocol-version";

/** The MCP origin when this request is for it: MCP_ORIGIN set, and the request's own host. */
export function mcpOrigin(env: Env, url: URL): string | null {
  const o = env.MCP_ORIGIN;

  if (!o) return null;

  try {
    const origin = new URL(o).origin;

    return new URL(origin).host === url.host ? origin : null;
  } catch {
    return null;
  }
}

export const resourceOf = (origin: string) => `${origin}/mcp`;

export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`;

/** RFC 9728: what /mcp is and who issues its tokens. */
export function protectedResourceDocument(origin: string) {
  return {
    resource: resourceOf(origin),
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
    resource_name: "Pando",
  };
}

/** RFC 8414: Pando's authorization server. */
export function authorizationServerDocument(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

const PRM_PATHS = new Set(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]);

const ASM_PATHS = new Set(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"]);

const DOORS = new Set(["/oauth/register", "/oauth/authorize", "/oauth/token", "/oauth/revoke"]);

/** Whether a path is one of this module's. */
export function isOAuthPath(path: string): boolean {
  return PRM_PATHS.has(path) || ASM_PATHS.has(path) || DOORS.has(path);
}

// ── Answers ─────────────────────────────────────────────────────────────

function preflight(methods: string): Response {
  return new Response(null, {
    status: 204,
    headers: { "access-control-allow-origin": "*", "access-control-allow-methods": methods, "access-control-allow-headers": CORS_HEADERS, "access-control-max-age": "600" },
  });
}

function notAllowed(allow: string): Response {
  return Response.json({ error: "method_not_allowed", error_description: `use ${allow}` }, { status: 405, headers: { allow, "cache-control": "no-store" } });
}

/** An OAuth answer's JSON: strings, numbers and lists of strings. */
interface OAuthBody {
  readonly [key: string]: string | number | readonly string[];
}

function json(body: OAuthBody, status: number, cors: boolean, extra: HeadersInit = {}): Response {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");

  if (cors) headers.set("access-control-allow-origin", "*");

  return Response.json(body, { status, headers });
}

/** An OAuth error: a fixed description, never the caller's input. */
function oauthError(status: number, error: string, description: string, cors: boolean, extra: HeadersInit = {}): Response {
  return json({ error, error_description: description }, status, cors, extra);
}

function isForm(req: Request): boolean {
  return (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() === "application/x-www-form-urlencoded";
}

/** Back to the app's redirect URI with these parameters and iss (RFC 9207), as a 302 (or 303 after a form post). */
function back(redirectUri: string, origin: string, params: Record<string, string | null>, status = 302): Response {
  const u = new URL(redirectUri);

  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  u.searchParams.set("iss", origin);

  return new Response(null, { status, headers: { location: u.toString(), "cache-control": "no-store" } });
}

function consentCookie(value: string, maxAge: number): string {
  return `${CONSENT_COOKIE}=${value}; Path=/oauth/authorize; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Equal strings, compared without stopping at the first difference. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;

  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);

  return diff === 0;
}

const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;

async function s256(verifier: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The resource a request names, as the same URL /mcp is, or false. Absent is ours (one resource). */
function resourceOk(v: string | null, origin: string): boolean {
  if (v === null) return true;

  try {
    const u = new URL(v);

    return u.origin === origin && u.pathname.replace(/\/$/, "") === "/mcp" && u.search === "" && u.hash === "";
  } catch {
    return false;
  }
}

// ── Clients ─────────────────────────────────────────────────────────────

/** The client a client_id names: a registration, or a metadata document (kept a day, else fetched now). */
async function resolveClient(store: OAuthStore, id: string): Promise<OAuthClient | string> {
  const known = await store.client(id);

  if (known) return known;

  if (!isCimdId(id)) return "this app is not registered with Pando";
  const fetched = await fetchCimd(id);

  if (isText(fetched)) return fetched;
  await store.keepCimd(fetched);

  return fetched;
}

// ── The doors ───────────────────────────────────────────────────────────

/** POST /oauth/register: a public client (RFC 7591), answered with what Pando will honour. */
async function register(req: Request, env: Env): Promise<Response> {
  const limit = await env.MCP_REGISTER_LIMITER?.limit({ key: req.headers.get("cf-connecting-ip") ?? "local" });

  if (limit && !limit.success) return oauthError(429, "temporarily_unavailable", "too many registrations from this address; try again in a minute", true, { "retry-after": "60" });

  if ((req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() !== "application/json") {
    return oauthError(415, "invalid_client_metadata", "send the registration as application/json", true);
  }

  const text = await req.text();

  if (text.length > 16_384) return oauthError(413, "invalid_client_metadata", "the registration is over 16 KiB", true);
  const b = parseJson(text);

  if (!isRecord(b)) return oauthError(400, "invalid_client_metadata", "the registration must be a JSON object", true);
  const uris = redirectList(b.redirect_uris);

  if (!Array.isArray(uris)) return oauthError(400, "invalid_redirect_uri", "redirect_uris: one to ten, each https, loopback http, or an app's own scheme, with no fragment", true);

  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== "none") {
    return oauthError(400, "invalid_client_metadata", "only public clients: token_endpoint_auth_method must be none", true);
  }

  const client = await new OAuthStore(env.ACCOUNTS_DB).register(cleanName(b.client_name) ?? "Unnamed app", uris);

  return json(
    {
      client_id: client.id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.name,
      redirect_uris: client.redirect_uris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    },
    201,
    true,
  );
}

/** The signed-in person in this browser (the session cookie only), or null. */
async function browserPerson(req: Request, env: Env) {
  const cookie = readCookie(req, SESSION_COOKIE);

  if (!cookie) return null;
  const auth = await authenticate(env, cookie, null);

  return auth && auth.credential.kind === "browser" ? auth : null;
}

/**
 * GET /oauth/authorize. In this order: the request's size and its client and redirect URI present
 * (answered here, never sent back); the person signed in (else off to sign in and back); the client
 * known and the redirect URI its own (answered here: Pando only sends a browser to a proven address);
 * then the rest, sent back to the app as an error; then a client already allowed gets its code at once,
 * and any other sees the consent page.
 */
async function authorizeGet(req: Request, env: Env, origin: string): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams;
  const clientId = q.get("client_id");
  const redirectUri = q.get("redirect_uri");

  // The whole request rides the sign-in's return_to, which keeps at most 1,000 characters.
  if (url.pathname.length + url.search.length > 1000) return problemPage("The sign-in request is over 1,000 characters.");

  if (!clientId || !redirectUri || hasControl(clientId) || hasControl(redirectUri)) return problemPage("The request names no app (client_id) or no address to return to (redirect_uri).");
  const person = await browserPerson(req, env);

  if (!person) {
    return new Response(null, { status: 302, headers: { location: `/v1/login/browser?return_to=${encodeURIComponent(url.pathname + url.search)}`, "cache-control": "no-store" } });
  }

  const store = new OAuthStore(env.ACCOUNTS_DB);
  const client = await resolveClient(store, clientId);

  if (isText(client)) return problemPage(`The app could not be checked: ${client}.`);

  if (!client.redirect_uris.some((r) => redirectMatches(r, redirectUri))) return problemPage("The address to return to is not one this app registered.");
  const state = q.get("state");
  const fail = (error: string, description: string) => back(redirectUri, origin, { error, error_description: description, state });

  if (q.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");

  if (q.get("code_challenge_method") !== "S256") return fail("invalid_request", "PKCE with code_challenge_method S256 is required");
  const challenge = q.get("code_challenge") ?? "";

  if (!PKCE.test(challenge)) return fail("invalid_request", "code_challenge must be 43 to 128 characters");

  if (!resourceOk(q.get("resource"), origin)) return fail("invalid_target", "resource must be this server's /mcp");
  const grant: GrantRequest = { login: person.user.login, client_id: client.id, redirect_uri: redirectUri, code_challenge: challenge };

  if (await store.allowed(grant.login, client.id)) return back(redirectUri, origin, { code: await store.mintCode(grant), state });
  const consentId = await store.newConsent(grant, state);

  return consentPage({ client, login: person.user.login, person: person.user.name, redirectUri, consentId }, consentCookie(consentId, 600));
}

/** POST /oauth/authorize: the click. The consent is taken once whatever the answer; the cookie goes on every outcome. */
async function authorizePost(req: Request, env: Env, origin: string): Promise<Response> {
  const clear = { "set-cookie": consentCookie("", 0) };

  const stopped = (message: string, status = 400) => {
    const res = problemPage(message, status);
    res.headers.append("set-cookie", clear["set-cookie"]);

    return res;
  };

  if (!sameOrigin(req)) return stopped("Answer from Pando's own page.", 403);

  if (!isForm(req)) return stopped("Answer with the page's own buttons.", 415);
  const form = new URLSearchParams(await req.text());
  const id = form.get("consent") ?? "";
  const cookie = readCookie(req, CONSENT_COOKIE) ?? "";

  if (id === "" || !same(id, cookie)) return stopped("This page is out of date. Start the connection again from your app.");
  const person = await browserPerson(req, env);

  if (!person) return stopped("You are signed out. Start the connection again from your app.", 401);
  const store = new OAuthStore(env.ACCOUNTS_DB);
  const consent = await store.takeConsent(id);

  if (!consent || consent.login !== person.user.login) return stopped("This page is out of date. Start the connection again from your app.");

  if (!(await store.nameOf(consent.client_id))) return stopped("The app is no longer registered.");
  let res: Response;

  if (form.get("decision") === "allow") {
    res = back(consent.redirect_uri, origin, { code: await store.mintCode(consent), state: consent.state }, 303);
  } else {
    res = back(consent.redirect_uri, origin, { error: "access_denied", error_description: "the person said no", state: consent.state }, 303);
  }

  res.headers.append("set-cookie", clear["set-cookie"]);

  return res;
}

const BAD_GRANT = "the code is unknown, used, expired, or does not match this request";

/** POST /oauth/token: a code and its PKCE verifier for a credential of kind mcp. No outbound call. */
async function token(req: Request, env: Env, origin: string): Promise<Response> {
  if (!isForm(req)) return oauthError(415, "invalid_request", "send the request as application/x-www-form-urlencoded", true);
  const f = new URLSearchParams(await req.text());

  if (f.get("grant_type") !== "authorization_code") return oauthError(400, "unsupported_grant_type", "only authorization_code is supported", true);
  const code = f.get("code");
  const verifier = f.get("code_verifier");
  const clientId = f.get("client_id");
  const redirectUri = f.get("redirect_uri");

  if (!code || !verifier || !clientId || !redirectUri) return oauthError(400, "invalid_request", "code, code_verifier, client_id and redirect_uri are required", true);

  if (!resourceOk(f.get("resource"), origin)) return oauthError(400, "invalid_target", "resource must be this server's /mcp", true);
  const store = new OAuthStore(env.ACCOUNTS_DB);
  // Spent first: a wrong verifier burns the code too.
  const row = await store.consumeCode(code);

  if (!row || row.client_id !== clientId || row.redirect_uri !== redirectUri || !PKCE.test(verifier) || (await s256(verifier)) !== row.code_challenge) {
    return oauthError(400, "invalid_grant", BAD_GRANT, true);
  }

  const name = await store.nameOf(clientId);

  if (!name) return oauthError(400, "invalid_client", "the app is no longer registered", true);
  const secret = newToken();
  await accounts(env).addCredential(row.login, { hash: await hashToken(secret), name, kind: "mcp", client_id: clientId });

  return json({ access_token: secret, token_type: "Bearer", expires_in: TOKEN_EXPIRES_IN_S, scope: SCOPE }, 200, true);
}

/**
 * POST /oauth/revoke (RFC 7009): ends the person's grant to that app (every credential it holds for
 * them, and its codes not yet traded). 200 whatever the token was. It reaches MCP credentials only.
 */
async function revoke(req: Request, env: Env): Promise<Response> {
  if (!isForm(req)) return oauthError(415, "invalid_request", "send the request as application/x-www-form-urlencoded", false);
  const t = new URLSearchParams(await req.text()).get("token");

  if (t) {
    const grant = await new OAuthStore(env.ACCOUNTS_DB).grantOf(t);

    if (grant) {
      await accounts(env).revokeMcpGrant(grant.login, grant.client_id);
      forgetCachedAuth();
    }
  }

  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}

/** This module's routes (isOAuthPath). 404 on them all when MCP_ORIGIN is unset or names another host. */
export async function handleOAuth(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const origin = mcpOrigin(env, url);

  if (!origin) return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
  const m = req.method;

  if (PRM_PATHS.has(path) || ASM_PATHS.has(path)) {
    if (m === "OPTIONS") return preflight("GET, HEAD, OPTIONS");

    if (m !== "GET" && m !== "HEAD") return notAllowed("GET, HEAD, OPTIONS");
    const doc = PRM_PATHS.has(path) ? protectedResourceDocument(origin) : authorizationServerDocument(origin);

    return Response.json(doc, { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" } });
  }

  if (path === "/oauth/register" || path === "/oauth/token") {
    if (m === "OPTIONS") return preflight("POST, OPTIONS");

    if (m !== "POST") return notAllowed("POST, OPTIONS");

    return path === "/oauth/register" ? register(req, env) : token(req, env, origin);
  }

  if (path === "/oauth/authorize") {
    if (m === "GET") return authorizeGet(req, env, origin);

    if (m === "POST") return authorizePost(req, env, origin);

    return notAllowed("GET, POST");
  }

  if (m !== "POST") return notAllowed("POST");

  return revoke(req, env);
}
