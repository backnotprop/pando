// Branch facts off the queue (C25-LIVE-HOME.md step 2, Shape O): the
// monorepo object writes a facts job to its outbox in the same step as the
// push or merge that needs it, and drains it at once with one RPC into the
// FactsDrain Worker entrypoint (facts.ts), which reads Artifacts and writes
// the facts back. The object's alarm is only the retry timer; the object
// never calls Artifacts. pando-branch-facts measured p50 4.6 s and up to 61 s
// in the queue alone; this path is the Worker's own time.

import type { Env } from "../env";
import { released } from "../timing";
import type { FactsMessage } from "./facts";
import type { ObjectInfo } from "./types";

type Row = Record<string, SqlStorageValue>;

export const FACTS_OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS facts_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, created INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER, dead_at INTEGER, error TEXT)`;

/** Jobs per drain call (a branch job is about 1 s of Artifacts reads; the Worker runs 6 at a time). */
const DRAIN_BATCH = 20;

/** A failed job is tried again after these delays; after the last, the row is dead (kept 7 days). */
const RETRY_MS = [5_000, 30_000, 300_000];

const DEAD_KEEP_MS = 7 * 86_400_000;

/** Armed with each row, in the same step: if the object dies mid-drain, its alarm drains again this soon. */
const SAFETY_MS = 5_000;

export type FactsJob = FactsMessage & { created: number };

/** Each kind of message without its monorepo (Omit over a union, kind by kind). */
type WithoutMonorepo<M> = M extends FactsMessage ? Omit<M, "monorepo"> : never;

/** A facts job as the object asks for it: the message without the monorepo, which the outbox adds. */
export type FactsRequest = WithoutMonorepo<FactsMessage>;

/** One outbox row, for the tests. */
type FactsOutboxRow = { attempts: number; next_at: number | null; dead_at: number | null; error: string | null };

/** The outbox as it is (FACTS_TEST): rows still to go, dead rows, and each row. */
export interface FactsOutboxState {
  live: number;
  dead: number;
  rows: FactsOutboxRow[];
}

export class FactsOut {
  /** The one drain in progress (single flight: two would run the same jobs twice). */
  private flushing: Promise<void> | null = null;

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
    private sql: SqlStorage,
    private info: () => ObjectInfo | null,
    /** The object's one alarm, shared with the feed's outbox (feed/out.ts armAt). */
    private armAt: (t: number) => void,
  ) {}

  ensureSchema(): void {
    this.sql.exec(FACTS_OUTBOX_SCHEMA);
  }

  private rows<T extends Row>(q: string, ...args: SqlStorageValue[]): T[] {
    return this.sql.exec<T>(q, ...args).toArray();
  }

  private retryMs(): number[] {
    const t = (this.env.FACTS_RETRY_MS ?? "").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);

    return t.length ? t : RETRY_MS;
  }

  /** A facts job, written in the caller's step; drained after this turn (a burst goes out together). */
  add(m: FactsRequest): void {
    const id = this.info()?.id;

    if (!id) return;
    const job: FactsJob = { ...m, monorepo: id, created: Date.now() };
    this.sql.exec("INSERT INTO facts_outbox (body, created) VALUES (?, ?)", JSON.stringify(job), job.created);
    this.armAt(Date.now() + SAFETY_MS);

    if (!this.flushing) this.ctx.waitUntil(Promise.resolve().then(() => this.flush()));
  }

  private due(limit: number): { id: number; body: string }[] {
    return this.rows<{ id: number; body: string }>("SELECT id, body FROM facts_outbox WHERE dead_at IS NULL AND (next_at IS NULL OR next_at <= ?) ORDER BY id LIMIT ?", Date.now(), limit);
  }

  /** Drain the outbox; one drain at a time. Never rejects. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.flushNow()
        .catch((err) => {
          console.error("facts: draining the outbox failed:", err instanceof Error ? (err.stack ?? err.message) : String(err));

          return false;
        })
        .then((ok) => {
          this.flushing = null;

          // Jobs added while the last round ran go now (a failed round waits for the alarm).
          if (ok && this.info() && this.due(1).length) this.ctx.waitUntil(this.flush());
        });
    }

    return this.flushing;
  }

  private async flushNow(): Promise<boolean> {
    if (!this.info()) {
      this.sql.exec("DELETE FROM facts_outbox");

      return true;
    }

    for (let round = 0; round < 50; round++) {
      const rows = this.due(DRAIN_BATCH);

      if (!rows.length) return true;
      let ok: boolean[];
      let error: string | null = null;

      try {
        if (this.testFail()) throw new Error("facts test: a failed drain");
        // SAFETY: add() is the only writer of facts_outbox.body, always JSON.stringify of a FactsJob.
        const jobs = rows.map((r) => JSON.parse(r.body) as FactsJob);
        const out = released(await this.ctx.exports.FactsDrain.run(jobs));
        ok = out.ok;
        error = out.error;
      } catch (err) {
        ok = rows.map(() => false);
        error = err instanceof Error ? err.message : String(err);
      }

      const done = rows.filter((_, i) => ok[i]).map((r) => r.id);
      const failed = rows.filter((_, i) => !ok[i]).map((r) => r.id);

      for (let i = 0; i < done.length; i += 90) {
        const chunk = done.slice(i, i + 90);
        this.sql.exec(`DELETE FROM facts_outbox WHERE id IN (${chunk.map(() => "?").join(",")})`, ...chunk);
      }

      if (failed.length) {
        this.retry(failed, error ?? "not computed");

        return false;
      }
    }

    return true;
  }

  /** Count a failed try: due again after the next delay, or dead after the last. */
  private retry(ids: number[], error: string): void {
    const delays = this.retryMs();
    const t = Date.now();
    let next = Infinity;

    for (const id of ids) {
      const r = this.rows<{ attempts: number }>("SELECT attempts FROM facts_outbox WHERE id = ?", id)[0];

      if (!r) continue;
      const attempts = r.attempts + 1;

      if (attempts > delays.length) {
        this.sql.exec("UPDATE facts_outbox SET attempts = ?, dead_at = ?, next_at = NULL, error = ? WHERE id = ?", attempts, t, error.slice(0, 500), id);
        console.error(`facts: a job of ${this.info()?.label} is dead after ${attempts} tries: ${error}`);
      } else {
        const at = t + delays[attempts - 1];
        next = Math.min(next, at);
        this.sql.exec("UPDATE facts_outbox SET attempts = ?, next_at = ?, error = ? WHERE id = ?", attempts, at, error.slice(0, 500), id);
      }
    }

    if (next < Infinity) this.armAt(next);
  }

  /** The object's alarm, after the feed's: drain what is due, keep the alarm for the rest. */
  async alarm(): Promise<void> {
    if (!this.info()) return;
    this.sql.exec("DELETE FROM facts_outbox WHERE dead_at IS NOT NULL AND dead_at < ?", Date.now() - DEAD_KEEP_MS);

    if (this.due(1).length) await this.flush();
    const later = this.rows<{ t: number | null }>("SELECT MIN(next_at) AS t FROM facts_outbox WHERE dead_at IS NULL AND next_at > ?", Date.now())[0]?.t;

    if (later) this.armAt(later);
  }

  // ── Tests only (FACTS_TEST=1) ─────────────────────────────────────────────

  private testFails = 0;

  private testFail(): boolean {
    if (this.env.FACTS_TEST !== "1" || this.testFails <= 0) return false;
    this.testFails--;

    return true;
  }

  /** Make the next `fail` drains fail; and the outbox as it is. */
  test(set: { fail?: number } = {}): FactsOutboxState {
    if (this.env.FACTS_TEST === "1" && set.fail !== undefined) this.testFails = set.fail;

    const rows = this.rows<FactsOutboxRow>(
      "SELECT attempts, next_at, dead_at, error FROM facts_outbox ORDER BY id",
    );

    return { live: rows.filter((r) => r.dead_at === null).length, dead: rows.filter((r) => r.dead_at !== null).length, rows };
  }
}
