// Hook deliveries off the queue (C25-LIVE-HOME.md step 3, Shape O): the
// delivery rows the monorepo object already keeps are the outbox. A row is
// written in the same step as the change; the object hands due rows at once to
// the HooksDrain Worker entrypoint (hooks.ts) by RPC, which POSTs and answers
// each result; the object records it. The alarm is only the retry timer
// (10 s, 60 s, 5 min, 30 min, then dead). pando-hooks measured p50 1.2 s and
// up to 4.5 s in the queue alone at one push every 5 s.
//
// Each delivery is its own call, so a slow receiver holds only itself. A row
// handed to a call is leased (`sent_at`), so concurrent drains never send it
// twice. If the object
// dies mid-drain, the lease runs out and the alarm sends the row again:
// deliveries stay at least once, and payloads carry `seq` for receivers.

import type { Env } from "../env";
import { now } from "../http";
import { released } from "../timing";
import { pool } from "./views";
import { RETRY_DELAYS_S, type AttemptResult, type HookRow, type StoredPayload } from "./hooks";
import type { ObjectInfo } from "./types";

type Row = Record<string, SqlStorageValue>;

/** Calls in flight at once, one delivery each (a slow receiver holds its own call only). */
const CALLS_AT_ONCE = 20;
/** Rows handed out per round; the rest go in the next. */
const ROUND_MAX = 60;
/** A handed-out row is sent again after this if no answer came (a POST times out after 10 s). */
export const LEASE_MS = 60_000;

/** One delivery for the drain: everything it needs, so it never calls back. */
export interface HookJob {
  monorepo: string;
  delivery_id: string;
  hook: HookRow;
  payload: StoredPayload;
  artifacts_name: string;
  /** Main's head as recorded, for the merge base (null: unknown). */
  main: string | null;
  /** This try's number in its round (1 = first; redeliver starts a new round). */
  attempt: number;
  /** When the row became due (ms): written, or its retry time. */
  due: number;
}

export type HookResult = AttemptResult & { ms: number };

