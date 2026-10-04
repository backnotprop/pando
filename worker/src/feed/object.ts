// The FeedObject: one Durable Object (SQLite) per person, keyed by login
// (C25). It holds:
// - pointers: the activity lines of the person's small monorepos, keyed by
//   (monorepo, seq), ordered by (at, monorepo, seq), each with `landed`, the
//   feed's own arrival number (live replay uses it; a queue delivers at least
//   once and in any order, and a backfill lands old events late);
// - the index: one row per monorepo the person belongs to, with its summary
//   line, whether it is large (read on demand), and how far back the
//   pointers cover it;
// - the person's hibernating sockets;
// - their contribution counts (profile SPEC section 3.2): one counter per UTC
//   hour, monorepo and kind, and the key of every credit applied (kept 30
//   days), so a credit delivered twice counts once.
// It makes no outbound calls; the routes merge in what comes from logs.

import type * as Contract from "@pando/contract";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { now } from "../http";
import { isRecord, isText, isWholeNumber, parseJson } from "../parse";
import {
  effectiveAfter, PENDING, REPLAY_MAX, storedPointerOf, summaryOf, uncovered, WINDOW_DAYS, WINDOW_MAX,
  type FeedEvent, type Key, type NeedChange, type StoredPointer, type Summary,
} from "./shape";

/** A row of the monorepos table, as selected by INDEX_COLUMNS. */
type IndexSqlRow = {
  name: string; label: string | null; kind: string | null; joined_at: string; pending: number; large: number;
  covered_after: string | null; summary: string | null; summary_at: string | null;
};

const INDEX_COLUMNS = "name, label, kind, joined_at, pending, large, covered_after, summary, summary_at";

/** A pointer row as stored (its body is a StoredPointer, as JSON). */
type PointerRow = { monorepo: string; seq: number; at: string; body: string };

/** Frames on the person's socket. */
type PersonFrame =
  | { type: "event"; landed: number; event: FeedEvent }
  | { type: "summary"; monorepo: string; monorepo_id: string; summary: Summary }
  | { type: "needs"; monorepo: string; monorepo_id: string; changed: NeedChange[]; more: boolean }
  | { type: "joined"; monorepo: string; monorepo_id: string; large: boolean }
  | { type: "left"; monorepo: string; monorepo_id: string }
  | { type: "contributed"; monorepo: string; monorepo_id: string; hour: string; kind: ContribKind; n: number }
  | { type: "resync"; landed: number }
  | { type: "caught_up"; landed: number }
  | { type: "error"; message: string };

/** A monorepo as the accounts list it for this person. */
export interface ListedMonorepo {
  name: string;
  kind: string;
  label?: string;
}

export interface Reconciled {
  added: string[];
  removed: string[];
  rows: IndexRow[];
}

export interface Trimmed {
  dropped: number;
  floor: string | null;
}

