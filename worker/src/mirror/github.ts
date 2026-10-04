// The GitHub App, as the Worker uses it: a JWT signed with the app's private
// key, installation tokens minted from it (one repository each, one hour,
// cached 50 minutes in the isolate, never stored or logged), the few REST
// calls the mirror makes, and the one-time user authorization at connect.
// The bases are github.com's, unless a test points them at a stand-in on
// this machine (GITHUB_API_BASE, GITHUB_WEB_BASE, GITHUB_GIT_BASE).

import type { Env } from "../env";
import { HttpError } from "../http";
import { isInteger, isRecord, isText, type Json, type JsonObject } from "../parse";
import { RemoteError, tokenAuth, type Remote } from "./pipe";

const local = (u: string | undefined): u is string => !!u && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u.replace(/\/$/, ""));

export const apiBase = (env: Env) => (local(env.GITHUB_API_BASE) ? env.GITHUB_API_BASE.replace(/\/$/, "") : "https://api.github.com");

export const webBase = (env: Env) => (local(env.GITHUB_WEB_BASE) ? env.GITHUB_WEB_BASE.replace(/\/$/, "") : "https://github.com");

const gitBase = (env: Env) => (local(env.GITHUB_GIT_BASE) ? env.GITHUB_GIT_BASE.replace(/\/$/, "") : "https://github.com");

/** A GitHub repository's git remote, pushed to with an installation token. */
export function remoteFor(env: Env, fullName: string, token: string): Remote {
  return { url: `${gitBase(env)}/${fullName}.git`, authorization: tokenAuth(token) };
}

/** True when the app's settings are all in place (else the mirror answers why it cannot connect). */
export function appConfigured(env: Env): boolean {
  return !!(env.GITHUB_APP_SLUG && env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET && env.GITHUB_APP_PRIVATE_KEY);
}

function needApp(env: Env) {
  const { GITHUB_APP_SLUG: slug, GITHUB_APP_CLIENT_ID: clientId, GITHUB_APP_CLIENT_SECRET: clientSecret, GITHUB_APP_PRIVATE_KEY: key } = env;

  if (!slug || !clientId || !clientSecret || !key) {
    throw new HttpError(503, "github_app_missing", "the GitHub App is not set up on this server (GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY)");
  }

  return { slug, clientId, clientSecret, key };
}

// ── The app's JWT ───────────────────────────────────────────────────────────

const enc = new TextEncoder();

function b64url(b: Uint8Array): string {
  let s = "";

  for (const x of b) s += String.fromCharCode(x);

  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);

  return out;
}

/** A DER length: short form under 128, else 0x8n and n bytes. */
function derLen(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];

  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);

  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, body: Uint8Array): Uint8Array {
  const len = derLen(body.length);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(body, 1 + len.length);

  return out;
}

/** PKCS#1 RSAPrivateKey (what GitHub's .pem holds) wrapped as PKCS#8, which WebCrypto imports. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  const key = der(0x04, pkcs1);
  const body = new Uint8Array(version.length + rsaAlgorithm.length + key.length);
  body.set(version, 0);
  body.set(rsaAlgorithm, version.length);
  body.set(key, version.length + rsaAlgorithm.length);

  return der(0x30, body);
}

/** The key as PKCS#8 DER, from PEM (PKCS#1 or PKCS#8), PEM with escaped newlines, or base64 of either. */
export function privateKeyDer(text: string): Uint8Array {
  let pem = text.replace(/\\n/g, "\n").trim();

  if (!pem.includes("-----BEGIN")) pem = new TextDecoder().decode(fromB64(pem));
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/.exec(pem);

  if (!m) throw new HttpError(503, "github_app_key", "GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  const bytes = fromB64(m[2]);

  return m[1] === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(bytes) : bytes;
}

let signingKey: { text: string; key: Promise<CryptoKey> } | null = null;

function keyFor(text: string): Promise<CryptoKey> {
  if (signingKey?.text !== text) {
    const der8 = privateKeyDer(text);
    signingKey = { text, key: crypto.subtle.importKey("pkcs8", der8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]) };
  }

  return signingKey.key;
}

