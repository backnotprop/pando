// The /v1 API (docs/contracts/api-v1.yaml), except the meta layer's routes.

import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { agentHeader, credential, HttpError, toErrorResponse } from "../http";
import { APP_SLUG, authorizeStatusToken, isStatusToken, type StatusStamp } from "../ci/statustoken";
import { ciRoutes } from "../ci/routes";
import { finishTiming, note, runTimed, startTiming, timedArtifacts } from "../timing";
import { artifactsCode, artifactsError, branchesOf, listRefs, updateRefs, withRepo } from "./artifacts";
import { combine, requiredKept } from "./checks";
import { toPatch, treeDiff } from "./diff";
import { commitReader, compareWith } from "./graph";
import * as views from "./views";
import type { BranchList } from "./views";
import { computeFacts, INLINE_MAX, SWEEP_PARALLEL } from "./facts";
import * as files from "./files";
import { objectsClient } from "../objects";
import { EVENT_STREAM, parseTopics } from "./stream";
import {
  artifactsRepoName,
  DEFAULT_BRANCH,
  isSha,
  metaArtifactsName,
  monorepoRef,
  repoNameFor,
  validBranchName,
  validMonorepoName,
  validRepoPath,
  ZERO,
} from "./names";
import type { MonorepoObject } from "./object";
import { cachedRepo, forgetRepos, hashToken, monorepoStub, newToken } from "./session";
import type { BranchRecord, Identity, MonorepoInfo, Outcome, RepoEvent, RepoRecord, StatusRecord } from "./types";
import { accounts, authenticateRequest, forgetCachedAuth, identityOf } from "../accounts/auth";
import type { Auth } from "../accounts/object";
import { feedMembership, membersBeforeDelete } from "../feed/membership";
import { monoreposSummary } from "../feed/routes";

type Stub = DurableObjectStub<MonorepoObject>;
// m: the monorepo's id (storage); full: its owner/name (what people see).
// stamp: set only for a request carrying a status token (ci/statustoken.ts).
type Vars = { identity: Identity; info: MonorepoInfo; stub: Stub; m: string; full: string; stamp?: StatusStamp };
type C = Context<{ Bindings: Env; Variables: Vars }>;
export type ApiVars = Vars;

export const api = new Hono<{ Bindings: Env; Variables: Vars }>();

api.onError((err) => toErrorResponse(err));

// One pando.timing line per request (timing.ts): where its time went.
api.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const m = path.match(/^\/v1\/monorepos\/([^/]+)\/([^/]+)(?:\/repos\/([^/]+))?/);
  const t = startTiming("api", {
    method: c.req.method,
    path,
    monorepo: m ? `${m[1]}/${m[2]}`.toLowerCase() : null,
    repo: m?.[3] ?? null,
    colo: (c.req.raw as Request & { cf?: { colo?: string } }).cf?.colo,
  });
  try {
    await runTimed(t, () => next());
  } finally {
    finishTiming(t, { status: c.res?.status });
  }
});
api.notFound(() => toErrorResponse(new HttpError(404, "not_found", "no such route")));

function unwrap<T>(o: Outcome<T>): T {
  if (o.ok) return o.value;
  throw new HttpError(o.status, o.code, o.message, o.extra ?? {});
}

function bad(message: string): never {
  throw new HttpError(400, "bad_request", message);
}

async function body<T = Record<string, unknown>>(c: C): Promise<T> {
  try {
    const b = await c.req.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) bad("the body must be a JSON object");
    return b as T;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    bad("the body must be JSON");
  }
}

function str(v: unknown, field: string, opts: { optional?: boolean; max?: number } = {}): string | undefined {
  if (v === undefined || v === null) {
    if (opts.optional) return undefined;
    bad(`${field} is required`);
  }
  if (typeof v !== "string" || (!opts.optional && v.length === 0)) bad(`${field} must be a string`);
  if (v.length > (opts.max ?? 10_000)) bad(`${field} is too long`);
  return v;
}

function owner(c: C, what: string): Identity {
  const id = c.get("identity");
  if (id.role !== "owner") throw new HttpError(403, "owner_only", `only an owner can ${what}`);
  return id;
}

/** git URLs (NAMESPACES.md): /owner/monorepo/repo.git, or /owner/name.git for a plain repo. */
function cloneUrl(c: C, repoName: string): string {
  const origin = new URL(c.req.url).origin;
  return c.get("info").kind === "repo" ? `${origin}/${c.get("full")}.git` : `${origin}/${c.get("full")}/${repoName}.git`;
}

/** The raw path after /v1/monorepos/{o}/{m}/repos/{r}/{what}/, as sent (any case, an old name). */
function rawTail(c: C): string {
  return new URL(c.req.url).pathname.split("/").slice(8).join("/");
}

function repoView(c: C, r: RepoRecord, required?: string[]) {
  return {
    monorepo: c.get("full"),
    name: r.name,
    path: r.path,
    description: r.description,
    default_branch: r.default_branch,
    clone_url: cloneUrl(c, r.name),
    ...(required ? { required_checks: required } : {}),
    created_at: r.created_at,
    created_by: r.created_by,
  };
}

async function repoOf(c: C): Promise<RepoRecord> {
  const r = await cachedRepo(c.env, c.get("m"), c.req.param("r")!);
  if (!r) throw new HttpError(404, "not_found", `no repo ${c.req.param("r")}`);
  return r;
}

/**
 * Make an empty Artifacts repo; drop the token it comes with. Artifacts
 * deletes repos in the background, so a name deleted moments ago (a monorepo
 * deleted and made again) can still read as taken: wait for it, up to about
 * 15 s. A repo that stays (a retry of a half-made monorepo) is reused.
 */
