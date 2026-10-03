// The monorepo object's side of the activity feed (C25). One instance lives in
// each MonorepoObject and shares its SQLite and its alarm. It:
// - marks activity events in the log as they are published (the `feed`
//   column holds the event's feed line; an index on (at, seq) serves pages
//   and backfills);
// - copies them to members' feeds when the monorepo has FANOUT_MAX members
//   or fewer (pushes wait for the branch-facts job, which adds the commit
//   count and head title), through an outbox: the row is written in the same
//   step as the event, drained at once by one RPC into the FeedDrain Worker
//   entrypoint (ctx.exports), which writes the feeds; the alarm is only the
//   retry timer (C25-LIVE-HOME.md);
// - keeps the member list the queue consumer last read from the accounts;
// - keeps presence from the follower sockets' hello;
// - sends the monorepo's summary line, coalesced, at most every 10 s (60 s
//   when large), only when it changed;
// - answers needs-you from stored branch facts.
// It never calls Artifacts or another object; the Worker does the fan-out.

import type { Env } from "../env";
import { now } from "../http";
import { released } from "../timing";
import { combine } from "../monorepo/checks";
import { ZERO } from "../monorepo/names";
import type { ObjectInfo, StatusRecord, StreamEvent } from "../monorepo/types";
import {
  FANOUT_MAX, HELLO_WORKTREES_MAX, MEMBERS_INLINE_MAX, nameOf, seqBound, TICK_LARGE_MS, TICK_SMALL_MS,
  type FeedEvent, type FeedMessage, type Key, type NeedChange, type NeedRow, type NeedState, type StoredPointer, type Summary,
} from "./shape";

