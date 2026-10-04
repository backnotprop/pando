// Mirror to GitHub: the API (SPEC 5.3).
//
// Members, under /v1/monorepos/{owner}/{name}:
//   GET    /mirror                    the connection, the mode, the switch, one row per source
// Owners:
//   PATCH  /mirror                    {on}: the section's switch (off pauses)
//   GET    /mirror/github-repos       the installation's repositories, for Change
//   PUT    /mirror/targets            {mode, targets: [{repo, github_id | create: {name}, on}]}
//   POST   /mirror/run                {repos?}: Retry
//   DELETE /mirror                    Disconnect (GitHub is never touched)
//   GET    /mirror/connect?purpose=connect|create   302 to GitHub's authorization (a browser)
//   GET    /mirror/choices            the installations proven in this browser, when there were several
//   POST   /mirror/installation       {installation_id}: one of those
// GitHub:
//   GET    /v1/github/callback        back from GitHub's authorization or install (index.ts)
//
// Connecting proves, with a user token GitHub gives once and Pando revokes at
// once, that the person reaches the installation (GitHub's own check against
// a faked installation id). Nothing of the person's GitHub account is kept
// but its numeric id, beside the link.

import type { Context, Hono } from "hono";
import type * as Contract from "@pando/contract";
import type { Env } from "../env";
import { HttpError, now, toErrorResponse } from "../http";
import type { ApiVars } from "../monorepo/api";
import { readCookie } from "../accounts/auth";
import { withRepo } from "../monorepo/artifacts";
import { monorepoStub } from "../monorepo/session";
import type { RepoRecord } from "../monorepo/types";
import { isInteger, isRecord, isText, type Json, type JsonObject } from "../parse";
import {
  appConfigured, authorizeUrl, createRepo, installationRepos, installUrl, manageUrl, revokeUserToken, userInstallations, userToken,
  type GithubRepo, type Installation,
} from "./github";
import { META, WHOLE, type MirrorSettings, type TargetInput, type TargetView } from "./out";
import type { MirrorMode } from "./types";

type C = Context<{ Bindings: Env; Variables: ApiVars }>;

const STATE_COOKIE = "__Host-pando_gh";

const STATE_TTL_S = 600;

function bad(message: string): never {
  throw new HttpError(400, "bad_request", message);
}

function ownerOnly(c: C, what: string): void {
  if (c.get("identity").role !== "owner") throw new HttpError(403, "owner_only", `only an owner can ${what}`);
}

async function body(c: C): Promise<JsonObject> {
  const b = await c.req.json<Json>().catch(() => null);

  if (!isRecord(b)) bad("the body must be a JSON object");

  return b;
}

// ── The signed state cookie (connect and create) ────────────────────────────

/** What the browser carries to GitHub and back: whose request, for which repository, and what for. */
interface FlowState {
  m: string;
  full: string;
  login: string;
  nonce: string;
  purpose: "connect" | "create";
  exp: number;
  /** Installations proven in this browser when there were several to choose from. */
  ids?: number[];
}

const enc = new TextEncoder();

const b64u = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const unb64u = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