async function createArtifactsRepo(env: Env, name: string, description: string): Promise<string> {
  let created: ArtifactsCreateRepoResult | null = null;
  for (const wait of [500, 1000, 2000, 4000, 8000, 0]) {
    try {
      created = await timedArtifacts(env.ARTIFACTS).create(name, { setDefaultBranch: DEFAULT_BRANCH, description });
      break;
    } catch (err) {
      const code = artifactsCode(err);
      if (code === "INVALID_REPO_NAME") throw new HttpError(400, "bad_name", `Artifacts refused the repo name ${name}`);
      if (code !== "ALREADY_EXISTS") throw artifactsError(err, `creating ${name}`);
      if (wait) await new Promise((r) => setTimeout(r, wait));
    }
  }
  return withRepo(env, name, async (repo) => {
    if (created) await repo.revokeToken(created.token).catch(() => false);
    return created?.remote ?? (await repo.info()).remote;
  });
}

// ── Users and credentials ─────────────────────────────────────────────────

type UserVars = { auth: Auth };
const userAuthed = async (c: Context<{ Bindings: Env; Variables: Vars & UserVars }>, next: () => Promise<void>) => {
  const auth = await authenticateRequest(c.env, c.req.raw, null);
  if (!auth) throw new HttpError(401, "unauthorized", "unknown, expired or revoked credential");
  c.set("auth", auth);
  await next();
};
const users = new Hono<{ Bindings: Env; Variables: Vars & UserVars }>();
users.onError((err) => toErrorResponse(err));
users.use("/v1/user", userAuthed);
users.use("/v1/user/*", userAuthed);
users.use("/v1/monorepos", userAuthed);

users.get("/v1/user", (c) => {
  const a = c.get("auth");
  return c.json({ ...a.user, credential: a.credential });
});

users.post("/v1/user/credentials", async (c) => {
  const a = c.get("auth");
  const b = await body(c as unknown as C);
  const name = str(b.name, "name", { max: 200 })!;
  const kind = b.kind ?? "machine";
  if (kind !== "machine" && kind !== "sandbox") bad("kind is machine or sandbox");
  const secret = newToken();
  const cred = await accounts(c.env).addCredential(a.user.login, { hash: await hashToken(secret), name, kind });
  return c.json({ ...cred, secret }, 201);
});

users.get("/v1/user/credentials", async (c) => {
  return c.json({ credentials: await accounts(c.env).listCredentials(c.get("auth").user.login) });
});

users.delete("/v1/user/credentials/:id", async (c) => {
  if (!(await accounts(c.env).revokeCredential(c.get("auth").user.login, c.req.param("id")))) {
    throw new HttpError(404, "not_found", "no such credential");
  }
  forgetCachedAuth();
  return c.body(null, 204);
});

// ── Monorepos ─────────────────────────────────────────────────────────────

// ?name=<name>: the caller's monorepos with that name, under any owner, their own first (pando clone <name>).
users.get("/v1/monorepos", async (c) => {
  if (c.req.query("summary") === "1") return c.json(await monoreposSummary(c.env, c.get("auth").user.login));
  const name = c.req.query("name")?.toLowerCase();
  if (name !== undefined && !validMonorepoName(name)) return c.json({ monorepos: [] });
  return c.json({ monorepos: await accounts(c.env).monoreposOf(c.get("auth").user.login, name) });
});

users.post("/v1/monorepos", async (c) => {
  const a = c.get("auth");
  const b = await body(c as unknown as C);
  const name = typeof b.name === "string" ? b.name.toLowerCase() : null;
  if (!validMonorepoName(name)) bad("name: letters, digits, '.', '_', '-'; starts with a letter or digit; no '--'; at most 39 characters");
  const kind = b.kind ?? "monorepo";
  if (kind !== "monorepo" && kind !== "repo") bad("kind is monorepo or repo");
  // owner: your own namespace (organizations come later).
  const ownerName = typeof b.owner === "string" ? b.owner.toLowerCase() : a.user.login;
  if (ownerName !== a.user.login) throw new HttpError(403, "not_your_namespace", `you can make monorepos under ${a.user.login} only (organizations come later)`);
  const acc = accounts(c.env);
  const claimed = await acc.claimMonorepo(ownerName, name, kind, a.user.login);
  if (!claimed) throw new HttpError(409, "monorepo_exists", `${ownerName}/${name} exists`);
  const { info, replaced_alias } = claimed;
  const stub = monorepoStub(c.env, info.id);
  try {
    if (!(await stub.init(info.id, info.full_name, kind))) throw new HttpError(409, "monorepo_exists", `${info.full_name} exists`);
    const repos: RepoRecord[] = [];
    if (kind === "monorepo") {
      await createArtifactsRepo(c.env, metaArtifactsName(info.id), `Pando meta layer of ${info.full_name}`);
    } else {
      const artifacts_name = artifactsRepoName(info.id, name);
      const remote = await createArtifactsRepo(c.env, artifacts_name, `Pando repo ${info.full_name}`);
      const rec: RepoRecord = {
        name, path: ".", artifacts_name, remote, default_branch: DEFAULT_BRANCH, description: null,
        created_at: new Date().toISOString(), created_by: a.user.login,
      };
      repos.push(unwrap(await stub.addRepo(rec)));
    }
    forgetCachedAuth();
    await feedMembership(c.env, info.id, [a.user.login]);
    c.set("m", info.id);
    c.set("full", info.full_name);
    c.set("info", info);
    return c.json({ monorepo: { ...info, role: "owner" }, repos: repos.map((r) => repoView(c as unknown as C, r)), replaced_alias }, 201);
  } catch (err) {
    await acc.releaseMonorepo(info.id);
    await stub.destroy();
    throw err;
  }
});

api.route("/", users);

