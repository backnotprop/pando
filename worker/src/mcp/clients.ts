// The apps that sign in to /mcp (MCP hosts: Claude Code, Codex, Cursor) and the rows of their sign-ins:
// registered clients, Client ID Metadata Documents fetched and kept, consents waiting for a click, and
// one-time codes. The routes are in oauth.ts; this file holds the rules they share and the SQL.
//
// Two ways a client names itself (MCP 2026-07-28, "Client Registration"):
// - a Client ID Metadata Document: its client_id is an https URL whose JSON names it and lists its
//   redirect URIs. Fetched at the authorize step only, behind the fence in fetchCimd.
// - dynamic registration (RFC 7591, deprecated in 2026-07-28 but still what 2025-era hosts use):
//   POST /oauth/register. Public clients only. At most MAX_UNUSED_REGISTRATIONS are kept unused.

import { hasControl, now } from "../http";
import { isRecord, isText, parseJson, type Json } from "../parse";
import { hashToken, newToken } from "../monorepo/session";

export type ClientKind = "cimd" | "dcr";

/** A client as the consent page and the token door see it, however it registered. */
export interface OAuthClient {
  id: string;
  kind: ClientKind;
  name: string;
  redirect_uris: string[];
}

/** Registrations never used for a code are dropped after a day, and the oldest go first past this many. */
export const MAX_UNUSED_REGISTRATIONS = 1000;

const UNUSED_REGISTRATION_MS = 86_400_000;

/** A fetched metadata document is kept this long before it is read again. */
const CIMD_KEEP_MS = 86_400_000;

const CIMD_TIMEOUT_MS = 5000;

const CIMD_MAX_BYTES = 64 * 1024;

export const CODE_TTL_MS = 5 * 60_000;

export const CONSENT_TTL_MS = 10 * 60_000;

const NAME_MAX = 120;

const URI_MAX = 2048;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Schemes a browser handles itself or that run code: never a redirect target. */
const REFUSED_SCHEMES = new Set([
  "javascript:", "data:", "blob:", "file:", "about:", "vbscript:", "ftp:", "ws:", "wss:", "view-source:",
  "chrome-extension:", "moz-extension:", "safari-web-extension:", "chrome:", "edge:",
]);

/** Format characters (bidi overrides, zero-width joiners) that could deform a name on the consent page. */
const FORMAT = /\p{Cf}/gu;

/** A client's name as it may be shown: no control or format characters, at most 120 characters; null when nothing is left. */
export function cleanName(v: Json | undefined): string | null {
  if (!isText(v)) return null;
  let out = "";

  for (const ch of v.replace(FORMAT, "")) if (!hasControl(ch)) out += ch;
  out = out.trim().slice(0, NAME_MAX);

  return out === "" ? null : out;
}

/** Why a redirect URI is refused, or null: https anywhere, http on loopback only, or an app's own scheme. */
export function redirectProblem(uri: string): string | null {
  if (uri.length > URI_MAX) return "longer than 2,048 characters";

  if (uri.includes("#")) return "has a fragment";
  let u: URL;

  try {
    u = new URL(uri);
  } catch {
    return "is not a URL";
  }

  if (u.username !== "" || u.password !== "") return "has a user name or password";

  if (u.protocol === "https:") return null;

  if (u.protocol === "http:") return LOOPBACK.has(u.hostname) ? null : "uses http on a host other than this computer";

  if (REFUSED_SCHEMES.has(u.protocol)) return "uses a scheme a browser handles itself";

  return null;
}

