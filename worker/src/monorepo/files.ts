// A project's files at any ref (FILES.md): folder listings, the last commit
// per entry (a folder's list), a path's history, and raw files. Everything
// reads git objects by hash through the cached `Objects` entrypoint
// (objects.ts), so repeat views reach no Artifacts call.
//
// History is first parents only (merges on main are two-parent merge
// commits; a merged change shows as the merge, with its branch). A walk
// compares a path's hash in each commit and its first parent, descending the
// path only as far as the hashes differ.

import type { Env } from "../env";
import { HttpError } from "../http";
import type { ObjectStats, ObjectsClient } from "../objects";
import { prepend } from "./pktline";
import type { RepoRecord } from "./types";

export interface TreeEntry {
  name: string;
  mode: string;
  hash: string;
  type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
}

export interface CommitMeta {
  hash: string;
  treeHash: string;
  message: string;
  author: { name: string; email: string };
  parents: string[];
  authoredAt: number;
}

/** A commit as the file pages show it. */
export interface CommitLine {
  sha: string;
  title: string;
  author: { name: string; email: string };
  at: string;
  /** On a merge into main: the branch it merged, and its title. */
  merged_branch: { branch: string; title: string | null } | null;
}

/** Entries per folder page. */
export const TREE_PAGE = 1000;
/** Changes per history page. */
export const HISTORY_PAGE = 30;
/** How far back a walk looks (an owner limit). */
export const WALK_MAX = 10_000;
/** Edge misses (Artifacts reads) a request may spend, and loads in all; a queue job's misses. */
export const REQUEST_BUDGET = { misses: 40, loads: 400 };
export const JOB_BUDGET = { misses: 2000, loads: 40_000 };

export type Budget = { misses: number; loads: number };

/** A test override (FILES_BUDGET=misses), else the default. */
export function requestBudget(env: { FILES_BUDGET?: string }): Budget {
  const n = Number(env.FILES_BUDGET);
  return env.FILES_BUDGET && Number.isInteger(n) && n > 0 ? { misses: n, loads: n * 10 } : REQUEST_BUDGET;
}

export async function sha1Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** `a/b/c` from a query: no empty, `.` or `..` segments. "" is the root. */
export function cleanPath(p: string | undefined | null): string {
  const s = (p ?? "").replace(/^\/+|\/+$/g, "");
  if (s === "") return "";
  if (s.split("/").some((seg) => !seg || seg === "." || seg === "..")) throw new HttpError(400, "bad_request", "path: a/b/c, no empty, . or .. segments");
  return s;
}

function lineOf(c: CommitMeta): CommitLine {
  return {
    sha: c.hash,
    title: c.message.split("\n", 1)[0],
    author: { name: c.author.name, email: c.author.email },
    at: new Date(c.authoredAt * 1000).toISOString(),
    merged_branch: null,
  };
}

/** Reads through the cache, remembered for the walk; stops when its budget is spent. */
export class Walker {
  readonly stats: ObjectStats = { hits: 0, misses: 0 };
  private trees = new Map<string, TreeEntry[]>();
  private commits = new Map<string, CommitMeta>();
  private at = new Map<string, { oid: string; type: TreeEntry["type"] } | null>();

  constructor(
    private obj: ObjectsClient,
    readonly repo: RepoRecord,
    private budget: Budget,
  ) {}

  spent(): boolean {
    return this.stats.misses >= this.budget.misses || this.stats.hits + this.stats.misses >= this.budget.loads;
  }

  async commit(sha: string): Promise<CommitMeta | null> {
    const hit = this.commits.get(sha);
    if (hit) return hit;
    const c = await this.obj.json<CommitMeta>(`/commit/${this.repo.artifacts_name}/${sha}`, this.stats);
    if (c) this.commits.set(sha, c);
    return c;
  }

  async tree(oid: string): Promise<TreeEntry[]> {
    const hit = this.trees.get(oid);
    if (hit) return hit;
    const t = (await this.obj.json<TreeEntry[]>(`/tree/${this.repo.artifacts_name}/${oid}`, this.stats)) ?? [];
    this.trees.set(oid, t);
    return t;
  }

  /** The entry at `path` under a root tree (the root itself for ""), or null. */
  async entryAt(rootTree: string, path: string): Promise<{ oid: string; type: TreeEntry["type"] } | null> {
    if (path === "") return { oid: rootTree, type: "tree" };
    const key = `${rootTree}\n${path}`;
    if (this.at.has(key)) return this.at.get(key)!;
    let cur: { oid: string; type: TreeEntry["type"] } | null = { oid: rootTree, type: "tree" };
    for (const seg of path.split("/")) {
      if (!cur || cur.type !== "tree") {
        cur = null;
        break;
      }
      const e: TreeEntry | undefined = (await this.tree(cur.oid)).find((x) => x.name === seg);
      cur = e ? { oid: e.hash, type: e.type } : null;
    }
    this.at.set(key, cur);
    return cur;
  }