// Every route under one monorepo: members only.
const authed = async (c: C, next: () => Promise<void>) => {
  const asked = `${c.req.param("o")}/${c.req.param("m")}`;
  const ref = monorepoRef(c.req.param("o"), c.req.param("m"));
  if (!ref) throw new HttpError(404, "not_found", `no monorepo ${asked}`);
  const bearer = credential(c.req.raw);
  if (isStatusToken(bearer)) {
    // A status token (FILES.md section 4): one route, one repo, one commit; no user.
    const info = await accounts(c.env).resolve(ref);
    if (!info) throw new HttpError(404, "not_found", `no monorepo ${ref.owner}/${ref.name}`);
    const stamp = await authorizeStatusToken(c.env, c.req.raw, bearer!, info.id);
    c.set("m", info.id);
    c.set("full", info.full_name);
    c.set("stub", monorepoStub(c.env, info.id));
    c.set("info", info);
    c.set("stamp", stamp);
    c.set("identity", { login: stamp.creator, name: null, email: null, credential_id: "status-token", credential_name: stamp.creator, role: "member", agent: null });
    note({ monorepo: info.full_name, monorepo_id: info.id, status_token: stamp.creator });
    return next();
  }
  const auth = await authenticateRequest(c.env, c.req.raw, ref);
  if (!auth) throw new HttpError(401, "unauthorized", "unknown, expired or revoked credential");
  if (!auth.monorepo) throw new HttpError(404, "not_found", `no monorepo ${ref.owner}/${ref.name}`);
  if (!auth.role) throw new HttpError(403, "not_a_member", `${auth.user.login} is not a member of ${auth.monorepo.full_name}`);
  c.set("m", auth.monorepo.id);
  c.set("full", auth.monorepo.full_name);
  c.set("stub", monorepoStub(c.env, auth.monorepo.id));
  c.set("info", auth.monorepo);
  note({ monorepo: auth.monorepo.full_name, monorepo_id: auth.monorepo.id });
  c.set("identity", { ...identityOf(auth), agent: agentHeader(c.req.raw) });
  await next();
};
api.use("/v1/monorepos/:o/:m", authed);
api.use("/v1/monorepos/:o/:m/*", authed);

api.get("/v1/monorepos/:o/:m", (c) => c.json({ ...c.get("info"), role: c.get("identity").role }));

// Rename or transfer: the label moves, the id and everything stored stay. The old name keeps working (an alias).
api.patch("/v1/monorepos/:o/:m", async (c) => {
  owner(c, "rename or transfer a monorepo");
  const b = await body(c);
  const info = c.get("info");
  const to = monorepoRef(b.owner === undefined ? info.owner : String(b.owner), b.name === undefined ? info.name : String(b.name));
  if (!to) bad("name: letters, digits, '.', '_', '-'; owner: a person's login");
  const out = unwrap(await accounts(c.env).renameMonorepo(info.id, to));
  await c.get("stub").setLabel(out.info.full_name);
  forgetCachedAuth();
  return c.json({ ...out.info, role: "owner", replaced_alias: out.replaced_alias });
});

api.delete("/v1/monorepos/:o/:m", async (c) => {
  owner(c, "delete a monorepo");
  const m = c.get("m");
  const info = c.get("info");
  // The full owner/name, typed out (GitHub's way): a bare name is too easy to get wrong across owners.
  if (c.req.query("confirm")?.toLowerCase() !== info.full_name) bad(`add ?confirm=${info.full_name} to delete ${info.full_name}, its repos and their history`);
  const stub = c.get("stub");
  // Every Artifacts repo it owns: the recorded ones, and any other <id>--* in
  // the namespace (ids and old names have no "--", so the prefix is its alone).
  const names = new Set(await stub.artifactsRepos());
  let cursor: string | undefined;
  do {
    const page = await timedArtifacts(c.env.ARTIFACTS).list({ limit: 200, cursor });
    for (const r of page.repos) if (r.name.startsWith(`${m}--`)) names.add(r.name);
    cursor = page.repos.length ? page.cursor : undefined;
  } while (cursor);
  for (const name of names) {
    try {
      await timedArtifacts(c.env.ARTIFACTS).delete(name);
    } catch (err) {
      if (artifactsCode(err) !== "NOT_FOUND") throw artifactsError(err, `deleting ${name}`);
    }
  }
  // The meta layer's large files in R2, and CI details cached there (ci/routes.ts).
  for (const prefix of [`meta/${m}/`, `ci/${m}/`]) {
    let more = true;
    while (more) {
      const listed = await c.env.BLOBS.list({ prefix, limit: 1000 });
      if (listed.objects.length) await c.env.BLOBS.delete(listed.objects.map((o) => o.key));
      more = listed.truncated;
    }
  }
  // The live meta layer: closes its sockets and clears its storage, so the name starts clean.
  if (c.get("info").kind === "monorepo") await c.env.META.get(c.env.META.idFromName(m)).destroy();
  const leaving = await membersBeforeDelete(c.env, m);
  await stub.destroy();
  forgetRepos(m);
  await accounts(c.env).releaseMonorepo(m);
  forgetCachedAuth();
  await feedMembership(c.env, m, leaving);
  return c.body(null, 204);
});

// ── Heads: every repo's main, for followers ───────────────────────────────

api.get("/v1/monorepos/:o/:m/heads", async (c) => {
  const stub = c.get("stub");
  const heads = await stub.heads();
  // A repo made before Pando kept heads: read it once from Artifacts and keep it.
  const unknown = heads.filter((h) => h.head === null);
  if (unknown.length) {
    await views.pool(unknown, 4, async (h) => {
      const r = await stub.getRepo(h.repo);
      if (!r) return;
      const sha = branchesOf(await listRefs(c.env, r).catch(() => new Map<string, string>())).get(r.default_branch) ?? null;
      if (sha) {
        h.head = sha;
        await stub.rememberHead(h.repo, sha);
      }
    });
  }
  // `seq`: open the event socket with ?since=<seq>&topics=main to miss nothing after this answer.
  const seq = EVENT_STREAM ? await stub.eventHead() : null;
  return c.json({ heads, seq });
});

// ── The event stream ──────────────────────────────────────────────────────

api.get("/v1/monorepos/:o/:m/events", async (c) => {
  if (!EVENT_STREAM) throw new HttpError(501, "event_stream_on_hold", "the event stream is built but on hold until the architecture review decides where events live");
  const stub = c.get("stub");
  if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-pando-login", c.get("identity").login);
    headers.set("x-pando-machine", c.get("identity").credential_name);
    return stub.fetch(new Request(c.req.raw, { headers }));
  }
  const sinceQ = c.req.query("since");
  const since = sinceQ === undefined || sinceQ === "" ? null : Number(sinceQ);
  if (since !== null && (!Number.isSafeInteger(since) || since < 0)) bad("since must be a whole number");
  const limit = Number(c.req.query("limit") ?? "100");
  if (!Number.isInteger(limit) || limit < 1) bad("limit must be a whole number from 1");
  const topics = parseTopics(c.req.query("topics") ?? null);
  if (!topics) bad("topics: up to 10 of all, main, main:<repo>, repo:<repo>, meta, kind:<kind>, comma-separated");
  return c.json(await stub.events(since, limit, topics));
});

