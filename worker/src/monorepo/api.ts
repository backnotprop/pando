// The /v1 API (docs/contracts/api-v1.yaml), except the meta layer's routes.

import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { HttpError, toErrorResponse } from "../http";
import { artifactsError, branchesOf, listRefs, updateRefs, withRepo } from "./artifacts";
import { combine, requiredChecks } from "./checks";
import { toPatch, treeDiff } from "./diff";
import { commitReader, compareWith } from "./graph";
import { gitwrite } from "./merge-port";
import {
  artifactsRepoName,
  DEFAULT_BRANCH,
  isSha,
  metaArtifactsName,
  repoNameFor,
  validBranchName,
  validMonorepoName,
  validRepoPath,
  ZERO,
} from "./names";
import type { MonorepoObject } from "./object";
import { hashToken, monorepoStub, newToken } from "./session";
import type { BranchRecord, Identity, MonorepoInfo, Outcome, RepoEvent, RepoRecord, StatusRecord } from "./types";
import { accounts, authenticate, forgetCachedAuth, identityOf, requireSecret } from "../accounts/auth";
import type { Auth } from "../accounts/object";

type Stub = DurableObjectStub<MonorepoObject>;
type Vars = { identity: Identity; info: MonorepoInfo; stub: Stub; m: string };
type C = Context<{ Bindings: Env; Variables: Vars }>;

export const api = new Hono<{ Bindings: Env; Variables: Vars }>();

api.onError((err) => toErrorResponse(err));
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

function cloneUrl(c: C, repoName: string): string {
  return `${new URL(c.req.url).origin}/${c.get("m")}/${repoName}.git`;
}

function repoView(c: C, r: RepoRecord, required?: string[]) {
  return {
    monorepo: c.get("m"),
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
  const r = await c.get("stub").getRepo(c.req.param("r")!);
  if (!r) throw new HttpError(404, "not_found", `no repo ${c.req.param("r")}`);
  return r;
}

/** Make an empty Artifacts repo; drop the token it comes with. */
async function createArtifactsRepo(env: Env, name: string, description: string): Promise<string> {
  let created: ArtifactsCreateRepoResult | null = null;
  try {
    created = await env.ARTIFACTS.create(name, { setDefaultBranch: DEFAULT_BRANCH, description });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "INVALID_REPO_NAME") throw new HttpError(400, "bad_name", `Artifacts refused the repo name ${name}`);
    if (code !== "ALREADY_EXISTS") throw artifactsError(err, `creating ${name}`);
  }
  return withRepo(env, name, async (repo) => {
    if (created) await repo.revokeToken(created.token).catch(() => false);
    return created?.remote ?? (await repo.info()).remote;
  });
}

// ── Users and credentials ─────────────────────────────────────────────────

