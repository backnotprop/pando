// The monorepo object: one Durable Object (SQLite) per monorepo. It keeps
// repos, branches, reviews, statuses, merges, hooks, deliveries and the
// worktree registry, and it runs merges one at a time. Users, credentials
// and membership are in the accounts object.
// Owned by the server-git lane.
//
// Its methods are RPC. A method that can fail returns an Outcome, because RPC
// passes only an error's message across.

import type * as Contract from "@pando/contract";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { HttpError, now, redact } from "../http";
import { branchesOf, listRefs, repoToken, repoTokenEntry, updateRefs, withRepo } from "./artifacts";
import { GateBusy, isBusy, LEASE_MS, releaseDelay, retryBusy, WAIT_MS, WRITE_SLOTS, WriteGate } from "./gate";
import { finishTiming, note, runTimed, startTiming, timed, timedArtifacts, timeGate } from "../timing";
import { combine, isChecksUnknown, requiredChecks, type Required } from "./checks";
import { hookView, wants, type HookRow, type StoredPayload } from "./hooks";
import { gitWriteCode, gitwrite } from "./merge-port";
import { DEFAULT_BRANCH, metaArtifactsName, ZERO } from "./names";
import { STALE_GRACE_MS, type Facts } from "./facts";
import { FactsOut, type FactsRequest } from "./facts-out";
import { HooksOut } from "./hooks-out";
import { isMergeable, type BranchList, type BranchView } from "./views";
import { EVENT_STREAM, eventTags, parseTopics } from "./stream";
import { changedFiles } from "./diff";
import type { RefCommand } from "./pktline";
import { FeedOut, type HelloAnswer } from "../feed/out";
import { isOneOf, isRecord, isText, isTextList, isWholeNumber, parseJson } from "../parse";
import { attachmentOf, Machines, type MachineRow } from "./machines";
import { verdictOf, type FeedEvent, type Key, type NeedRow, type NeedState, type PushNumbers, type Summary } from "../feed/shape";
import type { JoinData } from "../feed/object";
import { CiStore, type BuildsQuery, type CiRef, type IngestResult } from "../ci/store";
import type { Json } from "../parse";
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
  HookEvent,
  KeyedEvent,
  ReviewComment,
  ReviewVerdict,
  ReconcileSeen,
  EventFilter,
  RefusalExtra,
  MergeResult,
  EventSocketAttachment,
  Via,
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
CREATE TABLE IF NOT EXISTS unrecorded (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, identity TEXT NOT NULL, commands TEXT NOT NULL, origin TEXT, at TEXT NOT NULL,
  ref TEXT, old TEXT, new TEXT, landed TEXT NOT NULL DEFAULT 'yes');
CREATE TABLE IF NOT EXISTS object_sizes (repo TEXT NOT NULL, oid TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (repo, oid));
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT NOT NULL, path TEXT NOT NULL, machine TEXT NOT NULL,
  agent TEXT, kind TEXT NOT NULL, reported_by TEXT NOT NULL,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