type Row = Record<string, SqlStorageValue>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS feed_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS feed_members (login TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS feed_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS feed_presence (sid TEXT PRIMARY KEY, login TEXT, machine TEXT NOT NULL, worktrees TEXT NOT NULL, at TEXT NOT NULL);
`;

const OUTBOX_BATCH = 100;
/** Lines a reconnecting `feed` socket gets before it is told to refetch. */
const REPLAY_LINES = 500;
/** A failed drain is tried again after these delays; after the last, the row is dead (kept DEAD_KEEP_MS). */
const RETRY_MS = [1_000, 5_000, 30_000, 300_000];
const DEAD_KEEP_MS = 7 * 86_400_000;
/** Set with each outbox row, in the same step: if the object dies mid-drain, its alarm drains again this soon. */
const SAFETY_MS = 5_000;
const EVENTS_PER_MESSAGE = 50;
const WORKTREE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Outbox entries: an event line to copy, or a summary tick. */
type Outgoing =
  | { t: "event"; event: FeedEvent }
  | { t: "summary"; summary: Summary; needs_changed: NeedChange[]; needs_more: boolean };

/** Log a background failure with its stack (a promise left unhandled shows only "internal error"). */
function logged(what: string): (err: unknown) => void {
  return (err) => console.error(`feed: ${what} failed:`, err instanceof Error ? (err.stack ?? err.message) : String(err));
}

export class FeedOut {
  /** The one flush in progress, if any (single flight: two flushes would send the same rows twice). */
  private flushing: Promise<void> | null = null;

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
    private sql: SqlStorage,
    private info: () => ObjectInfo | null,
  ) {}

  /** The monorepo's id: the key of its lines and messages. */
  private monorepo(): string | null {
    return this.info()?.id ?? null;
  }

  /** Its owner/name, on every line sent out. */
  private label(): string {
    const m = this.info();
    return m?.label ?? m?.id ?? "";
  }

  private rows<T>(q: string, ...args: unknown[]): T[] {
    return this.sql.exec<Row>(q, ...args).toArray() as unknown as T[];
  }

  private row<T>(q: string, ...args: unknown[]): T | null {
    return this.rows<T>(q, ...args)[0] ?? null;
  }

  private get(k: string): string | null {
    return this.row<{ v: string }>("SELECT v FROM feed_state WHERE k = ?", k)?.v ?? null;
  }

  private set(k: string, v: string | null): void {
    if (v === null) this.sql.exec("DELETE FROM feed_state WHERE k = ?", k);
    else this.sql.exec("INSERT INTO feed_state (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  ensureSchema(): void {
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
    const ecols = this.rows<{ name: string }>("PRAGMA table_info(events)").map((c) => c.name);
    if (!ecols.includes("feed")) this.sql.exec("ALTER TABLE events ADD COLUMN feed TEXT");
    if (!ecols.includes("feed_wait")) this.sql.exec("ALTER TABLE events ADD COLUMN feed_wait INTEGER");
    this.sql.exec("CREATE INDEX IF NOT EXISTS events_feed ON events (at, seq) WHERE feed IS NOT NULL");
    // The order lines went out on the `feed` topic (a push goes out after its facts job, not in seq order).
    if (!ecols.includes("feed_n")) this.sql.exec("ALTER TABLE events ADD COLUMN feed_n INTEGER");
    this.sql.exec("CREATE INDEX IF NOT EXISTS events_feed_n ON events (feed_n) WHERE feed_n IS NOT NULL");
    const bcols = this.rows<{ name: string }>("PRAGMA table_info(branches)").map((c) => c.name);
    // The credential (machine) that last pushed the branch (C25, item 4).
    if (!bcols.includes("pushed_machine")) this.sql.exec("ALTER TABLE branches ADD COLUMN pushed_machine TEXT");
    const ocols = this.rows<{ name: string }>("PRAGMA table_info(feed_outbox)").map((c) => c.name);
    for (const [col, type] of [["attempts", "INTEGER NOT NULL DEFAULT 0"], ["next_at", "INTEGER"], ["dead_at", "INTEGER"], ["error", "TEXT"]]) {
      if (!ocols.includes(col)) this.sql.exec(`ALTER TABLE feed_outbox ADD COLUMN ${col} ${type}`);
    }
    if (!this.get("marked")) this.markOld();
  }

  private retryMs(): number[] {
    const t = (this.env.FEED_RETRY_MS ?? "").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
    return t.length ? t : RETRY_MS;
  }

  /** Once: give events logged before the feed existed their feed lines (no push summaries, every status counted). */
  private markOld(): void {
    const old = this.rows<{ seq: number; at: string; kind: string; body: string }>(
      `SELECT seq, at, kind, body FROM events WHERE feed IS NULL AND kind IN ('push','branch.opened','branch.deleted','merged','review','status','worktree.reported','worktree.removed','meta.saved')`,
    );
    for (const r of old) {
      let e: StreamEvent;
      try {
        e = { ...JSON.parse(r.body), kind: r.kind } as StreamEvent;
      } catch {
        continue;
      }
      const p = this.pointerOf(e, true);
      if (p) this.sql.exec("UPDATE events SET feed = ?, feed_wait = 0 WHERE seq = ?", JSON.stringify(p), r.seq);
    }
    this.set("marked", now());
  }

  // ── Members (read from the accounts by the queue consumer, on each join or leave) ──

  fanoutMax(): number {
    const n = Number(this.env.FEED_FANOUT_MAX);
    return Number.isInteger(n) && n > 0 ? n : FANOUT_MAX;
  }

  members(): string[] {
    return this.rows<{ login: string }>("SELECT login FROM feed_members ORDER BY login").map((r) => r.login);
  }

  private memberCount(): number {
    return this.row<{ n: number }>("SELECT COUNT(*) AS n FROM feed_members")!.n;
  }

  isLarge(): boolean {
    return this.memberCount() > this.fanoutMax();
  }

  setMembers(logins: string[]): void {
    const wasLarge = this.isLarge();
    const before = this.memberCount();
    this.sql.exec("DELETE FROM feed_members");
    for (const l of new Set(logins)) this.sql.exec("INSERT INTO feed_members (login) VALUES (?)", l);
    this.set("members_at", now());
    // Crossing the split changes how every member's feed reads this monorepo: tell them now, not in 60 s.
    if (wasLarge !== this.isLarge()) this.scheduleSummary(true);
    else if (before !== logins.length) this.scheduleSummary();
  }

  // ── Activity: marking, and copying to feeds ──────────────────────────────

  /** Called by publish() after each event is written; returns its feed line, if it is activity. Never throws. */
  onPublish(seq: number, at: string, e: StreamEvent): StoredPointer | null {
    try {
      const p = this.pointerOf(e, false);
      if (p) {
        // A push waits for the branch-facts job (feedPush) to add its commit count and head title.
        const wait = e.kind === "push" || e.kind === "branch.opened" ? 1 : 0;
        this.sql.exec("UPDATE events SET feed = ?, feed_wait = ? WHERE seq = ?", JSON.stringify(p), wait, seq);
        this.set("last_activity_at", at);
        if (!wait) this.emit({ monorepo_id: this.monorepo() ?? "", monorepo: this.label(), seq, at, ...p });
        this.scheduleSummary();
        return p;
      } else if (e.collection === "branches" || e.collection === "statuses" || e.collection === "default_heads") {
        this.scheduleSummary(); // needs-you may have changed (facts stored, main moved)
      }
    } catch (err) {
      console.error("feed: marking an event failed:", err instanceof Error ? err.message : String(err));
    }
    return null;
  }

  /** The branch-facts job's summary for a push (commit count, head title): the event goes out now. */
  push(seq: number, summary: Record<string, unknown>): boolean {
    const r = this.row<{ at: string; feed: string | null; feed_wait: number | null }>("SELECT at, feed, feed_wait FROM events WHERE seq = ?", seq);
    if (!r?.feed || !r.feed_wait) return false; // unknown, or already sent
    const p = JSON.parse(r.feed) as StoredPointer;
    p.summary = { ...(p.summary ?? {}), ...summary };
    this.sql.exec("UPDATE events SET feed = ?, feed_wait = 0 WHERE seq = ?", JSON.stringify(p), seq);
    this.emit({ monorepo_id: this.monorepo() ?? "", monorepo: this.label(), seq, at: r.at, ...p });
    return true;
  }

  /** A feed line: to sockets on this monorepo's `feed` topic now, and to members' feeds through the outbox. */
  private emit(event: FeedEvent): void {
    // Numbered in the order lines go out, so a socket that reconnects with feed_since=<n> misses none.
    const n = this.feedHead() + 1;
    this.set("feed_n", String(n));
    this.sql.exec("UPDATE events SET feed_n = ? WHERE seq = ?", n, event.seq);
    const frame = JSON.stringify({ type: "feed", n, event });
    for (const ws of this.ctx.getWebSockets("feed")) {
      try {
        ws.send(frame);
      } catch {
        // closed
      }
    }
    // Large monorepos are read on demand (fan-in); members unknown means no feed has joined yet.
    if (this.isLarge() || !this.get("members_at")) return;
    this.queue({ t: "event", event });
  }

  /** The number of the last line sent on the `feed` topic (0 when none). */
  feedHead(): number {
    return Number(this.get("feed_n") ?? 0);
  }

  /**
   * A socket on the `feed` topic that asked for `feed_since=<n>`: the lines sent after n, in the order they went
   * out (at most REPLAY_MAX; more, or an n this monorepo never reached, gets `feed_resync`: refetch the log).
   */
  replay(ws: WebSocket, sinceParam: string | null): void {
    if (sinceParam === null || sinceParam === "") return;
    const head = this.feedHead();
    const since = Number(sinceParam);
    const resync = () => ws.send(JSON.stringify({ type: "feed_resync", feed_n: head }));
    if (!Number.isSafeInteger(since) || since < 0 || since > head) return resync();
    const rows = this.rows<{ seq: number; at: string; feed: string; feed_n: number }>(
      "SELECT seq, at, feed, feed_n FROM events WHERE feed_n > ? ORDER BY feed_n LIMIT ?", since, REPLAY_LINES + 1,
    );
    if (rows.length > REPLAY_LINES) return resync();
    const id = this.monorepo() ?? "";
    const label = this.label();
    for (const r of rows) ws.send(JSON.stringify({ type: "feed", n: r.feed_n, event: { monorepo_id: id, monorepo: label, seq: r.seq, at: r.at, ...(JSON.parse(r.feed) as StoredPointer) } }));
  }

  /**
   * Add to the outbox, in the same step as the change, with the alarm that
   * drains it if this object dies before it does. `send`: drain after this
   * turn (a burst goes out together); the alarm drains on its own.
   */
  private queue(o: Outgoing, send = true): void {
    this.sql.exec("INSERT INTO feed_outbox (body) VALUES (?)", JSON.stringify(o));
    this.armAt(Date.now() + SAFETY_MS);
    if (send && !this.flushing) this.ctx.waitUntil(Promise.resolve().then(() => this.flush()));
  }

  private dueRows(limit: number): { id: number; body: string; attempts: number }[] {
    return this.rows("SELECT id, body, attempts FROM feed_outbox WHERE dead_at IS NULL AND (next_at IS NULL OR next_at <= ?) ORDER BY id LIMIT ?", Date.now(), limit);
  }

  /** Send the outbox; one flush at a time. Never rejects. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.flushNow()
        .catch((err) => {
          logged("sending the outbox")(err);
          return false;
        })
        .then((ok) => {
          this.flushing = null;
          // A row added while the last round was draining goes now (a failed drain waits for the alarm).
          if (ok && this.monorepo() && this.dueRows(1).length) this.ctx.waitUntil(this.flush());
        });
    }
    return this.flushing;
  }

  /**
   * Drain the outbox: up to 100 due rows at a time, as messages (events in
   * groups of 50 with the member list, summaries one each), in one RPC to the
   * FeedDrain entrypoint. Delivered rows are deleted; failed ones are tried
   * again on RETRY_MS, then kept as dead. False when a drain failed.
   */
  private async flushNow(): Promise<boolean> {
    const name = this.monorepo();
    if (!name) {
      this.sql.exec("DELETE FROM feed_outbox");
      return true;
    }
    for (let round = 0; round < 50; round++) {
      const rows = this.dueRows(OUTBOX_BATCH);
      if (!rows.length) return true;
      const members = this.members();
      const large = this.isLarge();
      const msgs: FeedMessage[] = [];
      const ids: number[][] = [];
      const drop: number[] = [];
      let events: FeedEvent[] = [];
      let eventIds: number[] = [];
      const cut = () => {
        if (events.length && !large) {
          msgs.push({ type: "events", monorepo: name, members, events });
          ids.push(eventIds);
        } else drop.push(...eventIds); // large now: read on demand, nothing to copy
        events = [];
        eventIds = [];
      };
      for (const r of rows) {
        const o = JSON.parse(r.body) as Outgoing;
        if (o.t === "event") {
          events.push(o.event);
          eventIds.push(r.id);
          if (events.length >= EVENTS_PER_MESSAGE) cut();
        } else {
          cut();
          msgs.push({ type: "summary", monorepo: name, members: members.length <= MEMBERS_INLINE_MAX ? members : null, summary: o.summary, needs_changed: o.needs_changed, needs_more: o.needs_more });
          ids.push([r.id]);
        }
      }
      cut();
      this.deleteRows(drop);
      if (!msgs.length) continue;
      let ok: boolean[];
      let error: string | null = null;
      try {
        await this.testCrash("before");
        if (this.testFail()) throw new Error("feed test: a failed drain");
        const out = released(await this.ctx.exports.FeedDrain.deliver(msgs));
        ok = out.ok;
        error = out.error;
        await this.testCrash("after");
      } catch (err) {
        ok = msgs.map(() => false);
        error = err instanceof Error ? err.message : String(err);
      }
      const done = ids.filter((_, i) => ok[i]).flat();
      const failed = ids.filter((_, i) => !ok[i]).flat();
      this.deleteRows(done);
      if (failed.length) {
        this.retryRows(failed, error ?? "not delivered");
        return false;
      }
    }
    return true; // 50 rounds of 100; the rest goes on the next flush
  }

  private deleteRows(ids: number[]): void {
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      this.sql.exec(`DELETE FROM feed_outbox WHERE id IN (${chunk.map(() => "?").join(",")})`, ...chunk);
    }
  }

  /** Count a failed try on each row: due again after the next delay, or dead after the last. */
  private retryRows(ids: number[], error: string): void {
    const delays = this.retryMs();
    const t = Date.now();
    let next = Infinity;
    for (const id of ids) {
      const r = this.row<{ attempts: number }>("SELECT attempts FROM feed_outbox WHERE id = ?", id);
      if (!r) continue;
      const attempts = r.attempts + 1;
      if (attempts > delays.length) {
        this.sql.exec("UPDATE feed_outbox SET attempts = ?, dead_at = ?, next_at = NULL, error = ? WHERE id = ?", attempts, t, error.slice(0, 500), id);
        console.error(`feed: an outbox row of ${this.monorepo()} is dead after ${attempts} tries: ${error}`);
      } else {
        const at = t + delays[attempts - 1];
        next = Math.min(next, at);
        this.sql.exec("UPDATE feed_outbox SET attempts = ?, next_at = ?, error = ? WHERE id = ?", attempts, at, error.slice(0, 500), id);
      }
    }
    if (next < Infinity) this.armAt(next);
  }

  /** Tests only (FEED_TEST=1): the object dies before or after its drain call. */
  private async testCrash(when: "before" | "after"): Promise<void> {
    if (this.env.FEED_TEST !== "1" || this.get("test_crash") !== when) return;
    this.set("test_crash", null);
    await this.ctx.storage.sync();
    // Let the change's own answer go out first: the crash is after the acknowledgement, mid-drain.
    if (when === "before") await new Promise((r) => setTimeout(r, 200));
    this.ctx.abort(`feed test: the object dies ${when} its drain`);
    // A real crash runs nothing after this point: neither does the old instance here.
    await new Promise<never>(() => {});
  }

  /** Tests only (FEED_TEST=1): the next n drains fail. */
  private testFail(): boolean {
    if (this.env.FEED_TEST !== "1") return false;
    const n = Number(this.get("test_fail") ?? 0);
    if (n <= 0) return false;
    this.set("test_fail", String(n - 1));
    return true;
  }

  /** Tests only: arm a crash or failures, and read the outbox. */
  testOutbox(set: { crash?: "before" | "after"; fail?: number } = {}): { live: number; dead: number; rows: { id: number; attempts: number; next_at: number | null; dead_at: number | null; error: string | null }[] } {
    if (set.crash) this.set("test_crash", set.crash);
    if (set.fail !== undefined) this.set("test_fail", String(set.fail));
    const rows = this.rows<{ id: number; attempts: number; next_at: number | null; dead_at: number | null; error: string | null }>(
      "SELECT id, attempts, next_at, dead_at, error FROM feed_outbox ORDER BY id",
    );
    return { live: rows.filter((r) => r.dead_at === null).length, dead: rows.filter((r) => r.dead_at !== null).length, rows };
  }

  /**
   * The feed line for an event, or null when it is not activity. `old`: an
   * event from before the feed (status changes cannot be told apart).
   */
  private pointerOf(e: StreamEvent, old: boolean): StoredPointer | null {
    const row = (e.row ?? {}) as Record<string, any>;
    let repo = (e.repo as string | null) ?? null;
    let branch: string | null = null;
    let summary: Record<string, unknown> | null = null;
    let actor = (e.actor as string | null) ?? null;
    switch (e.kind) {
      case "push":
      case "branch.opened": {
        if (e.collection === "default_heads") branch = row.default_branch ?? null;
        else if (e.collection === "branches") branch = row.name ?? null;
        else return null;
        const head = (e.head as string | undefined) ?? row.head ?? row.default_head ?? null;
        if (head === ZERO) return null;
        summary = { head, before: e.before && e.before !== ZERO ? e.before : null, commits: null, head_title: null };
        break;
      }
      case "branch.deleted":
        branch = row.name ?? null;
        summary = { before: e.before ?? null };
        break;
      case "merged": {
        const m = (e.merge ?? {}) as Record<string, unknown>;
        branch = row.name ?? null;
        summary = { merge_commit: m.sha ?? row.merge_commit ?? null, forced: m.forced ?? row.forced ?? null, title: row.title ?? null, head: row.head ?? null };
        break;
      }
      case "review":
        branch = row.branch ?? null;
        summary = { verdict: row.verdict ?? null, comments: Array.isArray(row.comments) ? row.comments.length : 0, head: row.head ?? null };
        break;
      case "status": {
        if (!repo || !row.sha || !row.context) return null;
        const runs = this.rows<{ id: number; state: string; created_at: string }>(
          "SELECT id, state, created_at FROM statuses WHERE repo = ? AND sha = ? AND context = ? ORDER BY id DESC LIMIT 200",
          repo, row.sha, row.context,
        );
        // Only a change of state is activity (a CI posting "pending" twice is one line).
        if (!old && runs.length > 1 && runs[1].state === row.state) return null;
        let duration: number | null = null;
        if (row.state !== "pending") {
          // From the first "pending" of this run (after the previous finished state) to now.
          let start: string | null = null;
          for (let i = 1; i < runs.length && runs[i].state === "pending"; i++) start = runs[i].created_at;
          if (start) duration = Math.max(0, Math.round((Date.parse(row.created_at) - Date.parse(start)) / 1000));
        }
        branch = this.row<{ name: string }>(
          "SELECT name FROM branches WHERE repo = ? AND head = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1", repo, row.sha,
        )?.name ?? null;
        // app: the CI service that reported it (null: a member posted it, and `actor` is that member).
        summary = { context: row.context, state: row.state, description: row.description ?? null, target_url: row.target_url ?? null, sha: row.sha, duration_s: duration, app: row.app ?? null };
        break;
      }
      case "worktree.reported":
      case "worktree.removed": {
        // A report of a worktree already known only moves last_seen_at: not activity.
        if (e.kind === "worktree.reported" && !old && row.created_at !== row.last_seen_at) return null;
        const r = this.row<{ name: string }>("SELECT name FROM repos WHERE path = ?", row.repo ?? "");
        repo = r?.name ?? null;
        branch = row.branch ?? null;
        summary = { path: row.path ?? null, worktree: row.id ?? null };
        return { kind: e.kind, repo, repo_path: row.repo ?? null, branch, actor, machine: row.machine ?? (e.machine as string | null) ?? null, summary };
      }
      case "meta.saved":
        // Files a merge brought in are the merge's line already.
        if (row.source === "main") return null;
        actor = actor ?? nameOf(row.author);
        summary = { path: e.key ?? row.path ?? null, version: row.version ?? null, deleted: !!row.deleted };
        break;
      default:
        return null;
    }
    const repo_path = repo === "meta" ? "." : repo ? (this.row<{ path: string }>("SELECT path FROM repos WHERE name = ?", repo)?.path ?? null) : null;
    return { kind: e.kind, repo, repo_path, branch, actor, machine: (e.machine as string | null) ?? null, summary };
  }

  // ── Reads: pages older than a key, and a join's backfill ─────────────────

  /** Activity events older than `cursor` (or the latest), newest first. One indexed read. */
  before(cursor: Key | null, limit: number): FeedEvent[] {
    const name = this.monorepo();
    if (!name) return [];
    const rows = cursor
      ? this.rows<{ seq: number; at: string; feed: string }>(
          "SELECT seq, at, feed FROM events WHERE feed IS NOT NULL AND (at < ?1 OR (at = ?1 AND seq < ?2)) ORDER BY at DESC, seq DESC LIMIT ?3",
          cursor.at, seqBound(cursor, name), limit,
        )
      : this.rows<{ seq: number; at: string; feed: string }>("SELECT seq, at, feed FROM events WHERE feed IS NOT NULL ORDER BY at DESC, seq DESC LIMIT ?", limit);
    const label = this.label();
    return rows.map((r) => ({ monorepo_id: name, monorepo: label, seq: r.seq, at: r.at, ...(JSON.parse(r.feed) as StoredPointer) }));
  }

  // ── Presence: the follower sockets' hello ────────────────────────────────

  /** A follower said which machine it is and which worktrees it holds. Returns the frame to answer with. */
  hello(ws: WebSocket, msg: Record<string, unknown>): Record<string, unknown> {
    const att = (ws.deserializeAttachment() ?? {}) as { sid?: string; login?: string; machine?: string };
    if (!att.sid) return { type: "error", message: "this socket cannot say hello; reconnect" };
    const machine = typeof msg.machine === "string" && msg.machine.trim() ? msg.machine.trim().slice(0, 200) : att.machine;
    if (!machine) return { type: "error", message: "hello needs machine (a string)" };
    const ids = msg.worktrees ?? [];
    if (!Array.isArray(ids) || ids.length > HELLO_WORKTREES_MAX || ids.some((x) => typeof x !== "string" || !WORKTREE_ID.test(x))) {
      return { type: "error", message: `hello.worktrees: at most ${HELLO_WORKTREES_MAX} worktree ids (1 to 64 of A-Z a-z 0-9 _ -)` };
    }
    this.sql.exec(
      `INSERT INTO feed_presence (sid, login, machine, worktrees, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (sid) DO UPDATE SET machine = excluded.machine, worktrees = excluded.worktrees, at = excluded.at`,
      att.sid, att.login ?? null, machine, JSON.stringify([...new Set(ids as string[])]), now(),
    );
    this.scheduleSummary();
    const p = this.presence();
    return { type: "hello_ok", machine, worktrees: (ids as string[]).length, machines_active: p.machines, worktrees_active: p.worktrees };
  }

  /** A socket closed: its machine and worktrees stop counting. */
  gone(ws: WebSocket): void {
    // Sockets of a deleted monorepo close after its storage is gone: nothing to count.
    if (!this.monorepo()) return;
    try {
      const sid = (ws.deserializeAttachment() as { sid?: string } | null)?.sid;
      if (sid && this.sql.exec("DELETE FROM feed_presence WHERE sid = ?", sid).rowsWritten) this.scheduleSummary();
    } catch {
      // no attachment
    }
  }

  /** The ids of open sockets that said hello (for the Machines tab). */
  liveHelloSids(): Set<string> {
    const open = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const sid = (ws.deserializeAttachment() as { sid?: string } | null)?.sid;
        if (sid && ws.readyState === WebSocket.OPEN) open.add(sid);
      } catch {
        // no attachment
      }
    }
    return new Set(this.rows<{ sid: string }>("SELECT sid FROM feed_presence").map((r) => r.sid).filter((s) => open.has(s)));
  }

  /** Machines and worktrees with an open follower socket (rows of sockets gone without a close are dropped). */
  presence(): { machines: number; worktrees: number } {
    const live = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const sid = (ws.deserializeAttachment() as { sid?: string } | null)?.sid;
        if (sid && ws.readyState === WebSocket.OPEN) live.add(sid);
      } catch {
        // no attachment
      }
    }
    const machines = new Set<string>();
    const worktrees = new Set<string>();
    for (const r of this.rows<{ sid: string; machine: string; worktrees: string }>("SELECT sid, machine, worktrees FROM feed_presence")) {
      if (!live.has(r.sid)) {
        this.sql.exec("DELETE FROM feed_presence WHERE sid = ?", r.sid);
        continue;
      }
      machines.add(r.machine);
      for (const id of JSON.parse(r.worktrees) as string[]) worktrees.add(id);
    }
    return { machines: machines.size, worktrees: worktrees.size };
  }

  // ── Needs you: from stored branch facts and statuses ─────────────────────

  /**
   * Open branches that need someone: `conflicts` (the stored dry run for the
   * current head conflicts), `failing` (a check failed on the head), `ready`
   * (facts for the current main and head say clean, and the checks pass).
   * One state per branch, in that order.
   */
  needs(only?: Set<NeedState>): NeedRow[] {
    const repos = new Map(
      this.rows<{ name: string; path: string; default_branch: string; default_head: string | null; required_checks: string | null }>(
        "SELECT name, path, default_branch, default_head, required_checks FROM repos",
      ).map((r) => [r.name, r]),
    );
    const branches = this.rows<{
      repo: string; name: string; head: string; creator: string | null; title: string | null; mergeable: string | null;
      facts_main: string | null; facts_head: string | null; pushed_machine: string | null; updated_at: string | null;
    }>(
      `SELECT repo, name, head, creator, title, mergeable, facts_main, facts_head, pushed_machine, updated_at FROM branches
       WHERE deleted_at IS NULL AND head IS NOT NULL AND (merged_head IS NULL OR merged_head != head)`,
    );
    if (!branches.length) return [];
    const statuses = new Map<string, StatusRecord[]>();
    for (const s of this.rows<StatusRecord & { repo: string }>(
      `SELECT s.repo, s.sha, s.context, s.state, s.target_url, s.description, s.creator, s.app, s.created_at FROM statuses s
       WHERE EXISTS (SELECT 1 FROM branches b WHERE b.repo = s.repo AND b.head = s.sha AND b.deleted_at IS NULL
                     AND (b.merged_head IS NULL OR b.merged_head != b.head))
       ORDER BY s.id`,
    )) {
      const k = `${s.repo}\n${s.sha}`;
      const l = statuses.get(k) ?? [];
      l.push(s);
      statuses.set(k, l);
    }
    const out: NeedRow[] = [];
    for (const b of branches) {
      const r = repos.get(b.repo);
      if (!r || b.name === r.default_branch) continue;
      const required = r.required_checks ? (JSON.parse(r.required_checks) as string[]) : [];
      const checks = combine(b.head, required, statuses.get(`${b.repo}\n${b.head}`) ?? []);
      let state: NeedState | null = null;
      if (b.facts_head === b.head && b.mergeable === "conflicts") state = "conflicts";
      else if (checks.state === "failure" || checks.state === "error") state = "failing";
      else if (b.facts_head === b.head && b.facts_main === r.default_head && r.default_head && b.mergeable === "clean" && checks.state === "success") state = "ready";
      if (!state || (only && !only.has(state))) continue;
      out.push({
        repo: b.repo, repo_path: r.path, branch: b.name, title: b.title, head: b.head, author: b.creator, pushed_machine: b.pushed_machine, state,
        checks: { state: checks.state, failing: checks.statuses.filter((s) => s.state === "failure" || s.state === "error").map((s) => s.context) },
        updated_at: b.updated_at,
      });
    }
    return out.sort((a, b) => ((a.updated_at ?? "") < (b.updated_at ?? "") ? 1 : -1));
  }

  // ── The summary line ─────────────────────────────────────────────────────

  summary(needs: NeedRow[] = this.needs()): Summary {
    let last = this.get("last_activity_at");
    if (!last) last = this.row<{ t: string | null }>("SELECT MAX(at) AS t FROM events WHERE feed IS NOT NULL")?.t ?? null;
    const p = this.presence();
    const counts = { ready: 0, conflicts: 0, failing: 0 };
    for (const n of needs) counts[n.state]++;
    // "2 projects, 5 open branches": counted from the object's own records (no Artifacts call).
    const code = "NOT (r.name = 'meta' AND r.artifacts_name LIKE '%--meta')";
    const repos = this.row<{ n: number }>(`SELECT COUNT(*) AS n FROM repos r WHERE ${code}`)!.n;
    const open = this.row<{ n: number }>(
      `SELECT COUNT(*) AS n FROM branches b JOIN repos r ON r.name = b.repo
       WHERE ${code} AND b.deleted_at IS NULL AND b.head IS NOT NULL AND (b.merged_head IS NULL OR b.merged_head != b.head) AND b.name != r.default_branch`,
    )!.n;
    return {
      last_activity_at: last, worktrees_active: p.worktrees, machines_active: p.machines, needs: counts,
      members: this.memberCount(), large: this.isLarge(), repos, open_branches: open, at: now(),
    };
  }

  private tickMs(): number {
    const t = Number(this.env.FEED_TICK_MS);
    if (Number.isFinite(t) && t > 0) return t;
    return this.isLarge() ? TICK_LARGE_MS : TICK_SMALL_MS;
  }

  /** Ask for a summary tick: at most one per tick interval, coalesced (`now`: send at once). */
  scheduleSummary(soon = false): void {
    const due = Number(this.get("tick_due") ?? 0);
    const next = soon ? Date.now() : Math.max(Date.now(), Number(this.get("tick_last") ?? 0) + this.tickMs());
    if (due && due <= next) return;
    if (!this.monorepo()) return;
    this.set("tick_due", String(next));
    this.armAt(next);
  }

  /**
   * Ask for the object's alarm at `t` unless one of ours is due sooner. The
   * time is kept here, not read back with getAlarm: no storage call is left
   * running in the background. The object's other alarm user (hook
   * re-sends, 30 s) may move it; alarm() then re-arms whatever is still due.
   */
  armAt(t: number): void {
    const cur = Number(this.get("alarm_at") ?? 0);
    if (cur > Date.now() && cur <= t) return;
    this.set("alarm_at", String(t));
    this.ctx.storage.setAlarm(t).catch(logged("setting the alarm"));
  }

  /** The object's alarm, after its own work: a due summary tick, and any outbox left by a failed send. */
  async alarm(): Promise<void> {
    this.set("alarm_at", null);
    if (!this.monorepo()) return;
    const due = Number(this.get("tick_due") ?? 0);
    if (due && due <= Date.now() + 50) this.tick();
    else if (due) this.armAt(due);
    this.sql.exec("DELETE FROM feed_outbox WHERE dead_at IS NOT NULL AND dead_at < ?", Date.now() - DEAD_KEEP_MS);
    if (this.dueRows(1).length) await this.flush();
    const later = this.row<{ t: number | null }>("SELECT MIN(next_at) AS t FROM feed_outbox WHERE dead_at IS NULL AND next_at > ?", Date.now())?.t;
    if (later) this.armAt(later);
  }

  private tick(): void {
    this.set("tick_due", null);
    this.set("tick_last", String(Date.now()));
    if (!this.monorepo()) return;
    const rows = this.needs();
    const s = this.summary(rows);
    const { at: _at, ...same } = s;
    const needsNow: Record<string, NeedState> = {};
    for (const n of rows) needsNow[`${n.repo}\n${n.branch}`] = n.state;
    const needsBefore = JSON.parse(this.get("needs_last") ?? "{}") as Record<string, NeedState>;
    const changed: NeedChange[] = [];
    for (const k of new Set([...Object.keys(needsNow), ...Object.keys(needsBefore)])) {
      if (needsNow[k] === needsBefore[k]) continue;
      const [repo, branch] = k.split("\n");
      changed.push({ repo, branch, state: needsNow[k] ?? null });
    }
    if (JSON.stringify(same) === this.get("summary_last") && !changed.length) return;
    this.set("summary_last", JSON.stringify(same));
    this.set("needs_last", JSON.stringify(needsNow));
    if (!this.get("members_at")) return; // no feed has joined yet
    this.queue({ t: "summary", summary: s, needs_changed: changed.slice(0, 50), needs_more: changed.length > 50 }, false);
  }
}