// ── Members ───────────────────────────────────────────────────────────────

api.get("/v1/monorepos/:o/:m/members", async (c) => {
  return c.json({ members: await accounts(c.env).members(c.get("m")) });
});

api.put("/v1/monorepos/:o/:m/members/:login", async (c) => {
  const by = owner(c, "manage members");
  const b = await body(c);
  if (b.role !== "owner" && b.role !== "member") bad("role is owner or member");
  const out = unwrap(await accounts(c.env).putMember(c.get("m"), c.req.param("login"), b.role, by.login));
  forgetCachedAuth();
  await feedMembership(c.env, c.get("m"), [out.login]);
  return c.json(out);
});

api.delete("/v1/monorepos/:o/:m/members/:login", async (c) => {
  owner(c, "manage members");
  unwrap(await accounts(c.env).removeMember(c.get("m"), c.req.param("login")));
  forgetCachedAuth();
  await feedMembership(c.env, c.get("m"), [c.req.param("login")]);
  return c.body(null, 204);
});

// ── Invites by email ──────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

api.post("/v1/monorepos/:o/:m/invites", async (c) => {
  const by = owner(c, "invite people");
  const b = await body(c);
  const email = str(b.email, "email", { max: 200 })!;
  if (!EMAIL_RE.test(email)) bad("email is not an email address");
  const role = b.role ?? "member";
  if (role !== "owner" && role !== "member") bad("role is owner or member");
  const out = unwrap(await accounts(c.env).invite(c.get("m"), email, role, by.login));
  forgetCachedAuth();
  if (out.status === "added") await feedMembership(c.env, c.get("m"), [out.member.login]);
  return c.json(out, out.status === "added" ? 200 : 201);
});

api.get("/v1/monorepos/:o/:m/invites", async (c) => {
  return c.json({ invites: await accounts(c.env).invites(c.get("m")) });
});

api.delete("/v1/monorepos/:o/:m/invites/:email", async (c) => {
  owner(c, "revoke invites");
  if (!(await accounts(c.env).revokeInvite(c.get("m"), decodeURIComponent(c.req.param("email"))))) {
    throw new HttpError(404, "not_found", "no such invite");
  }
  return c.body(null, 204);
});

// ── Repos ─────────────────────────────────────────────────────────────────

api.post("/v1/monorepos/:o/:m/repos", async (c) => {
  const by = c.get("identity");
  const b = await body(c);
  const info = c.get("info");
  if (info.kind === "repo") throw new HttpError(409, "plain_repo", "a plain git repo has exactly one repo");
  if (!validRepoPath(b.path) || b.path === ".") bad("path: a repo path such as projects/web");
  const name = repoNameFor(info.name, b.path);
  if (!name) bad(`path ${b.path} gives no usable repo name (names are the path with / turned into -, no '--', not 'meta')`);
  const description = str(b.description, "description", { optional: true, max: 1000 }) ?? null;
  const stub = c.get("stub");
  const existing = (await stub.listRepos()).find((r) => r.name === name || r.path === b.path);
  if (existing) throw new HttpError(409, "repo_exists", `a repo named ${existing.name} at ${existing.path} exists`);
  const artifacts_name = artifactsRepoName(info.id, name);
  const remote = await createArtifactsRepo(c.env, artifacts_name, description ?? `Pando repo ${info.full_name}/${b.path}`);
  const rec: RepoRecord = {
    name, path: b.path, artifacts_name, remote, default_branch: DEFAULT_BRANCH, description,
    created_at: new Date().toISOString(), created_by: by.login,
  };
  return c.json(repoView(c, unwrap(await stub.addRepo(rec))), 201);
});

api.get("/v1/monorepos/:o/:m/repos", async (c) => {
  return c.json({ repos: (await c.get("stub").listRepos()).map((r) => repoView(c, r)) });
});

api.get("/v1/monorepos/:o/:m/repos/:r", async (c) => {
  const r = await repoOf(c);
  return c.json(repoView(c, r, await requiredKept(c.env, c.get("info"), r)));
});

// ── Branches ──────────────────────────────────────────────────────────────

/**
 * The branch rows for one repo: stored facts from the monorepo object, at
 * once. Rows stale past the grace period are computed here, at most `inline`
 * of them (facts.ts), and read again.
 */
async function branchViews(
  c: C,
  r: RepoRecord,
  names: string[] | null,
  state: string,
  o: { limit?: number; cursor?: string | null; inline?: number; graceMs?: number } = {},
): Promise<BranchList> {
  const stub = c.get("stub");
  let main = await stub.currentMain(r.name);
  if (main === null) {
    // A repo made before Pando kept heads: read main once and keep it.
    main = branchesOf(await listRefs(c.env, r).catch(() => new Map<string, string>())).get(r.default_branch) ?? null;
    if (main) await stub.rememberHead(r.name, main);
  }
  const required = await requiredKept(c.env, c.get("info"), r);
  const ask = { names: names ?? undefined, state: state as "open" | "merged" | "all", limit: o.limit, cursor: o.cursor ?? null, required, graceMs: o.graceMs };
  let list = (await stub.branchRows(r.name, ask)) as BranchList;
  const due = list.due.slice(0, o.inline ?? INLINE_MAX);
  if (due.length && main) {
    const heads = new Map(list.branches.map((b) => [b.name, b.head]));
    const m = main;
    await withRepo(c.env, r.artifacts_name, async (repo) => {
      const read = commitReader(repo);
      await views.pool(due, SWEEP_PARALLEL, async (name) => {
        try {
          const f = await computeFacts(c.env, r, m, heads.get(name)!, read);
          await stub.writeFacts(r.name, name, f, required);
        } catch (err) {
          if (!(err instanceof views.MainMoved)) throw err; // main moved: the row stays pending
        }
      });
    });
    list = (await stub.branchRows(r.name, ask)) as BranchList;
  }
  return list;
}