  /** A commit's first parent, loading first-parent history ahead in one call. */
  async parentOf(c: CommitMeta, ahead: number): Promise<CommitMeta | null> {
    const p = c.parents[0];
    if (!p) return null;
    if (!this.commits.has(p)) {
      const page = (await this.obj.json<CommitMeta[]>(`/log/${this.repo.artifacts_name}/${p}?limit=${ahead}`, this.stats)) ?? [];
      for (const x of page) this.commits.set(x.hash, x);
    }
    return this.commits.get(p) ?? (await this.commit(p));
  }
}

// ── A folder at a ref ─────────────────────────────────────────────────────

const TYPE: Record<TreeEntry["type"], string> = { tree: "dir", blob: "file", exec: "file", symlink: "symlink", gitlink: "submodule" };

export async function listFolder(w: Walker, commit: CommitMeta, path: string, limit: number, cursor: string | null) {
  const at = await w.entryAt(commit.treeHash, path);
  if (!at) throw new HttpError(404, "not_found", `no ${path || "root"} at this ref`);
  if (at.type !== "tree") throw new HttpError(404, "not_a_folder", `${path} is a file; read it with getFile or raw`);
  const all = (await w.tree(at.oid))
    .map((e) => ({ name: e.name, type: TYPE[e.type] ?? "file", mode: e.mode, oid: e.hash }))
    .sort((a, b) => (a.type === "dir") !== (b.type === "dir") ? (a.type === "dir" ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const start = cursor ? all.findIndex((e) => `${e.type === "dir" ? 0 : 1}${e.name}` > cursor) : 0;
  const page = start < 0 ? [] : all.slice(start, start + limit);
  const last = page[page.length - 1];
  const more = start >= 0 && start + limit < all.length;
  return { entries: page, total: all.length, next: more && last ? `${last.type === "dir" ? 0 : 1}${last.name}` : null };
}

// ── The last commit per entry ─────────────────────────────────────────────

export interface LastCommits {
  commit: string;
  path: string;
  complete: boolean;
  entries: Record<string, CommitLine | null>;
  /** Entries still null when the walk hit WALK_MAX: older than this. */
  older: { before: string } | null;
}

/** Where a walk stopped, to resume it (R2). */
interface LastState {
  answers: Record<string, CommitLine>;
  open: string[];
  next: string | null;
  walked: number;
}

/**
 * Walk first parents from `state.next` until every open entry has the
 * commit that last changed it, the budget is spent, or WALK_MAX. `reuse`:
 * a complete answer for this folder at some commit; reaching it fills the rest.
 */
async function walkLast(w: Walker, path: string, state: LastState, reuse: LastCommits | null, merges: Set<string>) {
  const open = new Set(state.open);
  let k: CommitMeta | null = state.next ? await w.commit(state.next) : null;
  let walked = state.walked;
  let older: string | null = null;
  while (k && open.size) {
    if (reuse && k.hash === reuse.commit) {
      for (const n of open) if (reuse.entries[n]) state.answers[n] = reuse.entries[n]!;
      open.clear();
      break;
    }
    const p = await w.parentOf(k, 1000);
    const ka = await w.entryAt(k.treeHash, path);
    const pa = p ? await w.entryAt(p.treeHash, path) : null;
    if (!p || ka?.oid !== pa?.oid) {
      const kt = ka?.type === "tree" ? await w.tree(ka.oid) : [];
      const pt = new Map((pa?.type === "tree" ? await w.tree(pa.oid) : []).map((e) => [e.name, e.hash]));
      for (const e of kt) {
        if (!open.has(e.name) || (p && pt.get(e.name) === e.hash)) continue;
        state.answers[e.name] = lineOf(k);
        if (k.parents.length > 1) merges.add(k.hash);
        open.delete(e.name);
      }
    }
    walked++;
    k = p;
    if (!k) break;
    if (walked >= WALK_MAX) {
      older = new Date(k.authoredAt * 1000).toISOString();
      break;
    }
    if (w.spent()) break;
  }
  const done = open.size === 0 || !k || older !== null;
  return { state: { answers: state.answers, open: [...open], next: done ? null : k!.hash, walked }, done, older };
}

type MergesFor = (shas: string[]) => Promise<Record<string, { branch: string; title: string | null }>>;

async function labelMerges(lines: Iterable<CommitLine>, shas: Set<string>, mergesFor: MergesFor): Promise<void> {
  if (!shas.size) return;
  const m = await mergesFor([...shas]);
  for (const l of lines) if (m[l.sha]) l.merged_branch = m[l.sha];
}

/**
 * The last commit per entry of a folder at a commit: a stored answer, else a
 * walk within `budget` (resuming a checkpoint, reusing the newest answer for
 * this folder). Not done: the checkpoint is saved and, the first time, a job
 * is queued to finish it.
 */
export async function lastCommits(
  env: Env,
  w: Walker,
  obj: ObjectsClient,
  commit: CommitMeta,
  path: string,
  mergesFor: MergesFor,
  fromJob = false,
): Promise<LastCommits & { queued: boolean }> {
  const repo = w.repo;
  const ph = await sha1Hex(path);
  const key = answerKey("last", commit.hash, ph);
  const stored = await obj.json<LastCommits>(`/answer/${repo.artifacts_name}/${key}`);
  if (stored) return { ...stored, queued: false };
  const at = await w.entryAt(commit.treeHash, path);
  if (!at) throw new HttpError(404, "not_found", `no ${path || "root"} at this ref`);
  if (at.type !== "tree") throw new HttpError(404, "not_a_folder", `${path} is a file`);
  const names = (await w.tree(at.oid)).map((e) => e.name);
  const partialKey = `partial/${repo.artifacts_name}/${key}.json`;
  const saved = (await (await env.CACHE?.get(partialKey))?.json<LastState>()) ?? null;
  const state: LastState = saved ?? { answers: {}, open: names, next: commit.hash, walked: 0 };
  // The newest complete answer for this folder: a walk that reaches it stops there.
  const ptr = (await (await env.CACHE?.get(`answers/${repo.artifacts_name}/last-ptr/${ph}.json`))?.json<{ commit: string }>()) ?? null;
  const reuse = ptr && ptr.commit !== commit.hash ? await obj.json<LastCommits>(`/answer/${repo.artifacts_name}/${answerKey("last", ptr.commit, ph)}`) : null;
  const merges = new Set<string>();
  const r = await walkLast(w, path, state, reuse, merges);
  await labelMerges(Object.values(r.state.answers), merges, mergesFor);
  const entries: Record<string, CommitLine | null> = {};
  for (const n of names) entries[n] = r.state.answers[n] ?? null;
  if (r.done) {
    const answer: LastCommits = { commit: commit.hash, path, complete: true, entries, older: r.older ? { before: r.older } : null };
    await storeAnswer(env, repo.artifacts_name, key, answer);
    await env.CACHE?.put(`answers/${repo.artifacts_name}/last-ptr/${ph}.json`, JSON.stringify({ commit: commit.hash }));
    if (saved) await env.CACHE?.delete(partialKey);
    return { ...answer, queued: false };
  }
  await env.CACHE?.put(partialKey, JSON.stringify(r.state));
  let queued = false;
  if ((!saved || fromJob) && env.HISTORY_QUEUE) {
    const msg: HistoryMessage = { type: "last", monorepo: repo.artifacts_name.slice(0, repo.artifacts_name.indexOf("--")), repo: repo.name, artifacts: repo.artifacts_name, commit: commit.hash, path };
    await env.HISTORY_QUEUE.send(msg, fromJob ? { delaySeconds: 1 } : undefined);
    queued = true;
  }
  return { commit: commit.hash, path, complete: false, entries, older: null, queued };
}

// ── A path's history ──────────────────────────────────────────────────────

/** Commits from `start` (first parents) that changed `path`, up to `limit`; `next` resumes after the last one walked. */
export async function walkHistory(w: Walker, start: string, path: string, limit: number, walkedBefore: number, mergesFor: MergesFor) {
  const changes: CommitLine[] = [];
  const merges = new Set<string>();
  let k = await w.commit(start);
  if (!k) throw new HttpError(404, "not_found", "no such commit in this repo");
  let walked = walkedBefore;
  let next: string | null = null;
  let budgetCut = false;
  while (k) {
    const p = await w.parentOf(k, 200);
    const ka = await w.entryAt(k.treeHash, path);
    const pa = p ? await w.entryAt(p.treeHash, path) : null;
    if (ka?.oid !== pa?.oid) {
      changes.push(lineOf(k));
      if (k.parents.length > 1) merges.add(k.hash);
    }
    walked++;
    if (!p) break;
    if (changes.length >= limit || walked >= WALK_MAX || w.spent()) {
      next = p.hash;
      budgetCut = changes.length < limit && walked < WALK_MAX;
      break;
    }
    k = p;
  }
  await labelMerges(changes, merges, mergesFor);
  return { changes, next: walked >= WALK_MAX ? null : next, walked, budgetCut, capped: walked >= WALK_MAX };
}

// ── Raw ───────────────────────────────────────────────────────────────────

const IMAGES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp",
};

/**
 * A raw file's response. Same origin as the app and its cookie, so nothing
 * runs: a sandbox CSP, nosniff, images as images, text (HTML and SVG
 * included) as text/plain, anything with a NUL in its first 8,000 bytes as
 * octet-stream (git's binary test).
 */
export async function rawResponse(blob: Response, name: string, oid: string, pinned: boolean, head: boolean): Promise<Response> {
  const headers = new Headers({
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    etag: `"${oid}"`,
    "cache-control": pinned ? "private, max-age=31536000, immutable" : "private, no-cache",
  });
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const reader = blob.body!.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (n < 8000) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.byteLength;
  }
  const first = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    first.set(c, o);
    o += c.byteLength;
  }
  const binary = first.subarray(0, 8000).includes(0);
  headers.set("content-type", IMAGES[ext] ?? (binary ? "application/octet-stream" : "text/plain; charset=utf-8"));
  if (head) {
    await reader.cancel();
    return new Response(null, { headers });
  }
  return new Response(prepend(first, reader), { headers });
}

