// Understand pages (docs/understand/DESIGN.md) in the monorepo object's
// SQLite, beside issues and agent sessions: the question, its scope, the
// lines asked about, the lookups that ran (steps), what they found (refs,
// each with its record as the lookup read it) and the paragraphs the
// assistant placed. The honesty rule lives here: a paragraph may cite only
// refs this page's lookups registered. Every change publishes
// understand.updated (topics `understand`, `understand:<n>`).

import { HttpError, now } from "../http";
import type { StreamEvent } from "../monorepo/types";
import type * as Contract from "@pando/contract";

export const UNDERSTAND_SCHEMA = `
CREATE TABLE IF NOT EXISTS understand_pages (
  number INTEGER PRIMARY KEY, question TEXT NOT NULL, scope TEXT, status TEXT NOT NULL, reason TEXT,
  asked_by TEXT NOT NULL, origin TEXT, session INTEGER, model TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  lines TEXT, blocks TEXT NOT NULL DEFAULT '[]', refs TEXT NOT NULL DEFAULT '[]', steps TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
CREATE INDEX IF NOT EXISTS understand_session ON understand_pages (session)`;

/** A page holds at most this many refs, lookups and blocks (DESIGN.md, "Limits"): it is read whole and sent whole. */
export const REFS_MAX = 40;

export const STEPS_MAX = 30;

export const BLOCKS_MAX = 24;

/** A block's text, at most. */
export const TEXT_MAX = 1200;

export type Scope = typeof Contract.UnderstandScope.Encoded;

export type Card = typeof Contract.UnderstandCard.Encoded;

export type Step = typeof Contract.UnderstandStep.Encoded;

export type Lines = typeof Contract.UnderstandLines.Encoded;

export type From = typeof Contract.UnderstandFrom.Encoded;

export type Block = typeof Contract.UnderstandBlock.Encoded;

export type Row = typeof Contract.UnderstandRow.Encoded;

export type PageView = typeof Contract.UnderstandPage.Encoded;

export type ListView = typeof Contract.UnderstandList.Encoded;

export type Placed = typeof Contract.UnderstandPlaced.Encoded;

type How = "direct" | "named" | "search";

/** A ref as stored: `key` is its record's identity (commit:<repo>@<sha>, session:<id>, meta:<path>@<version>, issue:<n>, agent:<n>), so a record found twice keeps one id. */
export interface StoredRef {
  id: string;
  key: string;
  how: How;
  found_by: string;
  step: number;
  card: Card;
}

/** What a lookup found, before it has an id on the page. */
export interface Found {
  key: string;
  how: How;
  found_by: string;
  card: Card;
}

interface PageRow extends Record<string, SqlStorageValue> {
  number: number;
  question: string;
  scope: string | null;
  status: "building" | "complete" | "failed";
  reason: string | null;
  asked_by: string;
  origin: string | null;
  session: number | null;
  model: string;
  revision: number;
  lines: string | null;
  blocks: string;
  refs: string;
  steps: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface UnderstandHost {
  publish(e: StreamEvent): number;
}

/** A block the assistant asked to place, as the route read it (its fields checked here). */
export interface BlockInput {
  id: string | null;
  type: string | null;
  text: string | null;
}

const BLOCK_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** The ids a text cites inline: [r3]. */
export function citesIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\[(r[1-9][0-9]{0,2})\]/g)].map((m) => m[1]))];
}

function parse<T>(s: string | null, fallback: T): T {
  // SAFETY: the columns hold JSON this store wrote.
  return s === null ? fallback : (JSON.parse(s) as T);
}

export class UnderstandStore {
  constructor(
    private sql: SqlStorage,
    private host: UnderstandHost,
  ) {}

  private row(n: number): PageRow | null {
    return this.sql.exec<PageRow>("SELECT * FROM understand_pages WHERE number = ?", n).toArray()[0] ?? null;
  }

  private must(n: number): PageRow {
    const r = this.row(n);

    if (!r) throw new HttpError(404, "not_found", `no Understand page ${n}`);

    return r;
  }

  private rowView(r: PageRow): Row {
    const refs = parse<StoredRef[]>(r.refs, []);
    const blocks = parse<Block[]>(r.blocks, []);
    const cited = new Set(blocks.flatMap((b) => b.cites));

    return {
      number: r.number, question: r.question, scope: parse<Scope | null>(r.scope, null), from: parse<From | null>(r.origin, null), status: r.status, reason: r.reason, asked_by: r.asked_by,
      session: r.session, model: r.model, revision: r.revision, sources: refs.length, cited: refs.filter((x) => cited.has(x.id)).length,
      created_at: r.created_at, updated_at: r.updated_at, completed_at: r.completed_at,
    };
  }