/** The app's JWT: RS256, issued 60 s in the past, 9 minutes long, the Client ID as issuer (GitHub's recommendation). */
export async function appJwt(env: Env): Promise<string> {
  const app = needApp(env);
  const now = Math.floor(Date.now() / 1000);
  const part = (o: JsonObject) => b64url(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: app.clientId })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await keyFor(app.key), enc.encode(unsigned));

  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

// ── REST ────────────────────────────────────────────────────────────────────

/** One REST call to GitHub's API; a non-2xx answer throws RemoteError with its status and retry-after. */
export async function rest(env: Env, path: string, auth: string, init: { method?: string; body?: JsonObject } = {}): Promise<Json> {
  let res: Response;

  try {
    res = await fetch(`${apiBase(env)}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: auth,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "pando-mirror",
        ...(init.body ? { "content-type": "application/json" } : null),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (err) {
    throw new RemoteError(0, `GitHub did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await res.text();

  if (!res.ok) {
    const message = (() => {
      try {
        const j: Json = JSON.parse(text);

        return isRecord(j) && isText(j.message) ? j.message : text.slice(0, 200);
      } catch {
        return text.slice(0, 200);
      }
    })();

    throw new RemoteError(res.status, `GitHub answered ${res.status}: ${message}`, res.headers.get("retry-after"));
  }

  return text ? JSON.parse(text) : null;
}

// ── Installation tokens ─────────────────────────────────────────────────────

const TOKEN_KEEP_MS = 50 * 60_000;

const tokens = new Map<string, { token: string; until: number }>();

/**
 * A token for one installation, limited to `repoIds` when given (the mirror
 * pushes one repository per run). Cached in the isolate for 50 minutes of its
 * hour; `fresh` mints a new one (after GitHub refused the cached one).
 */
export async function installationToken(env: Env, installation: number, repoIds: number[] | null, fresh = false): Promise<string> {
  const key = `${installation}:${repoIds?.join(",") ?? "*"}`;
  const hit = tokens.get(key);

  if (!fresh && hit && hit.until > Date.now()) return hit.token;
  const body: JsonObject = repoIds ? { repository_ids: repoIds } : {};
  const r = await rest(env, `/app/installations/${installation}/access_tokens`, `Bearer ${await appJwt(env)}`, { method: "POST", body });

  if (!isRecord(r) || !isText(r.token)) throw new RemoteError(502, "GitHub's token answer had no token");

  if (tokens.size > 5_000) tokens.clear();
  tokens.set(key, { token: r.token, until: Date.now() + TOKEN_KEEP_MS });

  return r.token;
}

/** A GitHub repository as the mirror keeps it. */
export interface GithubRepo {
  id: number;
  full_name: string;
  private: boolean;
  url: string;
}

function repoOf(v: Json | undefined): GithubRepo | null {
  if (!isRecord(v) || !isInteger(v.id) || !isText(v.full_name)) return null;

  return { id: v.id, full_name: v.full_name, private: v.private === true, url: isText(v.html_url) ? v.html_url : `https://github.com/${v.full_name}` };
}

/** The repositories the installation reaches (at most 500), newest name order as GitHub gives them. */
export async function installationRepos(env: Env, installation: number): Promise<GithubRepo[]> {
  const token = await installationToken(env, installation, null);
  const out: GithubRepo[] = [];

  for (let page = 1; page <= 5; page++) {
    const r = await rest(env, `/installation/repositories?per_page=100&page=${page}`, `Bearer ${token}`);
    const list = isRecord(r) && Array.isArray(r.repositories) ? r.repositories : [];

    for (const x of list) {
      const repo = repoOf(x);

      if (repo) out.push(repo);
    }

    if (list.length < 100) break;
  }

  return out;
}

// ── The person's one-time authorization (connect, create) ──────────────────

/** Where to send the browser for the app's authorization, coming back with `state`. */
export function authorizeUrl(env: Env, state: string, callback: string): string {
  const app = needApp(env);

  return `${webBase(env)}/login/oauth/authorize?client_id=${encodeURIComponent(app.clientId)}&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(callback)}`;
}

/** Where to send the browser to install the app (GitHub returns to the callback, with a code, because the app asks for authorization at install). */
export function installUrl(env: Env, state: string): string {
  return `${webBase(env)}/apps/${encodeURIComponent(needApp(env).slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

/** Where a person manages the installation on GitHub. */
export function manageUrl(env: Env, installation: number, accountType: string, accountLogin: string): string {
  return accountType === "Organization"
    ? `${webBase(env)}/organizations/${encodeURIComponent(accountLogin)}/settings/installations/${installation}`
    : `${webBase(env)}/settings/installations/${installation}`;
}

/** Trade the one-time code for a user token. It is used at once and revoked (revokeUserToken); never stored. */
export async function userToken(env: Env, code: string): Promise<string> {
  const app = needApp(env);
  let res: Response;

  try {
    res = await fetch(`${webBase(env)}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "pando-mirror" },
      body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code }),
    });
  } catch {
    throw new HttpError(502, "github", "GitHub did not answer the authorization");
  }

  const j: Json = await res.json<Json>().catch(() => null);

  if (!isRecord(j) || !isText(j.access_token)) throw new HttpError(400, "github_authorization", "GitHub did not accept the authorization; try again");

  return j.access_token;
}