/** Whether a redirect URI is loopback http: any program on the computer could listen there. */
export function isLoopback(uri: string): boolean {
  try {
    const u = new URL(uri);

    return u.protocol === "http:" && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Whether the redirect URI an authorize or token request names is one the client registered: byte for
 * byte, except on loopback http, where the port is ignored (a command-line host takes a free port per
 * sign-in) and a query may be added when the registered URI has none (Codex adds ?cb=). Same host and path.
 */
export function redirectMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;

  if (!isLoopback(registered) || !isLoopback(presented)) return false;
  const r = new URL(registered);
  const p = new URL(presented);

  if (r.hostname !== p.hostname || r.pathname !== p.pathname) return false;

  return r.search === "" || r.search === p.search;
}

/** Whether a client_id names a metadata document (an https URL) rather than a registration. */
export function isCimdId(id: string): boolean {
  return id.startsWith("https://");
}

/**
 * Why a metadata document URL may not be fetched, or null. https, the default port, a path, no user,
 * query or fragment, and a name on the internet: no address literal and no local or internal name.
 */
export function cimdUrlProblem(id: string): string | null {
  if (id.length > URI_MAX) return "is too long";
  let u: URL;

  try {
    u = new URL(id);
  } catch {
    return "is not a URL";
  }

  if (u.protocol !== "https:" || u.port !== "" || u.pathname === "/" || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") {
    return "must be an https URL with a path and no port, query or fragment";
  }

  const host = u.hostname;

  if (host.startsWith("[") || /^[\d.]+$/.test(host) || !host.includes(".")) return "must name a host on the internet";

  if (/(^|\.)(localhost|local|internal|home|lan|test|invalid|example)$/.test(host)) return "must name a host on the internet";

  return null;
}

/** The redirect URIs of a document or a registration: one to ten, each allowed; else why not. */
export function redirectList(v: Json | undefined): string[] | string {
  if (!Array.isArray(v) || v.length === 0 || v.length > 10) return "redirect_uris must list one to ten URIs";
  const out: string[] = [];

  for (const uri of v) {
    if (!isText(uri)) return "redirect_uris must be strings";
    const problem = redirectProblem(uri);

    if (problem) return `a redirect URI ${problem}`;
    out.push(uri);
  }

  return out;
}

/** The body, read up to `max` bytes; null past it. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    size += value.byteLength;

    if (size > max) {
      await reader.cancel();

      return null;
    }

    parts.push(value);
  }

  const all = new Uint8Array(size);
  let at = 0;

  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }

  return new TextDecoder().decode(all);
}

/** A client's document as Pando saved it. */
interface SavedDocument {
  name: string;
  redirect_uris: string[];
}

/**
 * The documents of the hosts Pando's setup guide names, as they read on 2026-10-13, used only when the
 * live fetch fails: chatgpt.com answers a Worker's fetch of Codex's document with 403 (a bot check),
 * though it serves the same JSON to curl. The live document wins whenever it can be read.
 */
const SAVED_DOCUMENTS = new Map<string, SavedDocument>([
  ["https://claude.ai/oauth/claude-code-client-metadata", { name: "Claude Code", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"] }],
  ["https://chatgpt.com/oauth/codex/client.json", { name: "Codex", redirect_uris: ["http://127.0.0.1/callback", "http://localhost/callback"] }],
]);

/** A client's document: fetched, else Pando's saved copy of it when it has one, else why not. */
export async function fetchCimd(id: string): Promise<OAuthClient | string> {
  const live = await fetchLive(id);
  const saved = SAVED_DOCUMENTS.get(id);

  if (isText(live) && saved) return { id, kind: "cimd", name: saved.name, redirect_uris: saved.redirect_uris };

  return live;
}

/**
 * Fetch a Client ID Metadata Document: GET with no redirects followed, 5 seconds, 64 KiB, JSON. Its
 * client_id must equal the URL exactly, and it must name the client and list its redirect URIs.
 */
async function fetchLive(id: string): Promise<OAuthClient | string> {
  const problem = cimdUrlProblem(id);

  if (problem) return `the client_id ${problem}`;
  let res: Response;

  try {
    res = await fetch(id, { redirect: "manual", headers: { accept: "application/json", "user-agent": "Pando-MCP/1.0 (client metadata; +https://gitpando.com)" }, signal: AbortSignal.timeout(CIMD_TIMEOUT_MS) });
  } catch {
    return "the client's metadata document could not be fetched";
  }

  if (res.status !== 200) return `the client's metadata document answered ${res.status}`;

  if (!(res.headers.get("content-type") ?? "").includes("json")) return "the client's metadata document is not JSON";
  const text = await readCapped(res, CIMD_MAX_BYTES);

  if (text === null) return "the client's metadata document is over 64 KiB";
  const doc = parseJson(text);

  if (!isRecord(doc) || doc.client_id !== id) return "the client's metadata document names another client_id";
  const name = cleanName(doc.client_name);

  if (!name) return "the client's metadata document has no client_name";
  const uris = redirectList(doc.redirect_uris);

  if (!Array.isArray(uris)) return uris;

  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") return "only public clients (token_endpoint_auth_method none) may sign in";

  return { id, kind: "cimd", name, redirect_uris: uris };
}

interface ClientRow {
  id: string;
  kind: ClientKind;
  name: string;
  redirect_uris: string;
  fetched_at: string | null;
}

export interface CodeRow {
  login: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
}

export interface ConsentRow extends CodeRow {
  id: string;
  state: string | null;
}

/** What a code or a consent is made from. */
export interface GrantRequest {
  login: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
}

function asClient(row: ClientRow): OAuthClient {
  const uris = parseJson(row.redirect_uris);

  return { id: row.id, kind: row.kind, name: row.name, redirect_uris: Array.isArray(uris) ? uris.filter(isText) : [] };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The OAuth rows in the accounts database (migrations/0010_mcp_oauth.sql). */
export class OAuthStore {
  constructor(private db: D1Database) {}

  private st(query: string, ...args: (string | number | null)[]): D1PreparedStatement {
    return this.db.prepare(query).bind(...args);
  }

  /** A registered client, or a kept metadata document still fresh (null when it should be fetched again). */
  async client(id: string): Promise<OAuthClient | null> {
    const row = await this.st("SELECT id, kind, name, redirect_uris, fetched_at FROM oauth_clients WHERE id = ?1", id).first<ClientRow>();

    if (!row) return null;

    if (row.kind === "cimd" && (!row.fetched_at || Date.now() - Date.parse(row.fetched_at) > CIMD_KEEP_MS)) return null;

    return asClient(row);
  }

  /** A known client's name (a kept document of any age): the token door's check, which never fetches. */
  async nameOf(id: string): Promise<string | null> {
    return (await this.st("SELECT name FROM oauth_clients WHERE id = ?1", id).first<{ name: string }>())?.name ?? null;
  }

  /** Keep a fetched metadata document. */
  async keepCimd(c: OAuthClient): Promise<void> {
    const at = now();
    await this.st(
      `INSERT INTO oauth_clients (id, kind, name, redirect_uris, created_at, fetched_at) VALUES (?1, 'cimd', ?2, ?3, ?4, ?4)
       ON CONFLICT (id) DO UPDATE SET name = ?2, redirect_uris = ?3, fetched_at = ?4`,
      c.id, c.name, JSON.stringify(c.redirect_uris), at,
    ).run();
  }

  /**
   * Register a public client. Registrations unused for a day go first; past MAX_UNUSED_REGISTRATIONS
   * unused ones, the oldest go, so the cap never refuses a new one (one address filling it would
   * otherwise lock every new host out).
   */
  async register(name: string, uris: string[]): Promise<OAuthClient> {
    const id = `pmc_${newToken().slice("pando_".length)}`;
    const at = Date.now();
    await this.db.batch([
      this.st("DELETE FROM oauth_clients WHERE kind = 'dcr' AND used_at IS NULL AND created_at < ?1", iso(at - UNUSED_REGISTRATION_MS)),
      this.st(
        `DELETE FROM oauth_clients WHERE id IN (SELECT id FROM oauth_clients WHERE kind = 'dcr' AND used_at IS NULL
         ORDER BY created_at DESC LIMIT -1 OFFSET ?1)`,
        MAX_UNUSED_REGISTRATIONS - 1,
      ),
      this.st("INSERT INTO oauth_clients (id, kind, name, redirect_uris, created_at) VALUES (?1, 'dcr', ?2, ?3, ?4)", id, name, JSON.stringify(uris), iso(at)),
    ]);

    return { id, kind: "dcr", name, redirect_uris: uris };
  }

  /** The person already allowed this client: a credential it holds for them is live. */
  async allowed(login: string, clientId: string): Promise<boolean> {
    const row = await this.st("SELECT 1 AS one FROM credentials WHERE login = ?1 AND kind = 'mcp' AND client_id = ?2 AND revoked_at IS NULL LIMIT 1", login, clientId).first();

    return row !== null;
  }

  /** A consent waiting for the click; its id goes in the cookie and the form. */
  async newConsent(g: GrantRequest, state: string | null): Promise<string> {
    const id = newToken();
    await this.st(
      "INSERT INTO oauth_consents (id, login, client_id, redirect_uri, code_challenge, state, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      await hashToken(id), g.login, g.client_id, g.redirect_uri, g.code_challenge, state, iso(Date.now() + CONSENT_TTL_MS),
    ).run();

    return id;
  }

  /** Take a consent once: it is gone after this, whatever the click was. Null when unknown or expired. */
  async takeConsent(id: string): Promise<ConsentRow | null> {
    return this.st(
      "DELETE FROM oauth_consents WHERE id = ?1 AND expires_at > ?2 RETURNING id, login, client_id, redirect_uri, code_challenge, state",
      await hashToken(id), now(),
    ).first<ConsentRow>();
  }

  /** A one-time code for an allowed sign-in; the client is marked used. */
  async mintCode(g: GrantRequest): Promise<string> {
    const code = newToken();
    const at = Date.now();
    await this.db.batch([
      this.st(
        "INSERT INTO oauth_codes (hash, login, client_id, redirect_uri, code_challenge, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        await hashToken(code), g.login, g.client_id, g.redirect_uri, g.code_challenge, iso(at), iso(at + CODE_TTL_MS),
      ),
      this.st("UPDATE oauth_clients SET used_at = ?1 WHERE id = ?2 AND used_at IS NULL", iso(at), g.client_id),
      // Expired codes go as new ones are made.
      this.st("DELETE FROM oauth_codes WHERE expires_at < ?1", iso(at - CODE_TTL_MS)),
      this.st("DELETE FROM oauth_consents WHERE expires_at < ?1", iso(at)),
    ]);

    return code;
  }

  /** Use a code: one conditional write, so of two exchanges one wins, and it is spent before anything is checked. */
  async consumeCode(code: string): Promise<CodeRow | null> {
    return this.st(
      "UPDATE oauth_codes SET consumed_at = ?1 WHERE hash = ?2 AND consumed_at IS NULL AND expires_at > ?1 RETURNING login, client_id, redirect_uri, code_challenge",
      now(), await hashToken(code),
    ).first<CodeRow>();
  }

  /** The person and client of a live MCP credential, by its secret; null for any other credential. */
  async grantOf(secret: string): Promise<{ login: string; client_id: string } | null> {
    return this.st(
      "SELECT login, client_id FROM credentials WHERE hash = ?1 AND kind = 'mcp' AND revoked_at IS NULL AND client_id IS NOT NULL",
      await hashToken(secret),
    ).first<{ login: string; client_id: string }>();
  }
}