api.get("/v1/monorepos/:o/:m/repos/:r/branches", async (c) => {
  const r = await repoOf(c);
  const state = c.req.query("state") ?? "open";
  if (!["open", "merged", "all"].includes(state)) bad("state is open, merged or all");
  const limit = Number(c.req.query("limit") ?? "100");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) bad("limit is 1 to 500");
  const { due: _due, ...list } = await branchViews(c, r, null, state, { limit, cursor: c.req.query("cursor") ?? null });
  return c.json(list);
});

api.post("/v1/monorepos/:o/:m/repos/:r/branches", async (c) => {
  const r = await repoOf(c);
  const b = await body(c);
  if (!validBranchName(b.name) || b.name === r.default_branch) bad("name must be a valid git branch name other than the default branch");
  const from = str(b.from, "from", { optional: true }) ?? r.default_branch;
  const title = str(b.title, "title", { optional: true, max: 300 }) ?? null;
  const description = str(b.description, "description", { optional: true, max: 20_000 }) ?? null;
  const refs = branchesOf(await listRefs(c.env, r));
  if (refs.has(b.name)) throw new HttpError(409, "branch_exists", `branch ${b.name} exists`);
  let sha = refs.get(from) ?? null;
  if (!sha && isSha(from)) {
    const exists = await withRepo(c.env, r.artifacts_name, (repo) => repo.readCommit(from));
    if (exists) sha = from;
  }
  if (!sha) throw new HttpError(404, "not_found", `no branch or commit ${from}`);
  const ref = `refs/heads/${b.name}`;
  // Through the repo's write gate: waits for a slot, and goes out with other waiting ref updates.
  const result = unwrap(await c.get("stub").updateRefsQueued(r.name, [{ old: ZERO, new: sha, ref }]));
  const reason = result[ref];
  if (reason !== null) throw new HttpError(409, "branch_not_created", `Artifacts refused: ${reason ?? "no report"}`);
  const stub = c.get("stub");
  await stub.createBranchRecord(r.name, b.name, sha, c.get("identity"), title, description, new URL(c.req.url).origin);
  // Its facts come from the queue (a branch.updated event); the answer says stale until then.
  const view = (await branchViews(c, r, [b.name], "all", { inline: 0 })).branches[0];
  return c.json(view, 201);
});

/** /branches/<name>[/diff|/reviews|/merge], with the name raw or %2F-encoded. */
function branchPath(c: C): { branch: string; rest: string } {
  let tail = rawTail(c);
  let rest = "";
  for (const s of ["/diff", "/reviews", "/merge", "/commits"]) {
    if (tail.endsWith(s)) {
      rest = s.slice(1);
      tail = tail.slice(0, -s.length);
      break;
    }
  }
  let branch: string;
  try {
    branch = decodeURIComponent(tail);
  } catch {
    bad("bad branch name in the path");
  }
  if (!validBranchName(branch)) bad("bad branch name in the path");
  return { branch, rest };
}

api.all("/v1/monorepos/:o/:m/repos/:r/branches/*", async (c) => {
  const { branch, rest } = branchPath(c);
  const r = await repoOf(c);
  const method = c.req.method;
  if (rest === "" && method === "GET") {
    // Stored facts at once; computed here only when stale for over 30 s, or with ?fresh=1.
    const fresh = c.req.query("fresh") === "1";
    const v = (await branchViews(c, r, [branch], "all", fresh ? { inline: 1, graceMs: 0 } : { inline: 1 })).branches[0];
    if (!v) throw new HttpError(404, "not_found", `no branch ${branch}`);
    return c.json(v);
  }
  if (rest === "" && method === "PATCH") {
    const b = await body(c);
    const head = branchesOf(await listRefs(c.env, r)).get(branch);
    if (!head) throw new HttpError(404, "not_found", `no branch ${branch}`);
    const patch = {
      title: str(b.title, "title", { optional: true, max: 300 }),
      description: str(b.description, "description", { optional: true, max: 20_000 }),
    };
    unwrap(await c.get("stub").updateBranch(r.name, branch, patch, head, c.get("identity")));
    return c.json((await branchViews(c, r, [branch], "all", { inline: 0 })).branches[0]);
  }
  if (rest === "" && method === "DELETE") return deleteBranch(c, r, branch);
  if (rest === "diff" && method === "GET") return diff(c, r, branch);
  if (rest === "commits" && method === "GET") return commits(c, r, branch);
  if (rest === "reviews" && method === "GET") return c.json({ reviews: await c.get("stub").listReviews(r.name, branch) });
  if (rest === "reviews" && method === "POST") return review(c, r, branch);
  if (rest === "merge" && method === "POST") return merge(c, r, branch);
  throw new HttpError(405, "method", "method not allowed");
});

async function diff(c: C, r: RepoRecord, branch: string): Promise<Response> {
  const format = c.req.query("format") ?? "json";
  if (format !== "json" && format !== "patch") bad("format is json or patch");
  const maxBytesQ = c.req.query("max_bytes");
  const maxBytes = maxBytesQ === undefined ? 1 << 20 : Number(maxBytesQ);
  if (!Number.isInteger(maxBytes) || maxBytes < 0) bad("max_bytes must be a whole number");
  const paths = (c.req.queries("paths") ?? []).flatMap((p) => p.split(",")).map((p) => p.trim().replace(/^\/+/, "")).filter(Boolean);
  const refs = branchesOf(await listRefs(c.env, r));
  const head = refs.get(branch);
  if (!head) throw new HttpError(404, "not_found", `no branch ${branch}`);
  const main = refs.get(r.default_branch);
  if (!main) throw new HttpError(409, "no_main", `${r.default_branch} does not exist yet`);
  const result = await withRepo(c.env, r.artifacts_name, async (repo) => {
    const read = commitReader(repo);
    const { mergeBase } = await compareWith(read, main, head);
    if (!mergeBase) throw new HttpError(409, "no_merge_base", `${branch} shares no history with ${r.default_branch}`);
    const [from, to] = await Promise.all([read(mergeBase), read(head)]);
    const d = await treeDiff(repo, from.tree, to.tree, {
      hunks: format === "patch" || c.req.query("hunks") === "1",
      maxBytes: Math.min(maxBytes, 8 << 20),
      paths,
    });
    return { mergeBase, d };
  });
  if (format === "patch") {
    const { text, omitted } = toPatch(result.d, (f) => f.hunks);
    return new Response(text, {
      headers: { "content-type": "text/x-patch; charset=utf-8", "x-pando-diff-omitted": String(omitted), "x-pando-merge-base": result.mergeBase },
    });
  }
  return c.json({
    base_branch: r.default_branch,
    base: main,
    head,
    merge_base: result.mergeBase,
    truncated: result.d.truncated,
    stats: result.d.stats,
    files: result.d.files,
  });
}

