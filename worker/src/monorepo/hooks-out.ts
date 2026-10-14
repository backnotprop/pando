// Hook deliveries off the queue (C25-LIVE-HOME.md step 3, Shape O): the
// delivery rows the monorepo object already keeps are the outbox. A row is
// written in the same step as the change; the object hands due rows at once to
// the HooksDrain Worker entrypoint (hooks.ts) by RPC, which POSTs and answers
// each result; the object records it. The alarm is only the retry timer
// (10 s, 60 s, 5 min, 30 min, then dead). The pando-hooks queue this replaced
// took p50 1.2 s and up to 4.5 s on its own; through the outbox a hook
// reaches its receiver p50 0.15 s after git push returns (C25-LIVE-HOME.md).
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

/** The lease under HOOKS_TEST=1: longer than hooks.mjs's slow receiver (4 s), short enough to wait for. */
const TEST_LEASE_MS = 6_000;

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

/** A superseded build to cancel: the hook that started it and its number in the pipeline. */
export interface CancelJob {
  delivery_id: string;
  hook: HookRow;
  number: number;
}

/** canceled; finished (Buildkite had nothing to cancel: it was done); or failed, with why. */
export interface CancelResult {
  outcome: "canceled" | "finished" | "failed";
  error: string | null;
}

/** A build cancelled for a newer push: what the object marks (the build's row, the old head's checks). */
export interface Superseded {
  delivery_id: string;
  repo: string;
  /** The head the build was for, and the newer head that replaced it. */
  head: string;
  by: string;
  number: number;
}

/** A newer push on a branch looks back this far for builds to cancel (owner limit: a build older than a day has finished). */
const SUPERSEDE_LOOKBACK_MS = 24 * 3600_000;

/** At most this many earlier deliveries are looked at per push (the burst a branch can have in flight). */
const SUPERSEDE_MAX = 50;

/** Due rows handed out in one step, and the lease they carry. */
interface Taken {
  jobs: HookJob[];
  lease: string;
}

