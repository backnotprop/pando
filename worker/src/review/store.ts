// Risk-based review in the monorepo object's SQLite, beside reviews,
// statuses and merges: one row per branch head (its score, tier, reviewer
// sessions and guided review) and one settings row per project. The merge
// gate reads them in the merge's own step (object.ts mergeNow).

import type * as Contract from "@pando/contract";
import { now } from "../http";
import { isNumber, isOneOf, isRecord, isText, isWholeNumber, parseJson } from "../parse";
import { DEFAULT_SENSITIVE, DEFAULT_SETTINGS, gateOf, levelOf, tierOf, type ReviewerState, type Settings } from "./policy";
import { profileOf } from "./profiles";

export const REVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS branch_reviews (
  repo TEXT NOT NULL, branch TEXT NOT NULL, head TEXT NOT NULL, state TEXT NOT NULL,
  rule TEXT, score REAL, tier TEXT, reasons TEXT NOT NULL DEFAULT '[]', sensitive TEXT NOT NULL DEFAULT '[]', answers TEXT,
  model TEXT, tokens INTEGER, cost_usd REAL, error TEXT, reviewers TEXT NOT NULL DEFAULT '[]',
  guide_state TEXT NOT NULL DEFAULT 'none', guide TEXT, guide_error TEXT,
  created_at TEXT NOT NULL, classified_at TEXT, PRIMARY KEY (repo, branch, head));
