// A merge into the meta layer reaches the live files through this outbox
// (concurrency CODE-VS-MODEL M2). The row is written in the same step as the
// merge's record. The drain hands the rows to the meta layer object in
// order, so a later merge never reaches machines before an earlier one. A
// failed try is tried again after 1 s, 5 s and 30 s, then every 5 minutes
// until it is done: git main has the merge, so the live files must get it
// too. The meta layer object keeps the commits it applied, so a try sent
// again after a lost answer applies nothing twice.

import type { Identity } from "./types";

export const META_APPLY_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta_apply (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, merge TEXT NOT NULL,
  before TEXT, commit_sha TEXT, who TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, error TEXT)`;

/** Waits after each failed try; the last repeats. */
const RETRY_MS = [1_000, 5_000, 30_000, 300_000];

/** Who merged, for the versions the merge makes on the live files. */
export type MergedBy = Pick<Identity, "login" | "name" | "email">;

/** One row: a landed merge to apply to the live files. */
export interface MetaApplyRow {
  id: number;
  kind: "apply";
  merge: string;
  before: string;
  commit_sha: string;
  who: MergedBy;
}

type StoredRow = { id: number; kind: string; merge: string; before: string; commit_sha: string; who: string; attempts: number; next_at: number };

export class MetaApplyOut {
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private sql: SqlStorage,
    /** Apply one row (applyToMetaLayer); throws when it did not. */
    private run: (row: MetaApplyRow) => Promise<void>,
    /** The object's one alarm (feed/out.ts armAt). */
    private armAt: (t: number) => void,
  ) {}

  ensureSchema(): void {
    this.sql.exec(META_APPLY_SCHEMA);
  }

  /** A merge landed on the meta layer's main: its update of the live files, written in the caller's step. */
  landed(merge: string, before: string, commit: string, who: Identity): void {
    const by: MergedBy = { login: who.login, name: who.name, email: who.email };
    this.sql.exec(
      "INSERT INTO meta_apply (kind, merge, before, commit_sha, who, next_at) VALUES ('apply', ?, ?, ?, ?, ?)",
      merge, before, commit, JSON.stringify(by), Date.now(),
    );
  }

  /** Drain what is due, in order. Each call drains after the one before it ends. Never rejects. */
  flush(): Promise<void> {
    this.flushing = this.flushing
      .then(() => this.drain())
      .catch((err) => console.error("meta apply: the drain failed:", err instanceof Error ? err.message : String(err)));

    return this.flushing;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const row = this.sql.exec<StoredRow>("SELECT * FROM meta_apply ORDER BY id LIMIT 1").toArray()[0];

      if (!row) return;

      // The first row not due yet holds the rest back: merges reach machines in order.
      if (row.next_at > Date.now()) {
        this.armAt(row.next_at);

        return;
      }

      try {
        // SAFETY: landed() is the only writer of who, always JSON.stringify of a MergedBy.
        await this.run({ id: row.id, kind: "apply", merge: row.merge, before: row.before, commit_sha: row.commit_sha, who: JSON.parse(row.who) as MergedBy });
      } catch (err) {
        this.retry(row, err instanceof Error ? err.message : String(err));

        return;
      }

      this.sql.exec("DELETE FROM meta_apply WHERE id = ?", row.id);
    }
  }

  private retry(row: StoredRow, error: string): void {
    const attempts = row.attempts + 1;
    const at = Date.now() + RETRY_MS[Math.min(attempts, RETRY_MS.length) - 1];
    this.sql.exec("UPDATE meta_apply SET attempts = ?, next_at = ?, error = ? WHERE id = ?", attempts, at, error.slice(0, 500), row.id);
    this.armAt(at);
    console.error(`meta apply: merge ${row.commit_sha} not on the live files yet (try ${attempts}, again in ${at - Date.now()} ms): ${error}`);
  }

  /** The object's alarm: drain what is due, and keep the alarm for the rest. */
  async alarm(): Promise<void> {
    if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM meta_apply").one().n > 0) await this.flush();
  }
}