export class HooksOut {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
    private sql: SqlStorage,
    private info: () => ObjectInfo | null,
    /** The object's one alarm, shared with the feed's and the facts' outboxes. */
    private armAt: (t: number) => void,
    private repoOf: (name: string) => { artifacts_name: string } | null,
    private mainOf: (repo: string) => string | null,
    private keptAttempts: number,
  ) {}

  /** `tries`: the tries in the current round (attempts counts them all). */
  ensureSchema(): void {
    const cols = this.rows<{ name: string }>("PRAGMA table_info(deliveries)").map((c) => c.name);
    if (!cols.includes("tries")) {
      this.sql.exec("ALTER TABLE deliveries ADD COLUMN tries INTEGER NOT NULL DEFAULT 0");
      // Rows the queue was retrying keep their place in the schedule.
      this.sql.exec("UPDATE deliveries SET tries = attempts WHERE status = 'retrying'");
    }
  }

  private rows<T>(q: string, ...args: unknown[]): T[] {
    return this.sql.exec<Row>(q, ...args).toArray() as unknown as T[];
  }

  private delays(): number[] {
    const v = this.env.HOOK_RETRY_DELAYS?.split(",").map((x) => Number(x.trim()));
    return v && v.length && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 43_200) ? v : RETRY_DELAYS_S;
  }

  /** Send what is due, after this turn (rows written together go out together). */
  private kicked = false;
  kick(): void {
    if (this.kicked) return;
    this.kicked = true;
    this.ctx.waitUntil(
      Promise.resolve().then(() => {
        this.kicked = false;
        return this.sendDue();
      }),
    );
  }

  /** Make rows due now (redeliver, replay): a new round of tries. */
  requeue(ids: string[]): void {
    const at = now();
    for (const id of ids) {
      this.sql.exec("UPDATE deliveries SET status = 'queued', tries = 0, next_attempt_at = ?, sent_at = NULL WHERE id = ?", at, id);
    }
    if (ids.length) this.kick();
  }

  /** Lease up to `limit` due rows and build their jobs (rows whose hook or repo is gone are closed). */
  private take(limit: number): { jobs: HookJob[]; lease: string } {
    const m = this.info();
    const lease = now();
    if (!m) return { jobs: [], lease };
    const expired = new Date(Date.now() - LEASE_MS).toISOString();
    const due = this.rows<{ id: string; hook_id: string; repo: string; payload: string; tries: number; created_at: string; next_attempt_at: string | null }>(
      `SELECT id, hook_id, repo, payload, tries, created_at, next_attempt_at FROM deliveries
       WHERE status IN ('queued', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND (sent_at IS NULL OR sent_at <= ?)
       ORDER BY created_at, rowid LIMIT ?`,
      lease, expired, limit,
    );
    const jobs: HookJob[] = [];
    const mains = new Map<string, string | null>();
    for (const d of due) {
      const hook = this.rows<HookRow>("SELECT * FROM hooks WHERE id = ?", d.hook_id)[0];
      const repo = this.repoOf(d.repo);
      if (!hook || !repo) {
        this.sql.exec("UPDATE deliveries SET status = 'dead', next_attempt_at = NULL, sent_at = NULL, error = ? WHERE id = ?", "its hook or repo was deleted", d.id);
        continue;
      }
      this.sql.exec("UPDATE deliveries SET sent_at = ? WHERE id = ?", lease, d.id);
      if (!mains.has(d.repo)) mains.set(d.repo, this.mainOf(d.repo));
      const payload = JSON.parse(d.payload) as StoredPayload;
      payload.monorepo_id ??= m.id; // rows from before namespaces
      jobs.push({
        monorepo: m.id, delivery_id: d.id, hook, payload, artifacts_name: repo.artifacts_name, main: mains.get(d.repo) ?? null,
        attempt: d.tries + 1, due: Date.parse(d.next_attempt_at ?? d.created_at),
      });
    }
    if (jobs.length) this.armAt(Date.now() + LEASE_MS + 1_000);
    return { jobs, lease };
  }

  /** Hand out every due row, one per call, CALLS_AT_ONCE side by side. Never rejects. */
  async sendDue(): Promise<void> {
    try {
      for (let round = 0; round < 20; round++) {
        const { jobs, lease } = this.take(ROUND_MAX);
        if (!jobs.length) return;
        await pool(jobs, CALLS_AT_ONCE, (j) => this.drain([j], lease));
      }
    } catch (err) {
      console.error("hooks: draining the outbox failed; the alarm retries:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
  }

  private async drain(jobs: HookJob[], lease: string): Promise<void> {
    let results: HookResult[];
    try {
      results = released(await this.ctx.exports.HooksDrain.run(jobs));
    } catch (err) {
      const error = `the delivery call failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
      results = jobs.map(() => ({ ok: false, code: null, error, ms: 0 }));
    }
    jobs.forEach((j, i) => this.record(j, results[i] ?? { ok: false, code: null, error: "no answer", ms: 0 }, lease));
  }

  /** One try's result: delivered, retrying (its next time on the alarm), or dead after the last. */
  private record(j: HookJob, r: HookResult, lease: string): void {
    if (!this.rows("SELECT id FROM deliveries WHERE id = ?", j.delivery_id).length) return; // trimmed, or the monorepo is gone
    const at = now();
    this.sql.exec(
      "INSERT INTO delivery_attempts (delivery_id, n, at, response_code, error, ms) VALUES (?, ?, ?, ?, ?, ?)",
      j.delivery_id, j.attempt, at, r.code, r.error, r.ms,
    );
    this.sql.exec(
      `DELETE FROM delivery_attempts WHERE delivery_id = ? AND rowid NOT IN
       (SELECT rowid FROM delivery_attempts WHERE delivery_id = ? ORDER BY rowid DESC LIMIT ?)`,
      j.delivery_id, j.delivery_id, this.keptAttempts,
    );
    const retryIn = r.ok ? null : (this.delays()[j.attempt - 1] ?? null);
    const status = r.ok ? "delivered" : retryIn === null ? "dead" : "retrying";
    const next = retryIn === null ? null : Date.now() + retryIn * 1000;
    // Only while the lease is ours: a redeliver meanwhile starts its own round.
    this.sql.exec(
      `UPDATE deliveries SET status = ?, attempts = attempts + 1, tries = ?, response_code = ?, error = ?, last_attempt_at = ?,
         next_attempt_at = ?, sent_at = NULL WHERE id = ? AND sent_at = ?`,
      status, j.attempt, r.code, r.ok ? null : r.error, at, next === null ? null : new Date(next).toISOString(), j.delivery_id, lease,
    );
    if (next !== null) this.armAt(next);
  }

  /** The object's alarm: send what is due (retries, expired leases), then arm for the next. */
  async alarm(): Promise<void> {
    if (!this.info()) return;
    await this.sendDue();
    const live = "status IN ('queued', 'retrying')";
    const retry = this.rows<{ t: string | null }>(`SELECT MIN(next_attempt_at) AS t FROM deliveries WHERE ${live} AND next_attempt_at > ?`, now())[0]?.t;
    const leased = this.rows<{ t: string | null }>(`SELECT MIN(sent_at) AS t FROM deliveries WHERE ${live} AND sent_at IS NOT NULL`)[0]?.t;
    const times = [retry ? Date.parse(retry) : Infinity, leased ? Date.parse(leased) + LEASE_MS + 1_000 : Infinity];
    const t = Math.min(...times);
    if (t < Infinity) this.armAt(t);
  }
}
