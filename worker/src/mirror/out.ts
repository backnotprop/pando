// Mirror to GitHub, in the monorepo object: the settings, one row per GitHub
// repository (a target), and the outbox that runs them. A change to a main
// marks its target dirty in the same step that records it (one row write,
// however many agents push); the object hands due targets to the MirrorDrain
// entrypoint by RPC, one call each, and records the result. Runs are spaced
// (10 s per GitHub repository, GitHub's 6 pushes a minute; 20 s in whole
// repository mode) and leased, so one GitHub repository never has two runs.

import type { Env } from "../env";
import { now } from "../http";
import { released } from "../timing";
import type { ObjectInfo, RepoRecord, StreamEvent } from "../monorepo/types";
import { pool } from "../monorepo/views";
import { isRecord, isText, parseJson } from "../parse";
import type { GithubRepo } from "./github";
import type { MirrorJob, MirrorMode, MirrorProblem, MirrorResult, MirrorSource, SentHeads } from "./types";

type Row = Record<string, SqlStorageValue>;

/** The whole-repository target's key. */
export const WHOLE = "*";

/** The files outside projects/ (the meta layer's repo). */
export const META = "meta";

const SPACING_MS = 10_000;

const WHOLE_SPACING_MS = 20_000;

const RETRY_MS = [10_000, 60_000, 300_000, 1_800_000];

const HOURLY_MS = 3_600_000;

/** A run not answered in this long is taken again. */
const LEASE_MS = 15 * 60_000;

/** A target that needs a person is tried again on a change at most this often. */
const PERSON_RETRY_MS = 10 * 60_000;

/** Runs at once per repository (the object's six outbound connections). */
const AT_ONCE = 4;

/** The settings row, as the API shows it. */
export interface MirrorSettings {
  installation_id: number;
  account_login: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
  mode: MirrorMode;
  on: boolean;
  started: boolean;
  paused_by: string | null;
  paused_at: string | null;
  connected_by: string;
  connected_at: string;
}

/** One target as stored. */
export type TargetRow = {
  repo: string;
  github_id: number;
  github_full_name: string;
  github_private: number;
  on_: number;
  sent: string;
  composed: string | null;
  problem: string | null;
  dirty_since: number | null;
  dirty_n: number;
  next_at: number | null;
  lease: string | null;
  lease_until: number | null;
  tries: number;
  last_started: number | null;
  last_sha: string | null;
  last_at: string | null;
};

/** A target as the API shows it (before paths and "behind", which the route adds). */
export interface TargetView {
  repo: string;
  on: boolean;
  github: { id: number; full_name: string; private: boolean; url: string };
  state: "off" | "not_started" | "up_to_date" | "waiting" | "paused" | "mirroring" | "retrying" | "no_access" | "not_found" | "refused";
  last: { commit: string; at: string } | null;
  sent: SentHeads;
  waiting_since: string | null;
  next_try_at: string | null;
  problem: { code: MirrorProblem["code"]; message: string; at: string } | null;
}

/** A target to save (Start mirroring, Change, a project's switch). */
export interface TargetInput {
  repo: string;
  github: GithubRepo;
  on: boolean;
}