export interface FeedDebug {
  index: IndexRow[];
  pointers: { [monorepo: string]: number };
  landed: number;
  floor: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS monorepos (
  name TEXT PRIMARY KEY, kind TEXT, joined_at TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 1,
  covered_after TEXT, large INTEGER NOT NULL DEFAULT 0, summary TEXT, summary_at TEXT);
CREATE TABLE IF NOT EXISTS pointers (
  monorepo TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, landed INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (monorepo, seq));
CREATE INDEX IF NOT EXISTS pointers_key ON pointers (at, monorepo, seq);
CREATE INDEX IF NOT EXISTS pointers_mono ON pointers (monorepo, at, seq);
CREATE UNIQUE INDEX IF NOT EXISTS pointers_landed ON pointers (landed);
CREATE TABLE IF NOT EXISTS contrib (
  hour TEXT NOT NULL, monorepo TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (hour, monorepo, kind));
CREATE TABLE IF NOT EXISTS contrib_applied (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
`;

/** What a credit counts. Repositories made are read from D1 with the profile. */
export type ContribKind = "commit" | "branch" | "review";

/** One counter step: `n` more of `kind` in the UTC hour `hour` ("2026-10-03T17"). */
export interface ContribRow {
  hour: string;
  kind: ContribKind;
  n: number;
}

/** A credit's key is kept this long; the facts outbox gives up on a job after about 6 minutes. */
const APPLIED_KEEP_MS = 30 * 86_400_000;

/** Counters older than this go: the graph shows the last year. */
const CONTRIB_KEEP_MS = 400 * 86_400_000;

/** A credit's live frame goes out for work of this recent past only (a repository's history does not flash). */
const LIVE_FRAME_MS = 48 * 3_600_000;

/** The person's counts over a window, summed in the viewer's time zone. */
export interface ContribSums {
  /** By day and kind. */
  days: { date: string; kind: ContribKind; n: number }[];
  /** By calendar month, monorepo and kind. */
  months: { month: string; monorepo: string; kind: ContribKind; n: number }[];
}

/** The routes re-read the person's monorepos from the accounts when the index is older than this. */
const RECONCILE_MS = 60_000;

const TRIM_EVERY_MS = 3_600_000;

export interface IndexRow {
  /** The monorepo's id (namespaces). */
  name: string;
  /** Its owner/name, refreshed from the accounts on reconcile and join. */
  label: string | null;
  kind: string | null;
  joined_at: string;
  /** The join's backfill has not landed yet: nothing is covered, pages read its log. */
  pending: boolean;
  large: boolean;
  covered_after: string | null;
  summary: Summary | null;
}

export interface JoinData {
  kind: string;
  /** owner/name. */
  full_name?: string;
  large: boolean;
  /** The latest activity events, newest first. */
  events: FeedEvent[];
  /** True when `events` is the monorepo's whole history. */
  complete: boolean;
  summary: Summary;
}

export interface WindowPage {
  events: FeedEvent[];
  /** Large monorepos (read from their logs on every page), with their last activity. */
  large: { name: string; label: string | null; last: string | null }[];
  /** Small monorepos the window may not fully cover for this page; `after` is where coverage starts. */
  uncovered: { name: string; label: string | null; after: string; last: string | null }[];
  /** Only for `only`: false when none of them is in the index. */
  known: boolean;
  /** The index is old or never made: re-read the person's monorepos from the accounts and reconcile. */
  need_list: boolean;
}

export class FeedObject extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
    // Namespaces: rows key on the monorepo's id; its owner/name is kept beside it for display.
    const cols = this.rows<{ name: string }>("PRAGMA table_info(monorepos)").map((c) => c.name);

    if (!cols.includes("label")) this.sql.exec("ALTER TABLE monorepos ADD COLUMN label TEXT");
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Rows of a query, typed by the caller to the columns it selects. */
  private rows<T extends Record<string, SqlStorageValue>>(q: string, ...args: SqlStorageValue[]): T[] {
    return this.sql.exec<T>(q, ...args).toArray();
  }

  private row<T extends Record<string, SqlStorageValue>>(q: string, ...args: SqlStorageValue[]): T | null {
    return this.rows<T>(q, ...args)[0] ?? null;
  }

  private get(k: string): string | null {
    return this.row<{ v: string }>("SELECT v FROM state WHERE k = ?", k)?.v ?? null;
  }

  private set(k: string, v: string): void {
    this.sql.exec("INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  private indexRow(r: IndexSqlRow): IndexRow {
    return {
      name: r.name,
      label: r.label,
      kind: r.kind,
      joined_at: r.joined_at,
      pending: r.pending === 1,
      large: r.large === 1,
      covered_after: r.covered_after,
      summary: r.summary ? summaryOf(parseJson(r.summary)) : null,
    };
  }

  /** The index rows, or only those of the monorepos in `only`. */
  private index(only: string[] | null = null): IndexRow[] {
    const among = only === null ? null : JSON.stringify(only);

    return this.rows<IndexSqlRow>(`SELECT ${INDEX_COLUMNS} FROM monorepos WHERE (?1 IS NULL OR name IN (SELECT value FROM json_each(?1))) ORDER BY name`, among).map((r) => this.indexRow(r));
  }

  private indexRowOf(monorepo: string): IndexSqlRow | null {
    return this.row<IndexSqlRow>(`SELECT ${INDEX_COLUMNS} FROM monorepos WHERE name = ?`, monorepo);
  }

  /** A stored pointer back as a line, with its monorepo's label. */
  private lineOf(r: PointerRow, labels: Map<string, string>): FeedEvent | null {
    const p = storedPointerOf(parseJson(r.body));

    return p ? { monorepo_id: r.monorepo, monorepo: labels.get(r.monorepo) ?? r.monorepo, seq: r.seq, at: r.at, ...p } : null;
  }

  // ── The index ────────────────────────────────────────────────────────────

  /**
   * Make the index match the person's monorepos as the accounts list them.
   * New ones get a pending row (the caller queues their joins); gone ones
   * leave. Returns the rows.
   */
  reconcile(list: ListedMonorepo[]): Reconciled {
    const have = new Set(this.rows<{ name: string }>("SELECT name FROM monorepos").map((r) => r.name));
    const want = new Set(list.map((m) => m.name));
    const added: string[] = [];

    for (const m of list) {
      if (have.has(m.name)) {
        // A rename or transfer: only the label changes.
        if (m.label) this.sql.exec("UPDATE monorepos SET label = ? WHERE name = ? AND label IS NOT ?", m.label, m.name, m.label);
        continue;
      }

      this.sql.exec(
        "INSERT INTO monorepos (name, kind, label, joined_at, pending, covered_after) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT (name) DO NOTHING",
        m.name, m.kind, m.label ?? null, now(), PENDING,
      );
      added.push(m.name);
    }

    const removed = [...have].filter((n) => !want.has(n));

    for (const n of removed) this.leave(n);
    this.set("reconciled_at", String(Date.now()));
    this.ensureAlarm();

    return { added, removed, rows: this.index() };
  }

  /** A join's backfill and summary (from the queue consumer, after it checked the accounts). */
  join(monorepo: string, j: JoinData): void {
    const old = this.indexRowOf(monorepo);
    const prev = old ? this.indexRow(old) : null;
    let after: string | null = j.large || j.complete || !j.events.length ? null : j.events[j.events.length - 1].at;

    // A repeated join never shrinks what is covered (null covers everything).
    if (prev && !prev.pending && !prev.large && !j.large) {
      if (prev.covered_after === null || (after !== null && prev.covered_after < after)) after = prev.covered_after;
    }

    if (prev?.summary && prev.summary.at > j.summary.at) j.summary = prev.summary;
    this.sql.exec(
      `INSERT INTO monorepos (name, kind, label, joined_at, pending, covered_after, large, summary, summary_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, label = COALESCE(excluded.label, label), pending = 0, covered_after = excluded.covered_after,
         large = excluded.large, summary = excluded.summary, summary_at = excluded.summary_at`,
      monorepo, j.kind, j.full_name ?? null, now(), after, j.large ? 1 : 0, JSON.stringify(j.summary), j.summary.at,
    );

    if (j.large) this.sql.exec("DELETE FROM pointers WHERE monorepo = ?", monorepo);
    else this.store(monorepo, j.events, false);
    const label = this.labelOf(monorepo);
    this.broadcast({ type: "joined", monorepo: label, monorepo_id: monorepo, large: j.large });
    this.broadcast({ type: "summary", monorepo: label, monorepo_id: monorepo, summary: j.summary });
    this.ensureAlarm();
  }

  /** The person left the monorepo, or it was deleted: the index row first, then its pointers. */
  leave(monorepo: string): boolean {
    const label = this.labelOf(monorepo);
    const had = this.sql.exec("DELETE FROM monorepos WHERE name = ?", monorepo).rowsWritten > 0;
    this.sql.exec("DELETE FROM pointers WHERE monorepo = ?", monorepo);

    if (had) this.broadcast({ type: "left", monorepo: label, monorepo_id: monorepo });

    return had;
  }

  /** A monorepo's owner/name as the index last heard it (its id when unknown). */
  private labelOf(monorepo: string): string {
    return this.row<{ label: string | null }>("SELECT label FROM monorepos WHERE name = ?", monorepo)?.label ?? monorepo;
  }

  /** Labels for many lines at once. */
  private labels(): Map<string, string> {
    return new Map(this.rows<{ name: string; label: string | null }>("SELECT name, label FROM monorepos").map((r) => [r.name, r.label ?? r.name]));
  }

  // ── Writes from the queue ────────────────────────────────────────────────

  /** Event lines fanned out by the consumer, one call per feed per batch. Lines of monorepos not in the index (or large) are dropped. */
  addEvents(groups: { monorepo: string; events: FeedEvent[] }[]): number {
    let n = 0;

    for (const g of groups) {
      const r = this.row<{ large: number }>("SELECT large FROM monorepos WHERE name = ?", g.monorepo);

      if (!r || r.large) continue;
      n += this.store(g.monorepo, g.events, true);
    }

    if (n) this.ensureAlarm();

    return n;
  }

  /** Insert or refresh pointers (unique on (monorepo, seq)); live frames when asked. */
  private store(monorepo: string, events: FeedEvent[], live: boolean): number {
    let landed = Number(this.get("landed") ?? 0);
    let n = 0;
    const label = live ? this.labelOf(monorepo) : "";

    for (const e of events) {
      // The label is not stored: a rename changes the index row only.
      const { monorepo_id: _i, monorepo: _m, seq, at, ...rest } = e;
      const body = JSON.stringify(rest satisfies StoredPointer);
      const next = landed + 1;

      const wrote = this.sql.exec(
        "INSERT OR IGNORE INTO pointers (monorepo, seq, at, landed, body) VALUES (?, ?, ?, ?, ?)", monorepo, seq, at, next, body,
      ).rowsWritten > 0;

      let mine = next;

      if (wrote) {
        landed = next;
        n++;
      } else {
        // A repeat (at-least-once delivery) or a refresh (a push's summary): keep its landed number.
        const old = this.row<{ landed: number; body: string }>("SELECT landed, body FROM pointers WHERE monorepo = ? AND seq = ?", monorepo, seq)!;
        mine = old.landed;

        if (old.body === body) continue;
        this.sql.exec("UPDATE pointers SET body = ? WHERE monorepo = ? AND seq = ?", body, monorepo, seq);
      }

      if (live) this.broadcast({ type: "event", landed: mine, event: { monorepo_id: monorepo, monorepo: label, seq, at, ...rest } });
    }

    this.set("landed", String(landed));

    return n;
  }

  /** A monorepo's summary line changed. Older ticks arriving late are dropped. */
  putSummary(monorepo: string, s: Summary, needsChanged: NeedChange[], needsMore: boolean): boolean {
    const old = this.indexRowOf(monorepo);

    if (!old) return false;
    const r = this.indexRow(old);

    if (old.summary_at && old.summary_at > s.at) return false;
    this.sql.exec("UPDATE monorepos SET summary = ?, summary_at = ?, large = ? WHERE name = ?", JSON.stringify(s), s.at, s.large ? 1 : 0, monorepo);

    if (!r.large && s.large) this.sql.exec("DELETE FROM pointers WHERE monorepo = ?", monorepo); // read from its log from now on

    if (r.large && !s.large && !r.pending) this.sql.exec("UPDATE monorepos SET covered_after = ? WHERE name = ?", s.at, monorepo); // copied from now on
    const label = r.label ?? monorepo;
    this.broadcast({ type: "summary", monorepo: label, monorepo_id: monorepo, summary: s });

    if (needsChanged.length || needsMore) this.broadcast({ type: "needs", monorepo: label, monorepo_id: monorepo, changed: needsChanged, more: needsMore });

    return true;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /**
   * One page from the window: lines older than `cursor`, newest first, from
   * small monorepos in the index; and which monorepos the routes must read
   * from their logs (large ones always; small ones the window may not cover
   * this far back). `only`: these monorepos only (one, or an owner's).
   */
  page(cursor: Key | null, limit: number, only: string[] | null): WindowPage {
    const reconciled = Number(this.get("reconciled_at") ?? 0);
    const need_list = Date.now() - reconciled > RECONCILE_MS;
    const idx = this.index(only);

    if (only && !idx.length) return { events: [], large: [], uncovered: [], known: false, need_list: true };

    type P = PointerRow;

    let rows: P[];

    if (only?.length === 1) {
      const [one] = only;
      rows = cursor
        ? this.rows<P>(
            `SELECT monorepo, seq, at, body FROM pointers WHERE monorepo = ?1 AND (at < ?2 OR (at = ?2 AND seq < ?3))
             ORDER BY at DESC, seq DESC LIMIT ?4`,
            one, cursor.at, one < cursor.monorepo_id ? Number.MAX_SAFE_INTEGER : one > cursor.monorepo_id ? 0 : cursor.seq, limit,
          )
        : this.rows<P>("SELECT monorepo, seq, at, body FROM pointers WHERE monorepo = ? ORDER BY at DESC, seq DESC LIMIT ?", one, limit);

      if (idx[0].large) rows = [];
    } else {
      // Every small monorepo in the index, or those of `only` (bound first: its ? comes first).
      const among = only ? [JSON.stringify(only)] : [];
      const join = `FROM pointers p JOIN monorepos m ON m.name = p.monorepo AND m.large = 0${only ? " AND m.name IN (SELECT value FROM json_each(?))" : ""}`;
      rows = cursor
        ? this.rows<P>(
            `SELECT p.monorepo, p.seq, p.at, p.body ${join} WHERE (p.at, p.monorepo, p.seq) < (?, ?, ?)
             ORDER BY p.at DESC, p.monorepo DESC, p.seq DESC LIMIT ?`,
            ...among, cursor.at, cursor.monorepo_id, cursor.seq, limit,
          )
        : this.rows<P>(`SELECT p.monorepo, p.seq, p.at, p.body ${join} ORDER BY p.at DESC, p.monorepo DESC, p.seq DESC LIMIT ?`, ...among, limit);
    }

    const labels = this.labels();
    const events: FeedEvent[] = [];

    for (const r of rows) {
      const event = this.lineOf(r, labels);

      if (event) events.push(event);
    }

    const boundary = events.length === limit ? events[limit - 1].at : null;
    const floor = this.get("floor");
    const last = (r: IndexRow) => r.summary?.last_activity_at ?? null;
    const unc: WindowPage["uncovered"] = [];

    for (const r of idx) {
      if (r.large) continue;
      const after = r.pending ? PENDING : effectiveAfter(r.covered_after, floor);

      if (after !== null && uncovered(after, boundary)) unc.push({ name: r.name, label: r.label, after, last: last(r) });
    }

    return { events, large: idx.filter((r) => r.large).map((r) => ({ name: r.name, label: r.label, last: last(r) })), uncovered: unc, known: true, need_list };
  }

  /** The index (for the home's list and needs-you). */
  summaries(): IndexRow[] {
    return this.index();
  }

  // ── Contributions (profile SPEC section 3.2) ─────────────────────────────

  /**
   * Count a credit once: its key is new, so its rows are added; a key seen
   * before (a delivery retried after a lost answer) adds nothing. One
   * synchronous step. Recent work also goes out live as `contributed`.
   * `label`: the monorepo's owner/name for the frame.
   */
  credit(key: string, monorepo: string, label: string, rows: ContribRow[]): boolean {
    const t = Date.now();
    const fresh = this.sql.exec("INSERT OR IGNORE INTO contrib_applied (key, at) VALUES (?, ?)", key, t).rowsWritten > 0;

    if (!fresh) return false;

    for (const r of rows) {
      this.sql.exec(
        "INSERT INTO contrib (hour, monorepo, kind, n) VALUES (?, ?, ?, ?) ON CONFLICT (hour, monorepo, kind) DO UPDATE SET n = n + excluded.n",
        r.hour, monorepo, r.kind, r.n,
      );
    }

    const recent = new Date(t - LIVE_FRAME_MS).toISOString().slice(0, 13);

    for (const r of rows) if (r.hour >= recent) this.broadcast({ type: "contributed", monorepo: label, monorepo_id: monorepo, hour: r.hour, kind: r.kind, n: r.n });
    this.pruneContrib(t);

    return true;
  }

  /** At most once a day: keys past their 30 days and counters past the graph's year go. */
  private pruneContrib(t: number): void {
    if (t - Number(this.get("contrib_pruned_at") ?? 0) < 86_400_000) return;
    this.set("contrib_pruned_at", String(t));
    this.sql.exec("DELETE FROM contrib_applied WHERE at < ?", t - APPLIED_KEEP_MS);
    this.sql.exec("DELETE FROM contrib WHERE hour < ?", new Date(t - CONTRIB_KEEP_MS).toISOString().slice(0, 13));
  }

  /** The monorepos the person has counts in, in the UTC hours `from` to `to` (inclusive). */
  contributedIds(from: string, to: string): string[] {
    return this.rows<{ monorepo: string }>("SELECT DISTINCT monorepo FROM contrib WHERE hour >= ? AND hour <= ?", from, to).map((r) => r.monorepo);
  }

  /**
   * The counts of the UTC hours `from` to `to` (inclusive), in monorepos
   * `only` (the ones the viewer can open), summed by day and by month in the
   * viewer's zone (`tz`: minutes east of UTC).
   */
  contributions(only: string[], tz: number, from: string, to: string): ContribSums {
    const shift = `${tz >= 0 ? "+" : ""}${tz} minutes`;
    const among = JSON.stringify(only);
    const where = "hour >= ?2 AND hour <= ?3 AND monorepo IN (SELECT value FROM json_each(?4))";

    return {
      days: this.rows<{ date: string; kind: ContribKind; n: number }>(
        `SELECT date(hour || ':00:00', ?1) AS date, kind, SUM(n) AS n FROM contrib WHERE ${where} GROUP BY 1, 2 ORDER BY 1`,
        shift, from, to, among,
      ),
      months: this.rows<{ month: string; monorepo: string; kind: ContribKind; n: number }>(
        `SELECT strftime('%Y-%m', hour || ':00:00', ?1) AS month, monorepo, kind, SUM(n) AS n FROM contrib WHERE ${where} GROUP BY 1, 2, 3`,
        shift, from, to, among,
      ),
    };
  }

  /** One day's counts by monorepo and kind (UTC hours `from` to `to`, the day's in the viewer's zone). */
  contributionDay(only: string[], from: string, to: string): { monorepo: string; kind: ContribKind; n: number }[] {
    return this.rows<{ monorepo: string; kind: ContribKind; n: number }>(
      "SELECT monorepo, kind, SUM(n) AS n FROM contrib WHERE hour >= ?1 AND hour <= ?2 AND monorepo IN (SELECT value FROM json_each(?3)) GROUP BY 1, 2",
      from, to, JSON.stringify(only),
    );
  }

  // ── The window ───────────────────────────────────────────────────────────

  /**
   * The hourly trim alarm, set when there are lines and none is pending. Its
   * time is kept here (no getAlarm left running in the background).
   */
  private ensureAlarm(): void {
    if (Number(this.get("trim_at") ?? 0) > Date.now()) return;
    const t = Date.now() + TRIM_EVERY_MS;
    this.set("trim_at", String(t));
    this.ctx.storage.setAlarm(t).catch((err) =>
      console.error("feed: setting the trim alarm failed:", err instanceof Error ? (err.stack ?? err.message) : String(err)),
    );
  }

  async alarm(): Promise<void> {
    this.set("trim_at", "0");
    this.trim();

    // A feed with no lines needs no trimming until lines arrive (ensureAlarm sets it again).
    if (this.row("SELECT 1 AS x FROM pointers LIMIT 1")) this.ensureAlarm();
  }

  /** Keep WINDOW_DAYS of pointers, at most WINDOW_MAX; `floor` remembers the newest `at` dropped. `days`: tests only. */
  trim(days = WINDOW_DAYS): Trimmed {
    let floor = this.get("floor");

    const raise = (t: string | null) => {
      if (t && (floor === null || t > floor)) floor = t;
    };

    const cut = new Date(Date.now() - days * 86_400_000).toISOString();
    let dropped = 0;
    const old = this.row<{ t: string | null; n: number }>("SELECT MAX(at) AS t, COUNT(*) AS n FROM pointers WHERE at < ?", cut);

    if (old?.n) {
      raise(old.t);
      this.sql.exec("DELETE FROM pointers WHERE at < ?", cut);
      dropped += old.n;
    }

    const count = this.row<{ n: number }>("SELECT COUNT(*) AS n FROM pointers")!.n;

    if (count > WINDOW_MAX) {
      const extra = count - WINDOW_MAX;
      raise(this.row<{ at: string }>("SELECT at FROM pointers ORDER BY at, monorepo, seq LIMIT 1 OFFSET ?", extra - 1)?.at ?? null);
      this.sql.exec("DELETE FROM pointers WHERE rowid IN (SELECT rowid FROM pointers ORDER BY at, monorepo, seq LIMIT ?)", extra);
      dropped += extra;
    }

    // Pointers whose monorepo left the index (never shown; reads filter by it).
    this.sql.exec("DELETE FROM pointers WHERE monorepo NOT IN (SELECT name FROM monorepos)");

    if (floor) this.set("floor", floor);

    return { dropped, floor };
  }

  /** Tests only: the index, pointer counts and counters. */
  debugState(): FeedDebug {
    const pointers: FeedDebug["pointers"] = {};

    for (const r of this.rows<{ monorepo: string; n: number }>("SELECT monorepo, COUNT(*) AS n FROM pointers GROUP BY monorepo")) pointers[r.monorepo] = r.n;

    return { index: this.index(), pointers, landed: Number(this.get("landed") ?? 0), floor: this.get("floor") };
  }

  // ── The person's live socket ─────────────────────────────────────────────
  //
  // The client sends {"type":"hello","since":<landed>}; the feed replays the
  // lines that landed after it (at most REPLAY_MAX, else "resync"), then
  // "caught_up". Live frames: event, summary, needs, joined, left. The text
  // "ping" gets "pong" without waking the object.

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ["feed"]);
    server.serializeAttachment({ login: request.headers.get("x-pando-login") ?? "", connected_at: now() });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    const m = isText(msg) ? parseJson(msg) : null;

    if (!isRecord(m) || m.type !== "hello") return this.send(ws, { type: "error", message: 'send {"type":"hello","since":<landed>} (since optional), or the text ping' });
    const head = Number(this.get("landed") ?? 0);
    // A number, or a number as text; anything else is out of range (resync).
    const since = m.since === undefined || m.since === null ? null : isWholeNumber(m.since) ? m.since : isText(m.since) ? Number(m.since) : -1;

    if (since !== null) {
      if (!Number.isSafeInteger(since) || since < 0 || since > head) {
        this.send(ws, { type: "resync", landed: head });
      } else {
        const rows = this.rows<{ monorepo: string; seq: number; at: string; landed: number; body: string }>(
          "SELECT monorepo, seq, at, landed, body FROM pointers WHERE landed > ? ORDER BY landed LIMIT ?", since, REPLAY_MAX + 1,
        );

        if (rows.length > REPLAY_MAX) this.send(ws, { type: "resync", landed: head });
        else {
          const labels = this.labels();

          for (const r of rows) {
            const event = this.lineOf(r, labels);

            if (event) this.send(ws, { type: "event", landed: r.landed, event });
          }
        }
      }
    }

    this.send(ws, { type: "caught_up", landed: head });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(_ws: WebSocket): Promise<void> {}

  private send(ws: WebSocket, frame: PersonFrame): void {
    try {
      ws.send(JSON.stringify(frame satisfies typeof Contract.ActivityFrame.Encoded));
    } catch {
      // closed
    }
  }

  private broadcast(frame: PersonFrame): void {
    const s = JSON.stringify(frame);

    for (const ws of this.ctx.getWebSockets("feed")) {
      try {
        ws.send(s);
      } catch {
        // closed
      }
    }
  }
}