/** Delete a branch (not the default one), through the repo's write gate. */
async function deleteBranch(c: C, r: RepoRecord, branch: string): Promise<Response> {
  if (branch === r.default_branch) throw new HttpError(403, "protected", `${branch} is protected`);
  const head = branchesOf(await listRefs(c.env, r)).get(branch);
  if (!head) throw new HttpError(404, "not_found", `no branch ${branch}`);
  const ref = `refs/heads/${branch}`;
  const cmd = { old: head, new: ZERO, ref };
  const result = unwrap(await c.get("stub").updateRefsQueued(r.name, [cmd]));
  if (result[ref] !== null) throw new HttpError(409, "branch_not_deleted", `Artifacts refused: ${result[ref] ?? "no report"}`);
  await c.get("stub").recordPush(r.name, c.get("identity"), [cmd], {}, new URL(c.req.url).origin);
  return c.body(null, 204);
}

/** The branch's own commits (on it, not on the default branch), newest first, with Pando's trailers parsed. */
async function commits(c: C, r: RepoRecord, branch: string): Promise<Response> {
  const limitQ = c.req.query("limit");
  const limit = limitQ === undefined ? views.COMMITS_MAX : Number(limitQ);
  if (!Number.isInteger(limit) || limit < 1 || limit > views.COMMITS_MAX) bad(`limit is 1 to ${views.COMMITS_MAX}`);
  const refs = branchesOf(await listRefs(c.env, r));
  const head = refs.get(branch);
  if (!head) throw new HttpError(404, "not_found", `no branch ${branch}`);
  // A merged branch is compared with main as it was before its merge, so its page still lists its commits.
  const main = (await c.get("stub").mergedFrom(r.name, branch, head)) ?? refs.get(r.default_branch) ?? null;
  const out = await withRepo(c.env, r.artifacts_name, async (repo) => {
    const read = commitReader(repo);
    let shas: string[];
    let mergeBase: string | null = null;
    if (main) {
      const cmp = await compareWith(read, main, head);
      mergeBase = cmp.mergeBase;
      shas = cmp.aheadCommits;
    } else {
      shas = (await repo.log({ ref: head, limit })).map((x) => x.hash);
    }
    const list = await Promise.all(
      shas.slice(0, limit).map(async (sha) => {
        let ci = await read(sha);
        if (ci.message === undefined) {
          const full = await repo.readCommit(sha);
          if (full) ci = { ...ci, message: full.message, author: full.author, committer: full.committer, authoredAt: full.authoredAt };
        }
        const message = ci.message ?? "";
        return {
          sha,
          parents: ci.parents,
          title: message.split("\n")[0],
          message,
          author: { name: ci.author?.name ?? null, email: ci.author?.email ?? null, date: ci.authoredAt ? new Date(ci.authoredAt * 1000).toISOString() : null },
          committer: { name: ci.committer?.name ?? null, email: ci.committer?.email ?? null, date: new Date(ci.time * 1000).toISOString() },
          trailers: views.pandoTrailers(message),
          co_authors: views.coAuthors(message),
        };
      }),
    );
    return { mergeBase, total: shas.length, list };
  });
  return c.json({
    branch,
    head,
    base_branch: r.default_branch,
    merge_base: out.mergeBase,
    total: out.total,
    truncated: out.total > out.list.length,
    commits: out.list,
  });
}

async function review(c: C, r: RepoRecord, branch: string): Promise<Response> {
  const id = c.get("identity");
  const b = await body(c);
  const verdict = b.verdict;
  if (verdict !== "comment" && verdict !== "request_changes" && verdict !== "approve") bad("verdict is comment, request_changes or approve");
  const text = str(b.body, "body", { optional: true, max: 100_000 }) ?? null;
  const comments = b.comments ?? [];
  if (!Array.isArray(comments) || comments.length > 1000) bad("comments must be a list");
  const clean = comments.map((x, i) => {
    if (!x || typeof x !== "object") bad(`comments[${i}] must be an object`);
    const o = x as Record<string, unknown>;
    const line = o.line;
    if (line !== undefined && (!Number.isInteger(line) || (line as number) < 0)) bad(`comments[${i}].line must be a line number`);
    const side = o.side ?? "new";
    if (side !== "new" && side !== "old") bad(`comments[${i}].side is new or old`);
    return { path: str(o.path, `comments[${i}].path`, { max: 1000 })!, ...(line !== undefined ? { line } : {}), side, body: str(o.body, `comments[${i}].body`, { max: 20_000 })! };
  });
  let head = str(b.head, "head", { optional: true });
  if (!head) {
    head = branchesOf(await listRefs(c.env, r)).get(branch);
    if (!head) throw new HttpError(404, "not_found", `no branch ${branch}`);
  } else if (!isSha(head)) bad("head must be a full sha");
  return c.json(await c.get("stub").addReview(r.name, branch, head, verdict, text, clean, id), 201);
}

