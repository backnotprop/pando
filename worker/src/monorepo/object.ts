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
import { branchesOf, listRefs, repoToken, repoTokenEntry, updateRefs, withRepo } from "./artifacts";
import { GateBusy, isBusy, LEASE_MS, releaseDelay, retryBusy, WAIT_MS, WRITE_SLOTS, WriteGate } from "./gate";
import { finishTiming, note, runTimed, startTiming, timed, timedArtifacts, timeGate } from "../timing";
import { combine, requiredChecks } from "./checks";
import { hookView, wants, type HookRow, type StoredPayload } from "./hooks";
import { gitWriteCode, gitwrite } from "./merge-port";
import { DEFAULT_BRANCH, metaArtifactsName, ZERO } from "./names";
import { STALE_GRACE_MS } from "./facts";
import type { BranchList, BranchView } from "./views";
import { EVENT_STREAM, eventTags, parseTopics } from "./stream";
import { changedFiles } from "./diff";
import type { RefCommand } from "./pktline";
import { FeedOut } from "../feed/out";
import type { FeedEvent, Key, NeedRow, NeedState, Summary } from "../feed/shape";
import type { JoinData } from "../feed/object";
import type {
  BranchRecord,
  Checks,
  Identity,
  Kind,
  ObjectInfo,
  Outcome,
  RepoEvent,
  RepoRecord,
  StatusRecord,
  StreamEvent,
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
CREATE TABLE IF NOT EXISTS delivery_attempts (
  delivery_id TEXT NOT NULL, n INTEGER NOT NULL, at TEXT NOT NULL, response_code INTEGER, error TEXT, ms INTEGER);
CREATE INDEX IF NOT EXISTS delivery_attempts_d ON delivery_attempts (delivery_id);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS object_sizes (repo TEXT NOT NULL, oid TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (repo, oid));
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT NOT NULL, path TEXT NOT NULL, machine TEXT NOT NULL,
  agent TEXT, kind TEXT NOT NULL, reported_by TEXT NOT NULL,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
`;

type Row = Record<string, SqlStorageValue>;

/** Events replayed to a reconnecting socket or returned by one JSON page. */
export const REPLAY_MAX = 500;
/** Delivery records kept per hook (owner limit). */
export const DELIVERIES_KEPT = 1_000;
/** Attempts kept per delivery. */
export const ATTEMPTS_KEPT = 10;
/** Deliveries one replay re-sends. */
export const REPLAY_DELIVERIES = 1_000;
/** Rows read to filter one topic-filtered replay or page. */
export const SCAN_MAX = 5_000;
/** Ref commands sent in one receive-pack. */
export const REF_BATCH_MAX = 200;

/** Who did it, for an event: the user, the credential (machine) and the agent. */
function who(by: Identity | null): { actor: string | null; machine: string | null; agent: string | null } {
  return { actor: by?.login ?? null, machine: by?.credential_name ?? null, agent: by?.agent ?? null };
}

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
  /** At most two writes at once per Artifacts repo (gate.ts). In memory: leases end when the object restarts. */
  private gate = new WriteGate(WRITE_SLOTS, LEASE_MS, WAIT_MS, releaseDelay(this.env));
  /** Ref-only writes waiting for a slot, per Artifacts repo; sent together as one receive-pack. */
  private refQueues = new Map<string, { cmd: RefCommand; done: (reason: string | null) => void; fail: (err: unknown) => void }[]>();
  private refRunners = new Set<string>();
  /** The home's activity feed (feed/out.ts, C25): activity marking, fan-out, presence, summary ticks. */
  private feed: FeedOut;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.feed = new FeedOut(ctx, env, this.sql, () => this.info());
    this.ensureSchema();
    // A monorepo made before namespaces has no label yet: read it once from accounts.
    const m = this.info();
    if (m && m.label === m.id && env.ACCOUNTS_DB) {
      void ctx.blockConcurrencyWhile(async () => {
        const r = await env.ACCOUNTS_DB.prepare("SELECT owner || '/' || name AS label FROM monorepos WHERE id = ?1").bind(m.id).first<{ label: string }>().catch(() => null);
        if (r?.label) this.setLabel(r.label);
      });
    }
  }

  private ensureSchema(): void {
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
    // Added for the web: who merged from where (credential name) and as which agent.
    const cols = this.rows<{ name: string }>("PRAGMA table_info(merges)").map((c) => c.name);
    if (!cols.includes("machine")) this.sql.exec("ALTER TABLE merges ADD COLUMN machine TEXT");
    if (!cols.includes("agent")) this.sql.exec("ALTER TABLE merges ADD COLUMN agent TEXT");
    const bcols = this.rows<{ name: string }>("PRAGMA table_info(branches)").map((c) => c.name);
    for (const [col, type] of [["ahead", "INTEGER"], ["behind", "INTEGER"], ["merge_base", "TEXT"], ["mergeable", "TEXT"], ["facts_main", "TEXT"], ["facts_head", "TEXT"], ["facts_at", "TEXT"]]) {
      if (!bcols.includes(col)) this.sql.exec(`ALTER TABLE branches ADD COLUMN ${col} ${type}`);
    }
    const rcols = this.rows<{ name: string }>("PRAGMA table_info(repos)").map((c) => c.name);
    if (!rcols.includes("default_head")) this.sql.exec("ALTER TABLE repos ADD COLUMN default_head TEXT");
    if (!rcols.includes("default_head_at")) this.sql.exec("ALTER TABLE repos ADD COLUMN default_head_at TEXT");
    if (!rcols.includes("required_checks")) this.sql.exec("ALTER TABLE repos ADD COLUMN required_checks TEXT");
    const dcols = this.rows<{ name: string }>("PRAGMA table_info(deliveries)").map((c) => c.name);
    if (!dcols.includes("seq")) this.sql.exec("ALTER TABLE deliveries ADD COLUMN seq INTEGER");
    if (!dcols.includes("sent_at")) this.sql.exec("ALTER TABLE deliveries ADD COLUMN sent_at TEXT");
    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS deliveries_once ON deliveries (hook_id, event, seq)");
    const ecols = this.rows<{ name: string }>("PRAGMA table_info(events)").map((c) => c.name);
    if (!ecols.includes("tags")) this.sql.exec("ALTER TABLE events ADD COLUMN tags TEXT");
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.feed.ensureSchema();
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

  /** The meta row `name` holds the storage key: the id (a monorepo made before namespaces: its old name). */
  info(): ObjectInfo | null {
    const m = Object.fromEntries(this.rows<{ k: string; v: string }>("SELECT k, v FROM meta").map((r) => [r.k, r.v]));
    if (!m.name) return null;
    return { id: m.name, label: m.label ?? m.name, kind: m.kind as Kind, created_at: m.created_at };
  }

  /** Make the monorepo, keyed by its id and labelled owner/name. False if it exists already. */
  init(id: string, label: string, kind: Kind): boolean {
    // After a delete (deleteAll), make sure the tables are back before the first read.
    this.ensureSchema();
    if (this.info()) return false;
    const at = now();
    for (const [k, v] of [["name", id], ["label", label], ["kind", kind], ["created_at", at]]) this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?)", k, v);
    return true;
  }

  /** The monorepo's owner/name after a rename or a transfer (hook payloads and logs use it). */
  setLabel(label: string): void {
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('label', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", label);
  }

  /** Undo a monorepo whose creation failed half way, or delete one. */
  async destroy(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4404, "this monorepo was deleted");
      } catch {
        // already closed
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // This instance may serve the next request (a new monorepo of the same name).
    this.locks.clear();
    this.gate.clear();
    this.ensureSchema();
  }

  /** Every Artifacts repo this monorepo owns, the meta layer's included. */
  artifactsRepos(): string[] {
    const m = this.info();
    const names = new Set(this.rows<{ artifacts_name: string }>("SELECT artifacts_name FROM repos").map((r) => r.artifacts_name));
    if (m?.kind === "monorepo") names.add(metaArtifactsName(m.id));
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
    const artifacts_name = metaArtifactsName(m.id);
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

  /**
   * An Artifacts token for one of this monorepo's repos (C3): minted here,
   * once per repo and scope for the whole service, reused for about 10
   * minutes. Handed to the Worker's isolates, which never log it. `fresh`
   * mints anew (Artifacts refused the cached one).
   */
  async artifactsToken(name: string, scope: "read" | "write", generation: string, fresh: boolean): Promise<{ token: string; expiresAt: number; mint_ms: number } | null> {
    const m = this.info()?.id;
    // Gone (deleted, while another isolate still had it cached for up to 15 s): the Worker answers 404.
    if (!m) return null;
    if (!name.startsWith(`${m}--`)) throw new HttpError(403, "forbidden", "not this monorepo's repo");
    const t0 = Date.now();
    const e = await repoTokenEntry(this.env, name, scope, generation, "local", fresh);
    // mint_ms: how long this took when it minted (0 when it was cached), for the caller's timing line.
    const ms = Date.now() - t0;
    return { ...e, mint_ms: ms > 2 ? ms : 0 };
  }

  // ── Required checks, kept here (C3) ──────────────────────────────────────

  /** The repo's required checks as last read, or null when unknown (read them, then setRequiredChecks). */
  storedRequired(repo: string): string[] | null {
    const v = this.row<{ v: string | null }>("SELECT required_checks AS v FROM repos WHERE name = ?", repo)?.v;
    return v ? (JSON.parse(v) as string[]) : null;
  }

  setRequiredChecks(repo: string, list: string[]): void {
    this.sql.exec("UPDATE repos SET required_checks = ? WHERE name = ?", JSON.stringify(list), repo);
  }

  /**
   * .pando/pando.toml lives on main of the meta layer's repo (a monorepo) or
   * of the repo itself (a plain repo), and main moves only by a merge or main's
   * first push. When that happens there, forget the stored lists.
   */
  private forgetRequiredIfConfig(repo: string): void {
    const m = this.info();
    const r = this.repoRow(repo);
    if (!m || !r) return;
    if (m.kind === "repo") this.sql.exec("UPDATE repos SET required_checks = NULL WHERE name = ?", repo);
    else if (r.artifacts_name === metaArtifactsName(m.id)) this.sql.exec("UPDATE repos SET required_checks = NULL");
  }

  /** Main's head as Pando last moved or saw it (pushes through the door, merges, and the Worker's reads). */
  rememberHead(repo: string, sha: string | null): void {
    this.sql.exec(
      "UPDATE repos SET default_head = ?, default_head_at = ? WHERE name = ? AND (default_head IS NOT ? )",
      sha, now(), repo, sha,
    );
  }

  /** Every code repo's main, from the object's records (no Artifacts call). */
  heads(): { repo: string; path: string; default_branch: string; head: string | null; updated_at: string | null }[] {
    return this.rows<{ repo: string; path: string; default_branch: string; head: string | null; updated_at: string | null }>(
      `SELECT name AS repo, path, default_branch, default_head AS head, default_head_at AS updated_at FROM repos
       WHERE NOT (name = 'meta' AND artifacts_name LIKE '%--meta') ORDER BY path`,
    );
  }

  /** The code repos (the meta layer's repo is not listed). */
  listRepos(): RepoRecord[] {
    return this.rows<RepoRecord>("SELECT * FROM repos WHERE NOT (name = 'meta' AND artifacts_name LIKE '%--meta') ORDER BY path");
  }

  // ── Branches and pushes ──────────────────────────────────────────────────

  branchRecords(repo: string): BranchRecord[] {
    return this.rows<BranchRecord>(
      `SELECT b.*, m.forced AS merge_forced, m.machine AS merge_machine, m.agent AS merge_agent
       FROM branches b LEFT JOIN merges m ON m.repo = b.repo AND m.branch = b.name AND m.merge_commit = b.merge_commit
       WHERE b.repo = ? AND b.deleted_at IS NULL ORDER BY b.name`,
      repo,
    );
  }

  branchRecord(repo: string, name: string): BranchRecord | null {
    return this.row<BranchRecord>("SELECT * FROM branches WHERE repo = ? AND name = ? AND deleted_at IS NULL", repo, name);
  }

  /** Where main was before the merge that landed this branch head, if Pando merged it. */
  mergedFrom(repo: string, branch: string, head: string): string | null {
    return this.row<{ base_before: string }>(
      "SELECT base_before FROM merges WHERE repo = ? AND branch = ? AND head = ? ORDER BY id DESC LIMIT 1",
      repo, branch, head,
    )?.base_before ?? null;
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
  recordPush(
    repo: string,
    identity: Identity,
    updates: RefCommand[],
    made: { title?: string | null; description?: string | null } = {},
    origin: string | null = null,
  ): RepoEvent[] {
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
        this.rememberHead(repo, u.new === ZERO ? null : u.new);
        this.forgetRequiredIfConfig(repo);
        const seq = this.publish({
          kind: "push", collection: "default_heads", key: repo, op: "upsert", repo, ...who(identity),
          row: { repo, default_branch: main, default_head: u.new === ZERO ? null : u.new }, before: u.old, head: u.new,
        });
        if (u.new !== ZERO) this.queueFacts({ type: "sweep", repo, main: u.new, ...(seq ? { push: { seq, before: u.old } } : {}) });
        events.push({ ...base, event: "push", author: identity.login, seq: seq || null });
        continue;
      }
      let b = this.branchRecord(repo, name);
      if (u.new === ZERO) {
        if (b) this.sql.exec("UPDATE branches SET deleted_at = ?, head = NULL, updated_at = ? WHERE repo = ? AND name = ?", at, at, repo, name);
        const seq = this.publish({ kind: "branch.deleted", collection: "branches", key: `${repo}/${name}`, op: "delete", repo, ...who(identity), row: { repo, name }, before: u.old, head: u.new });
        events.push({ ...base, event: "push", author: b?.creator ?? null, title: b?.title ?? null, description: b?.description ?? null, seq: seq || null });
        continue;
      }
      const opened = !b;
      if (!b) {
        this.sql.exec(
          `INSERT INTO branches (repo, name, head, creator, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo, name) DO UPDATE SET head = excluded.head, creator = excluded.creator,
             title = excluded.title, description = excluded.description, created_at = excluded.created_at, updated_at = excluded.updated_at,
             merge_commit = NULL, merged_head = NULL, merged_at = NULL, merged_by = NULL, deleted_at = NULL`,
          repo, name, u.new, identity.login, made.title ?? null, made.description ?? null, at, at,
        );
      } else {
        this.sql.exec("UPDATE branches SET head = ?, updated_at = ? WHERE repo = ? AND name = ?", u.new, at, repo, name);
      }
      this.sql.exec("UPDATE branches SET pushed_machine = ? WHERE repo = ? AND name = ?", identity.credential_name, repo, name);
      b = this.branchRecord(repo, name)!;
      const seq = this.publishBranch(opened ? "branch.opened" : "push", repo, name, identity, { before: u.old, head: u.new });
      const e = { ...base, author: b.creator, title: b.title, description: b.description, seq: seq || null };
      if (opened) events.push({ ...e, event: "branch.opened" });
      events.push({ ...e, event: "push" });
      this.queueFacts({ type: "branch", repo, branch: name, head: u.new, ...(seq ? { push: { seq, before: u.old } } : {}) });
    }
    // Hook deliveries, in the same step as the change (C9).
    this.queueDeliveries(events, origin);
    return events;
  }

  /** A branch made by the API (createBranch): the caller is its creator. */
  createBranchRecord(repo: string, name: string, head: string, identity: Identity, title: string | null, description: string | null, origin: string | null = null): RepoEvent[] {
    return this.recordPush(repo, identity, [{ old: ZERO, new: head, ref: `refs/heads/${name}` }], { title, description }, origin);
  }

  updateBranch(repo: string, name: string, patch: { title?: string; description?: string }, head: string, identity: Identity | null = null): Promise<Outcome<BranchRecord>> {
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
      this.publishBranch("branch.updated", repo, name, identity);
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
    const review = { id, branch, head, verdict, body, comments, author: identity.login, created_at: at };
    this.publish({ kind: "review", collection: "reviews", key: `${repo}/${id}`, op: "upsert", repo, ...who(identity), row: review });
    return review;
  }

  listReviews(repo: string, branch: string) {
    return this.rows<Record<string, string>>("SELECT * FROM reviews WHERE repo = ? AND branch = ? ORDER BY created_at", repo, branch).map((r) => ({
      id: r.id, branch: r.branch, head: r.head, verdict: r.verdict, body: r.body, comments: JSON.parse(r.comments),
      author: r.author, created_at: r.created_at,
    }));
  }

  // ── Statuses and the gate ────────────────────────────────────────────────

  addStatus(repo: string, sha: string, s: { state: StatusRecord["state"]; context: string; target_url: string | null; description: string | null }, identity: Identity): StatusRecord {
    const at = now();
    const creator = identity.login;
    this.sql.exec(
      "INSERT INTO statuses (repo, sha, context, state, target_url, description, creator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      repo, sha, s.context, s.state, s.target_url, s.description, creator, at,
    );
    const status = { sha, ...s, creator, created_at: at };
    // Branches at this commit have new checks; clients holding them refetch (the event names the sha).
    this.publish({ kind: "status", collection: "statuses", key: `${repo}/${sha}/${s.context}`, op: "upsert", repo, ...who(identity), row: status });
    return status;
  }

  statuses(repo: string, sha: string): StatusRecord[] {
    return this.rows<StatusRecord>(
      "SELECT sha, context, state, target_url, description, creator, created_at FROM statuses WHERE repo = ? AND sha = ? ORDER BY id",
      repo, sha,
    );
  }

  /**
   * The merge gate's required checks: the kept list, read from pando.toml
   * when there is none. The kept list is dropped whenever main moves in the
   * repo holding pando.toml by a merge or its first push, and .pando/** never
   * changes any other way (the live layer refuses saves there), so it is
   * never stale.
   */
  private async checksFor(r: RepoRecord, sha: string): Promise<Checks> {
    let required = this.storedRequired(r.name);
    if (!required) {
      required = await requiredChecks(this.env, this.info()!, r);
      this.setRequiredChecks(r.name, required);
    }
    return combine(sha, required, this.statuses(r.name, sha));
  }

  // ── Merge ────────────────────────────────────────────────────────────────

  merge(args: MergeArgs): Promise<Outcome<MergeResult>> {
    const m = this.info();
    return this.guard(() =>
      this.serial(`merge:${args.repo}`, () =>
        timed("object", { route: "merge", monorepo: m?.label ?? null, monorepo_id: m?.id ?? null, repo: args.repo, branch: args.branch }, () => this.mergeNow(args)),
      ),
    );
  }

  /**
   * The branch head and main to merge. When the caller names the head it
   * expects and that is the head the door recorded (every push is recorded
   * before git is told it landed), the recorded heads are used and Artifacts
   * is not read. Otherwise, or when asked to, the refs are read from
   * Artifacts and a head that is not the expected one is refused.
   */
  private async mergeHeads(r: RepoRecord, a: MergeArgs, readRefs: boolean): Promise<{ head: string; base: string; read: boolean }> {
    if (a.branch === r.default_branch) fail(400, "bad_request", `cannot merge ${r.default_branch} into itself`);
    const stored = this.branchRecord(a.repo, a.branch)?.head ?? null;
    const storedMain = this.currentMain(a.repo);
    // The meta layer's main also moves by the live layer's commits, which this object does not record.
    const isMeta = r.artifacts_name === metaArtifactsName(this.info()!.id);
    if (!readRefs && !isMeta && a.expected_head && stored === a.expected_head && storedMain) {
      return { head: stored, base: storedMain, read: false };
    }
    const refs = branchesOf(await listRefs(this.env, r, "local"));
    const head = refs.get(a.branch) ?? fail(404, "not_found", `no branch ${a.branch}`);
    const base = refs.get(r.default_branch) ?? fail(409, "no_main", `${r.default_branch} does not exist yet`);
    if (a.expected_head && a.expected_head !== head) fail(409, "head_moved", `the branch is at ${head}, not ${a.expected_head}`);
    return { head, base, read: true };
  }

  private async mergeNow(a: MergeArgs): Promise<MergeResult> {
    const r = (await this.getRepo(a.repo)) ?? fail(404, "not_found", `no repo ${a.repo}`);
    let { head, base, read } = await this.mergeHeads(r, a, false);
    note({ heads_from: read ? "artifacts" : "records" });
    const checks = await this.checksFor(r, head);
    if (checks.state !== "success" && !a.force) {
      fail(412, "checks_not_green", `checks are ${checks.state} on ${head.slice(0, 12)}; wait, or merge with force`, { checks });
    }
    if (!gitwrite) fail(501, "merge_engine_unavailable", "the server-side merge engine (worker/src/gitwrite) is not wired in yet");
    const b = this.branchRecord(a.repo, a.branch);
    const message = a.message ?? mergeMessage(a.branch, b);
    const email = a.identity.email ?? `${a.identity.login}@users.pando.invalid`;
    let out;
    const engine = gitwrite;
    const attemptMerge = (h: string, baseSha: string) =>
      // One of the repo's two write slots, held for the merge's push; Artifacts' "busy" is retried.
      this.gatedTimed(r.artifacts_name, () =>
        retryBusy(
          () =>
            engine.mergeCommit(
              {
                artifacts: timedArtifacts(this.env.ARTIFACTS),
                name: r.artifacts_name,
                // The object's cached write token for this one repo (C3), not one minted per push.
                write: { remote: r.remote, token: (fresh) => repoToken(this.env, r.artifacts_name, "write", r.created_at, "local", fresh) },
              },
              {
                base: r.default_branch, head: h, baseSha, message,
                author: { name: a.identity.name ?? a.identity.login, email },
                committer: { name: "Pando", email: "pando@pando.invalid" },
              },
            ),
          (e) => isBusy(e instanceof Error ? e.message : String(e)),
        ),
      );
    try {
      out = await attemptMerge(head, base);
      if (out.status === "ref_moved" && !read) {
        // The recorded main was behind Artifacts: read the refs (which also re-checks the head) and try once more.
        ({ head, base, read } = await this.mergeHeads(r, a, true));
        note({ heads_from: "artifacts after ref_moved" });
        out = await attemptMerge(head, base);
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof GateBusy) fail(503, "repo_busy", err.message);
      const code = gitWriteCode(err);
      const msg = redact(err instanceof Error ? err.message : String(err));
      if (isBusy(msg)) fail(503, "repo_busy", "Artifacts is busy with other writes to this repo; try again");
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
      "INSERT INTO merges (repo, branch, head, base_before, merge_commit, merge_base, merged_by, forced, created_at, machine, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      a.repo, a.branch, head, out.old, out.sha, out.mergeBase, a.identity.login, forced ? 1 : 0, at, a.identity.credential_name, a.identity.agent ?? null,
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
    this.rememberHead(a.repo, out.sha);
    this.forgetRequiredIfConfig(a.repo);
    this.queueFacts({ type: "sweep", repo: a.repo, main: out.sha });
    const merge = { status: "merged", branch: a.branch, head, sha: out.sha, base_before: out.old, merge_base: out.mergeBase, forced, merged_by: a.identity.login };
    const mergedSeq = this.publishBranch("merged", a.repo, a.branch, a.identity, { merge });
    // main moved: every open branch's ahead, behind and mergeable change; clients refetch the branch list.
    this.publish({
      kind: "default_head.updated", collection: "default_heads", key: a.repo, op: "upsert", repo: a.repo, ...who(a.identity),
      row: { repo: a.repo, default_branch: r.default_branch, default_head: out.sha }, before: out.old, head: out.sha, merge,
    });
    this.queueDeliveries(
      [{
        event: "merged", repo: a.repo, branch: a.branch, ref: `refs/heads/${a.branch}`, before: out.old, head,
        base: out.mergeBase, author: b?.creator ?? null, pusher: a.identity.login, title: b?.title ?? null,
        description: b?.description ?? null, merge_commit: out.sha, seq: mergedSeq || null,
        machine: a.identity.credential_name, agent: a.identity.agent ?? null,
      }],
      a.origin,
    );
    if (r.artifacts_name === metaArtifactsName(this.info()!.id)) {
      // The merge has landed; machines get it on the live layer's next try if this fails.
      await this.applyToMetaLayer(out.old, out.sha, a.identity).catch((err) =>
        console.error("applyFromMain failed:", redact(err instanceof Error ? err.message : String(err))),
      );
    }

    const result: MergeResult = { status: "merged", branch: a.branch, head, sha: out.sha, base_before: out.old, merge_base: out.mergeBase, forced, merged_by: a.identity.login };
    return result;
  }

  /** A merge landed on the meta layer's main: hand the changed files to the live meta layer. */
  private async applyToMetaLayer(before: string, commit: string, who: Identity): Promise<void> {
    const m = this.info()!.id;
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

  // ── Deliveries: rows here, the work on the pando-hooks queue (C9) ─────────
  //
  // A delivery row is written in the same step as the change that caused it,
  // keyed by (hook, event, seq) so a retry or a replay never makes a second
  // row, and its id goes to the queue. The consumer (hooks.ts) POSTs and
  // reports each attempt here. The alarm only re-sends ids whose queue send
  // failed.

  private deliveryView(id: string): Record<string, unknown> | null {
    const d = this.row<Record<string, unknown>>(
      `SELECT id, hook_id, event, seq, status, attempts, response_code, error, created_at, last_attempt_at, next_attempt_at
       FROM deliveries WHERE id = ?`,
      id,
    );
    if (!d) return null;
    const attempts = this.rows<Record<string, unknown>>(
      "SELECT n, at, response_code, error, ms FROM delivery_attempts WHERE delivery_id = ? ORDER BY n DESC LIMIT ?",
      id, ATTEMPTS_KEPT,
    );
    return { ...d, recent_attempts: attempts };
  }

  listDeliveries(repo: string, hookId: string) {
    const ids = this.rows<{ id: string }>(
      "SELECT id FROM deliveries WHERE repo = ? AND hook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100",
      repo, hookId,
    );
    return ids.map((r) => this.deliveryView(r.id)!);
  }

  /** Write a delivery row per (hook, event) the events reach, and send their ids to the queue. */
  private queueDeliveries(events: RepoEvent[], origin: string | null): number {
    const m = this.info();
    if (!m || events.length === 0) return 0;
    const ids: string[] = [];
    for (const e of events) {
      const hooks = this.rows<HookRow>("SELECT * FROM hooks WHERE repo = ?", e.repo).filter((h) => wants(h, e));
      for (const h of hooks) {
        const payload: StoredPayload = { ...e, occurred_at: now(), monorepo: m.label, monorepo_id: m.id, plain: m.kind === "repo", origin: origin ?? "" };
        const id = this.insertDelivery(h.id, e.repo, e.event, e.seq ?? null, JSON.stringify(payload));
        if (id) ids.push(id);
      }
    }
    if (ids.length) this.ctx.waitUntil(this.sendDeliveries(ids));
    return ids.length;
  }

  /** A new row, or null when (hook, event, seq) already has one. */
  private insertDelivery(hookId: string, repo: string, event: string, seq: number | null, payload: string): string | null {
    const id = randomId("dlv_");
    const at = now();
    const written = this.sql.exec(
      `INSERT OR IGNORE INTO deliveries (id, hook_id, repo, event, seq, payload, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
      id, hookId, repo, event, seq, payload, at,
    ).rowsWritten;
    if (!written) return null;
    // Keep the latest DELIVERIES_KEPT per hook (and their attempts).
    const old = this.rows<{ id: string }>(
      "SELECT id FROM deliveries WHERE hook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?",
      hookId, DELIVERIES_KEPT,
    );
    for (const o of old) {
      this.sql.exec("DELETE FROM delivery_attempts WHERE delivery_id = ?", o.id);
      this.sql.exec("DELETE FROM deliveries WHERE id = ?", o.id);
    }
    return id;
  }

  private async sendDeliveries(ids: string[]): Promise<void> {
    const m = this.info()?.id;
    if (!m || !this.env.HOOKS) return;
    try {
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        await this.env.HOOKS.sendBatch(chunk.map((id) => ({ body: { monorepo: m, delivery_id: id } })));
        for (const id of chunk) this.sql.exec("UPDATE deliveries SET sent_at = ? WHERE id = ?", now(), id);
      }
    } catch (err) {
      console.error("sending deliveries to the queue failed; the alarm retries:", err instanceof Error ? err.message : String(err));
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  /** For the queue consumer: the hook and payload of a delivery (null when gone). */
  deliveryToSend(id: string): { hook: HookRow; payload: StoredPayload; artifacts_name: string; status: string; repo: RepoRecord } | null {
    const d = this.row<{ hook_id: string; repo: string; payload: string; status: string }>(
      "SELECT hook_id, repo, payload, status FROM deliveries WHERE id = ?", id,
    );
    if (!d) return null;
    const hook = this.row<HookRow>("SELECT * FROM hooks WHERE id = ?", d.hook_id);
    const repo = this.repoRow(d.repo);
    if (!hook || !repo) return null;
    return { hook, payload: JSON.parse(d.payload) as StoredPayload, artifacts_name: repo.artifacts_name, status: d.status, repo };
  }

  /**
   * One attempt's result. `retryInS` is when the queue tries again (null: no
   * more retries; the message goes to the dead-letter queue).
   */
  recordAttempt(id: string, r: { ok: boolean; code: number | null; error: string | null; ms: number }, n: number, retryInS: number | null): void {
    const at = now();
    if (!this.row("SELECT id FROM deliveries WHERE id = ?", id)) return;
    this.sql.exec(
      "INSERT INTO delivery_attempts (delivery_id, n, at, response_code, error, ms) VALUES (?, ?, ?, ?, ?, ?)",
      id, n, at, r.code, r.error, r.ms,
    );
    this.sql.exec(
      `DELETE FROM delivery_attempts WHERE delivery_id = ? AND rowid NOT IN
       (SELECT rowid FROM delivery_attempts WHERE delivery_id = ? ORDER BY rowid DESC LIMIT ?)`,
      id, id, ATTEMPTS_KEPT,
    );
    const status = r.ok ? "delivered" : retryInS === null ? "failed" : "retrying";
    this.sql.exec(
      `UPDATE deliveries SET status = ?, attempts = attempts + 1, response_code = ?, error = ?, last_attempt_at = ?, next_attempt_at = ? WHERE id = ?`,
      status, r.code, r.ok ? null : r.error, at, r.ok || retryInS === null ? null : new Date(Date.now() + retryInS * 1000).toISOString(), id,
    );
  }

  /** The dead-letter queue's consumer: the delivery gave up. */
  markDead(id: string): void {
    this.sql.exec("UPDATE deliveries SET status = 'dead', next_attempt_at = NULL WHERE id = ? AND status != 'delivered'", id);
  }

  /** Send one delivery again (same row, same seq; new attempts are added). */
  redeliver(repo: string, deliveryId: string): Promise<Outcome<Record<string, unknown>>> {
    return this.guard(async () => {
      if (!this.row("SELECT id FROM deliveries WHERE repo = ? AND id = ?", repo, deliveryId)) fail(404, "not_found", `no delivery ${deliveryId}`);
      this.sql.exec("UPDATE deliveries SET status = 'queued', next_attempt_at = NULL, sent_at = NULL WHERE id = ?", deliveryId);
      await this.sendDeliveries([deliveryId]);
      return this.deliveryView(deliveryId)!;
    });
  }

  /** Replay a hook from a seq (after an outage): every delivery of it with a higher seq, at most REPLAY_DELIVERIES. */
  replayHook(repo: string, hookId: string, since: number): Promise<Outcome<{ queued: number; ids: string[] }>> {
    return this.guard(async () => {
      if (!this.row("SELECT id FROM hooks WHERE repo = ? AND id = ?", repo, hookId)) fail(404, "not_found", `no hook ${hookId}`);
      const ids = this.rows<{ id: string }>(
        "SELECT id FROM deliveries WHERE repo = ? AND hook_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        repo, hookId, since, REPLAY_DELIVERIES,
      ).map((r) => r.id);
      for (const id of ids) this.sql.exec("UPDATE deliveries SET status = 'queued', next_attempt_at = NULL, sent_at = NULL WHERE id = ?", id);
      await this.sendDeliveries(ids);
      return { queued: ids.length, ids };
    });
  }

  /** Re-send ids whose queue send failed. */
  async alarm(): Promise<void> {
    const unsent = this.rows<{ id: string }>(
      "SELECT id FROM deliveries WHERE status = 'queued' AND sent_at IS NULL ORDER BY created_at LIMIT 500",
    ).map((r) => r.id);
    if (unsent.length) await this.sendDeliveries(unsent);
    await this.feed.alarm();
  }

  // ── Object sizes (git protocol v2 object-info) ───────────────────────────

  /** Known sizes of objects in a repo. Objects never change, so entries never expire. */
  objectSizes(repo: string, oids: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    // Durable Object SQLite binds at most 100 variables: the repo plus 90 ids.
    for (let i = 0; i < oids.length; i += 90) {
      const chunk = oids.slice(i, i + 90);
      const rows = this.rows<{ oid: string; size: number }>(
        `SELECT oid, size FROM object_sizes WHERE repo = ? AND oid IN (${chunk.map(() => "?").join(",")})`,
        repo, ...chunk,
      );
      for (const r of rows) out[r.oid] = r.size;
    }
    return out;
  }

  recordObjectSizes(repo: string, entries: [string, number][]): void {
    for (const [oid, size] of entries) {
      this.sql.exec("INSERT OR IGNORE INTO object_sizes (repo, oid, size) VALUES (?, ?, ?)", repo, oid, size);
    }
  }

  // ── The event stream ─────────────────────────────────────────────────────
  //
  // Every change a screen shows is an event: a sequence number, a kind, and
  // the changed row in the shape its REST route returns, with the client-side
  // collection, key and op (upsert or delete) it applies to. Every event is
  // kept (owner, 2026-10-03); the one limit is the object's storage (10 GB per
  // Durable Object on Workers Paid; an event is about 0.3 to 2 KB). Sockets
  // (hibernating) get each new event; a socket opened with ?since=<seq> first
  // gets what it missed, at most REPLAY_MAX, else a "resync" frame. Each event
  // is self-contained JSON, so the same rows could later also go to an event
  // log for hooks and replay.

  /** Record an event and send it to every open event socket. Returns its seq. */
  publish(e: StreamEvent): number {
    if (!EVENT_STREAM) return 0;
    const at = now();
    const { seq: _s, at: _a, ...rest } = e;
    const body = JSON.stringify(rest);
    const tags = eventTags(e);
    const seq = this.sql.exec<{ seq: number }>(
      "INSERT INTO events (at, kind, body, tags) VALUES (?, ?, ?, ?) RETURNING seq", at, e.kind, body, ` ${tags.join(" ")} `,
    ).one().seq as number;
    this.feed.onPublish(seq, at, e);
    const frame = JSON.stringify({ type: "event", seq, at, ...rest });
    // Each socket subscribed to topics (acceptWebSocket tags); send once to every socket on any of this event's.
    const sent = new Set<WebSocket>();
    for (const tag of tags) {
      for (const ws of this.ctx.getWebSockets(tag)) {
        if (sent.has(ws)) continue;
        sent.add(ws);
        try {
          ws.send(frame);
        } catch {
          // closed; its close event cleans up
        }
      }
    }
    return seq;
  }

  /** Events from the meta layer object, in order (meta.saved, machine.connected, machine.disconnected). */
  publishMany(events: StreamEvent[]): number {
    let seq = 0;
    for (const e of events) seq = this.publish(e);
    return seq;
  }

  /** Events after `since` (or the latest), on any of `topics`; reads at most SCAN_MAX rows. */
  private eventRows(since: number, limit: number, latest: boolean, topics: string[] = ["all"]): Record<string, unknown>[] {
    const all = topics.includes("all");
    const match = (tags: string | null) => all || topics.some((t) => (tags ?? " all ").includes(` ${t} `));
    const rows = latest
      ? this.rows<{ seq: number; at: string; body: string; tags: string | null }>("SELECT seq, at, body, tags FROM events ORDER BY seq DESC LIMIT ?", all ? limit : SCAN_MAX)
          .filter((r) => match(r.tags)).slice(0, limit).reverse()
      : this.rows<{ seq: number; at: string; body: string; tags: string | null }>("SELECT seq, at, body, tags FROM events WHERE seq > ? ORDER BY seq LIMIT ?", since, all ? limit : SCAN_MAX)
          .filter((r) => match(r.tags)).slice(0, limit);
    return rows.map((r) => ({ seq: r.seq, at: r.at, ...JSON.parse(r.body) }));
  }

  /** The newest event's seq (0 when there is none). */
  eventHead(): number {
    return this.eventBounds().head;
  }

  private eventBounds(): { head: number; oldest: number } {
    const b = this.row<{ head: number | null; oldest: number | null }>("SELECT MAX(seq) AS head, MIN(seq) AS oldest FROM events");
    return { head: b?.head ?? 0, oldest: b?.oldest ?? 0 };
  }

  /** Events after `since` (oldest first), or the latest `limit` with no `since`. */
  /** `seq` is the newest event's seq, `oldest_seq` the oldest kept. (An event's own `head` is a commit sha.) */
  events(since: number | null, limit: number, topics: string[] = ["all"]): { events: Record<string, unknown>[]; seq: number; oldest_seq: number; resync: boolean } {
    const { head, oldest } = this.eventBounds();
    const n = Math.min(Math.max(limit, 1), REPLAY_MAX);
    const bounds = { seq: head, oldest_seq: oldest };
    if (since === null) return { events: this.eventRows(0, n, true, topics), ...bounds, resync: false };
    const resync = since > head || (head > 0 && since < oldest - 1);
    return { events: resync ? [] : this.eventRows(since, n, false, topics), ...bounds, resync };
  }

  /** The event socket (GET /v1/monorepos/{m}/events with Upgrade), after the Worker checked membership. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/events") || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
    }
    const topics = parseTopics(url.searchParams.get("topics"));
    if (!topics) {
      return Response.json(
        { error: { code: "bad_request", message: "topics: up to 10 of all, main, main:<repo>, repo:<repo>, meta, kind:<kind>, comma-separated" } },
        { status: 400 },
      );
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, topics);
    server.serializeAttachment({
      login: request.headers.get("x-pando-login") ?? "", connected_at: now(), topics,
      // For presence (C25): the socket's id, and the credential's name as the default machine.
      sid: randomId("ws_"), machine: request.headers.get("x-pando-machine") ?? "",
    });
    // Replay, then live. Nothing here awaits, so no event can fall between the two.
    const sinceParam = url.searchParams.get("since");
    const since = sinceParam === null || sinceParam === "" ? null : Number(sinceParam);
    const { head, oldest } = this.eventBounds();
    if (since !== null) {
      const missed = Number.isSafeInteger(since) && since >= 0 ? head - since : Infinity;
      const all = topics.includes("all");
      if (!Number.isSafeInteger(since) || since < 0 || since > head || (head > 0 && since < oldest - 1) || missed > (all ? REPLAY_MAX : SCAN_MAX)) {
        server.send(JSON.stringify({ type: "resync", seq: head, oldest_seq: oldest }));
      } else {
        const replay = this.eventRows(since, REPLAY_MAX + 1, false, topics);
        if (replay.length > REPLAY_MAX) server.send(JSON.stringify({ type: "resync", seq: head, oldest_seq: oldest }));
        else for (const e of replay) server.send(JSON.stringify({ type: "event", ...e }));
      }
    }
    server.send(JSON.stringify({ type: "caught_up", seq: head }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    // The stream is one way, but for a follower's hello (presence, C25). Text "ping" is answered "pong" without waking the object.
    let reply: Record<string, unknown> = { type: "error", message: "this socket only sends; send the text ping to keep it open" };
    try {
      const m = typeof msg === "string" && msg.startsWith("{") ? (JSON.parse(msg) as Record<string, unknown>) : null;
      if (m?.type === "hello") reply = this.feed.hello(ws, m);
    } catch {
      // not JSON
    }
    try {
      ws.send(JSON.stringify(reply));
    } catch {
      // closed
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.feed.gone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(_ws: WebSocket): Promise<void> {}

  /**
   * A branch's stored fields as an event row (no Artifacts reads in the
   * object). `ahead`, `behind`, `base`, `mergeable` and `checks` are computed
   * per request by GET getBranch; the event says `partial: true`, and a client
   * that shows them refetches that branch.
   */
  private branchEventRow(repo: string, name: string): Record<string, unknown> | null {
    const b = this.branchRecords(repo).find((x) => x.name === name);
    if (!b || !b.head) return null;
    const merged = b.merged_head === b.head;
    return {
      repo, name, head: b.head, author: b.creator, title: b.title, description: b.description,
      state: merged ? "merged" : "open",
      merge_commit: merged ? b.merge_commit : null, merged_by: merged ? b.merged_by : null, merged_at: merged ? b.merged_at : null,
      merged_machine: merged ? (b.merge_machine ?? null) : null, merged_agent: merged ? (b.merge_agent ?? null) : null,
      forced: merged ? b.merge_forced === 1 : null,
      pushed_machine: b.pushed_machine ?? null,
      created_at: b.created_at, updated_at: b.updated_at,
    };
  }

  private publishBranch(kind: string, repo: string, name: string, by: Identity | null, extra: Record<string, unknown> = {}): number {
    const row = this.branchEventRow(repo, name);
    return this.publish({
      kind, collection: "branches", key: `${repo}/${name}`, op: row ? "upsert" : "delete", repo, ...who(by),
      row: row ?? { repo, name }, partial: true, ...extra,
    });
  }

  // ── Branch facts (facts.ts): stored, computed on change by the queue ─────

  private queueFacts(
    m: ({ type: "sweep"; repo: string; main: string } | { type: "branch"; repo: string; branch: string; head: string }) & { push?: { seq: number; before: string } },
  ): void {
    const monorepo = this.info()?.id;
    if (!monorepo || !this.env.BRANCH_FACTS) return;
    this.ctx.waitUntil(
      this.env.BRANCH_FACTS.send({ ...m, monorepo }).catch((err) =>
        console.error("queueing branch facts failed:", err instanceof Error ? err.message : String(err)),
      ),
    );
  }

  /** Main's head as recorded (null when unknown or the repo is empty). */
  /** A branch's head from the stored rows (main from the repo's record), or null when unknown here (FILES.md). */
  refHead(repo: string, ref: string): string | null {
    const r = this.row<{ default_branch: string; default_head: string | null }>("SELECT default_branch, default_head FROM repos WHERE name = ?", repo);
    if (!r) return null;
    if (ref === r.default_branch) return r.default_head;
    return this.row<{ head: string | null }>("SELECT head FROM branches WHERE repo = ? AND name = ? AND deleted_at IS NULL", repo, ref)?.head ?? null;
  }

  /** For merge commits: the branch each merged and its title (the file pages' history). */
  mergedBranches(repo: string, shas: string[]): Record<string, { branch: string; title: string | null }> {
    const out: Record<string, { branch: string; title: string | null }> = {};
    for (let i = 0; i < shas.length; i += 100) {
      const chunk = shas.slice(i, i + 100);
      for (const r of this.rows<{ merge_commit: string; branch: string; title: string | null }>(
        `SELECT m.merge_commit, m.branch, b.title FROM merges m LEFT JOIN branches b ON b.repo = m.repo AND b.name = m.branch
         WHERE m.repo = ? AND m.merge_commit IN (${chunk.map(() => "?").join(",")})`,
        repo, ...chunk,
      )) out[r.merge_commit] = { branch: r.branch, title: r.title };
    }
    return out;
  }

  currentMain(repo: string): string | null {
    return this.row<{ default_head: string | null }>("SELECT default_head FROM repos WHERE name = ?", repo)?.default_head ?? null;
  }

  /** A sweep's branches: open, pushed within `days`, newest first, at most `max`, without facts for (main, head) yet. */
  factsCandidates(repo: string, main: string, days: number, max: number): { main: string | null; branches: { name: string; head: string }[] } {
    const current = this.currentMain(repo);
    if (current !== main) return { main: current, branches: [] };
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const branches = this.rows<{ name: string; head: string }>(
      `SELECT name, head FROM branches
       WHERE repo = ? AND deleted_at IS NULL AND head IS NOT NULL AND (merged_head IS NULL OR merged_head != head)
         AND updated_at >= ? AND NOT (facts_main IS ? AND facts_head IS head)
       ORDER BY updated_at DESC LIMIT ?`,
      repo, since, main, max,
    );
    return { main: current, branches };
  }

  /**
   * Store a branch's facts, if they are for its current head and main's
   * current head (else a newer job is coming), keep the required checks they
   * were computed with, and publish the full row. False when stale.
   */
  writeFacts(repo: string, name: string, f: { main: string; head: string; ahead: number | null; behind: number | null; merge_base: string | null; mergeable: string }, required: string[]): boolean {
    if (this.currentMain(repo) !== f.main) return false;
    const b = this.branchRecord(repo, name);
    if (!b || b.head !== f.head) return false;
    this.sql.exec(
      "UPDATE branches SET ahead = ?, behind = ?, merge_base = ?, mergeable = ?, facts_main = ?, facts_head = ?, facts_at = ? WHERE repo = ? AND name = ?",
      f.ahead, f.behind, f.merge_base, f.mergeable, f.main, f.head, now(), repo, name,
    );
    // `required` is for this row only: the kept list changes only through storedRequired's owners.
    const row = this.branchRows(repo, { names: [name], state: "all", required }).branches[0];
    if (row) this.publish({ kind: "branch.updated", collection: "branches", key: `${repo}/${name}`, op: "upsert", repo, actor: null, machine: null, agent: null, row: { repo, ...row }, partial: false });
    return true;
  }

  /**
   * Branch rows as GET listBranches returns them, from stored facts (no
   * Artifacts call). Rows whose facts are not for the current (main, head)
   * are `stale`, with mergeable "pending" and `last_mergeable`; those stale
   * longer than `graceMs` are named in `due` for the caller to compute.
   */
  branchRows(
    repo: string,
    o: { names?: string[]; state: "open" | "merged" | "all"; limit?: number; cursor?: string | null; required?: string[] | null; graceMs?: number },
  ): BranchList {
    const r = this.repoRow(repo);
    if (!r) return { default_branch: DEFAULT_BRANCH, default_head: null, branches: [], next_cursor: null, due: [] };
    const main = this.currentMain(repo);
    const mainAt = Date.parse(this.row<{ t: string | null }>("SELECT default_head_at AS t FROM repos WHERE name = ?", repo)?.t ?? "") || 0;
    const required = o.required ?? (JSON.parse(this.row<{ v: string | null }>("SELECT required_checks AS v FROM repos WHERE name = ?", repo)?.v ?? "null") as string[] | null) ?? [];
    const limit = Math.min(Math.max(o.limit ?? 100, 1), 500);
    const all = this.branchRecords(repo).filter((b) => b.head && b.name !== r.default_branch && (!o.names || o.names.includes(b.name)));
    const t = Date.now();
    const rows: BranchView[] = [];
    const due: string[] = [];
    let next: string | null = null;
    for (const b of all) {
      if (o.cursor && b.name <= o.cursor) continue;
      const merged = b.merged_head === b.head;
      const state = merged ? "merged" : "open";
      if (o.state !== "all" && state !== o.state) continue;
      if (rows.length >= limit) {
        next = rows[rows.length - 1].name;
        break;
      }
      const fresh = merged || (b.facts_main === main && b.facts_head === b.head && main !== null);
      if (!fresh && main && t - Math.max(mainAt, Date.parse(b.updated_at ?? "") || 0) > (o.graceMs ?? STALE_GRACE_MS)) due.push(b.name);
      rows.push({
        name: b.name,
        head: b.head!,
        base: merged ? b.head : (b.merge_base ?? null),
        author: b.creator,
        title: b.title,
        description: b.description,
        ahead: merged ? 0 : (b.ahead ?? null),
        behind: b.behind ?? null,
        mergeable: merged ? "up_to_date" : fresh ? (b.mergeable ?? "unknown") : "pending",
        checks: combine(b.head!, required, this.statuses(repo, b.head!)),
        state,
        merge_commit: merged ? b.merge_commit : null,
        merged_by: merged ? b.merged_by : null,
        merged_at: merged ? b.merged_at : null,
        merged_machine: merged ? (b.merge_machine ?? null) : null,
        merged_agent: merged ? (b.merge_agent ?? null) : null,
        forced: merged ? b.merge_forced === 1 : null,
        pushed_machine: b.pushed_machine ?? null,
        created_at: b.created_at,
        updated_at: b.updated_at,
        stale: !fresh,
        last_mergeable: !fresh ? (b.mergeable ?? null) : null,
        facts_at: b.facts_at ?? null,
      });
    }
    return { default_branch: r.default_branch, default_head: main, branches: rows, next_cursor: next, due };
  }

  // ── Writes: the gate, and ref updates sent together ────────────────────

  /** gate.with, with the wait recorded as gate time on the current timing line. */
  private async gatedTimed<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lease = await timeGate(() => this.gate.acquire(key));
    const renew = setInterval(() => this.gate.renew(key, lease), Math.max(1000, Math.floor(LEASE_MS / 3)));
    try {
      return await fn();
    } finally {
      clearInterval(renew);
      this.gate.release(key, lease);
    }
  }

  /** Take one of the repo's write slots (waits in line, at most WAIT_MS). Key: the Artifacts repo name. */
  async acquireWrite(key: string): Promise<Outcome<{ lease: string; waited_ms: number }>> {
    const t = Date.now();
    try {
      const lease = await this.gate.acquire(key);
      return { ok: true, value: { lease, waited_ms: Date.now() - t } };
    } catch (err) {
      return { ok: false, status: 503, code: "repo_busy", message: err instanceof Error ? err.message : String(err) };
    }
  }

  renewWrite(key: string, lease: string): boolean {
    return this.gate.renew(key, lease);
  }

  /** hold: false lets the next writer in at once (door pushes); else after the release delay. */
  releaseWrite(key: string, lease: string, hold = true): boolean {
    return hold ? this.gate.release(key, lease) : this.gate.release(key, lease, 0);
  }

  gateStats(key: string): { held: number; waiting: number } {
    return this.gate.stats(key);
  }

  /**
   * Move refs to commits that already exist (branch creates and deletes).
   * Waiting writes for one repo go out together, as one receive-pack per
   * write slot. Answers each ref: null when it moved, else why not.
   */
  updateRefsQueued(repo: string, commands: RefCommand[]): Promise<Outcome<Record<string, string | null>>> {
    return this.guard(async () => {
      const r = (await this.getRepo(repo)) ?? fail(404, "not_found", `no repo ${repo}`);
      const key = r.artifacts_name;
      const q = this.refQueues.get(key) ?? [];
      this.refQueues.set(key, q);
      const answers = commands.map(
        (cmd) => new Promise<string | null>((done, failed) => q.push({ cmd, done, fail: failed })),
      );
      if (!this.refRunners.has(key)) this.ctx.waitUntil(this.runRefQueue(r));
      const out: Record<string, string | null> = {};
      const settled = await Promise.allSettled(answers);
      settled.forEach((s, i) => {
        if (s.status === "fulfilled") out[commands[i].ref] = s.value;
        else {
          const e = s.reason;
          if (e instanceof GateBusy || isBusy(e instanceof Error ? e.message : String(e))) fail(503, "repo_busy", e instanceof Error ? e.message : String(e));
          if (e instanceof HttpError) throw e;
          fail(502, "artifacts", redact(e instanceof Error ? e.message : String(e)));
        }
      });
      return out;
    });
  }

  private async runRefQueue(r: RepoRecord): Promise<void> {
    const key = r.artifacts_name;
    this.refRunners.add(key);
    try {
      for (;;) {
        const q = this.refQueues.get(key);
        if (!q || q.length === 0) return;
        // One timing line per batch (timing.ts): the gate wait, then Artifacts.
        const t = startTiming("object", { route: "ref-batch", monorepo: this.info()?.label ?? null, monorepo_id: this.info()?.id ?? null, repo: r.name });
        let lease: string;
        try {
          lease = await runTimed(t, () => timeGate(() => this.gate.acquire(key)));
        } catch (err) {
          finishTiming(t, { status: "busy" });
          for (const e of q.splice(0)) e.fail(err);
          return;
        }
        // Everything queued by now goes in one receive-pack (one command per ref; a repeat waits a round).
        const batch: typeof q = [];
        const refs = new Set<string>();
        for (let i = 0; i < q.length && batch.length < REF_BATCH_MAX; ) {
          if (refs.has(q[i].cmd.ref)) {
            i++;
            continue;
          }
          refs.add(q[i].cmd.ref);
          batch.push(...q.splice(i, 1));
        }
        try {
          t.fields.refs = batch.length;
          const result = await runTimed(t, () =>
            retryBusy(
              () => updateRefs(this.env, r, batch.map((e) => e.cmd), "local"),
              (e) => e instanceof HttpError && e.code === "repo_busy",
            ),
          );
          finishTiming(t, { status: "ok" });
          for (const e of batch) e.done(result.has(e.cmd.ref) ? result.get(e.cmd.ref)! : "no status in Artifacts' report");
        } catch (err) {
          finishTiming(t, { status: "error" });
          for (const e of batch) e.fail(err);
        } finally {
          this.gate.release(key, lease);
        }
      }
    } finally {
      this.refRunners.delete(key);
    }
  }

  // ── The home's activity feed (feed/, C25) ────────────────────────────────

  /** The member list as the accounts have it (the feed consumer reads it on each join or leave). */
  setFeedMembers(logins: string[]): void {
    if (this.info()) this.feed.setMembers(logins);
  }

  feedMembers(): string[] {
    return this.feed.members();
  }

  /** A join: store the fresh member list, and for `login`, the latest `n` activity events and the summary. Null when the monorepo is gone. */
  feedJoin(members: string[], login: string | null, n: number): JoinData | null {
    const m = this.info();
    if (!m) return null;
    this.feed.setMembers(members);
    if (!login) return null;
    const large = this.feed.isLarge();
    const events = large ? [] : this.feed.before(null, n);
    return { kind: m.kind, full_name: m.label, large, events, complete: events.length < n, summary: this.feed.summary() };
  }

  /** The branch-facts job's commit count and head title for a push: the push goes out to feeds. */
  feedPush(seq: number, summary: Record<string, unknown>): boolean {
    return this.feed.push(seq, summary);
  }

  /** Activity events older than the cursor, newest first (fan-in for large monorepos and history past a feed's window). */
  eventsBefore(cursor: Key | null, limit: number): FeedEvent[] {
    return this.feed.before(cursor, Math.min(Math.max(limit, 1), 500));
  }

  /** Open branches that need someone (ready, conflicts, failing), from stored facts. */
  needsYou(needs: NeedState[], limit: number): NeedRow[] {
    return this.feed.needs(new Set(needs)).slice(0, Math.min(Math.max(limit, 1), 500));
  }

  feedSummary(): Summary {
    return this.feed.summary();
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
      const row = this.worktree(id)!;
      this.publish({ kind: "worktree.reported", collection: "worktrees", key: id, op: "upsert", repo: null, ...who(identity), row });
      return row;
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

  deleteWorktree(id: string, identity: Identity): Promise<Outcome<boolean>> {
    return this.guard(() => {
      const row = this.worktree(id) ?? fail(404, "not_found", `no worktree ${id}`);
      this.sql.exec("DELETE FROM worktrees WHERE id = ?", id);
      this.publish({ kind: "worktree.removed", collection: "worktrees", key: id, op: "delete", repo: null, ...who(identity), row });
      return true;
    });
  }
}

export function mergeMessage(branch: string, b: BranchRecord | null): string {
  const tail = `Merge branch '${branch}'`;
  if (!b?.title) return tail + "\n";
  return [b.title, b.description, tail].filter(Boolean).join("\n\n") + "\n";
}
