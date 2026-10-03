// The monorepo object: one Durable Object (SQLite) per monorepo. It keeps
// repos, branches, reviews, statuses, merges, hooks, deliveries and the
// worktree registry, and it runs merges one at a time. Users, credentials
// and membership are in the accounts object.
// Owned by the server-git lane.
//
// Its methods are RPC. A method that can fail returns an Outcome, because RPC
// passes only an error's message across.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { HttpError, now, redact } from "../http";
import { branchesOf, listRefs, withRepo } from "./artifacts";
import { combine, requiredChecks } from "./checks";
import { attempt, hookView, RETRY_DELAYS_MS, wants, type HookRow, type StoredPayload } from "./hooks";
import { gitWriteCode, gitwrite } from "./merge-port";
import { DEFAULT_BRANCH, metaArtifactsName, ZERO } from "./names";
import { changedFiles } from "./diff";
import type { RefCommand } from "./pktline";
import type {
  BranchRecord,
  Checks,
  Identity,
  Kind,
  MonorepoInfo,
  Outcome,
  RepoEvent,
  RepoRecord,
  StatusRecord,
} from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repos (
  name TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, artifacts_name TEXT NOT NULL UNIQUE, remote TEXT NOT NULL,
  default_branch TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS branches (
  repo TEXT NOT NULL, name TEXT NOT NULL, head TEXT, creator TEXT, title TEXT, description TEXT,
  created_at TEXT, updated_at TEXT, merge_commit TEXT, merged_head TEXT, merged_at TEXT, merged_by TEXT, deleted_at TEXT,
  PRIMARY KEY (repo, name));
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT NOT NULL, head TEXT NOT NULL, verdict TEXT NOT NULL,
  body TEXT, comments TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS reviews_branch ON reviews (repo, branch);
CREATE TABLE IF NOT EXISTS statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, sha TEXT NOT NULL, context TEXT NOT NULL, state TEXT NOT NULL,
  target_url TEXT, description TEXT, creator TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS statuses_sha ON statuses (repo, sha);
CREATE TABLE IF NOT EXISTS merges (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, branch TEXT NOT NULL, head TEXT NOT NULL,
  base_before TEXT NOT NULL, merge_commit TEXT NOT NULL, merge_base TEXT, merged_by TEXT NOT NULL,
  forced INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hooks (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, type TEXT NOT NULL, url TEXT, secret TEXT, events TEXT NOT NULL,
  config TEXT, active INTEGER NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, hook_id TEXT NOT NULL, repo TEXT NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL, response_code INTEGER, error TEXT,
  created_at TEXT NOT NULL, last_attempt_at TEXT, next_attempt_at TEXT);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS deliveries_hook ON deliveries (hook_id, created_at);
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT NOT NULL, path TEXT NOT NULL, machine TEXT NOT NULL,
  agent TEXT, kind TEXT NOT NULL, reported_by TEXT NOT NULL,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
`;

type Row = Record<string, SqlStorageValue>;

function randomId(prefix: string, bytes = 8): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function fail(status: number, code: string, message: string, extra?: Record<string, unknown>): never {
  throw new HttpError(status, code, message, extra);
}

export interface PushVerdict {
  ref: string;
  reason: string;
}

export interface MergeArgs {
  repo: string;
  branch: string;
  identity: Identity;
  force: boolean;
  message?: string;
  expected_head?: string;
  origin: string;
}

export interface MergeResult {
  status: "merged" | "up_to_date";
  branch: string;
  head: string;
  sha: string;
  base_before?: string;
  merge_base?: string;
  forced: boolean;
  merged_by: string;
}

export class MonorepoObject extends DurableObject<Env> {
  private sql: SqlStorage;
  private locks = new Map<string, Promise<unknown>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
  }

  private rows<T>(query: string, ...args: unknown[]): T[] {
    return this.sql.exec<Row>(query, ...args).toArray() as unknown as T[];
  }

  private row<T>(query: string, ...args: unknown[]): T | null {
    return this.rows<T>(query, ...args)[0] ?? null;
  }

  private async guard<T>(fn: () => Promise<T> | T): Promise<Outcome<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      if (err instanceof HttpError) return { ok: false, status: err.status, code: err.code, message: err.message, extra: err.extra };
      throw err;
    }
  }

  /** Run fn after every earlier fn with the same key: merges are serialized per repo. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  // ── The monorepo ─────────────────────────────────────────────────────────

  info(): MonorepoInfo | null {
    const m = Object.fromEntries(this.rows<{ k: string; v: string }>("SELECT k, v FROM meta").map((r) => [r.k, r.v]));
    if (!m.name) return null;
    return { name: m.name, kind: m.kind as Kind, created_at: m.created_at };
  }

  /** Make the monorepo. False if it exists already. */
  init(name: string, kind: Kind): boolean {
    if (this.info()) return false;
    const at = now();
    for (const [k, v] of [["name", name], ["kind", kind], ["created_at", at]]) this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?)", k, v);
    return true;
  }

  /** Undo a monorepo whose creation failed half way, or delete one. */
  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Every Artifacts repo this monorepo owns, the meta layer's included. */
  artifactsRepos(): string[] {
    const m = this.info();
    const names = new Set(this.rows<{ artifacts_name: string }>("SELECT artifacts_name FROM repos").map((r) => r.artifacts_name));
    if (m?.kind === "monorepo") names.add(metaArtifactsName(m.name));
    return [...names];
  }

  // ── Repos ────────────────────────────────────────────────────────────────

  addRepo(r: RepoRecord): Promise<Outcome<RepoRecord>> {
    return this.guard(() => {
      const m = this.info();
      if (!m) fail(404, "not_found", "no such monorepo");
      if (m.kind === "repo" && this.row("SELECT name FROM repos")) fail(409, "plain_repo", "a plain git repo has exactly one repo");
      if (this.row("SELECT name FROM repos WHERE name = ? OR path = ?", r.name, r.path))
        fail(409, "repo_exists", `a repo named ${r.name} or at ${r.path} exists`);
      this.sql.exec(
        "INSERT INTO repos (name, path, artifacts_name, remote, default_branch, description, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        r.name, r.path, r.artifacts_name, r.remote, r.default_branch, r.description, r.created_at, r.created_by,
      );
      return r;
    });
  }

  private repoRow(name: string): RepoRecord | null {
    return this.row<RepoRecord>("SELECT * FROM repos WHERE name = ?", name);
  }

  /**
   * A repo by its URL name. In a monorepo, `meta` is the meta layer's own
   * repo (<monorepo>--meta, path "."): it takes branches, reviews and merges
   * like any repo, which is how .pando/** changes. Its record is made on
   * first use.
   */
  async getRepo(name: string): Promise<RepoRecord | null> {
    const r = this.repoRow(name);
    if (r || name !== "meta") return r;
    const m = this.info();
    if (m?.kind !== "monorepo") return null;
    const artifacts_name = metaArtifactsName(m.name);
    let remote: string;
    try {
      remote = await withRepo(this.env, artifacts_name, async (repo) => (await repo.info()).remote);
    } catch {
      return null;
    }
    this.sql.exec(
      `INSERT INTO repos (name, path, artifacts_name, remote, default_branch, description, created_at, created_by)
       VALUES ('meta', '.', ?, ?, ?, 'The meta layer', ?, 'pando') ON CONFLICT DO NOTHING`,
      artifacts_name, remote, DEFAULT_BRANCH, now(),
    );
    return this.repoRow(name);
  }

  /** The code repos (the meta layer's repo is not listed). */
  listRepos(): RepoRecord[] {
    return this.rows<RepoRecord>("SELECT * FROM repos WHERE NOT (name = 'meta' AND artifacts_name LIKE '%--meta') ORDER BY path");
  }

  // ── Branches and pushes ──────────────────────────────────────────────────

  branchRecords(repo: string): BranchRecord[] {
    return this.rows<BranchRecord>("SELECT * FROM branches WHERE repo = ? AND deleted_at IS NULL ORDER BY name", repo);
  }

  branchRecord(repo: string, name: string): BranchRecord | null {
    return this.row<BranchRecord>("SELECT * FROM branches WHERE repo = ? AND name = ? AND deleted_at IS NULL", repo, name);
  }

  /** The door's one rule: main moves only by a merge (creating it is allowed). */
  checkPush(repo: string, commands: RefCommand[]): PushVerdict[] {
    const r = this.repoRow(repo);
    const main = `refs/heads/${r?.default_branch ?? DEFAULT_BRANCH}`;
    return commands
      .filter((c) => c.ref === main && c.old !== ZERO)
      .map((c) => ({ ref: c.ref, reason: `${main.slice(11)} is protected; push a branch and merge it (pando merge)` }));
  }

  /** Record branch heads after Artifacts accepted a push. Returns the events to deliver. */
  recordPush(repo: string, identity: Identity, updates: RefCommand[]): RepoEvent[] {
    const r = this.repoRow(repo);
    const main = r?.default_branch ?? DEFAULT_BRANCH;
    const at = now();
    const events: RepoEvent[] = [];
    for (const u of updates) {
      if (!u.ref.startsWith("refs/heads/")) continue;
      const name = u.ref.slice(11);
      const base: Omit<RepoEvent, "event"> = {
        repo, branch: name, ref: u.ref, before: u.old, head: u.new, base: null,
        author: null, pusher: identity.login, title: null, description: null,
      };
      if (name === main) {
        events.push({ ...base, event: "push", author: identity.login });
        continue;
      }
      let b = this.branchRecord(repo, name);
      if (u.new === ZERO) {
        if (b) this.sql.exec("UPDATE branches SET deleted_at = ?, head = NULL, updated_at = ? WHERE repo = ? AND name = ?", at, at, repo, name);
        events.push({ ...base, event: "push", author: b?.creator ?? null, title: b?.title ?? null, description: b?.description ?? null });
        continue;
      }
      const opened = !b;
      if (!b) {
        this.sql.exec(
          `INSERT INTO branches (repo, name, head, creator, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo, name) DO UPDATE SET head = excluded.head, creator = excluded.creator,
             title = NULL, description = NULL, created_at = excluded.created_at, updated_at = excluded.updated_at,
             merge_commit = NULL, merged_head = NULL, merged_at = NULL, merged_by = NULL, deleted_at = NULL`,
          repo, name, u.new, identity.login, at, at,
        );
      } else {
        this.sql.exec("UPDATE branches SET head = ?, updated_at = ? WHERE repo = ? AND name = ?", u.new, at, repo, name);
      }
      b = this.branchRecord(repo, name)!;
      const e = { ...base, author: b.creator, title: b.title, description: b.description };
      if (opened) events.push({ ...e, event: "branch.opened" });
      events.push({ ...e, event: "push" });
    }
    return events;
  }

  /** A branch made by the API (createBranch): the caller is its creator. */
  createBranchRecord(repo: string, name: string, head: string, identity: Identity, title: string | null, description: string | null): RepoEvent[] {
    const events = this.recordPush(repo, identity, [{ old: ZERO, new: head, ref: `refs/heads/${name}` }]);
    if (title !== null || description !== null) {
      this.sql.exec("UPDATE branches SET title = ?, description = ? WHERE repo = ? AND name = ?", title, description, repo, name);
      for (const e of events) Object.assign(e, { title, description });
    }
    return events;
  }

  updateBranch(repo: string, name: string, patch: { title?: string; description?: string }, head: string): Promise<Outcome<BranchRecord>> {
    return this.guard(() => {
      let b = this.branchRecord(repo, name);
      if (!b) {
        // A branch that exists in Artifacts but never came through the door.
        this.sql.exec(
          `INSERT INTO branches (repo, name, head, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (repo, name) DO UPDATE SET head = excluded.head, deleted_at = NULL`,
          repo, name, head, now(), now(),
        );
        b = this.branchRecord(repo, name)!;
      }
      if (patch.title !== undefined) this.sql.exec("UPDATE branches SET title = ? WHERE repo = ? AND name = ?", patch.title, repo, name);
      if (patch.description !== undefined) this.sql.exec("UPDATE branches SET description = ? WHERE repo = ? AND name = ?", patch.description, repo, name);
      return this.branchRecord(repo, name)!;
    });
  }

  // ── Reviews ──────────────────────────────────────────────────────────────

  addReview(repo: string, branch: string, head: string, verdict: string, body: string | null, comments: unknown[], identity: Identity) {
    const id = randomId("rv_");
    const at = now();
    this.sql.exec(
      "INSERT INTO reviews (id, repo, branch, head, verdict, body, comments, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, repo, branch, head, verdict, body, JSON.stringify(comments), identity.login, at,
    );
    return { id, branch, head, verdict, body, comments, author: identity.login, created_at: at };
  }

  listReviews(repo: string, branch: string) {
    return this.rows<Record<string, string>>("SELECT * FROM reviews WHERE repo = ? AND branch = ? ORDER BY created_at", repo, branch).map((r) => ({
      id: r.id, branch: r.branch, head: r.head, verdict: r.verdict, body: r.body, comments: JSON.parse(r.comments),
      author: r.author, created_at: r.created_at,
    }));
  }

  // ── Statuses and the gate ────────────────────────────────────────────────

  addStatus(repo: string, sha: string, s: { state: StatusRecord["state"]; context: string; target_url: string | null; description: string | null }, creator: string): StatusRecord {
    const at = now();
    this.sql.exec(
      "INSERT INTO statuses (repo, sha, context, state, target_url, description, creator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      repo, sha, s.context, s.state, s.target_url, s.description, creator, at,
    );
    return { sha, ...s, creator, created_at: at };
  }

  statuses(repo: string, sha: string): StatusRecord[] {
    return this.rows<StatusRecord>(
      "SELECT sha, context, state, target_url, description, creator, created_at FROM statuses WHERE repo = ? AND sha = ? ORDER BY id",
      repo, sha,
    );
  }

  private async checksFor(r: RepoRecord, sha: string): Promise<Checks> {
    const m = this.info()!;
    return combine(sha, await requiredChecks(this.env, m, r), this.statuses(r.name, sha));
  }

  // ── Merge ────────────────────────────────────────────────────────────────

  merge(args: MergeArgs): Promise<Outcome<MergeResult>> {
    return this.guard(() => this.serial(`merge:${args.repo}`, () => this.mergeNow(args)));
  }

  private async mergeNow(a: MergeArgs): Promise<MergeResult> {
    const r = (await this.getRepo(a.repo)) ?? fail(404, "not_found", `no repo ${a.repo}`);
    const refs = branchesOf(await listRefs(this.env, r));
    const head = refs.get(a.branch) ?? fail(404, "not_found", `no branch ${a.branch}`);
    const base = refs.get(r.default_branch) ?? fail(409, "no_main", `${r.default_branch} does not exist yet`);
    if (a.branch === r.default_branch) fail(400, "bad_request", `cannot merge ${r.default_branch} into itself`);
    if (a.expected_head && a.expected_head !== head) fail(409, "head_moved", `the branch is at ${head}, not ${a.expected_head}`);
    const checks = await this.checksFor(r, head);
    if (checks.state !== "success" && !a.force) {
      fail(412, "checks_not_green", `checks are ${checks.state} on ${head.slice(0, 12)}; wait, or merge with force`, { checks });
    }
    if (!gitwrite) fail(501, "merge_engine_unavailable", "the server-side merge engine (worker/src/gitwrite) is not wired in yet");
    const b = this.branchRecord(a.repo, a.branch);
    const message = a.message ?? mergeMessage(a.branch, b);
    const email = a.identity.email ?? `${a.identity.login}@users.pando.invalid`;
    let out;
    try {
      out = await gitwrite.mergeCommit(
        { artifacts: this.env.ARTIFACTS, name: r.artifacts_name },
        {
          base: r.default_branch, head, baseSha: base, message,
          author: { name: a.identity.name ?? a.identity.login, email },
          committer: { name: "Pando", email: "pando@pando.invalid" },
        },
      );
    } catch (err) {
      const code = gitWriteCode(err);
      const msg = redact(err instanceof Error ? err.message : String(err));
      if (code === "no_merge_base") fail(409, "no_merge_base", msg);
      if (code === "not_found") fail(404, "not_found", msg);
      if (code === "invalid_input") fail(400, "bad_request", msg);
      if (code === "too_large") fail(422, "too_large", msg);
      fail(502, code ?? "merge_failed", msg);
    }
    if (out.status === "conflict") {
      fail(409, "conflict", `${out.paths.length} file(s) changed differently on both sides; merge ${r.default_branch} into the branch, push, and merge again`, { paths: out.paths });
    }
    if (out.status === "ref_moved") fail(409, "ref_moved", `${r.default_branch} moved while merging; retry`);
    if (out.status === "up_to_date") {
      return { status: "up_to_date", branch: a.branch, head, sha: base, forced: false, merged_by: a.identity.login };
    }
    if (out.status !== "merged") fail(502, "merge_failed", `unexpected merge result ${out.status}`);
    const at = now();
    const forced = checks.state !== "success";
    this.sql.exec(
      "INSERT INTO merges (repo, branch, head, base_before, merge_commit, merge_base, merged_by, forced, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      a.repo, a.branch, head, out.old, out.sha, out.mergeBase, a.identity.login, forced ? 1 : 0, at,
    );
    this.sql.exec(
      `INSERT INTO branches (repo, name, head, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (repo, name) DO UPDATE SET deleted_at = NULL`,
      a.repo, a.branch, head, at, at,
    );
    this.sql.exec(
      "UPDATE branches SET merge_commit = ?, merged_head = ?, merged_at = ?, merged_by = ? WHERE repo = ? AND name = ?",
      out.sha, head, at, a.identity.login, a.repo, a.branch,
    );
    if (r.artifacts_name === metaArtifactsName(this.info()!.name)) {
      // The merge has landed; machines get it on the live layer's next try if this fails.
      await this.applyToMetaLayer(out.old, out.sha, a.identity).catch((err) =>
        console.error("applyFromMain failed:", redact(err instanceof Error ? err.message : String(err))),
      );
    }
    await this.enqueue(
      [{
        event: "merged", repo: a.repo, branch: a.branch, ref: `refs/heads/${a.branch}`, before: out.old, head,
        base: out.mergeBase, author: b?.creator ?? null, pusher: a.identity.login, title: b?.title ?? null,
        description: b?.description ?? null, merge_commit: out.sha,
      }],
      a.origin,
    );
    return { status: "merged", branch: a.branch, head, sha: out.sha, base_before: out.old, merge_base: out.mergeBase, forced, merged_by: a.identity.login };
  }

  /** A merge landed on the meta layer's main: hand the changed files to the live meta layer. */
  private async applyToMetaLayer(before: string, commit: string, who: Identity): Promise<void> {
    const m = this.info()!.name;
    const changes = await withRepo(this.env, metaArtifactsName(m), async (repo) => {
      const [a, b] = await Promise.all([repo.readCommit(before), repo.readCommit(commit)]);
      if (!a || !b) throw new HttpError(502, "artifacts", "the merge's commits could not be read");
      const files = await changedFiles(repo, a.treeHash, b.treeHash);
      return Promise.all(
        files.map(async (f) => {
          if (!f.sha) return { path: f.path, bytes: null };
          const blob = await repo.readBlob(f.sha);
          return { path: f.path, bytes: blob ? new Uint8Array(await blob.arrayBuffer()) : null };
        }),
      );
    });
    const author = `${who.name ?? who.login} <${who.email ?? `${who.login}@users.pando.invalid`}>`;
    await this.env.META.get(this.env.META.idFromName(m)).applyFromMain({ monorepo: m, commit, author, changes });
  }

  // ── Hooks and deliveries ─────────────────────────────────────────────────

  addHook(repo: string, h: { type: "web" | "buildkite"; url: string | null; secret: string | null; events: string[]; config: unknown }, identity: Identity) {
    const id = randomId("hk_");
    this.sql.exec(
      "INSERT INTO hooks (id, repo, type, url, secret, events, config, active, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
      id, repo, h.type, h.url, h.secret, JSON.stringify(h.events), h.config ? JSON.stringify(h.config) : null, now(), identity.login,
    );
    return hookView(this.row<HookRow>("SELECT * FROM hooks WHERE id = ?", id)!);
  }

  listHooks(repo: string) {
    return this.rows<HookRow>("SELECT * FROM hooks WHERE repo = ? ORDER BY created_at", repo).map(hookView);
  }

  deleteHook(repo: string, id: string): boolean {
    return this.sql.exec("DELETE FROM hooks WHERE repo = ? AND id = ?", repo, id).rowsWritten > 0;
  }

  listDeliveries(repo: string, hookId: string) {
    return this.rows<Record<string, unknown>>(
      `SELECT id, hook_id, event, status, attempts, response_code, error, created_at, last_attempt_at, next_attempt_at
       FROM deliveries WHERE repo = ? AND hook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100`,
      repo, hookId,
    );
  }

  /** Fan events out to the repo's hooks and start delivering. */
  async enqueue(events: RepoEvent[], origin: string): Promise<number> {
    const m = this.info();
    if (!m || events.length === 0) return 0;
    let n = 0;
    for (const e of events) {
      const hooks = this.rows<HookRow>("SELECT * FROM hooks WHERE repo = ?", e.repo).filter((h) => wants(h, e));
      for (const h of hooks) {
        const payload: StoredPayload = { ...e, occurred_at: now(), monorepo: m.name, origin };
        this.insertDelivery(h.id, e.repo, e.event, JSON.stringify(payload));
        n++;
      }
    }
    if (n) await this.ctx.storage.setAlarm(Date.now());
    return n;
  }

  private insertDelivery(hookId: string, repo: string, event: string, payload: string): string {
    const id = randomId("dlv_");
    const at = now();
    this.sql.exec(
      "INSERT INTO deliveries (id, hook_id, repo, event, payload, status, attempts, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
      id, hookId, repo, event, payload, at, at,
    );
    return id;
  }

  redeliver(repo: string, deliveryId: string): Promise<Outcome<Record<string, unknown>>> {
    return this.guard(async () => {
      const d = this.row<{ hook_id: string; event: string; payload: string }>(
        "SELECT hook_id, event, payload FROM deliveries WHERE repo = ? AND id = ?", repo, deliveryId,
      ) ?? fail(404, "not_found", `no delivery ${deliveryId}`);
      const payload = JSON.parse(d.payload) as StoredPayload;
      payload.occurred_at = now();
      const id = this.insertDelivery(d.hook_id, repo, d.event, JSON.stringify(payload));
      await this.ctx.storage.setAlarm(Date.now());
      return this.row<Record<string, unknown>>(
        "SELECT id, hook_id, event, status, attempts, response_code, error, created_at, last_attempt_at, next_attempt_at FROM deliveries WHERE id = ?", id,
      )!;
    });
  }

  async alarm(): Promise<void> {
    const due = this.rows<{ id: string; hook_id: string; repo: string; payload: string; attempts: number }>(
      "SELECT id, hook_id, repo, payload, attempts FROM deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 25",
      now(),
    );
    await Promise.all(due.map((d) => this.deliver(d)));
    const next = this.row<{ t: string | null }>("SELECT MIN(next_attempt_at) AS t FROM deliveries WHERE status = 'pending'");
    if (next?.t) await this.ctx.storage.setAlarm(Math.max(Date.parse(next.t), Date.now() + 1000));
  }

  private async deliver(d: { id: string; hook_id: string; repo: string; payload: string; attempts: number }) {
    const hook = this.row<HookRow>("SELECT * FROM hooks WHERE id = ?", d.hook_id);
    const repo = this.repoRow(d.repo);
    const at = now();
    if (!hook || !repo) {
      this.sql.exec("UPDATE deliveries SET status = 'failed', error = ?, last_attempt_at = ?, next_attempt_at = NULL WHERE id = ?", "the hook or repo was removed", at, d.id);
      return;
    }
    const result = await attempt(this.env, hook, d.id, repo.artifacts_name, JSON.parse(d.payload));
    const attempts = d.attempts + 1;
    if (result.ok) {
      this.sql.exec(
        "UPDATE deliveries SET status = 'delivered', attempts = ?, response_code = ?, error = NULL, last_attempt_at = ?, next_attempt_at = NULL WHERE id = ?",
        attempts, result.code, at, d.id,
      );
      return;
    }
    const delay = RETRY_DELAYS_MS[attempts - 1];
    this.sql.exec(
      "UPDATE deliveries SET status = ?, attempts = ?, response_code = ?, error = ?, last_attempt_at = ?, next_attempt_at = ? WHERE id = ?",
      delay === undefined ? "failed" : "pending", attempts, result.code, result.error, at,
      delay === undefined ? null : new Date(Date.now() + delay).toISOString(), d.id,
    );
  }

  // ── Worktrees ────────────────────────────────────────────────────────────

  putWorktree(id: string, w: { repo: string; branch: string; path: string; machine: string; agent: string | null; kind: string }, identity: Identity): Promise<Outcome<Record<string, unknown>>> {
    return this.guard(() => {
      const at = now();
      const old = this.row<{ created_at: string }>("SELECT created_at FROM worktrees WHERE id = ?", id);
      this.sql.exec(
        `INSERT INTO worktrees (id, repo, branch, path, machine, agent, kind, reported_by, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET repo = excluded.repo, branch = excluded.branch, path = excluded.path, machine = excluded.machine,
           agent = excluded.agent, kind = excluded.kind, reported_by = excluded.reported_by, last_seen_at = excluded.last_seen_at`,
        id, w.repo, w.branch, w.path, w.machine, w.agent, w.kind, identity.login, old?.created_at ?? at, at,
      );
      return this.worktree(id)!;
    });
  }

  private worktree(id: string): Record<string, unknown> | null {
    return this.row(
      "SELECT id, repo, branch, path, machine, agent, kind, reported_by, created_at, last_seen_at FROM worktrees WHERE id = ?", id,
    );
  }

  getWorktree(id: string) {
    return this.worktree(id);
  }

  listWorktrees(filter: { machine?: string; repo?: string }) {
    return this.rows<Record<string, unknown>>(
      `SELECT id, repo, branch, path, machine, agent, kind, reported_by, created_at, last_seen_at FROM worktrees
       WHERE (?1 IS NULL OR machine = ?1) AND (?2 IS NULL OR repo = ?2) ORDER BY machine, path`,
      filter.machine ?? null, filter.repo ?? null,
    );
  }

  deleteWorktree(id: string): Promise<Outcome<boolean>> {
    return this.guard(() => {
      if (!this.row("SELECT id FROM worktrees WHERE id = ?", id)) fail(404, "not_found", `no worktree ${id}`);
      this.sql.exec("DELETE FROM worktrees WHERE id = ?", id);
      return true;
    });
  }
}

export function mergeMessage(branch: string, b: BranchRecord | null): string {
  const tail = `Merge branch '${branch}'`;
  if (!b?.title) return tail + "\n";
  return [b.title, b.description, tail].filter(Boolean).join("\n\n") + "\n";
}