async function merge(c: C, r: RepoRecord, branch: string): Promise<Response> {
  let b: Record<string, unknown> = {};
  if ((c.req.header("content-length") ?? "0") !== "0" || c.req.header("transfer-encoding")) {
    const text = await c.req.text();
    if (text.trim()) {
      try {
        b = JSON.parse(text);
      } catch {
        bad("the body must be JSON");
      }
    }
  }
  const out = await c.get("stub").merge({
    repo: r.name,
    branch,
    identity: c.get("identity"),
    force: c.req.query("force") === "1" || c.req.query("force") === "true",
    message: str(b.message, "message", { optional: true, max: 50_000 }),
    expected_head: str(b.expected_head, "expected_head", { optional: true }),
    origin: new URL(c.req.url).origin,
  });
  return c.json(unwrap(out));
}

// ── Files ─────────────────────────────────────────────────────────────────

// ── A project's files at any ref (FILES.md): folders, last commits, history ──

function intParam(v: string | undefined, dflt: number, max: number, name: string): number {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) bad(`${name} is 1 to ${max}`);
  return n;
}

function walkerOf(c: C, r: RepoRecord): { w: files.Walker; obj: ReturnType<typeof objectsClient> } {
  const obj = objectsClient(c.executionCtx);
  return { w: new files.Walker(obj, r, files.requestBudget(c.env)), obj };
}

function refOf(c: C, r: RepoRecord, w: files.Walker) {
  const stub = c.get("stub");
  return files.resolveCommit(c.env, w, (ref) => stub.refHead(r.name, ref), c.req.query("ref"));
}

api.get("/v1/monorepos/:o/:m/repos/:r/tree", async (c) => {
  const r = await repoOf(c);
  const { w } = walkerOf(c, r);
  const { ref, commit } = await refOf(c, r, w);
  const path = files.cleanPath(c.req.query("path"));
  const limit = intParam(c.req.query("limit"), files.TREE_PAGE, files.TREE_PAGE, "limit");
  const out = await files.listFolder(w, commit, path, limit, c.req.query("cursor") ?? null);
  return c.json({ ref, commit: commit.hash, path, ...out });
});

api.get("/v1/monorepos/:o/:m/repos/:r/tree/last-commits", async (c) => {
  const r = await repoOf(c);
  const { w, obj } = walkerOf(c, r);
  const { ref, commit } = await refOf(c, r, w);
  const path = files.cleanPath(c.req.query("path"));
  const stub = c.get("stub");
  const out = await files.lastCommits(c.env, w, obj, commit, path, (shas) => stub.mergedBranches(r.name, shas));
  const names = c.req.query("names")?.split(",").filter(Boolean).slice(0, files.TREE_PAGE);
  const entries = names ? Object.fromEntries(names.filter((n) => n in out.entries).map((n) => [n, out.entries[n]])) : out.entries;
  return c.json({ ref, commit: commit.hash, path, complete: out.complete, entries, older: out.older, retry_after_ms: out.complete ? null : 2000 });
});

api.get("/v1/monorepos/:o/:m/repos/:r/history", async (c) => {
  const r = await repoOf(c);
  const { w, obj } = walkerOf(c, r);
  const path = files.cleanPath(c.req.query("path"));
  const limit = intParam(c.req.query("limit"), files.HISTORY_PAGE, 100, "limit");
  const cursor = c.req.query("cursor");
  let start: string;
  let walked = 0;
  let ref: string | null = null;
  if (cursor) {
    const m = /^([0-9a-f]{40})\.(\d+)$/.exec(cursor);
    if (!m) bad("cursor: pass back a `next` from an earlier page");
    [start, walked] = [m[1], Number(m[2])];
  } else {
    const at = await refOf(c, r, w);
    [start, ref] = [at.commit.hash, at.ref];
  }
  const key = files.answerKey("hist", start, await files.sha1Hex(`${limit}\n${walked}\n${path}`));
  type Page = { commits: files.CommitLine[]; next: string | null; capped: boolean };
  const stored = await obj.json<Page>(`/answer/${r.artifacts_name}/${key}`);
  if (stored) return c.json({ ref, path, ...stored, complete_page: true });
  const stub = c.get("stub");
  const p = await files.walkHistory(w, start, path, limit, walked, (shas) => stub.mergedBranches(r.name, shas));
  const page: Page = { commits: p.changes, next: p.next ? `${p.next}.${p.walked}` : null, capped: p.capped };
  // A page cut short by the budget is not kept: the next ask walks further.
  if (!p.budgetCut) await files.storeAnswer(c.env, r.artifacts_name, key, page);
  return c.json({ ref, path, ...page, complete_page: !p.budgetCut });
});

api.get("/v1/monorepos/:o/:m/repos/:r/files/*", async (c) => {
  const r = await repoOf(c);
  const path = decodeURIComponent(rawTail(c));
  if (!path || path.split("/").some((s) => !s || s === "." || s === "..")) bad("bad path");
  const ref = c.req.query("ref") ?? r.default_branch;
  const blob = await withRepo(c.env, r.artifacts_name, (repo) => repo.readFile({ ref, path }));
  if (!blob) throw new HttpError(404, "not_found", `no file ${path} at ${ref}`);
  return new Response(blob, { headers: { "content-type": blob.type || "application/octet-stream" } });
});

// ── Statuses ──────────────────────────────────────────────────────────────

api.post("/v1/monorepos/:o/:m/repos/:r/statuses/:sha", async (c) => {
  const r = await repoOf(c);
  const sha = c.req.param("sha");
  if (!isSha(sha)) bad("sha must be a full 40-character sha");
  const b = await body(c);
  const state = b.state as StatusRecord["state"];
  if (!["pending", "success", "failure", "error"].includes(state)) bad("state is pending, success, failure or error");
  const s = await c.get("stub").addStatus(
    r.name,
    sha,
    {
      state,
      context: str(b.context, "context", { optional: true, max: 200 }) || "default",
      target_url: str(b.target_url, "target_url", { optional: true, max: 2000 }) ?? null,
      description: str(b.description, "description", { optional: true, max: 1000 }) ?? null,
    },
    c.get("identity"),
    // A member's own credential stamps nothing: `app` is null and the creator is the member, whatever the body says.
    c.get("stamp") ?? null,
  );
  return c.json(s, 201);
});