CREATE TABLE IF NOT EXISTS review_settings (
  repo TEXT PRIMARY KEY, enabled INTEGER, auto_below REAL NOT NULL, human_above REAL NOT NULL, human_for_sensitive INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS review_paths (repo TEXT PRIMARY KEY, sensitive TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS review_test (k TEXT PRIMARY KEY, v TEXT NOT NULL)`;

/** A head still classifying this long after its push is taken as unknown (a person reviews it). */
export const PENDING_MS = 60_000;

type Row = Record<string, SqlStorageValue>;

/** A head's review state as it goes on the wire. */
export type BranchReviewOut = typeof Contract.BranchReview.Encoded;

interface HeadRow extends Row {
  repo: string;
  branch: string;
  head: string;
  state: string;
  rule: string | null;
  score: number | null;
  tier: string | null;
  reasons: string;
  sensitive: string;
  model: string | null;
  tokens: number | null;
  cost_usd: number | null;
  error: string | null;
  reviewers: string;
  guide_state: string;
  guide: string | null;
  created_at: string;
  classified_at: string | null;
}

/** A launched reviewer as stored: its profile and session (null when the launch failed). */
export interface Launched {
  profile: string;
  session: number | null;
}

/** What classifying wrote, and what the drain does next. */
export interface ClassifiedRow {
  /** The project's sensitive paths as read for this head. */
  patterns: string[];
  /** A rule that decided it with no model call (policy.ts commentsAndDocsOnly). */
  rule: "comments_and_docs" | null;
  score: number | null;
  tier: Contract.ReviewTier;
  reasons: string[];
  sensitive: string[];
  answers: unknown;
  model: string | null;
  tokens: number | null;
  cost_usd: number | null;
  error: string | null;
}

/** A review on a head, as the gate needs it. */
export interface HeadReview {
  verdict: Contract.Review["verdict"];
  author: string;
  session: number | null;
  agent: string | null;
}

/** The test switches (RISK_TEST): the next `fail` classifications fail; `score` stands in for clef; reviewers use `model` and are given `script`. */
export interface RiskTest {
  fail: number;
  score: number | null;
  model: string | null;
  script: string | null;
}

const textList = (v: string): string[] => {
  const j = parseJson(v);

  return Array.isArray(j) ? j.filter(isText) : [];
};

export class ReviewStore {
  constructor(
    private sql: SqlStorage,
    /** The server's default for a project with no setting (RISK_REVIEW=on). */
    private serverOn: () => boolean,
  ) {}

  ensureSchema(): void {
    for (const s of REVIEW_SCHEMA.split(";").map((x) => x.trim()).filter(Boolean)) this.sql.exec(s);

    // Rows from before the comments-and-docs rule.
    if (!this.sql.exec<{ name: string }>("PRAGMA table_info(branch_reviews)").toArray().some((c) => c.name === "rule")) this.sql.exec("ALTER TABLE branch_reviews ADD COLUMN rule TEXT");
  }

  private one<T extends Row>(q: string, ...args: SqlStorageValue[]): T | null {
    return this.sql.exec<T>(q, ...args).toArray()[0] ?? null;
  }

  settings(repo: string): Settings {
    const r = this.one<{ enabled: number | null; auto_below: number; human_above: number; human_for_sensitive: number }>("SELECT * FROM review_settings WHERE repo = ?", repo);

    return r ? { enabled: r.enabled === null ? null : r.enabled === 1, auto_below: r.auto_below, human_above: r.human_above, human_for_sensitive: r.human_for_sensitive === 1 } : { ...DEFAULT_SETTINGS };
  }

  enabled(repo: string): boolean {
    return this.settings(repo).enabled ?? this.serverOn();
  }

  setSettings(repo: string, s: Settings): void {
    this.sql.exec(
      `INSERT INTO review_settings (repo, enabled, auto_below, human_above, human_for_sensitive) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (repo) DO UPDATE SET enabled = excluded.enabled, auto_below = excluded.auto_below, human_above = excluded.human_above, human_for_sensitive = excluded.human_for_sensitive`,
      repo, s.enabled === null ? null : s.enabled ? 1 : 0, s.auto_below, s.human_above, s.human_for_sensitive ? 1 : 0,
    );
  }

  /** The sensitive paths as the last scoring read them from pando.toml (Settings shows them); the defaults before any. */
  sensitive(repo: string): string[] {
    const v = this.one<{ s: string }>("SELECT sensitive AS s FROM review_paths WHERE repo = ?", repo)?.s;

    return v ? textList(v) : [...DEFAULT_SENSITIVE];
  }

  setSensitive(repo: string, list: readonly string[]): void {
    this.sql.exec("INSERT INTO review_paths (repo, sensitive) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET sensitive = excluded.sensitive", repo, JSON.stringify(list));
  }

  /** A head to classify: true when this is its first time (the caller queues the job). A head seen before does nothing. */
  begin(repo: string, branch: string, head: string): boolean {
    return this.sql.exec("INSERT INTO branch_reviews (repo, branch, head, state, created_at) VALUES (?, ?, ?, 'classifying', ?) ON CONFLICT DO NOTHING", repo, branch, head, now()).rowsWritten > 0;
  }

  /** clef's answer (or why there is none), once per head: false when it was already written. */
  classified(repo: string, branch: string, head: string, c: ClassifiedRow): boolean {
    return this.sql.exec(
      `UPDATE branch_reviews SET state = 'done', rule = ?, score = ?, tier = ?, reasons = ?, sensitive = ?, answers = ?, model = ?, tokens = ?, cost_usd = ?, error = ?, classified_at = ?
       WHERE repo = ? AND branch = ? AND head = ? AND state = 'classifying'`,
      c.rule, c.score, c.tier, JSON.stringify(c.reasons), JSON.stringify(c.sensitive), c.answers === undefined ? null : JSON.stringify(c.answers),
      c.model, c.tokens, c.cost_usd, c.error, now(), repo, branch, head,
    ).rowsWritten > 0;
  }

  setReviewers(repo: string, branch: string, head: string, list: Launched[]): void {
    this.sql.exec("UPDATE branch_reviews SET reviewers = ? WHERE repo = ? AND branch = ? AND head = ?", JSON.stringify(list), repo, branch, head);
  }

  setGuide(repo: string, branch: string, head: string, state: BranchReviewOut["guide_state"], guide: BranchReviewOut["guide"], error: string | null): void {
    this.sql.exec("UPDATE branch_reviews SET guide_state = ?, guide = ?, guide_error = ? WHERE repo = ? AND branch = ? AND head = ?", state, guide ? JSON.stringify(guide) : null, error, repo, branch, head);
  }

  /** The guide's state for a head, or null when there is no row. */
  guideState(repo: string, branch: string, head: string): string | null {
    return this.one<{ g: string }>("SELECT guide_state AS g FROM branch_reviews WHERE repo = ? AND branch = ? AND head = ?", repo, branch, head)?.g ?? null;
  }

  /** Whether the head waits for its score. */
  classifying(repo: string, branch: string, head: string): boolean {
    return this.one<{ s: string }>("SELECT state AS s FROM branch_reviews WHERE repo = ? AND branch = ? AND head = ?", repo, branch, head)?.s === "classifying";
  }

  /** Whether the head was seen (rows are kept after a merge or a delete: they are small, and the page shows them). */
  hasRow(repo: string, branch: string, head: string): boolean {
    return !!this.one("SELECT 1 AS x FROM branch_reviews WHERE repo = ? AND branch = ? AND head = ?", repo, branch, head);
  }

  /**
   * The head's review state as the branch page and the gate read it; null
   * when the project has it off or the head was never seen (pushed before
   * it was turned on: the caller begins it).
   */
  view(repo: string, branch: string, head: string, reviews: readonly HeadReview[], sessionStatus: (n: number) => string | null): BranchReviewOut | null {
    if (!this.enabled(repo)) return null;
    const r = this.one<HeadRow>("SELECT * FROM branch_reviews WHERE repo = ? AND branch = ? AND head = ?", repo, branch, head);

    if (!r) return null;
    const s = this.settings(repo);
    const late = r.state === "classifying" && Date.now() - Date.parse(r.created_at) > PENDING_MS;
    const sensitive = textList(r.sensitive);
    // The tier from the stored score under the settings as they are now: a threshold changed in Settings counts at once.
    // Reviewers and the guide start only when a head is scored.
    const rule = r.rule === "comments_and_docs" ? r.rule : null;
    const tier = late ? "human" : r.state === "classifying" ? null : rule ? "auto" : tierOf(r.score, sensitive.length, s);
    const launched = parseJson(r.reviewers);

    const reviewers: (typeof Contract.Reviewer.Encoded & ReviewerState)[] = (Array.isArray(launched) ? launched : []).flatMap((x) => {
      if (!isRecord(x) || !isText(x.profile)) return [];
      const session = isWholeNumber(x.session) ? x.session : null;
      const mine = session === null ? [] : reviews.filter((v) => v.session === session);
      const last = mine.at(-1) ?? null;
      const status = session === null ? null : sessionStatus(session);
      const state = last ? "posted" : session === null || status === "failed" || status === "stopped" || status === "waiting" ? "failed" : "running";

      return [{ profile: x.profile, label: profileOf(x.profile)?.label ?? x.profile, session, state, verdict: last?.verdict ?? null }];
    });

    // A person's approval: not posted by an agent session, nor by an agent on a machine (X-Pando-Agent).
    const approval = reviews.filter((v) => v.verdict === "approve" && v.session === null && !v.agent).at(-1) ?? null;
    const gate = gateOf({ tier: r.state === "classifying" && !late ? null : tier, reviewers, approvedBy: approval?.author ?? null });
    const g = r.guide ? parseJson(r.guide) : null;

    return {
      head: r.head,
      state: r.state === "classifying" && !late ? "classifying" : "done",
      score: r.score,
      level: late || r.state === "classifying" ? "unknown" : rule ? "low" : levelOf(r.score, s),
      rule,
      tier,
      reasons: late ? ["The risk score did not arrive within a minute"] : textList(r.reasons),
      sensitive_paths: sensitive,
      model: r.model,
      tokens: r.tokens,
      cost_usd: r.cost_usd,
      error: late ? "the risk score did not arrive within a minute" : r.error,
      reviewers: reviewers.map(({ profile, label, session, state, verdict }) => ({ profile, label, session, state, verdict })),
      guide_state: isOneOf(["none", "writing", "ready", "failed"] as const, r.guide_state) ? r.guide_state : "none",
      guide: isRecord(g) && isText(g.artifact) && isWholeNumber(g.version) ? { artifact: g.artifact, version: g.version, title: isText(g.title) ? g.title : null } : null,
      approved_by: approval?.author ?? null,
      passes: gate.passes,
      why: gate.why,
      classified_at: r.classified_at,
    };
  }

  testSet(t: Partial<RiskTest>): RiskTest {
    const cur = this.test();
    const next = { ...cur, ...t };
    this.sql.exec("INSERT INTO review_test (k, v) VALUES ('t', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", JSON.stringify(next));

    return next;
  }

  test(): RiskTest {
    const v = this.one<{ v: string }>("SELECT v FROM review_test WHERE k = 't'")?.v;
    const j = v ? parseJson(v) : null;

    return isRecord(j)
      ? { fail: isWholeNumber(j.fail) ? j.fail : 0, score: isNumber(j.score) ? j.score : null, model: isText(j.model) ? j.model : null, script: isText(j.script) ? j.script : null }
      : { fail: 0, score: null, model: null, script: null };
  }

  /** One classification's test switch: whether it fails (counting one down), and the scripted score. */
  takeTest(): RiskTest {
    const t = this.test();

    if (t.fail > 0) this.testSet({ fail: t.fail - 1 });

    return t;
  }
}