/** The test switch (HOOKS_TEST) as it is, and the lease in force. */
export interface HooksTestState {
  crash: boolean;
  lease_ms: number;
}

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
    /** A build was cancelled for a newer push: the object marks its row and the old head's checks. */
    private onSuperseded: (s: Superseded) => void,
    /** A build Pando knows finished (a CI connection's webhooks said so): nothing to cancel. */
    private buildFinished: (deliveryId: string) => boolean,
  ) {}

  /**
   * `tries`: the tries in the current round (attempts counts them all).
   * A Buildkite delivery keeps the build it made (`build_number`); a newer
   * push sets `superseded_by` and `cancel`: waiting (its answer is not in
   * yet), pending, sending (leased at `cancel_at`), canceled, finished
   * (Buildkite had nothing to cancel) or failed: <why>.
   */
  ensureSchema(): void {
    const cols = this.rows<{ name: string }>("PRAGMA table_info(deliveries)").map((c) => c.name);

    if (!cols.includes("tries")) {
      this.sql.exec("ALTER TABLE deliveries ADD COLUMN tries INTEGER NOT NULL DEFAULT 0");
      // Rows the queue was retrying keep their place in the schedule.
      this.sql.exec("UPDATE deliveries SET tries = attempts WHERE status = 'retrying'");
    }

    for (const [col, type] of [["build_number", "INTEGER"], ["superseded_by", "TEXT"], ["cancel", "TEXT"], ["cancel_at", "TEXT"]]) {
      if (!cols.includes(col)) this.sql.exec(`ALTER TABLE deliveries ADD COLUMN ${col} ${type}`);
    }
  }

  /**
   * A new head on a branch: the hook's earlier builds of the branch are
   * superseded. One not sent yet is never sent; one in flight is cancelled
   * when its answer names its build; one Buildkite took is cancelled now,
   * unless Pando knows it finished. Answers whether one of them was a build
   * a merge asked for (on_merge: the merge still waits, so the new head builds).
   */
  supersede(hookId: string, repo: string, branch: string, head: string): boolean {
    const since = new Date(Date.now() - SUPERSEDE_LOOKBACK_MS).toISOString();

    const earlier = this.rows<{ id: string; status: string; sent_at: string | null; build_number: number | null; for_merge: number | null }>(
      `SELECT id, status, sent_at, build_number, json_extract(payload, '$.for_merge') AS for_merge FROM deliveries
       WHERE hook_id = ? AND repo = ? AND event IN ('push', 'branch.opened') AND superseded_by IS NULL
         AND status IN ('queued', 'retrying', 'delivered') AND created_at > ?
         AND json_extract(payload, '$.branch') = ? AND json_extract(payload, '$.head') != ?
       ORDER BY created_at DESC LIMIT ?`,
      hookId, repo, since, branch, head, SUPERSEDE_MAX,
    );

    let forMerge = false;
    let cancels = false;

    for (const d of earlier) {
      if (d.status !== "delivered" && d.sent_at === null) {
        this.sql.exec("UPDATE deliveries SET status = 'superseded', superseded_by = ?, next_attempt_at = NULL WHERE id = ?", head, d.id);
      } else if (d.status !== "delivered") {
        this.sql.exec("UPDATE deliveries SET superseded_by = ?, cancel = 'waiting' WHERE id = ?", head, d.id);
      } else if (d.build_number !== null && !this.buildFinished(d.id)) {
        this.sql.exec("UPDATE deliveries SET superseded_by = ?, cancel = 'pending' WHERE id = ?", head, d.id);
        cancels = true;
      } else continue; // finished, or no build number to cancel by

      if (d.for_merge === 1) forMerge = true;
    }

    if (cancels) this.kick();

    return forMerge;
  }

  private rows<T extends Row>(q: string, ...args: SqlStorageValue[]): T[] {
    return this.sql.exec<T>(q, ...args).toArray();
  }

  private lease(): number {
    return this.env.HOOKS_TEST === "1" ? TEST_LEASE_MS : LEASE_MS;
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
      // Asked for again: no longer superseded.
      this.sql.exec("UPDATE deliveries SET status = 'queued', tries = 0, next_attempt_at = ?, sent_at = NULL, superseded_by = NULL, cancel = NULL WHERE id = ?", at, id);
    }

    if (ids.length) this.kick();
  }

  /** Lease up to `limit` due rows and build their jobs (rows whose hook or repo is gone are closed). */
  private take(limit: number): Taken {
    const m = this.info();
    const lease = now();

    if (!m) return { jobs: [], lease };
    const expired = new Date(Date.now() - this.lease()).toISOString();
    // A row superseded while in flight whose answer never came: not sent again.
    this.sql.exec(
      `UPDATE deliveries SET status = 'superseded', cancel = NULL, next_attempt_at = NULL, sent_at = NULL
       WHERE status IN ('queued', 'retrying') AND superseded_by IS NOT NULL AND (sent_at IS NULL OR sent_at <= ?)`,
      expired,
    );

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
      // SAFETY: queueDeliveries is the only writer of deliveries.payload, always JSON.stringify of a StoredPayload.
      const payload = JSON.parse(d.payload) as StoredPayload;
      payload.monorepo_id ??= m.id; // rows from before namespaces
      jobs.push({
        monorepo: m.id, delivery_id: d.id, hook, payload, artifacts_name: repo.artifacts_name, main: mains.get(d.repo) ?? null,
        attempt: d.tries + 1, due: Date.parse(d.next_attempt_at ?? d.created_at),
      });
    }

    if (jobs.length) this.armAt(Date.now() + this.lease() + 1_000);

    return { jobs, lease };
  }

  /** Hand out every due row, one per call, CALLS_AT_ONCE side by side; then the cancels due. Never rejects. */
  async sendDue(): Promise<void> {
    try {
      for (let round = 0; round < 20; round++) {
        const { jobs, lease } = this.take(ROUND_MAX);

        if (!jobs.length) break;
        await pool(jobs, CALLS_AT_ONCE, (j) => this.drain([j], lease));
      }

      await this.sendCancels();
    } catch (err) {
      console.error("hooks: draining the outbox failed; the alarm retries:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
  }

  /**
   * Cancel the superseded builds due: one try each (a lost cancel costs one
   * build, never a wrong check). A row leased and not answered within the
   * lease is sent again by the alarm.
   */
  private async sendCancels(): Promise<void> {
    const lease = now();
    const expired = new Date(Date.now() - this.lease()).toISOString();

    const due = this.rows<{ id: string; hook_id: string; repo: string; build_number: number; superseded_by: string; head: string }>(
      `SELECT id, hook_id, repo, build_number, superseded_by, json_extract(payload, '$.head') AS head FROM deliveries
       WHERE cancel = 'pending' OR (cancel = 'sending' AND cancel_at <= ?) LIMIT ?`,
      expired, ROUND_MAX,
    );

    const jobs: CancelJob[] = [];

    for (const d of due) {
      const hook = this.rows<HookRow>("SELECT * FROM hooks WHERE id = ?", d.hook_id)[0];

      if (!hook) {
        this.sql.exec("UPDATE deliveries SET cancel = 'failed: its hook was deleted' WHERE id = ?", d.id);
        continue;
      }

      this.sql.exec("UPDATE deliveries SET cancel = 'sending', cancel_at = ? WHERE id = ?", lease, d.id);
      jobs.push({ delivery_id: d.id, hook, number: d.build_number });
    }

    if (!jobs.length) return;
    this.armAt(Date.now() + this.lease() + 1_000);
    let results: CancelResult[];

    try {
      results = released(await this.ctx.exports.HooksDrain.cancel(jobs));
    } catch (err) {
      results = jobs.map(() => ({ outcome: "failed", error: `the cancel call failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) }));
    }

    jobs.forEach((j, i) => {
      const r = results[i] ?? { outcome: "failed", error: "no answer" };
      const d = due.find((x) => x.id === j.delivery_id)!;
      const word = r.outcome === "failed" ? `failed: ${r.error ?? "unknown"}`.slice(0, 300) : r.outcome;
      const changed = this.sql.exec("UPDATE deliveries SET cancel = ? WHERE id = ? AND cancel = 'sending' AND cancel_at = ?", word, j.delivery_id, lease).rowsWritten;

      if (changed && r.outcome === "canceled") this.onSuperseded({ delivery_id: d.id, repo: d.repo, head: d.head, by: d.superseded_by, number: d.build_number });
    });
  }

  private async drain(jobs: HookJob[], lease: string): Promise<void> {
    let results: HookResult[];

    try {
      results = released(await this.ctx.exports.HooksDrain.run(jobs));

      if (this.crashNext) {
        // Tests only: the receiver has the delivery; the object dies before recording it.
        this.crashNext = false;
        await this.ctx.storage.sync();
        await new Promise((r) => setTimeout(r, 200)); // the push's own answer goes out first
        this.ctx.abort("hooks test: the object dies after a delivery was sent, before its answer is recorded");

        return;
      }
    } catch (err) {
      const error = `the delivery call failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
      results = jobs.map(() => ({ ok: false, code: null, error, ms: 0 }));
    }

    jobs.forEach((j, i) => this.record(j, results[i] ?? { ok: false, code: null, error: "no answer", ms: 0 }, lease));
  }

  /** One try's result: delivered, retrying (its next time on the alarm), or dead after the last. */
  private record(j: HookJob, r: HookResult, lease: string): void {
    if (!this.rows<{ id: string }>("SELECT id FROM deliveries WHERE id = ?", j.delivery_id).length) return; // trimmed, or the monorepo is gone
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
    // A newer push came while this one was in flight: a failure is not tried again, and a build it made is cancelled.
    const superseded = this.rows<{ superseded_by: string | null }>("SELECT superseded_by FROM deliveries WHERE id = ?", j.delivery_id)[0]?.superseded_by ?? null;
    const retryIn = r.ok || superseded ? null : (this.delays()[j.attempt - 1] ?? null);
    const status = r.ok ? "delivered" : superseded ? "superseded" : retryIn === null ? "dead" : "retrying";
    const next = retryIn === null ? null : Date.now() + retryIn * 1000;
    const cancel = superseded ? (r.ok && r.build_number != null ? "pending" : null) : undefined;
    // Only while the lease is ours: a redeliver meanwhile starts its own round.
    this.sql.exec(
      `UPDATE deliveries SET status = ?, attempts = attempts + 1, tries = ?, response_code = ?, error = ?, last_attempt_at = ?,
         next_attempt_at = ?, sent_at = NULL, build_number = COALESCE(?, build_number), cancel = CASE WHEN ? THEN ? ELSE cancel END
       WHERE id = ? AND sent_at = ?`,
      status, j.attempt, r.code, r.ok ? null : r.error, at, next === null ? null : new Date(next).toISOString(), r.build_number ?? null,
      cancel === undefined ? 0 : 1, cancel ?? null, j.delivery_id, lease,
    );

    if (next !== null) this.armAt(next);

    if (cancel === "pending") this.kick();
  }

  /** The object's alarm: send what is due (retries, expired leases), then arm for the next. */
  async alarm(): Promise<void> {
    if (!this.info()) return;
    await this.sendDue();
    const live = "status IN ('queued', 'retrying')";
    const retry = this.rows<{ t: string | null }>(`SELECT MIN(next_attempt_at) AS t FROM deliveries WHERE ${live} AND next_attempt_at > ?`, now())[0]?.t;
    const leased = this.rows<{ t: string | null }>(`SELECT MIN(sent_at) AS t FROM deliveries WHERE ${live} AND sent_at IS NOT NULL`)[0]?.t;
    const times = [retry ? Date.parse(retry) : Infinity, leased ? Date.parse(leased) + this.lease() + 1_000 : Infinity];
    const t = Math.min(...times);

    if (t < Infinity) this.armAt(t);
  }

  // ── Tests only (HOOKS_TEST=1) ─────────────────────────────────────────────

  private crashNext = false;

  /** Make the object die right after the next delivery's call answers, before it is recorded. */
  test(set: { crash?: boolean } = {}): HooksTestState {
    if (this.env.HOOKS_TEST === "1" && set.crash !== undefined) this.crashNext = set.crash;

    return { crash: this.crashNext, lease_ms: this.lease() };
  }
}