api.get("/v1/monorepos/:o/:m/repos/:r/commits/*", async (c) => {
  const r = await repoOf(c);
  const tail = rawTail(c);
  if (!tail.endsWith("/status")) throw new HttpError(404, "not_found", "no such route");
  const ref = decodeURIComponent(tail.slice(0, -"/status".length));
  const sha = isSha(ref) ? ref : branchesOf(await listRefs(c.env, r)).get(ref);
  if (!sha) throw new HttpError(404, "not_found", `no branch or commit ${ref}`);
  const required = await requiredKept(c.env, c.get("info"), r);
  return c.json(combine(sha, required, await c.get("stub").statuses(r.name, sha)));
});

// ── Hooks ─────────────────────────────────────────────────────────────────

const EVENTS = ["push", "branch.opened", "merged"];

api.post("/v1/monorepos/:o/:m/repos/:r/hooks", async (c) => {
  const by = owner(c, "register hooks");
  const r = await repoOf(c);
  const b = await body(c);
  const type = b.type;
  if (type !== "web" && type !== "buildkite") bad("type is web or buildkite");
  const events = (b.events ?? (type === "web" ? EVENTS : ["push"])) as unknown[];
  if (!Array.isArray(events) || !events.length || events.some((e) => !EVENTS.includes(e as string))) bad(`events: some of ${EVENTS.join(", ")}`);
  let url: string | null = null;
  let secret: string | null = null;
  let config: Record<string, string> | null = null;
  if (type === "web") {
    url = str(b.url, "url", { max: 2000 })!;
    if (!/^https?:\/\//.test(url)) bad("url must be http(s)");
    secret = str(b.secret, "secret", { max: 500 })!;
    // The CI service behind it (github-actions, circleci, ...): stamped on statuses posted with its deliveries' status tokens.
    const app = str(b.app, "app", { optional: true, max: 39 });
    if (app !== undefined) {
      if (!APP_SLUG.test(app)) bad("app: a slug such as github-actions (a-z, 0-9, '-')");
      if (app === "buildkite") bad("app buildkite is for buildkite hooks; register type buildkite");
      config = { app };
    }
  } else {
    const bk = (b.buildkite ?? {}) as Record<string, unknown>;
    config = { organization: str(bk.organization, "buildkite.organization", { max: 200 })!, pipeline: str(bk.pipeline, "buildkite.pipeline", { max: 200 })! };
    const apiUrl = str(bk.api_url, "buildkite.api_url", { optional: true, max: 500 });
    if (apiUrl) {
      // Testing only: the Buildkite token is never sent anywhere but Buildkite or this machine.
      if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(apiUrl)) bad("buildkite.api_url may only point at localhost (for tests)");
      config.api_url = apiUrl;
    }
  }
  return c.json(await c.get("stub").addHook(r.name, { type, url, secret, events: events as string[], config }, by), 201);
});

api.get("/v1/monorepos/:o/:m/repos/:r/hooks", async (c) => {
  const r = await repoOf(c);
  return c.json({ hooks: await c.get("stub").listHooks(r.name) });
});

api.delete("/v1/monorepos/:o/:m/repos/:r/hooks/:id", async (c) => {
  owner(c, "remove hooks");
  const r = await repoOf(c);
  if (!(await c.get("stub").deleteHook(r.name, c.req.param("id")))) throw new HttpError(404, "not_found", "no such hook");
  return c.body(null, 204);
});

api.get("/v1/monorepos/:o/:m/repos/:r/hooks/:id/deliveries", async (c) => {
  const r = await repoOf(c);
  return c.json({ deliveries: await c.get("stub").listDeliveries(r.name, c.req.param("id")) });
});

api.post("/v1/monorepos/:o/:m/repos/:r/hooks/:id/redeliver", async (c) => {
  owner(c, "replay hooks");
  const r = await repoOf(c);
  const since = Number(c.req.query("since"));
  if (!Number.isSafeInteger(since) || since < 0) bad("since: the seq to replay after (a whole number)");
  return c.json(unwrap(await c.get("stub").replayHook(r.name, c.req.param("id"), since)), 202);
});

api.post("/v1/monorepos/:o/:m/repos/:r/hooks/deliveries/:id/redeliver", async (c) => {
  owner(c, "redeliver hooks");
  const r = await repoOf(c);
  return c.json(unwrap(await c.get("stub").redeliver(r.name, c.req.param("id"))), 202);
});

// ── CI (ci/routes.ts): the CI tab's reads and actions, and connections ──

ciRoutes(api);

// ── Worktrees ─────────────────────────────────────────────────────────────

api.get("/v1/monorepos/:o/:m/worktrees", async (c) => {
  return c.json({ worktrees: await c.get("stub").listWorktrees({ machine: c.req.query("machine"), repo: c.req.query("repo") }) });
});

function worktreeId(c: C): string {
  const id = c.req.param("id")!;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) bad("worktree id: 1 to 64 of A-Z a-z 0-9 _ -");
  return id;
}

api.put("/v1/monorepos/:o/:m/worktrees/:id", async (c) => {
  const id = worktreeId(c);
  const b = await body(c);
  const kind = b.kind;
  if (kind !== "fuse" && kind !== "sparse" && kind !== "fskit") bad("kind is fuse, sparse or fskit");
  const w = {
    repo: str(b.repo, "repo", { max: 200 })!,
    branch: str(b.branch, "branch", { max: 200 })!,
    path: str(b.path, "path", { max: 1000 })!,
    machine: str(b.machine, "machine", { max: 200 })!,
    agent: str(b.agent, "agent", { optional: true, max: 200 }) ?? null,
    kind,
  };
  return c.json(unwrap(await c.get("stub").putWorktree(id, w, c.get("identity"))));
});

api.get("/v1/monorepos/:o/:m/worktrees/:id", async (c) => {
  const w = await c.get("stub").getWorktree(worktreeId(c));
  if (!w) throw new HttpError(404, "not_found", "no such worktree");
  return c.json(w);
});

api.delete("/v1/monorepos/:o/:m/worktrees/:id", async (c) => {
  unwrap(await c.get("stub").deleteWorktree(worktreeId(c), c.get("identity")));
  return c.body(null, 204);
});


export type { BranchRecord };