`;

type Row = Record<string, SqlStorageValue>;

/** A record read with SELECT *: every column is there (NULL where unset), so no field is missing. */
type Stored<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };

/** A delivery as the API lists it, with its latest tries. */
type DeliveryRow = {
  id: string;
  hook_id: string;
  event: string;
  seq: number | null;
  status: string;
  attempts: number;
  response_code: number | null;
  error: string | null;
  created_at: string;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
};

type AttemptRow = { n: number; at: string; response_code: number | null; error: string | null; ms: number | null };

export type DeliveryView = DeliveryRow & { recent_attempts: AttemptRow[] };

/** How a worktree is mounted. */
export type WorktreeKind = "fuse" | "sparse" | "fskit";

/** A worktree as reported (the API's Worktree). */
export type Worktree = Omit<WorktreeRow, "kind"> & { kind: WorktreeKind };

/** A worktree row as stored. */
type WorktreeRow = {
  id: string;
  repo: string;
  branch: string;
  path: string;
  machine: string;
  agent: string | null;
  kind: string;
  reported_by: string;
  created_at: string;
  last_seen_at: string;
};

/** A stored event as the stream sends and pages it: publish() stores everything but seq, at and via. */
export type EventFrame = Omit<StreamEvent, "via"> & { seq: number; at: string };

/** A page of the event stream: `seq` is the newest event's seq, `oldest_seq` the oldest kept. */
export interface EventPage {
  events: EventFrame[];
  seq: number;
  oldest_seq: number;
  resync: boolean;
}

interface EventBounds {
  head: number;
  oldest: number;
}

/** A branch's stored fields, as branch events carry them (`partial`: the facts follow). */
interface BranchEventRow {
  repo: string;
  name: string;
  head: string;
  author: string | null;
  title: string | null;
  description: string | null;
  state: "merged" | "open";
  merge_commit: string | null;
  merged_by: string | null;
  merged_at: string | null;
  merged_machine: string | null;
  merged_agent: string | null;
  forced: boolean | null;
  pushed_machine: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * A branch list's cursor: the last row's time and name, "<time> <name>"
 * (a branch name never holds a space). Null for the first page, or a cursor
 * from before lists were ordered by time.
 */
function branchCursor(cursor: string | null): { at: string; name: string } | null {
  const i = cursor ? cursor.indexOf(" ") : -1;

  return cursor && i >= 0 ? { at: cursor.slice(0, i), name: cursor.slice(i + 1) } : null;
}

/** A code repo's main as the object last moved it (GET .../heads). */
export type RepoHead = {
  repo: string;
  path: string;
  default_branch: string;
  head: string | null;
  /** The head commit's title, when known here. */
  head_title: string | null;
  updated_at: string | null;
};

/** A merge commit's branch and that branch's title (the file pages' history). */
export interface MergedBranch {
  branch: string;
  title: string | null;
}

/** A sweep's work: main as the object has it, and the branches still to compute. */
export interface FactsCandidates {
  main: string | null;
  branches: { name: string; head: string }[];
}

/** Who did it, for an event: the user, the credential (machine) and the agent. `via` (the credential) is for the Machines tab and never stored. */
interface EventWho {
  actor: string | null;
  machine: string | null;
  agent: string | null;
  via?: Via;
}

function isKind(v: string | undefined): v is Kind {
  return v === "monorepo" || v === "repo";
}

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

/** After a push, Artifacts' refs are compared with the records this long after, twice (CODE-VS-MODEL.md P1). */
const REFS_CHECK_MS = 5 * 60_000;

/**
 * A push kept for later (C2), one ref per row: landed 'yes' (Artifacts took
 * it; its record waits for its old head) or 'unknown' (Artifacts' answer was
 * lost). keepPush is the only writer.
 */
type KeptRow = { id: number; identity: string; origin: string | null; ref: string; old: string; new: string; landed: string };

/** A kept push's pusher, as keepPush wrote it (null: not known, a catch-up by the refs compare). */
function keptIdentity(k: KeptRow): Identity | null {
  // SAFETY: keepPush is the only writer of unrecorded.identity: JSON.stringify of an Identity or null.
  return JSON.parse(k.identity) as Identity | null;
}

/** A stored review comment, read back from its JSON column; null when it is not one. */
function reviewCommentOf(v: Json): ReviewComment | null {
  if (!isRecord(v) || !isText(v.path) || !isText(v.body) || (v.side !== "new" && v.side !== "old")) return null;

  return isWholeNumber(v.line) ? { path: v.path, line: v.line, side: v.side, body: v.body } : { path: v.path, side: v.side, body: v.body };
}

const WORKTREE_KINDS: readonly WorktreeKind[] = ["fuse", "sparse", "fskit"];

/** A stored worktree, its kind checked as it is read back from SQL; null when the kind is none of the three. */
function worktreeOf(r: WorktreeRow): Worktree | null {
  return isOneOf(WORKTREE_KINDS, r.kind) ? { ...r, kind: r.kind } : null;
}

function who(by: Identity | null): EventWho {
  const out: EventWho = { actor: by?.login ?? null, machine: by?.credential_name ?? null, agent: by?.agent ?? null };

  if (by) out.via = { credential_id: by.credential_id, credential_kind: by.credential_kind ?? null };

  return out;
}

function randomId(prefix: string, bytes = 8): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));

  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function fail(status: number, code: string, message: string, extra?: RefusalExtra): never {
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

export type { MergeResult } from "./types";

export class MonorepoObject extends DurableObject<Env> {
  private sql: SqlStorage;
  private locks = new Map<string, Promise<unknown>>();
  /** At most two writes at once per Artifacts repo (gate.ts). In memory: leases end when the object restarts. */
  private gate = new WriteGate(WRITE_SLOTS, LEASE_MS, WAIT_MS, releaseDelay(this.env));
  /** Ref-only writes waiting for a slot, per Artifacts repo; sent together as one receive-pack. */
  private refQueues = new Map<string, { cmd: RefCommand; done: (reason: string | null) => void; fail: (cause: unknown) => void }[]>();
  private refRunners = new Set<string>();
  /** The home's activity feed (feed/out.ts, C25): activity marking, fan-out, presence, summary ticks. */
  private feed: FeedOut;
  /** The Machines tab (machines.ts): one row per (login, credential). */
  private machines: Machines;
  /** Branch facts jobs, drained by RPC (facts-out.ts). */
  private factsOut: FactsOut;
  /** Hook deliveries, sent by RPC (hooks-out.ts). */
  private hooksOut: HooksOut;
  /** CI (ci/store.ts): connections, pipelines, builds, jobs and their checks. */
  private ci: CiStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.feed = new FeedOut(ctx, env, this.sql, () => this.info());
    this.machines = new Machines(ctx, this.sql, (e) => this.publish(e));
    this.factsOut = new FactsOut(ctx, env, this.sql, () => this.info(), (t) => this.feed.armAt(t));
    this.hooksOut = new HooksOut(
      ctx, env, this.sql, () => this.info(), (t) => this.feed.armAt(t),
      (name) => this.repoRow(name), (repo) => this.currentMain(repo), ATTEMPTS_KEPT,
    );
    this.ci = new CiStore(ctx, env, this.sql, {
      info: () => this.info(),
      publish: (e) => this.publish(e),
      addStatus: (repo, sha, st, identity, stamp) => this.addStatus(repo, sha, st, identity, stamp),
    });
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

    for (const [col, type] of [["ahead", "INTEGER"], ["behind", "INTEGER"], ["merge_base", "TEXT"], ["mergeable", "TEXT"], ["conflict_paths", "TEXT"], ["facts_main", "TEXT"], ["facts_head", "TEXT"], ["facts_at", "TEXT"]]) {
      if (!bcols.includes(col)) this.sql.exec(`ALTER TABLE branches ADD COLUMN ${col} ${type}`);
    }

    const rcols = this.rows<{ name: string }>("PRAGMA table_info(repos)").map((c) => c.name);

    // Each move of a ref's record counts (a reconcile reads again when one slipped in after its refs read), and the refs compare's schedule.
    for (const [col, type] of [["record_moves", "INTEGER NOT NULL DEFAULT 0"], ["refs_check_at", "INTEGER"], ["refs_check_ms", "INTEGER"], ["refs_checks_left", "INTEGER"]]) {
      if (!rcols.includes(col)) this.sql.exec(`ALTER TABLE repos ADD COLUMN ${col} ${type}`);
    }

    const ucols = this.rows<{ name: string }>("PRAGMA table_info(unrecorded)").map((c) => c.name);

    if (!ucols.includes("ref")) {
      for (const [col, type] of [["ref", "TEXT"], ["old", "TEXT"], ["new", "TEXT"], ["landed", "TEXT NOT NULL DEFAULT 'yes'"]]) this.sql.exec(`ALTER TABLE unrecorded ADD COLUMN ${col} ${type}`);

      // Rows from before held a whole push; now one ref each.
      for (const p of this.rows<{ id: number; repo: string; identity: string; commands: string; origin: string | null; at: string }>("SELECT id, repo, identity, commands, origin, at FROM unrecorded")) {
        // SAFETY: markUnrecorded was the only writer of commands: JSON of the door's RefCommands.
        for (const c of JSON.parse(p.commands) as RefCommand[]) {
          this.sql.exec(
            "INSERT INTO unrecorded (repo, identity, commands, origin, at, ref, old, new, landed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'yes')",
            p.repo, p.identity, JSON.stringify([c]), p.origin, p.at, c.ref, c.old, c.new,
          );
        }

        this.sql.exec("DELETE FROM unrecorded WHERE id = ?", p.id);
      }
    }

    if (!rcols.includes("default_head")) this.sql.exec("ALTER TABLE repos ADD COLUMN default_head TEXT");

    if (!rcols.includes("default_head_at")) this.sql.exec("ALTER TABLE repos ADD COLUMN default_head_at TEXT");

    if (!rcols.includes("required_checks")) this.sql.exec("ALTER TABLE repos ADD COLUMN required_checks TEXT");

    // Main's head commit's title (its first line), when Pando knew it as main moved: a merge's message, or the first push's commit.
    if (!rcols.includes("default_head_title")) this.sql.exec("ALTER TABLE repos ADD COLUMN default_head_title TEXT");
    const dcols = this.rows<{ name: string }>("PRAGMA table_info(deliveries)").map((c) => c.name);

    if (!dcols.includes("seq")) this.sql.exec("ALTER TABLE deliveries ADD COLUMN seq INTEGER");

    if (!dcols.includes("sent_at")) this.sql.exec("ALTER TABLE deliveries ADD COLUMN sent_at TEXT");
    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS deliveries_once ON deliveries (hook_id, event, seq)");
    const ecols = this.rows<{ name: string }>("PRAGMA table_info(events)").map((c) => c.name);

    if (!ecols.includes("tags")) this.sql.exec("ALTER TABLE events ADD COLUMN tags TEXT");

    // The pull's repo= and kinds= (C4): each event's repo as a column, indexed with the kinds.
    if (!ecols.includes("repo")) {
      this.sql.exec("ALTER TABLE events ADD COLUMN repo TEXT");
      // Events from before: the repo is in the stored body too (publish() writes both).
      this.sql.exec("UPDATE events SET repo = json_extract(body, '$.repo')");
    }

    this.sql.exec("CREATE INDEX IF NOT EXISTS events_repo ON events (repo, seq)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS events_kind ON events (kind, seq)");

    // A meta layer event's key (KeyedEvent): each (source, version) is in the log once.
    if (!ecols.includes("source")) {
      this.sql.exec("ALTER TABLE events ADD COLUMN source TEXT");
      this.sql.exec("ALTER TABLE events ADD COLUMN source_version INTEGER");
    }

    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS events_once ON events (source, source_version)");
    // The CI service that reported a status (ci/statustoken.ts), stamped by Pando.
    const scols = this.rows<{ name: string }>("PRAGMA table_info(statuses)").map((c) => c.name);

    if (!scols.includes("app")) this.sql.exec("ALTER TABLE statuses ADD COLUMN app TEXT");
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.feed.ensureSchema();
    this.machines.ensureSchema();
    this.factsOut.ensureSchema();
    this.hooksOut.ensureSchema();
    this.ci.ensureSchema();
  }

  private rows<T extends Row>(query: string, ...args: SqlStorageValue[]): T[] {
    return this.sql.exec<T>(query, ...args).toArray();
  }

  private row<T extends Row>(query: string, ...args: SqlStorageValue[]): T | null {
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

    // A monorepo whose kind was never written is a monorepo.
    return { id: m.name, label: m.label ?? m.name, kind: isKind(m.kind) ? m.kind : "monorepo", created_at: m.created_at };
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
      this.feed.scheduleSummary(); // the home's "N projects" changed, with no event to say so

      return r;
    });
  }

  private repoRow(name: string): RepoRecord | null {
    return this.row<Stored<RepoRecord>>("SELECT * FROM repos WHERE name = ?", name);
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

    const list = v ? parseJson(v) : null;

    return isTextList(list) ? list : null;
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
  /** Main moved (or was read once): its head, and its commit's title when known here (else null, never a stale one). */
  rememberHead(repo: string, sha: string | null, title: string | null = null): void {
    const moved = this.sql.exec(
      "UPDATE repos SET default_head = ?, default_head_at = ?, default_head_title = ? WHERE name = ? AND (default_head IS NOT ? )",
      sha, now(), title, repo, sha,
    ).rowsWritten;

    if (moved) this.recordMoved(repo);
  }

  /** Count a move of one of the repo's records (a branch head or main): a reconcile that read Artifacts' refs before it reads them again. */
  private recordMoved(repo: string): void {
    this.sql.exec("UPDATE repos SET record_moves = record_moves + 1 WHERE name = ?", repo);
  }

  /**
   * Every code repo's main, from the object's records (no Artifacts call).
   * `head_title`: the title recorded when main moved; for a main recorded
   * before titles were, the last merge's branch title (the first line of
   * Pando's merge message), or null.
   */
  heads(): RepoHead[] {
    return this.rows<RepoHead>(
      `SELECT r.name AS repo, r.path, r.default_branch, r.default_head AS head,
         COALESCE(r.default_head_title, b.title, CASE WHEN m.branch IS NOT NULL THEN 'Merge branch ''' || m.branch || '''' END) AS head_title,
         r.default_head_at AS updated_at
       FROM repos r
       LEFT JOIN merges m ON m.repo = r.name AND m.merge_commit = r.default_head
       LEFT JOIN branches b ON b.repo = m.repo AND b.name = m.branch
       WHERE NOT (r.name = 'meta' AND r.artifacts_name LIKE '%--meta') ORDER BY r.path`,
    );
  }

  /** The code repos (the meta layer's repo is not listed). */
  listRepos(): RepoRecord[] {
    return this.rows<Stored<RepoRecord>>("SELECT * FROM repos WHERE NOT (name = 'meta' AND artifacts_name LIKE '%--meta') ORDER BY path");
  }

  // ── Branches and pushes ──────────────────────────────────────────────────

  branchRecords(repo: string): BranchRecord[] {
    return this.rows<Stored<BranchRecord>>(
      `SELECT b.*, m.forced AS merge_forced, m.machine AS merge_machine, m.agent AS merge_agent
       FROM branches b LEFT JOIN merges m ON m.repo = b.repo AND m.branch = b.name AND m.merge_commit = b.merge_commit
       WHERE b.repo = ? AND b.deleted_at IS NULL ORDER BY b.name`,
      repo,
    );
  }

  branchRecord(repo: string, name: string): BranchRecord | null {
    return this.row<Stored<BranchRecord>>("SELECT * FROM branches WHERE repo = ? AND name = ? AND deleted_at IS NULL", repo, name);
  }

  /** Where main was before the merge that landed this branch head, if Pando merged it. */
  mergedFrom(repo: string, branch: string, head: string): string | null {
    return this.row<{ base_before: string }>(
      "SELECT base_before FROM merges WHERE repo = ? AND branch = ? AND head = ? ORDER BY id DESC LIMIT 1",
      repo, branch, head,
    )?.base_before ?? null;
  }

  /**
   * The door's one rule: main moves only by a merge (creating it is allowed).
   * A push let through schedules the refs compare for its repo
   * (`checkEveryMs`: tests only, else REFS_CHECK_MS).
   */
  checkPush(repo: string, commands: RefCommand[], checkEveryMs: number | null = null): PushVerdict[] {
    const r = this.repoRow(repo);
    const main = `refs/heads/${r?.default_branch ?? DEFAULT_BRANCH}`;

    const refused = commands.flatMap((c) => (c.ref === main && c.old !== ZERO ? [{ ref: c.ref, reason: `${main.slice(11)} is protected; push a branch and merge it (pando merge)` }] : []));

    if (!refused.length && r) this.scheduleRefsCheck(repo, checkEveryMs ?? REFS_CHECK_MS);

    return refused;
  }

  // ── The refs compare (CODE-VS-MODEL.md P1) ───────────────────────────────
  //
  // A push whose record and keep both failed leaves no trace here. After any
  // push, a refs job (facts outbox, FactsDrain) compares Artifacts' refs with
  // the records twice, an interval apart (a push slower than one interval is
  // still found), and the reconcile catches the records up.

  private scheduleRefsCheck(repo: string, every: number): void {
    const at = Date.now() + every;

    this.sql.exec(
      "UPDATE repos SET refs_check_at = MIN(COALESCE(refs_check_at, ?), ?), refs_check_ms = ?, refs_checks_left = 2 WHERE name = ?",
      at, at, every, repo,
    );
    this.feed.armAt(at);
  }

  /** On the alarm: a refs job for each repo whose compare is due, and the next one scheduled. */
  private refsChecks(): void {
    const t = Date.now();

    const due = this.rows<{ name: string; every: number; left: number }>(
      "SELECT name, refs_check_ms AS every, refs_checks_left AS left FROM repos WHERE refs_check_at IS NOT NULL AND refs_check_at <= ?", t,
    );

    for (const r of due) {
      this.queueFacts({ type: "refs", repo: r.name });
      this.sql.exec("UPDATE repos SET refs_check_at = ?, refs_checks_left = ? WHERE name = ?", r.left > 1 ? t + r.every : null, r.left - 1, r.name);
    }

    const next = this.row<{ t: number | null }>("SELECT MIN(refs_check_at) AS t FROM repos")?.t;

    if (next) this.feed.armAt(next);
  }

  /**
   * Record branch heads after Artifacts accepted a push. Records follow
   * Artifacts' order (CODE-VS-MODEL.md P2): a branch moves only from the
   * push's own old head. A push whose old head is not the record (another
   * push's record landed first, or an earlier one was lost) is kept and
   * applied once its old head is recorded. Returns the events to deliver.
   */
  recordPush(
    repo: string,
    identity: Identity,
    updates: RefCommand[],
    made: { title?: string | null; description?: string | null } = {},
    origin: string | null = null,
  ): RepoEvent[] {
    const events: RepoEvent[] = [];
    const refs = updates.filter((u) => u.ref.startsWith("refs/heads/"));

    for (const u of refs) {
      if (!this.moveRef(repo, identity, u, made, events)) this.keepPush(repo, identity, u, origin, "yes");
    }

    // Hook deliveries, in the same step as the change (C9).
    this.queueDeliveries(events, origin);

    for (const u of refs) this.drainKept(repo, u.ref);

    return events;
  }

  /**
   * Move one ref's record from `u.old` to `u.new`, with its events and its
   * facts job. False, and nothing written, when a branch's record is not at
   * `u.old`. Main moves only by a merge or its first push, so it always moves.
   */
  private moveRef(repo: string, identity: Identity | null, u: RefCommand, made: { title?: string | null; description?: string | null }, events: RepoEvent[]): boolean {
    const r = this.repoRow(repo);
    const main = r?.default_branch ?? DEFAULT_BRANCH;
    const name = u.ref.slice(11);
    const at = now();
    const pusher = identity?.login ?? null;

    const base: Omit<RepoEvent, "event"> = {
      repo, branch: name, ref: u.ref, before: u.old, head: u.new, base: null,
      author: null, pusher, title: null, description: null,
    };

    if (name === main) {
      this.rememberHead(repo, u.new === ZERO ? null : u.new);
      this.forgetRequiredIfConfig(repo);

      const seq = this.publish({
        kind: "push", collection: "default_heads", key: repo, op: "upsert", repo, ...who(identity),
        row: { repo, default_branch: main, default_head: u.new === ZERO ? null : u.new }, before: u.old, head: u.new,
      });

      if (u.new !== ZERO) this.queueFacts({ type: "sweep", repo, main: u.new, push: seq ? { seq, before: u.old } : undefined });
      events.push({ ...base, event: "push", author: identity?.login ?? null, seq: seq || null });

      return true;
    }

    let b = this.branchRecord(repo, name);

    if ((b?.head ?? ZERO) !== u.old) return false;
    this.recordMoved(repo);

    if (u.new === ZERO) {
      if (b) this.sql.exec("UPDATE branches SET deleted_at = ?, head = NULL, updated_at = ? WHERE repo = ? AND name = ?", at, at, repo, name);
      const seq = this.publish({ kind: "branch.deleted", collection: "branches", key: `${repo}/${name}`, op: "delete", repo, ...who(identity), row: { repo, name }, before: u.old, head: u.new });
      events.push({ ...base, event: "push", author: b?.creator ?? null, title: b?.title ?? null, description: b?.description ?? null, seq: seq || null });

      return true;
    }

    const opened = !b;

    if (!b) {
      this.sql.exec(
        `INSERT INTO branches (repo, name, head, creator, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, name) DO UPDATE SET head = excluded.head, creator = excluded.creator,
           title = excluded.title, description = excluded.description, created_at = excluded.created_at, updated_at = excluded.updated_at,
           merge_commit = NULL, merged_head = NULL, merged_at = NULL, merged_by = NULL, deleted_at = NULL`,
        repo, name, u.new, identity?.login ?? null, made.title ?? null, made.description ?? null, at, at,
      );
    } else {
      this.sql.exec("UPDATE branches SET head = ?, updated_at = ? WHERE repo = ? AND name = ?", u.new, at, repo, name);
    }

    if (identity) this.sql.exec("UPDATE branches SET pushed_machine = ? WHERE repo = ? AND name = ?", identity.credential_name, repo, name);
    b = this.branchRecord(repo, name)!;
    const seq = this.publishBranch(opened ? "branch.opened" : "push", repo, name, identity, { before: u.old, head: u.new });
    const e = { ...base, author: b.creator, title: b.title, description: b.description, seq: seq || null };

    if (opened) events.push({ ...e, event: "branch.opened" });
    events.push({ ...e, event: "push" });
    this.queueFacts({ type: "branch", repo, branch: name, head: u.new, push: seq ? { seq, before: u.old } : undefined });

    return true;
  }

  /** Keep one ref of a push for later: landed 'yes' (waits for its old head) or 'unknown' (only a reconcile's catch-up covers it). */
  private keepPush(repo: string, identity: Identity | null, u: RefCommand, origin: string | null, landed: "yes" | "unknown"): void {
    this.sql.exec(
      "INSERT INTO unrecorded (repo, identity, commands, origin, at, ref, old, new, landed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      repo, JSON.stringify(identity), JSON.stringify([u]), origin, now(), u.ref, u.old, u.new, landed,
    );
  }

  /** Apply a ref's kept pushes that landed, in order, while each one's old head is the record. */
  private drainKept(repo: string, ref: string): void {
    for (let i = 0; i < 1_000; i++) {
      const k = this.row<KeptRow>(
        "SELECT id, identity, origin, ref, old, new, landed FROM unrecorded WHERE repo = ? AND ref = ? AND old = ? AND landed = 'yes' ORDER BY id LIMIT 1",
        repo, ref, this.recordedHead(repo, ref) ?? ZERO,
      );

      if (!k) return;
      this.sql.exec("DELETE FROM unrecorded WHERE id = ?", k.id);
      const events: RepoEvent[] = [];

      if (this.moveRef(repo, keptIdentity(k), { ref, old: k.old, new: k.new }, {}, events)) this.queueDeliveries(events, k.origin);
    }
  }

  // ── Kept pushes and the reconcile (C2; CODE-VS-MODEL.md P1 to P3) ───────
  //
  // `unrecorded` keeps pushes not yet in the records, one ref per row:
  // - 'yes': Artifacts took it, and either the door's record failed or the
  //   record was not at its old head yet (another push's record landed
  //   first); drainKept applies it once its old head is recorded;
  // - 'unknown': Artifacts' answer was lost and the refs did not show it
  //   landed; only a reconcile's catch-up covers it, never a replay.
  // A reconcile (reconcile.ts: a branch list with kept pushes, the door after
  // a lost answer, the refs compare) reads Artifacts' refs and catches the
  // records up: the branch rows, the push events and the hook deliveries.

  /**
   * The door could not record a push (landed 'yes': Artifacts accepted it) or
   * could not tell whether it landed ('unknown': Artifacts' answer was lost):
   * keep it for the reconcile, one row per ref.
   */
  markUnrecorded(repo: string, identity: Identity, commands: RefCommand[], origin: string | null, landed: "yes" | "unknown" = "yes"): void {
    for (const c of commands) this.keepPush(repo, identity, c, origin, landed);
  }

  /** A ref's head as recorded here: main from the repo's record, a branch from its row; null when unknown or deleted. */
  private recordedHead(repo: string, ref: string): string | null {
    const r = this.repoRow(repo);

    if (!r || !ref.startsWith("refs/heads/")) return null;

    if (ref === `refs/heads/${r.default_branch}`) return this.currentMain(repo);

    return this.branchRecord(repo, ref.slice(11))?.head ?? null;
  }

  /** Tests only (DOOR_TEST=1): a repo's kept pushes. */
  testKept(repo: string): { ref: string; old: string; new: string; landed: string }[] {
    if (this.env.DOOR_TEST !== "1") return [];

    return this.rows<{ ref: string; old: string; new: string; landed: string }>("SELECT ref, old, new, landed FROM unrecorded WHERE repo = ? ORDER BY id", repo);
  }

  /** What a reconcile saw before reading Artifacts' refs: the record-move count and the kept pushes. */
  reconcileSeen(repo: string): ReconcileSeen {
    const moves = this.row<{ n: number }>("SELECT record_moves AS n FROM repos WHERE name = ?", repo)?.n ?? 0;

    return { moves, ids: this.rows<{ id: number }>("SELECT id FROM unrecorded WHERE repo = ? ORDER BY id", repo).map((r) => r.id) };
  }

  /**
   * Catch a repo's records up to Artifacts' refs as read (ref to sha), after
   * reconcileSeen (CODE-VS-MODEL.md P3). "retry" when a record moved since:
   * the caller reads the refs again. Else, in one step: replay the seen
   * pushes that landed, in order, where each starts at the record; make one
   * catch-up move per ref still not at the head read (one push event, so CI
   * runs on it; an 'unknown' push is covered only this way, never replayed);
   * delete only the rows seen (later ones wait for their old head or the next
   * reconcile); then apply kept pushes that now follow. The refs named are the
   * seen rows' refs, or with `all` (the refs compare) every branch Artifacts
   * has but main (moved only by merges). Returns how many moves it wrote.
   */
  reconcile(repo: string, refs: Record<string, string>, seen: ReconcileSeen, all = false): number | "retry" {
    if (this.reconcileSeen(repo).moves !== seen.moves) return "retry";
    const ids = new Set(seen.ids);
    const rows = this.rows<KeptRow>("SELECT id, identity, origin, ref, old, new, landed FROM unrecorded WHERE repo = ? ORDER BY id", repo).filter((k) => ids.has(k.id));
    const main = `refs/heads/${this.repoRow(repo)?.default_branch ?? DEFAULT_BRANCH}`;
    let written = 0;

    for (const k of rows) {
      if (k.landed !== "yes" || (this.recordedHead(repo, k.ref) ?? ZERO) !== k.old) continue;
      const events: RepoEvent[] = [];

      if (this.moveRef(repo, keptIdentity(k), { ref: k.ref, old: k.old, new: k.new }, {}, events)) {
        this.queueDeliveries(events, k.origin);
        written++;
      }
    }

    const named = new Set(rows.map((k) => k.ref));

    if (all) for (const ref of Object.keys(refs)) if (ref.startsWith("refs/heads/") && ref !== main) named.add(ref);

    for (const ref of named) {
      const recorded = this.recordedHead(repo, ref) ?? ZERO;
      const there = refs[ref] ?? ZERO;

      if (recorded === there) continue;
      // By the kept push that brought this head, else the ref's last kept push, else no one known.
      const mine = rows.filter((k) => k.ref === ref);
      const by = mine.findLast((k) => k.new === there) ?? mine.at(-1) ?? null;
      const events: RepoEvent[] = [];

      if (this.moveRef(repo, by ? keptIdentity(by) : null, { ref, old: recorded, new: there }, {}, events)) {
        console.warn(`reconcile ${repo}: ${ref} caught up to Artifacts`);
        this.queueDeliveries(events, by?.origin ?? null);
        written++;
      }
    }

    for (let i = 0; i < rows.length; i += 90) {
      const chunk = rows.slice(i, i + 90).map((k) => k.id);
      this.sql.exec(`DELETE FROM unrecorded WHERE id IN (${chunk.map(() => "?").join(",")})`, ...chunk);
    }

    for (const ref of named) this.drainKept(repo, ref);

    return written;
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
        this.recordMoved(repo);
        b = this.branchRecord(repo, name)!;
      }

      if (patch.title !== undefined) this.sql.exec("UPDATE branches SET title = ? WHERE repo = ? AND name = ?", patch.title, repo, name);

      if (patch.description !== undefined) this.sql.exec("UPDATE branches SET description = ? WHERE repo = ? AND name = ?", patch.description, repo, name);
      this.publishBranch("branch.updated", repo, name, identity);

      return this.branchRecord(repo, name)!;
    });
  }

  // ── Reviews ──────────────────────────────────────────────────────────────

  addReview(repo: string, branch: string, head: string, verdict: ReviewVerdict, body: string | null, comments: ReviewComment[], identity: Identity) {
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
    type ReviewRow = { id: string; branch: string; head: string; verdict: string; body: string | null; comments: string; author: string; created_at: string };

    // addReview is the only writer: a row whose verdict reads back as none of the three is left out.
    return this.rows<ReviewRow>("SELECT * FROM reviews WHERE repo = ? AND branch = ? ORDER BY created_at", repo, branch).flatMap((r) => {
      const verdict = verdictOf(r.verdict);

      if (!verdict) return [];
      const comments = parseJson(r.comments);

      return [{
        id: r.id, branch: r.branch, head: r.head, verdict, body: r.body, comments: Array.isArray(comments) ? comments.flatMap((x) => reviewCommentOf(x) ?? []) : [],
        author: r.author, created_at: r.created_at,
      }];
    });
  }

  // ── Statuses and the gate ────────────────────────────────────────────────

  /**
   * A status. A member's shows them as creator, with no app. `stamp` is set
   * only by Pando: a verified status token (ci/statustoken.ts) or a CI
   * integration (ci/store.ts); the event then has no actor, since no person
   * posted it.
   */
  addStatus(
    repo: string,
    sha: string,
    s: { state: StatusRecord["state"]; context: string; target_url: string | null; description: string | null },
    identity: Identity | null,
    stamp: { app: string | null; creator: string } | null = null,
  ): StatusRecord {
    const at = now();
    const creator = stamp?.creator ?? identity?.login ?? "pando";
    const app = stamp?.app ?? null;
    this.sql.exec(
      "INSERT INTO statuses (repo, sha, context, state, target_url, description, creator, app, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      repo, sha, s.context, s.state, s.target_url, s.description, creator, app, at,
    );
    const status: StatusRecord = { sha, ...s, creator, app, created_at: at };
    this.publish({ kind: "status", collection: "statuses", key: `${repo}/${sha}/${s.context}`, op: "upsert", repo, ...who(stamp ? null : identity), row: status });

    // The branches at this commit have new checks and gate state: their full rows go out (combine() is the one rule).
    for (const b of this.rows<{ name: string }>("SELECT name FROM branches WHERE repo = ? AND head = ? AND deleted_at IS NULL", repo, sha)) {
      this.publishBranchRow(repo, b.name);
    }

    return status;
  }

  statuses(repo: string, sha: string): StatusRecord[] {
    return this.rows<Stored<StatusRecord>>(
      "SELECT sha, context, state, target_url, description, creator, app, created_at FROM statuses WHERE repo = ? AND sha = ? ORDER BY id",
      repo, sha,
    );
  }

  /**
   * The merge gate's required checks: the kept list, read from pando.toml
   * when there is none. The kept list is dropped whenever main moves in the
   * repo holding pando.toml by a merge or its first push, and .pando/** never
   * changes any other way (the live layer refuses saves there), so it is
   * never stale. Throws checks_unknown when pando.toml could not be read or
   * does not parse: nothing is kept, and the next merge reads it again.
   */
  private async checksFor(r: RepoRecord, sha: string): Promise<Checks> {
    let required = this.storedRequired(r.name);

    if (!required) {
      required = await requiredChecks(this.env, this.info()!, r, this.takeConfigFail());
      this.setRequiredChecks(r.name, required);
    }

    return combine(sha, { list: required, unknown: null }, this.statuses(r.name, sha));
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
    let checks: Checks | null = null;

    try {
      checks = await this.checksFor(r, head);
    } catch (err) {
      // Unknown required checks refuse an unforced merge, as red ones do; a forced one goes through as forced.
      if (!isChecksUnknown(err) || !a.force) throw err;
    }

    if (checks && checks.state !== "success" && !a.force) {
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
    const forced = checks?.state !== "success";
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
    this.rememberHead(a.repo, out.sha, message.split("\n")[0] || null);
    this.forgetRequiredIfConfig(a.repo);
    this.queueFacts({ type: "sweep", repo: a.repo, main: out.sha });
    const merge: MergeResult = { status: "merged", branch: a.branch, head, sha: out.sha, base_before: out.old, merge_base: out.mergeBase, forced, merged_by: a.identity.login };
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
    await this.env.META.get(this.env.META.idFromName(m)).applyFromMain({ monorepo: m, commit, author, login: who.login, changes });
  }

  // ── Hooks and deliveries ─────────────────────────────────────────────────

  addHook(repo: string, h: { type: "web" | "buildkite"; url: string | null; secret: string | null; events: HookEvent[]; config: unknown }, identity: Identity) {
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

  // ── Deliveries: rows here, sent by the HooksDrain entrypoint (hooks-out.ts) ──
  //
  // A delivery row is written in the same step as the change that caused it,
  // keyed by (hook, event, seq) so a retry or a replay never makes a second
  // row. The rows are the outbox: due ones go at once to HooksDrain by RPC,
  // which POSTs and answers each result; the alarm is only the retry timer.

  private deliveryView(id: string): DeliveryView | null {
    const d = this.row<DeliveryRow>(
      `SELECT id, hook_id, event, seq, status, attempts, response_code, error, created_at, last_attempt_at, next_attempt_at
       FROM deliveries WHERE id = ?`,
      id,
    );

    if (!d) return null;

    const attempts = this.rows<AttemptRow>(
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

    if (ids.length) this.hooksOut.kick();

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

  /** Send one delivery again (same row, same seq; new attempts are added). */
  redeliver(repo: string, deliveryId: string): Promise<Outcome<DeliveryView>> {
    return this.guard(async () => {
      if (!this.row("SELECT id FROM deliveries WHERE repo = ? AND id = ?", repo, deliveryId)) fail(404, "not_found", `no delivery ${deliveryId}`);
      this.hooksOut.requeue([deliveryId]);

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

      this.hooksOut.requeue(ids);

      return { queued: ids.length, ids };
    });
  }

  /** The one alarm: the feed's outbox and tick, then the facts' and the hooks' retries. */
  async alarm(): Promise<void> {
    await this.feed.alarm();
    this.refsChecks();
    await this.factsOut.alarm();
    await this.hooksOut.alarm();
  }

  // ── Object sizes (git protocol v2 object-info) ───────────────────────────

  /** Known sizes of objects in a repo. Objects never change, so entries never expire. */
  objectSizes(repo: string, oids: string[]): Record<string, number> {
    const sizes: [string, number][] = [];

    // Durable Object SQLite binds at most 100 variables: the repo plus 90 ids.
    for (let i = 0; i < oids.length; i += 90) {
      const chunk = oids.slice(i, i + 90);

      const rows = this.rows<{ oid: string; size: number }>(
        `SELECT oid, size FROM object_sizes WHERE repo = ? AND oid IN (${chunk.map(() => "?").join(",")})`,
        repo, ...chunk,
      );

      for (const r of rows) sizes.push([r.oid, r.size]);
    }

    return Object.fromEntries(sizes);
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

  /** Record an event and send it to every open event socket. Returns its seq; a keyed event already in the log is not sent again. */
  publish(e: StreamEvent, key: Omit<KeyedEvent, "event"> | null = null): number {
    if (!EVENT_STREAM) return 0;
    const had = key ? this.row<{ seq: number }>("SELECT seq FROM events WHERE source = ? AND source_version = ?", key.source, key.version) : null;

    if (had) return had.seq;
    const at = now();
    const { seq: _s, at: _a, via: _v, ...rest } = e;
    const body = JSON.stringify(rest);
    const tags = eventTags(e);

    const seq = this.sql.exec<{ seq: number }>(
      "INSERT INTO events (at, kind, body, tags, source, source_version, repo) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq",
      at, e.kind, body, ` ${tags.join(" ")} `, key?.source ?? null, key?.version ?? null, e.repo ?? null,
    ).one().seq;

    const line = this.feed.onPublish(seq, at, body);
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

    // After this event's frames: its machine's latest activity (may publish machine.updated).
    this.machines.onEvent(seq, at, e, line);

    return seq;
  }

  /** Events from the meta layer object's outbox, in order (meta.saved, machine.connected, machine.disconnected), each once by its key. */
  publishMeta(events: KeyedEvent[]): number {
    let seq = 0;

    for (const { event, ...key } of events) seq = this.publish(event, key);

    return seq;
  }

  /**
   * Events after `since` (or the latest), on any of `topics`. `filter`
   * narrows in SQL (before a seq; a repo and kinds, on their indexes); a topic
   * other than `all` is matched here, over at most SCAN_MAX rows.
   */
  private eventRows(since: number, limit: number, latest: boolean, topics: string[] = ["all"], filter: EventFilter = {}): EventFrame[] {
    const all = topics.includes("all");
    const match = (tags: string | null) => all || topics.some((t) => (tags ?? " all ").includes(` ${t} `));
    const where: string[] = [];
    const args: SqlStorageValue[] = [];

    const and = (clause: string, ...values: SqlStorageValue[]) => {
      where.push(clause);
      args.push(...values);
    };

    if (!latest) and("seq > ?", since);

    if (filter.before) and("seq < ?", filter.before);

    if (filter.repo) and("repo = ?", filter.repo);

    if (filter.kinds?.length) and(`kind IN (${filter.kinds.map(() => "?").join(",")})`, ...filter.kinds);

    const found = this.rows<{ seq: number; at: string; body: string; tags: string | null }>(
      `SELECT seq, at, body, tags FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq ${latest ? "DESC" : "ASC"} LIMIT ?`,
      ...args, all ? limit : SCAN_MAX,
    ).filter((r) => match(r.tags)).slice(0, limit);

    const rows = latest ? found.reverse() : found;

    // publish() writes body: JSON of the event without seq, at and via.
    return rows.map((r): EventFrame => ({ seq: r.seq, at: r.at, ...JSON.parse(r.body) }));
  }

  /** The newest event's seq (0 when there is none). */
  eventHead(): number {
    return this.eventBounds().head;
  }

  private eventBounds(): EventBounds {
    const b = this.row<{ head: number | null; oldest: number | null }>("SELECT MAX(seq) AS head, MIN(seq) AS oldest FROM events");

    return { head: b?.head ?? 0, oldest: b?.oldest ?? 0 };
  }

  /**
   * Events after `since` (oldest first), or the latest `limit` with no
   * `since`; with `filter.before`, only those before that seq (page back with
   * the first one's seq). (An event's own `head` is a commit sha.)
   */
  events(since: number | null, limit: number, topics: string[] = ["all"], filter: EventFilter = {}): EventPage {
    const { head, oldest } = this.eventBounds();
    const n = Math.min(Math.max(limit, 1), REPLAY_MAX);
    const bounds = { seq: head, oldest_seq: oldest };

    if (since === null) return { events: this.eventRows(0, n, true, topics, filter), ...bounds, resync: false };
    const resync = since > head || (head > 0 && since < oldest - 1);

    return { events: resync ? [] : this.eventRows(since, n, false, topics, filter), ...bounds, resync };
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

    const attachment: EventSocketAttachment = {
      login: request.headers.get("x-pando-login") ?? "", connected_at: now(), topics,
      // For presence (C25): the socket's id, and the credential's name as the default machine.
      sid: randomId("ws_"), machine: request.headers.get("x-pando-machine") ?? "",
      // For the Machines tab: the credential behind the socket.
      cid: request.headers.get("x-pando-credential") ?? "", kind: request.headers.get("x-pando-credential-kind") ?? "",
    };

    server.serializeAttachment(attachment);
    // Replay, then live. Nothing here awaits, so no event can fall between the two.
    const sinceParam = url.searchParams.get("since");
    const since = sinceParam === null || sinceParam === "" ? null : Number(sinceParam);
    const { head, oldest } = this.eventBounds();

    if (since !== null) {
      const missed = Number.isSafeInteger(since) && since >= 0 ? head - since : Infinity;
      const all = topics.includes("all");

      if (!Number.isSafeInteger(since) || since < 0 || since > head || (head > 0 && since < oldest - 1) || missed > (all ? REPLAY_MAX : SCAN_MAX)) {
        server.send(JSON.stringify({ type: "resync", seq: head, oldest_seq: oldest } satisfies typeof Contract.MonorepoEventFrame.Encoded));
      } else {
        const replay = this.eventRows(since, REPLAY_MAX + 1, false, topics);

        if (replay.length > REPLAY_MAX) server.send(JSON.stringify({ type: "resync", seq: head, oldest_seq: oldest } satisfies typeof Contract.MonorepoEventFrame.Encoded));
        else for (const e of replay) server.send(JSON.stringify({ type: "event", ...e }));
      }
    }

    // The `feed` topic: what was sent after feed_since, in the order it went out (C25).
    if (topics.includes("feed")) this.feed.replay(server, url.searchParams.get("feed_since"));
    // feed_n only with the feed topic (stringify drops undefined).
    // The same frame ends a row socket's replay and a feed socket's (feed_n only on the latter).
    server.send(JSON.stringify({ type: "caught_up", seq: head, feed_n: topics.includes("feed") ? this.feed.feedHead() : undefined } satisfies typeof Contract.MonorepoFeedFrame.Encoded));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    // The stream is one way, but for a follower's hello (presence, C25). Text "ping" is answered "pong" without waking the object.
    let reply: HelloAnswer = { type: "error", message: "this socket only sends; send the text ping to keep it open" };
    const m = isText(msg) ? parseJson(msg) : null;

    if (isRecord(m) && m.type === "hello") {
      reply = this.feed.hello(ws, m);

      if (reply.type === "hello_ok") this.machines.hello(attachmentOf(ws) ?? {}, isTextList(m.worktrees) ? m.worktrees : []);
    }

    try {
      ws.send(JSON.stringify(reply));
    } catch {
      // closed
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.feed.gone(ws);
    this.machines.gone(ws, this.feed.liveHelloSids());

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
  private branchEventRow(repo: string, name: string): BranchEventRow | null {
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

  private publishBranch(kind: string, repo: string, name: string, by: Identity | null, extra: Pick<StreamEvent, "before" | "head" | "merge"> = {}): number {
    const row = this.branchEventRow(repo, name);

    return this.publish({
      kind, collection: "branches", key: `${repo}/${name}`, op: row ? "upsert" : "delete", repo, ...who(by),
      row: row ?? { repo, name }, partial: true, ...extra,
    });
  }

  // ── Branch facts (facts.ts): stored, computed on change by FactsDrain ────

  private queueFacts(m: FactsRequest): void {
    // The outbox (facts-out.ts), drained at once by RPC.
    this.factsOut.add(m);
  }

  /** Tests only (HOOKS_TEST=1): die after the next delivery's call answers, before recording it. */
  testHooksOutbox(set: { crash?: boolean } = {}) {
    return this.hooksOut.test(set);
  }

  private configFails = 0;

  /** Tests only (CHECKS_TEST=1): the next `fail` reads of pando.toml fail. */
  testChecks(fail: number) {
    if (this.env.CHECKS_TEST === "1") this.configFails = fail;

    return { fail: this.configFails };
  }

  /** Tests only: whether this read of pando.toml fails (CHECKS_TEST=1 and a failure left). */
  takeConfigFail(): boolean {
    if (this.env.CHECKS_TEST !== "1" || this.configFails <= 0) return false;
    this.configFails--;

    return true;
  }

  /** Tests only (FACTS_TEST=1): fail the next drains; the facts outbox as it is. */
  testFactsOutbox(set: { fail?: number } = {}) {
    return this.factsOut.test(set);
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
  mergedBranches(repo: string, shas: string[]): Record<string, MergedBranch> {
    const merged: [string, MergedBranch][] = [];

    for (let i = 0; i < shas.length; i += 100) {
      const chunk = shas.slice(i, i + 100);

      for (const r of this.rows<{ merge_commit: string; branch: string; title: string | null }>(
        `SELECT m.merge_commit, m.branch, b.title FROM merges m LEFT JOIN branches b ON b.repo = m.repo AND b.name = m.branch
         WHERE m.repo = ? AND m.merge_commit IN (${chunk.map(() => "?").join(",")})`,
        repo, ...chunk,
      )) merged.push([r.merge_commit, { branch: r.branch, title: r.title }]);
    }

    return Object.fromEntries(merged);
  }

  currentMain(repo: string): string | null {
    return this.row<{ default_head: string | null }>("SELECT default_head FROM repos WHERE name = ?", repo)?.default_head ?? null;
  }

  /** A sweep's branches: open, pushed within `days`, newest first, at most `max`, without facts for (main, head) yet. */
  factsCandidates(repo: string, main: string, days: number, max: number): FactsCandidates {
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
  writeFacts(repo: string, name: string, f: Facts, required: Required): boolean {
    if (this.currentMain(repo) !== f.main) return false;
    const b = this.branchRecord(repo, name);

    if (!b || b.head !== f.head) return false;
    this.sql.exec(
      "UPDATE branches SET ahead = ?, behind = ?, merge_base = ?, mergeable = ?, conflict_paths = ?, facts_main = ?, facts_head = ?, facts_at = ? WHERE repo = ? AND name = ?",
      f.ahead, f.behind, f.merge_base, f.mergeable, f.conflict_paths ? JSON.stringify(f.conflict_paths) : null, f.main, f.head, now(), repo, name,
    );
    // `required` is for this row only: the kept list changes only through storedRequired's owners.
    this.publishBranchRow(repo, name, required);

    return true;
  }

  /** A branch's full row as getBranch answers it (facts, checks and gate), as `branch.updated` with `partial: false`. */
  private publishBranchRow(repo: string, name: string, required: Required | null = null): void {
    const row = this.branchRows(repo, { names: [name], state: "all", required }).branches[0];

    if (row) this.publish({ kind: "branch.updated", collection: "branches", key: `${repo}/${name}`, op: "upsert", repo, actor: null, machine: null, agent: null, row: { repo, ...row }, partial: false });
  }

  /** The stored dry run's conflicting paths, when its answer was "conflicts". */
  private conflictPaths(b: BranchRecord): string[] | null {
    if (b.mergeable !== "conflicts" || !b.conflict_paths) return null;
    const paths = parseJson(b.conflict_paths);

    return isTextList(paths) ? paths : null;
  }

  /**
   * Branch rows as GET listBranches returns them, from stored facts (no
   * Artifacts call). Rows whose facts are not for the current (main, head)
   * are `stale`, with mergeable "pending" and `last_mergeable`; those stale
   * longer than `graceMs` are named in `due` for the caller to compute.
   */
  branchRows(
    repo: string,
    o: { names?: string[]; state: "open" | "merged" | "all"; limit?: number; cursor?: string | null; required?: Required | null; graceMs?: number },
  ): BranchList {
    const r = this.repoRow(repo);

    if (!r) return { default_branch: DEFAULT_BRANCH, default_head: null, branches: [], next_cursor: null, due: [], reconcile: false };
    const main = this.currentMain(repo);
    const mainAt = Date.parse(this.row<{ t: string | null }>("SELECT default_head_at AS t FROM repos WHERE name = ?", repo)?.t ?? "") || 0;
    const required: Required = o.required ?? { list: this.storedRequired(repo) ?? [], unknown: null };
    const limit = Math.min(Math.max(o.limit ?? 100, 1), 500);

    // Newest first, as GitHub lists active branches: an open branch by its last push, a merged one by its merge; ties by name.
    const all = this.branchRecords(repo)
      .filter((b) => b.head && b.name !== r.default_branch && (!o.names || o.names.includes(b.name)))
      .map((b) => ({ b, at: (b.merged_head === b.head ? b.merged_at : b.updated_at) ?? "" }))
      .sort((x, y) => (x.at !== y.at ? (x.at < y.at ? 1 : -1) : x.b.name < y.b.name ? -1 : x.b.name > y.b.name ? 1 : 0));

    const after = branchCursor(o.cursor ?? null);
    const t = Date.now();
    const rows: BranchView[] = [];
    const due: string[] = [];
    let next: string | null = null;
    let lastAt = "";

    for (const { b, at } of all) {
      if (after && (at > after.at || (at === after.at && b.name <= after.name))) continue;
      const merged = b.merged_head === b.head;
      const state = merged ? "merged" : "open";

      if (o.state !== "all" && state !== o.state) continue;

      if (rows.length >= limit) {
        next = `${lastAt} ${rows[rows.length - 1].name}`;
        break;
      }

      lastAt = at;

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
        mergeable: merged ? "up_to_date" : fresh ? (isMergeable(b.mergeable) ? b.mergeable : "unknown") : "pending",
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
        last_mergeable: !fresh && isMergeable(b.mergeable) ? b.mergeable : null,
        conflict_paths: merged ? null : this.conflictPaths(b),
        facts_at: b.facts_at ?? null,
      });
    }

    const reconcile = this.rows<{ id: number }>("SELECT id FROM unrecorded WHERE repo = ? LIMIT 1", repo).length > 0;

    return { default_branch: r.default_branch, default_head: main, branches: rows, next_cursor: next, due, reconcile };
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
  feedPush(seq: number, summary: PushNumbers): boolean {
    const sent = this.feed.push(seq, summary);

    if (sent) this.machines.pushSummary(seq, summary);
    this.rememberHeadTitle(seq, summary.head_title);

    return sent;
  }

  /** A push of main (a default_heads event) got its head commit's title from the facts job: keep it while that commit is main. */
  private rememberHeadTitle(seq: number, title: string | null): void {
    if (!title) return;
    const stored = this.row<{ body: string }>("SELECT body FROM events WHERE seq = ?", seq);
    const e = stored ? parseJson(stored.body) : null;

    if (!isRecord(e) || e.collection !== "default_heads" || !isRecord(e.row) || !isText(e.row.repo) || !isText(e.head)) return;
    this.sql.exec("UPDATE repos SET default_head_title = ? WHERE name = ? AND default_head = ?", title, e.row.repo, e.head);
  }

  /** Activity events older than the cursor, newest first (fan-in for large monorepos and history past a feed's window). */
  eventsBefore(cursor: Key | null, limit: number): FeedEvent[] {
    return this.feed.before(cursor, Math.min(Math.max(limit, 1), 500));
  }

  /** Open branches that need someone (ready, conflicts, failing), from stored facts. */
  needsYou(needs: NeedState[], limit: number): NeedRow[] {
    return this.feed.needs(new Set(needs)).slice(0, Math.min(Math.max(limit, 1), 500));
  }

  /** The Machines tab: one row per machine, latest activity first. */
  machineRows(): MachineRow[] {
    return this.machines.list(this.feed.liveHelloSids());
  }

  feedSummary(): Summary {
    return this.feed.summary();
  }

  /** Tests only (the crash and failure switches act only with FEED_TEST=1): the feed outbox. */
  feedTestOutbox(set: { crash?: "before" | "after"; fail?: number } = {}) {
    return this.feed.testOutbox(set);
  }

  // ── CI (ci/store.ts; routes in ci/routes.ts) ─────────────────────────────

  ciConnect(c: { service: "buildkite"; organization: string; api_base: string | null; webhook_token: string | null }, by: Identity) {
    return this.guard(() => this.ci.connect(c, by));
  }

  ciDisconnect(id: string, by: Identity): boolean {
    return this.ci.disconnect(id, by);
  }

  ciWebhook(id: string, h: { event: string | null; token: string | null; signature: string | null }, body: string, nowMs: number): Promise<Outcome<IngestResult>> {
    return this.guard(() => this.ci.webhook(id, h, body, nowMs));
  }

  ciIngestBuild(connection: string, build: Json | null): Promise<Outcome<IngestResult>> {
    return this.guard(() => this.ci.ingestBuild(connection, build));
  }

  ciIngestJob(build: string, job: Json | null) {
    const j = this.ci.ingestJob(build, job);

    return j ? this.ci.jobView(j) : null;
  }

  ciOverview() {
    return this.ci.overview();
  }

  ciBuilds(q: BuildsQuery) {
    return this.guard(() => this.ci.builds(q));
  }

  ciBuild(id: string) {
    return this.ci.build(id);
  }

  ciRef(build: string, job: string | null): CiRef | null {
    return this.ci.ref(build, job);
  }

  ciPipeline(slug: string, connection: string | null) {
    return this.guard(() => this.ci.pipeline(slug, connection));
  }

  ciSavePipeline(connection: string, slug: string, repo: string | null, p: { configuration: string | null; name: string | null; web_url: string | null; default_branch: string | null }): void {
    this.ci.savePipeline(connection, slug, repo, p);
  }

  ciPermit(connection: string) {
    return this.ci.permit(connection);
  }

  ciRateWait(connection: string, ms: number): void {
    this.ci.rateWait(connection, ms);
  }

  // ── Worktrees ────────────────────────────────────────────────────────────

  putWorktree(id: string, w: { repo: string; branch: string; path: string; machine: string; agent: string | null; kind: WorktreeKind }, identity: Identity): Promise<Outcome<Worktree>> {
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

  private worktree(id: string): Worktree | null {
    const r = this.row<WorktreeRow>(
      "SELECT id, repo, branch, path, machine, agent, kind, reported_by, created_at, last_seen_at FROM worktrees WHERE id = ?", id,
    );

    return r ? worktreeOf(r) : null;
  }

  getWorktree(id: string) {
    return this.worktree(id);
  }

  listWorktrees(filter: { machine?: string; repo?: string }): Worktree[] {
    return this.rows<WorktreeRow>(
      `SELECT id, repo, branch, path, machine, agent, kind, reported_by, created_at, last_seen_at FROM worktrees
       WHERE (?1 IS NULL OR machine = ?1) AND (?2 IS NULL OR repo = ?2) ORDER BY machine, path`,
      filter.machine ?? null, filter.repo ?? null,
    ).flatMap((r) => worktreeOf(r) ?? []);
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