async function hmac(env: Env, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(`pando-mirror-state\n${env.GITHUB_APP_CLIENT_SECRET ?? ""}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));

  return b64u(String.fromCharCode(...sig));
}

async function sealState(env: Env, s: FlowState): Promise<string> {
  const payload = b64u(JSON.stringify(s));

  return `${payload}.${await hmac(env, payload)}`;
}

async function openState(env: Env, req: Request): Promise<FlowState | null> {
  const raw = readCookie(req, STATE_COOKIE);

  if (!raw) return null;
  const [payload, sig] = raw.split(".");

  if (!payload || !sig) return null;
  const want = await hmac(env, payload);

  if (want.length !== sig.length) return null;
  let diff = 0;

  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);

  if (diff !== 0) return null;
  const j: Json = JSON.parse(unb64u(payload));

  if (!isRecord(j) || !isText(j.m) || !isText(j.full) || !isText(j.login) || !isText(j.nonce) || !isInteger(j.exp) || j.exp < Date.now()) return null;
  const ids = Array.isArray(j.ids) ? j.ids.filter(isInteger) : undefined;

  return { m: j.m, full: j.full, login: j.login, nonce: j.nonce, purpose: j.purpose === "create" ? "create" : "connect", exp: j.exp, ids };
}

const stateCookie = (value: string, maxAge = STATE_TTL_S) => `${STATE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

function redirect(to: string, cookie?: string): Response {
  const headers = new Headers({ location: to, "cache-control": "no-store" });

  if (cookie) headers.append("set-cookie", cookie);

  return new Response(null, { status: 302, headers });
}

const callbackUrl = (req: Request) => `${new URL(req.url).origin}/v1/github/callback`;

// ── Reading ─────────────────────────────────────────────────────────────────

/** The repos' paths as people see them: the files outside projects/ have none. */
const pathOf = (r: RepoRecord) => (r.name === META ? "" : r.path);

/** Commits on main not yet on GitHub (up to 100, then 100), when a target is behind. */
async function behind(c: C, repo: RepoRecord, sent: string | undefined): Promise<number | null> {
  if (!sent) return null;

  try {
    const log = await withRepo(c.env, repo.artifacts_name, (r) => r.log({ ref: repo.default_branch || "main", limit: 100 }));
    const i = log.findIndex((x) => x.hash === sent);

    return i >= 0 ? i : 100;
  } catch {
    return null;
  }
}

const BEHIND_STATES = new Set(["waiting", "paused", "retrying", "no_access", "not_found", "refused"]);

async function mirrorView(c: C): Promise<typeof Contract.Mirror.Encoded> {
  const { settings, targets, repos } = await c.get("stub").mirrorState();
  const byRepo = new Map(targets.map((t) => [t.repo, t]));
  const rows = settings?.mode === "whole" ? [WHOLE] : repos.map((r) => r.name);

  const out = await Promise.all(
    rows.map(async (name) => {
      const t: TargetView | undefined = byRepo.get(name);
      const repo = repos.find((r) => r.name === name);
      const n = t && repo && BEHIND_STATES.has(t.state) ? await behind(c, repo, t.sent[name]) : null;

      return {
        repo: name,
        path: name === WHOLE ? "*" : repo ? pathOf(repo) : name,
        on: t?.on ?? false,
        github: t ? t.github : null,
        state: t?.state ?? "off",
        last: t?.last ?? null,
        behind: n,
        waiting_since: t?.waiting_since ?? null,
        next_try_at: t?.next_try_at ?? null,
        problem: t?.problem ?? null,
      };
    }),
  );

  return {
    app: { configured: appConfigured(c.env) },
    connection: settings ? connectionOf(c.env, settings) : null,
    mode: settings?.mode ?? "projects",
    on: settings?.on ?? false,
    started: settings?.started ?? false,
    paused: settings?.paused_at ? { by: settings.paused_by ?? "", at: settings.paused_at } : null,
    targets: out,
  };
}

function connectionOf(env: Env, s: MirrorSettings) {
  return {
    installation_id: s.installation_id,
    login: s.account_login,
    type: s.account_type,
    repository_selection: s.repository_selection,
    manage_url: manageUrl(env, s.installation_id, s.account_type, s.account_login),
    connected_at: s.connected_at,
    connected_by: s.connected_by,
  };
}

// ── Linking a proven installation ───────────────────────────────────────────

export async function linkInstallation(env: Env, monorepoId: string, i: Installation, login: string, githubUser: number): Promise<void> {
  const at = now();
  await env.ACCOUNTS_DB.batch([
    env.ACCOUNTS_DB.prepare(
      `INSERT INTO github_installations (id, account_id, account_login, account_type, repository_selection, suspended_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type,
         repository_selection = excluded.repository_selection, suspended_at = excluded.suspended_at, updated_at = excluded.updated_at`,
    ).bind(i.id, i.account_id, i.account_login, i.account_type, i.repository_selection, i.suspended ? at : null, at),
    env.ACCOUNTS_DB.prepare(
      `INSERT INTO github_mirror_links (monorepo_id, installation_id, linked_by, github_user_id, linked_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (monorepo_id) DO UPDATE SET installation_id = excluded.installation_id, linked_by = excluded.linked_by,
         github_user_id = excluded.github_user_id, linked_at = excluded.linked_at`,
    ).bind(monorepoId, i.id, login, githubUser, at),
  ]);
  await monorepoStub(env, monorepoId).mirrorLink(
    { id: i.id, account_login: i.account_login, account_type: i.account_type, repository_selection: i.repository_selection },
    login,
  );
}

// ── Saving targets ──────────────────────────────────────────────────────────

/** One requested target: an existing GitHub repository by id, or one to create by name. */
interface Wanted {
  repo: string;
  on: boolean;
  github_id: number | null;
  create: string | null;
}

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

function wantedOf(v: Json, sources: Set<string>): Wanted {
  if (!isRecord(v) || !isText(v.repo) || !sources.has(v.repo)) bad("each target names a repo of this repository (or * in whole mode)");
  const on = v.on !== false;
  const create = isRecord(v.create) && isText(v.create.name) ? v.create.name : null;

  if (create !== null && !REPO_NAME.test(create)) bad(`${create} is not a GitHub repository name`);
  const id = isInteger(v.github_id) ? v.github_id : null;

  if (on && id === null && create === null) bad(`${v.repo}: github_id or create`);

  return { repo: v.repo, on, github_id: id, create };
}

/** Targets with existing repositories, resolved against the installation's list (a repository it cannot reach is refused). */
async function resolve(env: Env, installation: number, wanted: Wanted[], made: Map<string, GithubRepo> = new Map()): Promise<TargetInput[]> {
  const needList = wanted.some((w) => w.github_id !== null && !made.has(w.repo));
  const list = needList ? await installationRepos(env, installation) : [];
  const out: TargetInput[] = [];

  for (const w of wanted) {
    const github = made.get(w.repo) ?? list.find((r) => r.id === w.github_id);

    if (!github) {
      if (!w.on) continue; // off, with nothing to keep
      throw new HttpError(422, "github_repo_unreachable", `the Pando app cannot reach GitHub repository ${w.github_id}; add it to the app's repositories on GitHub`);
    }

    out.push({ repo: w.repo, github, on: w.on });
  }

  return out;
}

// ── Routes ──────────────────────────────────────────────────────────────────

export function mirrorRoutes(api: Hono<{ Bindings: Env; Variables: ApiVars }>): void {
  const base = "/v1/monorepos/:o/:m/mirror";

  api.get(base, async (c) => c.json((await mirrorView(c)) satisfies typeof Contract.Mirror.Encoded));

  api.patch(base, async (c) => {
    ownerOnly(c, "turn mirroring on or off");
    const b = await body(c);

    if (b.on !== true && b.on !== false) bad("on: true or false");
    await c.get("stub").mirrorSetOn(b.on, c.get("identity").login);

    return c.json(await mirrorView(c));
  });

  api.delete(base, async (c) => {
    ownerOnly(c, "disconnect GitHub");
    await c.get("stub").mirrorDisconnect();
    await c.env.ACCOUNTS_DB.prepare("DELETE FROM github_mirror_links WHERE monorepo_id = ?1").bind(c.get("m")).run();

    return c.body(null, 204);
  });

  api.get(`${base}/github-repos`, async (c) => {
    ownerOnly(c, "list GitHub repositories");
    const { settings } = await c.get("stub").mirrorState();

    if (!settings) throw new HttpError(409, "not_connected", "connect GitHub first");

    return c.json({
      account: settings.account_login,
      repos: await installationRepos(c.env, settings.installation_id),
      add_url: manageUrl(c.env, settings.installation_id, settings.account_type, settings.account_login),
    } satisfies typeof Contract.GithubRepos.Encoded);
  });

  api.put(`${base}/targets`, async (c) => {
    ownerOnly(c, "choose where the repository mirrors");
    const b = await body(c);
    const mode: MirrorMode = b.mode === "whole" ? "whole" : "projects";
    const { settings, repos } = await c.get("stub").mirrorState();

    if (!settings) throw new HttpError(409, "not_connected", "connect GitHub first");
    const sources = new Set(mode === "whole" ? [WHOLE] : repos.map((r) => r.name));

    if (!Array.isArray(b.targets)) bad("targets: a list");
    const wanted = b.targets.map((t) => wantedOf(t, sources));

    // Repositories to create: GitHub's authorization once more, then the callback creates them, saves, and returns.
    if (wanted.some((w) => w.on && w.create !== null)) {
      await c.get("stub").mirrorSetPending(JSON.stringify({ mode, wanted, by: c.get("identity").login }));

      return c.json({ mirror: await mirrorView(c), authorize_url: `/v1/monorepos/${c.get("full")}/mirror/connect?purpose=create` } satisfies typeof Contract.MirrorSaved.Encoded);
    }

    await c.get("stub").mirrorSave(mode, await resolve(c.env, settings.installation_id, wanted), c.get("identity").login);

    return c.json({ mirror: await mirrorView(c), authorize_url: null } satisfies typeof Contract.MirrorSaved.Encoded);
  });

  api.post(`${base}/run`, async (c) => {
    ownerOnly(c, "retry the mirror");
    const b = await c.req.json<Json>().catch(() => null);
    const repos = isRecord(b) && Array.isArray(b.repos) ? b.repos.filter(isText) : null;
    const queued = await c.get("stub").mirrorRetry(repos);

    return c.json({ queued, skipped: [] } satisfies typeof Contract.MirrorQueued.Encoded, 202);
  });

  // A browser on its way to GitHub: the state goes in a short signed cookie, and only its nonce to GitHub.
  api.get(`${base}/connect`, async (c) => {
    ownerOnly(c, "connect GitHub");

    if (!appConfigured(c.env)) throw new HttpError(503, "github_app_missing", "the GitHub App is not set up on this server");
    const purpose = c.req.query("purpose") === "create" ? "create" : "connect";
    const nonce = crypto.randomUUID();
    const state = await sealState(c.env, { m: c.get("m"), full: c.get("full"), login: c.get("identity").login, nonce, purpose, exp: Date.now() + STATE_TTL_S * 1000 });

    return redirect(authorizeUrl(c.env, nonce, callbackUrl(c.req.raw)), stateCookie(state));
  });

  api.get(`${base}/choices`, async (c) => {
    ownerOnly(c, "connect GitHub");
    const st = await openState(c.env, c.req.raw);

    if (!st || st.m !== c.get("m") || !st.ids?.length) return c.json({ installations: [] } satisfies typeof Contract.GithubChoices.Encoded);

    const rows = await c.env.ACCOUNTS_DB.prepare(`SELECT id, account_login, account_type, repository_selection FROM github_installations WHERE id IN (${st.ids.map(() => "?").join(",")})`)
      .bind(...st.ids)
      .all<{ id: number; account_login: string; account_type: string; repository_selection: string }>();

    return c.json({
      installations: rows.results.map((r) => ({ installation_id: r.id, login: r.account_login, type: r.account_type === "Organization" ? "Organization" : "User", repository_selection: r.repository_selection === "all" ? "all" : "selected" })),
    } satisfies typeof Contract.GithubChoices.Encoded);
  });

  api.post(`${base}/installation`, async (c) => {
    ownerOnly(c, "connect GitHub");
    const b = await body(c);
    const st = await openState(c.env, c.req.raw);

    if (!isInteger(b.installation_id) || !st || st.m !== c.get("m") || !st.ids?.includes(b.installation_id)) {
      throw new HttpError(403, "not_proven", "that installation was not proven in this browser; connect GitHub again");
    }

    const r = await c.env.ACCOUNTS_DB.prepare("SELECT id, account_id, account_login, account_type, repository_selection, suspended_at FROM github_installations WHERE id = ?1")
      .bind(b.installation_id)
      .first<{ id: number; account_id: number; account_login: string; account_type: string; repository_selection: string; suspended_at: string | null }>();

    if (!r) throw new HttpError(404, "not_found", "no such installation");

    const i: Installation = {
      id: r.id, account_id: r.account_id, account_login: r.account_login, account_type: r.account_type === "Organization" ? "Organization" : "User",
      repository_selection: r.repository_selection === "all" ? "all" : "selected", suspended: !!r.suspended_at,
    };

    await linkInstallation(c.env, c.get("m"), i, c.get("identity").login, 0);

    return c.json(await mirrorView(c));
  });
}

// ── Back from GitHub ────────────────────────────────────────────────────────

/** GET /v1/github/callback?code=&state=: the authorization (or install) is done; connect, or create and save. */
export async function githubCallback(req: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(req.url);
    const st = await openState(env, req);
    const code = url.searchParams.get("code");

    if (!st || !code || url.searchParams.get("state") !== st.nonce) {
      throw new HttpError(400, "bad_state", "this GitHub answer does not match a connect started in this browser; start again from the repository's Settings");
    }

    const settings = `/${st.full}/settings`;
    const token = await userToken(env, code);

    try {
      return st.purpose === "create" ? await createAndSave(env, st, token, settings) : await connectWith(env, st, token, url, settings);
    } finally {
      await revokeUserToken(env, token);
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function connectWith(env: Env, st: FlowState, token: string, url: URL, settings: string): Promise<Response> {
  const { user_id, installations } = await userInstallations(env, token);
  const asked = Number(url.searchParams.get("installation_id"));
  const pick = installations.find((i) => i.id === asked) ?? (installations.length === 1 ? installations[0] : null);

  // Not installed yet: GitHub's install page, which comes back here (the app asks for authorization at install).
  if (!installations.length) return redirect(installUrl(env, st.nonce), stateCookie(await sealState(env, st)));

  if (!pick) {
    // Several: remember which this browser proved, and let the person choose.
    for (const i of installations) await upsertInstallation(env, i);

    return redirect(`${settings}?mirror=choose`, stateCookie(await sealState(env, { ...st, ids: installations.map((i) => i.id) })));
  }

  await linkInstallation(env, st.m, pick, st.login, user_id);

  return redirect(`${settings}?mirror=match`, stateCookie("", 0));
}

async function upsertInstallation(env: Env, i: Installation): Promise<void> {
  await env.ACCOUNTS_DB.prepare(
    `INSERT INTO github_installations (id, account_id, account_login, account_type, repository_selection, suspended_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type, repository_selection = excluded.repository_selection, updated_at = excluded.updated_at`,
  ).bind(i.id, i.account_id, i.account_login, i.account_type, i.repository_selection, i.suspended ? now() : null, now()).run();
}

async function createAndSave(env: Env, st: FlowState, token: string, settings: string): Promise<Response> {
  const stub = monorepoStub(env, st.m);
  const { settings: s, pending } = await stub.mirrorState();
  const p: Json = pending ? JSON.parse(pending) : null;

  if (!s || !isRecord(p) || !Array.isArray(p.wanted)) return redirect(settings, stateCookie("", 0));
  const mode: MirrorMode = p.mode === "whole" ? "whole" : "projects";

  const wanted: Wanted[] = p.wanted.filter(isRecord).map((w) => ({
    repo: isText(w.repo) ? w.repo : "", on: w.on !== false, github_id: isInteger(w.github_id) ? w.github_id : null, create: isText(w.create) ? w.create : null,
  }));

  const made = new Map<string, GithubRepo>();

  for (const w of wanted) {
    if (w.on && w.create) made.set(w.repo, await createRepo(env, token, { login: s.account_login, type: s.account_type }, w.create));
  }

  await stub.mirrorSave(mode, await resolve(env, s.installation_id, wanted, made), isText(p.by) ? p.by : st.login);
  await stub.mirrorSetPending(null);

  return redirect(settings, stateCookie("", 0));
}