  /** The page, with each ref's record passed through `fresh` (an issue as it reads now; a deleted session as gone). */
  view(n: number, fresh: (card: Card) => { card: Card | null; gone: string | null }): PageView {
    const r = this.must(n);
    const refs = parse<StoredRef[]>(r.refs, []).map((x) => ({ id: x.id, how: x.how, found_by: x.found_by, step: x.step, ...fresh(x.card) }));

    return { ...this.rowView(r), lines: parse<Lines | null>(r.lines, null), blocks: parse<Block[]>(r.blocks, []), refs, steps: parse<Step[]>(r.steps, []) };
  }

  /** Newest first; `before` a number to page back. */
  list(before: number | null, limit: number): ListView {
    const rows = this.sql.exec<PageRow>("SELECT * FROM understand_pages WHERE number < ? ORDER BY number DESC LIMIT ?", before ?? Number.MAX_SAFE_INTEGER, limit + 1).toArray();
    const page = rows.slice(0, limit);

    return { pages: page.map((r) => this.rowView(r)), next_before: rows.length > limit ? (page.at(-1)?.number ?? null) : null };
  }

  create(input: { question: string; scope: Scope | null; from: From | null; model: string }, login: string): Row {
    const n = (this.sql.exec<{ n: number | null }>("SELECT MAX(number) AS n FROM understand_pages").one().n ?? 0) + 1;
    const at = now();

    this.sql.exec(
      "INSERT INTO understand_pages (number, question, scope, origin, status, asked_by, model, created_at, updated_at) VALUES (?, ?, ?, ?, 'building', ?, ?, ?, ?)",
      n, input.question, input.scope ? JSON.stringify(input.scope) : null, input.from ? JSON.stringify(input.from) : null, login, input.model, at, at,
    );

    return this.changed(n, login);
  }

  asker(n: number): string {
    return this.must(n).asked_by;
  }

  sessionOf(n: number): number | null {
    return this.must(n).session;
  }

  setSession(n: number, session: number): void {
    this.sql.exec("UPDATE understand_pages SET session = ? WHERE number = ?", session, n);
    this.changed(n, null);
  }

  setLines(n: number, lines: Lines): void {
    this.sql.exec("UPDATE understand_pages SET lines = ? WHERE number = ?", JSON.stringify(lines), n);
    this.changed(n, null);
  }

  /** The page failed before its session could run (pando-agents unreachable): the reason in plain words. */
  fail(n: number, reason: string): Row {
    const at = now();

    this.sql.exec("UPDATE understand_pages SET status = 'failed', reason = ?, completed_at = ? WHERE number = ?", reason, at, n);

    return this.changed(n, null);
  }

  /**
   * A lookup ran: its step is kept, and each record it found gets an id on the page (the id it already has when an
   * earlier lookup found it). Answers each record's id, in the order given (null: left out past REFS_MAX, which the
   * step says); past STEPS_MAX, the lookup is refused.
   */
  record(n: number, step: Omit<Step, "refs">, found: Found[]): (string | null)[] {
    const r = this.must(n);
    const steps = parse<Step[]>(r.steps, []);

    if (steps.length >= STEPS_MAX) throw new HttpError(429, "too_many_lookups", `a page holds at most ${STEPS_MAX} lookups; write the answer from what was found`);
    const refs = parse<StoredRef[]>(r.refs, []);
    const ids: (string | null)[] = [];
    let dropped = 0;

    for (const f of found) {
      const had = refs.find((x) => x.key === f.key);

      if (had) {
        ids.push(had.id);
        continue;
      }

      if (refs.length >= REFS_MAX) {
        ids.push(null);
        dropped++;
        continue;
      }

      const ref: StoredRef = { id: `r${refs.length + 1}`, key: f.key, how: f.how, found_by: f.found_by, step: steps.length, card: f.card };

      refs.push(ref);
      ids.push(ref.id);
    }

    const kept: Step = { ...step, refs: [...new Set(ids.filter((x) => x !== null))], found: dropped ? `${step.found} (${dropped} more not kept: a page holds ${REFS_MAX} sources)` : step.found };

    steps.push(kept);
    this.sql.exec("UPDATE understand_pages SET refs = ?, steps = ? WHERE number = ?", JSON.stringify(refs), JSON.stringify(steps), n);
    this.changed(n, null);

    return ids;
  }

  /** The ids this page's lookups registered, and what each names (for the model's text). */
  refIds(n: number): Set<string> {
    return new Set(parse<StoredRef[]>(this.must(n).refs, []).map((x) => x.id));
  }