/** Queue messages for pando-history: finish a folder's last commits off the request. */
export interface HistoryMessage {
  type: "last";
  monorepo: string;
  repo: string;
  artifacts: string;
  commit: string;
  path: string;
}

export function answerKey(kind: "last" | "hist", commit: string, pathHash: string): string {
  return `${kind}/${commit}/${pathHash}`;
}

export async function storeAnswer(env: Env, artifacts: string, key: string, body: unknown): Promise<void> {
  await env.CACHE?.put(`answers/${artifacts}/${key}.json`, JSON.stringify(body), { httpMetadata: { contentType: "application/json" } });
}

/**
 * A ref (a branch name or a 40-hex sha; default main) to its commit in this
 * repo. Branches come from the object's stored heads (`refHead`, no Artifacts
 * call); anything else (a tag, an old branch) from one Artifacts log call. A
 * sha from another repo is a 404: the commit is read through this repo.
 */
export async function resolveCommit(
  env: Env,
  w: Walker,
  refHead: (ref: string) => Promise<string | null>,
  ref: string | null | undefined,
): Promise<{ ref: string; commit: CommitMeta; pinned: boolean }> {
  const r = ref || w.repo.default_branch;
  let sha: string | null = null;
  if (/^[0-9a-f]{40}$/.test(r)) sha = r;
  else {
    if (r.length > 200 || /[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{/.test(r)) throw new HttpError(400, "bad_request", "ref: a branch name or a 40-character sha");
    sha = await refHead(r);
    if (!sha) {
      const { withRepo } = await import("./artifacts");
      const log = await withRepo(env, w.repo.artifacts_name, (repo) => repo.log({ ref: r, limit: 1 })).catch(() => []);
      sha = log[0]?.hash ?? null;
    }
  }
  if (!sha) throw new HttpError(404, "not_found", `no ref ${r}`);
  const commit = await w.commit(sha);
  if (!commit) throw new HttpError(404, "not_found", `no commit ${r} in this repo`);
  return { ref: r, commit, pinned: sha === r };
}

/** pando-history: finish a folder's last commits with the job's budget. */
export async function handleHistoryBatch(
  batch: MessageBatch<HistoryMessage>,
  env: Env,
  ctx: ExecutionContext,
  deps: { objects: (ctx: { exports?: unknown } | ExecutionContext) => ObjectsClient; mergesFor: (monorepoId: string, repo: string) => MergesFor },
): Promise<void> {
  for (const msg of batch.messages) {
    const m = msg.body;
    try {
      const obj = deps.objects(ctx);
      const rec = { name: m.repo, artifacts_name: m.artifacts } as RepoRecord;
      const w = new Walker(obj, rec, JOB_BUDGET);
      const commit = await w.commit(m.commit);
      if (commit) await lastCommits(env, w, obj, commit, m.path, deps.mergesFor(m.monorepo, m.repo), true);
      msg.ack();
    } catch (err) {
      console.error({ msg: "pando.history", error: err instanceof Error ? err.message : String(err) });
      msg.retry({ delaySeconds: 5 });
    }
  }
}