/** Revoke a user token at once. Best effort: it expires in 8 hours anyway. */
export async function revokeUserToken(env: Env, token: string): Promise<void> {
  const app = needApp(env);

  await rest(env, `/applications/${encodeURIComponent(app.clientId)}/token`, `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`, { method: "DELETE", body: { access_token: token } }).catch(() => null);
}

/** An installation of the app, as the person's authorization shows it. */
export interface Installation {
  id: number;
  account_id: number;
  account_login: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
  suspended: boolean;
}

/** The app's installations this GitHub user can reach (GitHub's check against a faked installation id), and who they are. */
export async function userInstallations(env: Env, token: string): Promise<{ user_id: number; installations: Installation[] }> {
  const auth = `Bearer ${token}`;
  const [me, r] = await Promise.all([rest(env, "/user", auth), rest(env, "/user/installations?per_page=100", auth)]);
  const list = isRecord(r) && Array.isArray(r.installations) ? r.installations : [];
  const installations: Installation[] = [];

  for (const x of list) {
    if (!isRecord(x) || !isInteger(x.id) || !isRecord(x.account) || !isInteger(x.account.id) || !isText(x.account.login)) continue;
    installations.push({
      id: x.id,
      account_id: x.account.id,
      account_login: x.account.login,
      account_type: x.account.type === "Organization" ? "Organization" : "User",
      repository_selection: x.repository_selection === "all" ? "all" : "selected",
      suspended: !!x.suspended_at,
    });
  }

  return { user_id: isRecord(me) && isInteger(me.id) ? me.id : 0, installations };
}

/** Make a private, empty repository on the installation's account, with the person's token. Answers the one that exists if the name is taken. */
export async function createRepo(env: Env, token: string, account: { login: string; type: string }, name: string): Promise<GithubRepo> {
  const auth = `Bearer ${token}`;
  const path = account.type === "Organization" ? `/orgs/${encodeURIComponent(account.login)}/repos` : "/user/repos";

  try {
    const made = repoOf(await rest(env, path, auth, { method: "POST", body: { name, private: true, auto_init: false } }));

    if (!made) throw new RemoteError(502, "GitHub's answer had no repository");

    return made;
  } catch (err) {
    if (!(err instanceof RemoteError) || err.status !== 422) throw err;
    // Taken: the repository of that name, if this person reaches it.
    const found = repoOf(await rest(env, `/repos/${encodeURIComponent(account.login)}/${encodeURIComponent(name)}`, auth));

    if (!found) throw err;

    return found;
  }
}