  /**
   * The assistant's blocks: each checked (known type, an id, its length, every [rN] it cites found by this page's
   * lookups, a paragraph citing at least one). A block with an id already placed replaces it, marked with the
   * page's revision. Answers what was placed and why anything was refused.
   */
  place(n: number, input: BlockInput[]): Placed {
    const r = this.must(n);
    const known = this.refIds(n);
    const blocks = parse<Block[]>(r.blocks, []);
    const placed: string[] = [];
    const refused: { id: string; reason: string }[] = [];

    // Every block names itself: a missing, malformed or repeated id is the whole request's refusal, never renamed (a
    // renamed block could take another's id and replace it).
    const seen = new Set<string>();

    for (const [i, b] of input.entries()) {
      if (b.id === null || !BLOCK_ID.test(b.id)) throw new HttpError(400, "bad_request", `blocks[${i}].id: ${b.id === null ? "missing" : `"${b.id.slice(0, 60)}" is not one`}; give each block an id of letters, digits, _ and -, at most 40 characters (such as p1)`);

      if (seen.has(b.id)) throw new HttpError(400, "bad_request", `blocks[${i}].id: "${b.id}" is given twice in this request`);
      seen.add(b.id);
    }

    for (const [i, b] of input.entries()) {
      const id = b.id ?? `block ${i + 1}`;
      const no = (reason: string) => refused.push({ id, reason });

      if (b.type !== "paragraph" && b.type !== "nothing") {
        no('type: "paragraph" (a part of the answer) or "nothing" (no record explains what was asked)');
        continue;
      }

      if (b.text === null || !b.text.trim()) {
        no("text: the paragraph's words, citing sources as [r1]");
        continue;
      }

      if (b.text.length > TEXT_MAX) {
        no(`text: at most ${TEXT_MAX} characters`);
        continue;
      }

      const cites = citesIn(b.text);
      const unknown = cites.filter((c) => !known.has(c));

      if (unknown.length) {
        no(`${unknown.join(", ")}: not a source this page's lookups found. Cite only the ids the lookups gave you.`);
        continue;
      }

      if (b.type === "paragraph" && !cites.length) {
        no("a paragraph must cite at least one source as [r1]: every claim on the page rests on a record");
        continue;
      }

      const block: Block = { id, type: b.type, text: b.text.trim(), cites, revision: r.revision };
      const at = blocks.findIndex((x) => x.id === id);

      if (at === -1 && blocks.length >= BLOCKS_MAX) {
        no(`a page holds at most ${BLOCKS_MAX} blocks`);
        continue;
      }

      if (at === -1) blocks.push(block);
      else blocks[at] = block;
      placed.push(id);
    }

    if (placed.length) {
      this.sql.exec("UPDATE understand_pages SET blocks = ? WHERE number = ?", JSON.stringify(blocks), n);
      this.changed(n, null);
    }

    return { placed, refused };
  }

  /** A follow-up from the asker: the next revision, building again. */
  followUp(n: number, login: string): Row {
    const r = this.must(n);

    if (r.asked_by !== login) throw new HttpError(403, "not_asker", `only ${r.asked_by}, who asked, can ask a follow-up here`);
    this.sql.exec("UPDATE understand_pages SET revision = revision + 1, status = 'building', reason = NULL, completed_at = NULL WHERE number = ?", n);

    return this.changed(n, login);
  }

  /** Its session's state changed (agents/store.ts report): working is building; waiting is complete; failed or stopped is failed. */
  onSession(session: number, status: string, reason: string | null): void {
    const r = this.sql.exec<PageRow>("SELECT * FROM understand_pages WHERE session = ?", session).toArray()[0];

    if (!r) return;
    const next = status === "working" ? "building" : status === "waiting" ? "complete" : "failed";
    const why = next === "failed" ? (reason ?? status) : null;

    if (next === r.status && why === r.reason) return;
    this.sql.exec("UPDATE understand_pages SET status = ?, reason = ?, completed_at = ? WHERE number = ?", next, why, next === "building" ? null : now(), r.number);
    this.changed(r.number, null);
  }

  private changed(n: number, actor: string | null): Row {
    this.sql.exec("UPDATE understand_pages SET updated_at = ? WHERE number = ?", now(), n);
    const row = this.rowView(this.must(n));

    this.host.publish({
      kind: "understand.updated", collection: "understand", key: String(n), op: "upsert", repo: null,
      actor, machine: null, agent: null, number: n, row, topics: ["understand", `understand:${n}`],
    });

    return row;
  }
}