type UserVars = { auth: Auth };
const userAuthed = async (c: Context<{ Bindings: Env; Variables: Vars & UserVars }>, next: () => Promise<void>) => {
  const auth = await authenticate(c.env, requireSecret(c.req.raw), null);
  if (!auth) throw new HttpError(401, "unauthorized", "unknown or revoked credential");
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

users.get("/v1/monorepos", async (c) => {
  return c.json({ monorepos: await accounts(c.env).monoreposOf(c.get("auth").user.login) });
});

users.post("/v1/monorepos", async (c) => {
  const a = c.get("auth");
  const b = await body(c as unknown as C);
  if (!validMonorepoName(b.name)) bad("name: lower-case letters, digits, '.', '_', '-'; starts with a letter or digit; no '--'; at most 39 characters");
  const kind = b.kind ?? "monorepo";
  if (kind !== "monorepo" && kind !== "repo") bad("kind is monorepo or repo");
  const name = b.name;
  const acc = accounts(c.env);
  if (!(await acc.claimMonorepo(name, kind, a.user.login))) throw new HttpError(409, "monorepo_exists", `monorepo ${name} exists`);
  const stub = monorepoStub(c.env, name);
  try {
    if (!(await stub.init(name, kind))) throw new HttpError(409, "monorepo_exists", `monorepo ${name} exists`);
    const repos: RepoRecord[] = [];
    if (kind === "monorepo") {
      await createArtifactsRepo(c.env, metaArtifactsName(name), `Pando meta layer of ${name}`);
    } else {
      const artifacts_name = artifactsRepoName(name, name);
      const remote = await createArtifactsRepo(c.env, artifacts_name, `Pando repo ${name}`);
      const rec: RepoRecord = {
        name, path: ".", artifacts_name, remote, default_branch: DEFAULT_BRANCH, description: null,
        created_at: new Date().toISOString(), created_by: a.user.login,
      };
      repos.push(unwrap(await stub.addRepo(rec)));
    }
    forgetCachedAuth();
    const info = (await stub.info())!;
    c.set("m", name);
    return c.json({ monorepo: { ...info, role: "owner" }, repos: repos.map((r) => repoView(c as unknown as C, r)) }, 201);
  } catch (err) {
    await acc.releaseMonorepo(name);
    await stub.destroy();
    throw err;
  }
});

api.route("/", users);

// Every route under one monorepo: members only.
const authed = async (c: C, next: () => Promise<void>) => {
  const m = c.req.param("m")!;
  if (!validMonorepoName(m)) throw new HttpError(404, "not_found", `no monorepo ${m}`);
  const auth = await authenticate(c.env, requireSecret(c.req.raw), m);
  if (!auth) throw new HttpError(401, "unauthorized", "unknown or revoked credential");
  if (!auth.monorepo) throw new HttpError(404, "not_found", `no monorepo ${m}`);
  if (!auth.role) throw new HttpError(403, "not_a_member", `${auth.user.login} is not a member of ${m}`);
  c.set("m", m);
  c.set("stub", monorepoStub(c.env, m));
  c.set("info", auth.monorepo);
  c.set("identity", identityOf(auth));
  await next();
};
api.use("/v1/monorepos/:m", authed);
api.use("/v1/monorepos/:m/*", authed);

api.get("/v1/monorepos/:m", (c) => c.json({ ...c.get("info"), role: c.get("identity").role }));

// ── Members ───────────────────────────────────────────────────────────────

api.get("/v1/monorepos/:m/members", async (c) => {
  return c.json({ members: await accounts(c.env).members(c.get("m")) });
});

api.put("/v1/monorepos/:m/members/:login", async (c) => {
  const by = owner(c, "manage members");
  const b = await body(c);
  if (b.role !== "owner" && b.role !== "member") bad("role is owner or member");
  const out = unwrap(await accounts(c.env).putMember(c.get("m"), c.req.param("login"), b.role, by.login));
  forgetCachedAuth();
  return c.json(out);
});

api.delete("/v1/monorepos/:m/members/:login", async (c) => {
  owner(c, "manage members");
  unwrap(await accounts(c.env).removeMember(c.get("m"), c.req.param("login")));
  forgetCachedAuth();
  return c.body(null, 204);
});

// ── Repos ─────────────────────────────────────────────────────────────────

api.post("/v1/monorepos/:m/repos", async (c) => {
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
  const artifacts_name = artifactsRepoName(info.name, name);
  const remote = await createArtifactsRepo(c.env, artifacts_name, description ?? `Pando repo ${info.name}/${b.path}`);
  const rec: RepoRecord = {
    name, path: b.path, artifacts_name, remote, default_branch: DEFAULT_BRANCH, description,
    created_at: new Date().toISOString(), created_by: by.login,
  };
  return c.json(repoView(c, unwrap(await stub.addRepo(rec))), 201);
});

api.get("/v1/monorepos/:m/repos", async (c) => {
  return c.json({ repos: (await c.get("stub").listRepos()).map((r) => repoView(c, r)) });
});

api.get("/v1/monorepos/:m/repos/:r", async (c) => {
  const r = await repoOf(c);
  return c.json(repoView(c, r, await requiredChecks(c.env, c.get("info"), r)));
});

// ── Branches ──────────────────────────────────────────────────────────────

const mergeableCache = new Map<string, string>();

async function mergeable(env: Env, r: RepoRecord, main: string, head: string, ahead: number | null): Promise<string> {
  if (ahead === 0) return "up_to_date";
  if (!gitwrite) return "unknown";
  const key = `${r.artifacts_name}:${main}:${head}`;
  const hit = mergeableCache.get(key);
  if (hit) return hit;
  let v = "unknown";
  try {
    const out = await gitwrite.mergeCommit(
      { artifacts: env.ARTIFACTS, name: r.artifacts_name },
      { base: r.default_branch, head, baseSha: main, message: "dry run\n", author: { name: "Pando", email: "pando@pando.invalid" }, dryRun: true },
    );
    v = out.status === "mergeable" ? "clean" : out.status === "conflict" ? "conflicts" : out.status === "up_to_date" ? "up_to_date" : "unknown";
  } catch {
    v = "unknown";
  }
  if (mergeableCache.size > 5000) mergeableCache.clear();
  if (v !== "unknown") mergeableCache.set(key, v);
  return v;
}

async function pool<T, U>(items: T[], n: number, fn: (t: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

async function branchViews(c: C, r: RepoRecord, names: string[] | null, state: string) {
  const refs = branchesOf(await listRefs(c.env, r));
  const main = refs.get(r.default_branch) ?? null;
  const stub = c.get("stub");
  const records = new Map((await stub.branchRecords(r.name)).map((b) => [b.name, b]));
  const required = await requiredChecks(c.env, c.get("info"), r);
  const wantNames = (names ?? [...refs.keys()]).filter((n) => n !== r.default_branch && refs.has(n));
  const views = await withRepo(c.env, r.artifacts_name, async (repo) => {
    const read = commitReader(repo);
    return pool(wantNames, 4, async (name) => {
      const head = refs.get(name)!;
      const rec = records.get(name) ?? null;
      let base: string | null = null;
      let ahead: number | null = null;
      let behind: number | null = null;
      if (main) {
        try {
          ({ mergeBase: base, ahead, behind } = await compareWith(read, main, head));
        } catch {
          /* too far apart: leave nulls */
        }
      }
      const checks = combine(head, required, await stub.statuses(r.name, head));
      return {
        name,
        head,
        base,
        author: rec?.creator ?? null,
        title: rec?.title ?? null,
        description: rec?.description ?? null,
        ahead,
        behind,
        mergeable: main && base ? await mergeable(c.env, r, main, head, ahead) : "unknown",
        checks,
        state: rec?.merged_head === head ? "merged" : "open",
        merge_commit: rec?.merged_head === head ? rec.merge_commit : null,
        created_at: rec?.created_at ?? null,
        updated_at: rec?.updated_at ?? null,
      };
    });
  });
  return {
    default_branch: r.default_branch,
    default_head: main,
    branches: views.filter((v) => state === "all" || v.state === state),
  };
}

api.get("/v1/monorepos/:m/repos/:r/branches", async (c) => {
  const r = await repoOf(c);
  const state = c.req.query("state") ?? "open";
  if (!["open", "merged", "all"].includes(state)) bad("state is open, merged or all");
  return c.json(await branchViews(c, r, null, state));
});

api.post("/v1/monorepos/:m/repos/:r/branches", async (c) => {
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
  const result = await updateRefs(c.env, r, [{ old: ZERO, new: sha, ref }]);
  const reason = result.get(ref);
  if (reason !== null) throw new HttpError(409, "branch_not_created", `Artifacts refused: ${reason ?? "no report"}`);
  const stub = c.get("stub");
  const events = await stub.createBranchRecord(r.name, b.name, sha, c.get("identity"), title, description);
  c.executionCtx.waitUntil(enqueueWithBases(c, r, events));
  const view = (await branchViews(c, r, [b.name], "all")).branches[0];
  return c.json(view, 201);
});

/** /branches/<name>[/diff|/reviews|/merge], with the name raw or %2F-encoded. */
function branchPath(c: C): { branch: string; rest: string } {
  const raw = new URL(c.req.url).pathname;
  const prefix = `/v1/monorepos/${c.get("m")}/repos/${c.req.param("r")}/branches/`;
  let tail = raw.slice(prefix.length);
  let rest = "";
  for (const s of ["/diff", "/reviews", "/merge"]) {
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

api.all("/v1/monorepos/:m/repos/:r/branches/*", async (c) => {
  const { branch, rest } = branchPath(c);
  const r = await repoOf(c);
  const method = c.req.method;
  if (rest === "" && method === "GET") {
    const v = (await branchViews(c, r, [branch], "all")).branches[0];
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
    unwrap(await c.get("stub").updateBranch(r.name, branch, patch, head));
    return c.json((await branchViews(c, r, [branch], "all")).branches[0]);
  }
  if (rest === "diff" && method === "GET") return diff(c, r, branch);
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

api.get("/v1/monorepos/:m/repos/:r/files/*", async (c) => {
  const r = await repoOf(c);
  const raw = new URL(c.req.url).pathname;
  const prefix = `/v1/monorepos/${c.get("m")}/repos/${r.name}/files/`;
  const path = decodeURIComponent(raw.slice(prefix.length));
  if (!path || path.split("/").some((s) => !s || s === "." || s === "..")) bad("bad path");
  const ref = c.req.query("ref") ?? r.default_branch;
  const blob = await withRepo(c.env, r.artifacts_name, (repo) => repo.readFile({ ref, path }));
  if (!blob) throw new HttpError(404, "not_found", `no file ${path} at ${ref}`);
  return new Response(blob, { headers: { "content-type": blob.type || "application/octet-stream" } });
});

// ── Statuses ──────────────────────────────────────────────────────────────

api.post("/v1/monorepos/:m/repos/:r/statuses/:sha", async (c) => {
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
    c.get("identity").login,
  );
  return c.json(s, 201);
});

api.get("/v1/monorepos/:m/repos/:r/commits/*", async (c) => {
  const r = await repoOf(c);
  const raw = new URL(c.req.url).pathname;
  const prefix = `/v1/monorepos/${c.get("m")}/repos/${r.name}/commits/`;
  if (!raw.endsWith("/status")) throw new HttpError(404, "not_found", "no such route");
  const ref = decodeURIComponent(raw.slice(prefix.length, -"/status".length));
  const sha = isSha(ref) ? ref : branchesOf(await listRefs(c.env, r)).get(ref);
  if (!sha) throw new HttpError(404, "not_found", `no branch or commit ${ref}`);
  const required = await requiredChecks(c.env, c.get("info"), r);
  return c.json(combine(sha, required, await c.get("stub").statuses(r.name, sha)));
});

// ── Hooks ─────────────────────────────────────────────────────────────────

const EVENTS = ["push", "branch.opened", "merged"];

api.post("/v1/monorepos/:m/repos/:r/hooks", async (c) => {
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

api.get("/v1/monorepos/:m/repos/:r/hooks", async (c) => {
  const r = await repoOf(c);
  return c.json({ hooks: await c.get("stub").listHooks(r.name) });
});

api.delete("/v1/monorepos/:m/repos/:r/hooks/:id", async (c) => {
  owner(c, "remove hooks");
  const r = await repoOf(c);
  if (!(await c.get("stub").deleteHook(r.name, c.req.param("id")))) throw new HttpError(404, "not_found", "no such hook");
  return c.body(null, 204);
});

api.get("/v1/monorepos/:m/repos/:r/hooks/:id/deliveries", async (c) => {
  const r = await repoOf(c);
  return c.json({ deliveries: await c.get("stub").listDeliveries(r.name, c.req.param("id")) });
});

api.post("/v1/monorepos/:m/repos/:r/hooks/deliveries/:id/redeliver", async (c) => {
  owner(c, "redeliver hooks");
  const r = await repoOf(c);
  return c.json(unwrap(await c.get("stub").redeliver(r.name, c.req.param("id"))), 202);
});

// ── Worktrees ─────────────────────────────────────────────────────────────

api.get("/v1/monorepos/:m/worktrees", async (c) => {
  return c.json({ worktrees: await c.get("stub").listWorktrees({ machine: c.req.query("machine"), repo: c.req.query("repo") }) });
});

function worktreeId(c: C): string {
  const id = c.req.param("id")!;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) bad("worktree id: 1 to 64 of A-Z a-z 0-9 _ -");
  return id;
}

api.put("/v1/monorepos/:m/worktrees/:id", async (c) => {
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

api.get("/v1/monorepos/:m/worktrees/:id", async (c) => {
  const w = await c.get("stub").getWorktree(worktreeId(c));
  if (!w) throw new HttpError(404, "not_found", "no such worktree");
  return c.json(w);
});

api.delete("/v1/monorepos/:m/worktrees/:id", async (c) => {
  unwrap(await c.get("stub").deleteWorktree(worktreeId(c)));
  return c.body(null, 204);
});

/** Fill in each event's merge base, then hand the events to the monorepo object for delivery. */
async function enqueueWithBases(c: C, r: RepoRecord, events: RepoEvent[]): Promise<void> {
  if (!events.length) return;
  try {
    const main = branchesOf(await listRefs(c.env, r)).get(r.default_branch);
    if (main) {
      await withRepo(c.env, r.artifacts_name, async (repo) => {
        const read = commitReader(repo);
        for (const e of events) {
          if (e.head === ZERO || e.branch === r.default_branch) continue;
          e.base = (await compareWith(read, main, e.head).catch(() => null))?.mergeBase ?? null;
        }
      });
    }
    await c.get("stub").enqueue(events, new URL(c.req.url).origin);
  } catch (err) {
    console.error("queueing hook events failed:", err instanceof Error ? err.message : String(err));
  }
}

export type { BranchRecord };