export class MirrorOut {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
    private sql: SqlStorage,
    private info: () => ObjectInfo | null,
    private armAt: (t: number) => void,
    private repos: () => RepoRecord[],
    private publish: (e: StreamEvent) => number,
  ) {}

  ensureSchema(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS mirror (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mirror_targets (
      repo TEXT PRIMARY KEY, github_id INTEGER NOT NULL, github_full_name TEXT NOT NULL, github_private INTEGER NOT NULL,
      on_ INTEGER NOT NULL DEFAULT 1, sent TEXT NOT NULL DEFAULT '{}', composed TEXT, problem TEXT,
      dirty_since INTEGER, dirty_n INTEGER NOT NULL DEFAULT 0, next_at INTEGER, lease TEXT, lease_until INTEGER,
      tries INTEGER NOT NULL DEFAULT 0, last_started INTEGER, last_sha TEXT, last_at TEXT)`);
  }

  private rows<T extends Row>(q: string, ...args: SqlStorageValue[]): T[] {
    return this.sql.exec<T>(q, ...args).toArray();
  }

  private kv(k: string): string | null {
    return this.rows<{ v: string }>("SELECT v FROM mirror WHERE k = ?", k)[0]?.v ?? null;
  }

  private setKv(k: string, v: string | null): void {
    if (v === null) this.sql.exec("DELETE FROM mirror WHERE k = ?", k);
    else this.sql.exec("INSERT INTO mirror (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  settings(): MirrorSettings | null {
    const inst = Number(this.kv("installation_id"));

    if (!inst) return null;

    return {
      installation_id: inst,
      account_login: this.kv("account_login") ?? "",
      account_type: this.kv("account_type") === "Organization" ? "Organization" : "User",
      repository_selection: this.kv("repository_selection") === "all" ? "all" : "selected",
      mode: this.kv("mode") === "whole" ? "whole" : "projects",
      on: this.kv("paused_at") === null && this.kv("started") === "1",
      started: this.kv("started") === "1",
      paused_by: this.kv("paused_by"),
      paused_at: this.kv("paused_at"),
      connected_by: this.kv("connected_by") ?? "",
      connected_at: this.kv("connected_at") ?? "",
    };
  }

  /** Connect (or change) the GitHub account: a verified installation. Targets of another account go. */
  link(i: { id: number; account_login: string; account_type: "User" | "Organization"; repository_selection: "all" | "selected" }, by: string): void {
    if (Number(this.kv("installation_id")) !== i.id) {
      this.sql.exec("DELETE FROM mirror_targets");
      this.setKv("started", null);
    }

    this.setKv("installation_id", String(i.id));
    this.setKv("account_login", i.account_login);
    this.setKv("account_type", i.account_type);
    this.setKv("repository_selection", i.repository_selection);
    this.setKv("connected_by", by);
    this.setKv("connected_at", now());
    this.changed(null);
  }

  /** Start mirroring, change targets, or switch projects: the mode and the full list of targets. */
  save(mode: MirrorMode, targets: TargetInput[], by: string): void {
    if (!this.settings()) return;
    const was = this.kv("mode");

    if (was && was !== mode) this.sql.exec("DELETE FROM mirror_targets");
    this.setKv("mode", mode);
    const keep = new Set(targets.map((t) => t.repo));

    for (const r of this.rows<{ repo: string }>("SELECT repo FROM mirror_targets")) if (!keep.has(r.repo)) this.sql.exec("DELETE FROM mirror_targets WHERE repo = ?", r.repo);

    for (const t of targets) {
      const had = this.rows<{ github_id: number }>("SELECT github_id FROM mirror_targets WHERE repo = ?", t.repo)[0];

      if (had && had.github_id !== t.github.id) this.sql.exec("DELETE FROM mirror_targets WHERE repo = ?", t.repo);
      this.sql.exec(
        `INSERT INTO mirror_targets (repo, github_id, github_full_name, github_private, on_) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repo) DO UPDATE SET github_full_name = excluded.github_full_name, github_private = excluded.github_private, on_ = excluded.on_`,
        t.repo, t.github.id, t.github.full_name, t.github.private ? 1 : 0, t.on ? 1 : 0,
      );
    }

    if (this.kv("started") !== "1") {
      this.setKv("started", "1");
      this.setKv("paused_at", null);
      this.setKv("paused_by", null);
    }

    void by;
    this.dirtyAll();
  }

  /** The section's switch: off pauses (rows stay), on sends everything in one run per target. */
  setOn(on: boolean, by: string): void {
    if (!this.settings()?.started) return;
    this.setKv("paused_at", on ? null : now());
    this.setKv("paused_by", on ? null : by);

    if (on) this.dirtyAll();
    else this.changed(null);
  }

  pending(): string | null {
    return this.kv("pending");
  }

  setPending(v: string | null): void {
    this.setKv("pending", v);
  }

  /** Disconnect: everything goes; GitHub is never touched. */
  disconnect(): void {
    this.sql.exec("DELETE FROM mirror_targets");
    this.sql.exec("DELETE FROM mirror");
    this.changed(null);
  }

  /** Retry (a row's, or every row's): now, with the backoff reset. Answers the targets queued. */
  retry(repos: string[] | null): string[] {
    const s = this.settings();

    if (!s?.on) return [];
    const rows = this.rows<{ repo: string }>("SELECT repo FROM mirror_targets WHERE on_ = 1").map((r) => r.repo).filter((r) => !repos || repos.includes(r));

    for (const r of rows) {
      this.sql.exec("UPDATE mirror_targets SET tries = 0, problem = NULL, next_at = ?, dirty_since = COALESCE(dirty_since, ?), dirty_n = dirty_n + 1 WHERE repo = ?", Date.now(), Date.now(), r);
    }

    if (rows.length) this.kick();

    return rows;
  }

  // ── Triggers ──────────────────────────────────────────────────────────────

  /** A repo's main moved (a merge, main's first push, a shared-files commit): mark its target, and arm it. */
  dirty(repo: string): void {
    const s = this.settings();

    if (!s?.started) return;
    const key = s.mode === "whole" ? WHOLE : repo;
    const t = this.rows<TargetRow>("SELECT * FROM mirror_targets WHERE repo = ? AND on_ = 1", key)[0];

    if (!t) return;
    const at = Date.now();
    const problem = parseProblem(t.problem);
    let next = t.next_at;

    if (!problem) next = Math.max(at, (t.last_started ?? 0) + this.spacing(s.mode));
    else if (problem.code !== "retrying" && at - (t.last_started ?? 0) >= PERSON_RETRY_MS) next = at;
    this.sql.exec("UPDATE mirror_targets SET dirty_since = COALESCE(dirty_since, ?), dirty_n = dirty_n + 1, next_at = ? WHERE repo = ?", at, next, key);

    if (!s.on || next === null) return;

    if (next <= at) this.kick();
    else this.armAt(next);
  }

  private dirtyAll(): void {
    const at = Date.now();
    this.sql.exec("UPDATE mirror_targets SET dirty_since = COALESCE(dirty_since, ?), dirty_n = dirty_n + 1, next_at = ?, tries = 0, problem = NULL WHERE on_ = 1", at, at);
    this.changed(null);
    this.kick();
  }

  private spacing(mode: MirrorMode): number {
    const v = Number(this.env.MIRROR_SPACING_MS);

    if (this.env.MIRROR_TEST === "1" && Number.isInteger(v) && v >= 0) return v;

    return mode === "whole" ? WHOLE_SPACING_MS : SPACING_MS;
  }

  private retryDelay(tries: number): number {
    const v = this.env.MIRROR_RETRY_MS?.split(",").map((x) => Number(x.trim()));
    const list = this.env.MIRROR_TEST === "1" && v && v.length && v.every((n) => Number.isInteger(n) && n >= 0) ? v : RETRY_MS;

    return list[tries - 1] ?? (list === RETRY_MS ? HOURLY_MS : list[list.length - 1]);
  }

  // ── The outbox ────────────────────────────────────────────────────────────

  private kicked = false;

  /** Run what is due, after this turn (changes made together go out together). */
  kick(): void {
    if (this.kicked) return;
    this.kicked = true;
    this.ctx.waitUntil(
      Promise.resolve().then(() => {
        this.kicked = false;

        return this.runDue();
      }),
    );
  }

  /** Lease the due targets and build their jobs. */
  private take(): { job: MirrorJob; lease: string; n: number }[] {
    const s = this.settings();
    const m = this.info();

    if (!s?.on || !m) return [];
    const at = Date.now();

    const due = this.rows<TargetRow>(
      "SELECT * FROM mirror_targets WHERE on_ = 1 AND dirty_since IS NOT NULL AND next_at IS NOT NULL AND next_at <= ? AND (lease IS NULL OR lease_until <= ?) ORDER BY next_at LIMIT ?",
      at, at, AT_ONCE,
    );

    const repos = this.repos();

    const source = (r: RepoRecord): MirrorSource => ({
      repo: r.name, path: r.name === META ? "" : r.path, ref: { artifacts_name: r.artifacts_name, remote: r.remote, created_at: r.created_at },
      branch: r.default_branch || "main", meta: r.name === META,
    });

    const out: { job: MirrorJob; lease: string; n: number }[] = [];

    for (const t of due) {
      const sources = s.mode === "whole" ? repos.map(source) : repos.filter((r) => r.name === t.repo).map(source);
      const lease = crypto.randomUUID();
      this.sql.exec("UPDATE mirror_targets SET lease = ?, lease_until = ?, last_started = ? WHERE repo = ?", lease, at + LEASE_MS, at, t.repo);
      out.push({
        lease,
        n: t.dirty_n,
        job: {
          monorepo: m.id, label: m.label, target: t.repo, mode: s.mode, installation: s.installation_id,
          github: { id: t.github_id, full_name: t.github_full_name }, sources, sent: parseSent(t.sent), composed: t.composed,
        },
      });
    }

    if (out.length) this.armAt(at + LEASE_MS + 1_000);

    return out;
  }

  /** Run every due target, AT_ONCE side by side. Never rejects. */
  async runDue(): Promise<void> {
    try {
      for (let round = 0; round < 10; round++) {
        const taken = this.take();

        if (!taken.length) return;
        await pool(taken, AT_ONCE, async (x) => {
          let r: MirrorResult;

          try {
            r = released(await this.ctx.exports.MirrorDrain.run(x.job));
          } catch (err) {
            r = { ok: false, sent: x.job.sent, composed: x.job.composed, last_sha: null, pushes: 0, ms: 0, problem: { code: "retrying", message: `the run failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), retry_after_s: null } };
          }

          this.record(x.job.target, x.lease, x.n, r);
        });
      }
    } catch (err) {
      console.error("mirror: running the outbox failed; the alarm retries:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
  }

  /** One run's result, while the lease is ours. */
  private record(repo: string, lease: string, n: number, r: MirrorResult): void {
    const t = this.rows<TargetRow>("SELECT * FROM mirror_targets WHERE repo = ? AND lease = ?", repo, lease)[0];

    if (!t) return; // disconnected, changed, or taken again after the lease ran out
    const at = Date.now();
    const spacing = this.spacing(this.settings()?.mode ?? "projects");
    const movedSince = t.dirty_n !== n;

    if (r.ok) {
      this.sql.exec(
        `UPDATE mirror_targets SET lease = NULL, lease_until = NULL, sent = ?, composed = ?, problem = NULL, tries = 0,
           last_sha = COALESCE(?, last_sha), last_at = CASE WHEN ? IS NULL THEN last_at ELSE ? END,
           dirty_since = ?, next_at = ? WHERE repo = ?`,
        JSON.stringify(r.sent), r.composed, r.last_sha, r.last_sha, now(),
        movedSince ? t.dirty_since : null, movedSince ? (t.last_started ?? at) + spacing : null, repo,
      );

      if (movedSince) this.armAt((t.last_started ?? at) + spacing);
    } else {
      const p = r.problem ?? { code: "retrying", message: "no answer", retry_after_s: null };
      const tries = t.tries + 1;
      const wait = p.code === "retrying" ? Math.max(p.retry_after_s !== null ? p.retry_after_s * 1000 : this.retryDelay(tries), p.retry_after_s === 0 ? spacing : 0) : null;
      const next = wait === null ? null : at + wait;
      this.sql.exec(
        "UPDATE mirror_targets SET lease = NULL, lease_until = NULL, sent = ?, composed = ?, problem = ?, tries = ?, next_at = ? WHERE repo = ?",
        JSON.stringify(r.sent), r.composed, JSON.stringify({ code: p.code, message: p.message, at: now() }), tries, next, repo,
      );

      if (next !== null) this.armAt(next);
    }

    this.changed(repo);
  }

  /** The object's alarm: run what is due (backoff, expired leases), then arm for the next. */
  async alarm(): Promise<void> {
    if (!this.info() || !this.settings()?.on) return;
    await this.runDue();
    const next = this.rows<{ t: number | null }>("SELECT MIN(COALESCE(lease_until, next_at)) AS t FROM mirror_targets WHERE on_ = 1 AND dirty_since IS NOT NULL AND next_at IS NOT NULL")[0]?.t;

    if (next) this.armAt(Math.max(next, Date.now() + 1_000));
  }

  /** Tell open pages: one event per run or settings change (not per state step), so the log stays small. */
  private changed(repo: string | null): void {
    this.publish({ kind: "mirror.updated", collection: "mirror", key: repo ?? "settings", op: "upsert", repo: repo && repo !== WHOLE ? repo : null, row: repo ? this.view(repo) : this.settings() });
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  view(repo: string): TargetView | null {
    const t = this.rows<TargetRow>("SELECT * FROM mirror_targets WHERE repo = ?", repo)[0];

    return t ? this.viewOf(t) : null;
  }

  views(): TargetView[] {
    return this.rows<TargetRow>("SELECT * FROM mirror_targets ORDER BY repo").map((t) => this.viewOf(t));
  }

  private viewOf(t: TargetRow): TargetView {
    const s = this.settings();
    const problem = parseProblem(t.problem);
    const at = Date.now();
    let state: TargetView["state"];

    if (!t.on_) state = "off";
    else if (!s?.on) state = "paused";
    else if (t.lease && (t.lease_until ?? 0) > at) state = "mirroring";
    else if (problem) state = problem.code;
    else if (t.dirty_since !== null) state = t.last_sha ? "waiting" : "not_started";
    else state = t.last_sha ? "up_to_date" : "not_started";

    return {
      repo: t.repo,
      on: !!t.on_,
      github: { id: t.github_id, full_name: t.github_full_name, private: !!t.github_private, url: `https://github.com/${t.github_full_name}` },
      state,
      last: t.last_sha && t.last_at ? { commit: t.last_sha, at: t.last_at } : null,
      sent: parseSent(t.sent),
      waiting_since: t.dirty_since ? new Date(t.dirty_since).toISOString() : null,
      next_try_at: problem?.code === "retrying" && t.next_at ? new Date(t.next_at).toISOString() : null,
      problem: problem ? { code: problem.code, message: problem.message, at: problem.at } : null,
    };
  }
}

function parseSent(v: string): SentHeads {
  const o = parseJson(v);
  const out: SentHeads = {};

  if (isRecord(o)) for (const [k, x] of Object.entries(o)) if (isText(x)) out[k] = x;

  return out;
}

function parseProblem(v: string | null): (Pick<MirrorProblem, "code" | "message"> & { at: string }) | null {
  const o = v ? parseJson(v) : null;

  if (!isRecord(o) || !isText(o.message) || !isText(o.at)) return null;
  const code = o.code === "retrying" || o.code === "no_access" || o.code === "not_found" || o.code === "refused" ? o.code : null;

  return code ? { code, message: o.message, at: o.at } : null;
}
