// The session index in the monorepo object's SQLite: one row per session, one per stored piece (where it starts and
// ends in the agent's own coordinates, its R2 key, and what Pando read from it), the models that answered in it, and
// each removed turn. The pieces in R2 are the source; every number here can be rebuilt from them (reindex). A piece
// is taken only at the session's current end, in one synchronous step, so two uploads can never both land.
import { HttpError, now } from "../http";
import type { StreamEvent } from "../monorepo/types";
import type { Program } from "./ids";
import type { SessionCommitRef } from "./commits";
import type { PieceFacts } from "./parse";

type Row = Record<string, SqlStorageValue>;

/** A session is Active while it has a record from the last 30 minutes (owner, 2026-10-04). */
export const ACTIVE_MS = 30 * 60_000;

export const LIST_MAX = 100;

export const SESSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, person TEXT, machine TEXT, program TEXT, agent_id TEXT, repo TEXT, branch TEXT, parent TEXT,
  started_at TEXT, last_at TEXT, appended_at TEXT, end_cursor INTEGER NOT NULL DEFAULT 0, model TEXT,
  prompts INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0, images INTEGER NOT NULL DEFAULT 0,
  redactions INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, deleted_by TEXT, deleted_at TEXT);
CREATE INDEX IF NOT EXISTS sessions_recent ON sessions (last_at, id);
CREATE INDEX IF NOT EXISTS sessions_person ON sessions (person, last_at);
CREATE INDEX IF NOT EXISTS sessions_branch ON sessions (repo, branch, last_at);
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions (parent);
CREATE TABLE IF NOT EXISTS session_pieces (
  session TEXT NOT NULL, at INTEGER NOT NULL, next INTEGER NOT NULL, key TEXT NOT NULL, bytes INTEGER NOT NULL,
  lines INTEGER NOT NULL, first_at TEXT, last_at TEXT, carry_at TEXT, carry_model TEXT,
  prompt_first INTEGER NOT NULL, prompts INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL, images INTEGER NOT NULL, redactions INTEGER NOT NULL, PRIMARY KEY (session, at));
CREATE TABLE IF NOT EXISTS session_piece_models (
  session TEXT NOT NULL, piece INTEGER NOT NULL, model TEXT NOT NULL, answers INTEGER NOT NULL, last_at TEXT,
  PRIMARY KEY (session, piece, model));
CREATE TABLE IF NOT EXISTS session_model_changes (session TEXT NOT NULL, piece INTEGER NOT NULL, at TEXT NOT NULL, model TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS session_model_changes_at ON session_model_changes (session, at);
CREATE TABLE IF NOT EXISTS session_commits (
  session TEXT NOT NULL, repo TEXT NOT NULL, sha TEXT NOT NULL, line INTEGER NOT NULL, branch TEXT, ord INTEGER,
  title TEXT NOT NULL, committed_at TEXT NOT NULL, on_main INTEGER NOT NULL DEFAULT 0, gone INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session, repo, sha));
CREATE INDEX IF NOT EXISTS session_commits_branch ON session_commits (repo, branch);
CREATE TABLE IF NOT EXISTS session_removals (
  session TEXT NOT NULL, prompt INTEGER NOT NULL, from_at TEXT NOT NULL, to_at TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (session, prompt))
`;

/** What the machine (or a server-side writer) says about a session it starts; checked on every piece. */
export interface SessionStart {
  program: Program;
  agent_id: string;
  repo: string | null;
  branch: string | null;
  /** The parent session's id, for a subagent the machine knows to be one (Claude Code, OpenCode). */
  parent: string | null;
}

/** Who sends: the person and their machine (the credential's name). */
export interface Sender {
  login: string;
  machine: string;
}

/** A stored piece, as the append step records it. */
export interface PieceRecord {
  key: string;
  /** Bytes of lines as stored (before gzip). */
  bytes: number;
  redactions: number;
  facts: PieceFacts;
}

/** Where the next piece starts, and what its parse needs from the pieces before. */
export interface SessionEnd {
  end: number;
  carry_model: string | null;
  carry_at: string | null;
  exists: boolean;
}

export interface ModelCount {
  model: string;
  answers: number;
}

export interface RemovedTurn {
  prompt: number;
  by: string;
  at: string;
}

/** One commit of a session: where it is, and the model in force in the session when it was committed. */
export interface SessionCommit {
  repo: string;
  sha: string;
  branch: string | null;
  title: string;
  committed_at: string;
  on_main: boolean;
  model: string | null;
}

/** A session on a branch, numbered by its earliest commit there (null: no commit there yet). */
export interface BranchSession {
  number: number | null;
  id: string;
  /** Null: a commit names a session this repository has no record of. */
  session: SessionView | DeletedView | null;
  commits: SessionCommit[];
}

/** A commit on the branch with the numbers of the sessions it names, in its lines' order; its model when they agree. */
export interface BranchCommit {
  sha: string;
  sessions: number[];
  model: string | null;
}

export interface BranchSessions {
  sessions: BranchSession[];
  commits: BranchCommit[];
}

export interface SessionView {
  id: string;
  state: "active" | "inactive";
  person: string;
  machine: string;
  program: Program;
  models: ModelCount[];
  repo: string | null;
  branch: string | null;
  parent: string | null;
  subagents: number;
  started_at: string | null;
  last_at: string | null;
  prompts: number;
  tool_calls: number;
  images: number;
  redactions: number;
  bytes: number;
  end: number;
  removed: RemovedTurn[];
  commits: SessionCommit[];
}

export interface DeletedView {
  id: string;
  state: "deleted";
  deleted_by: string;
  deleted_at: string;
}

export interface PieceRow {
  at: number;
  next: number;
  key: string;
  bytes: number;
  first_at: string | null;
  last_at: string | null;
  carry_at: string | null;
  carry_model: string | null;
  prompt_first: number;
  prompts: number;
  removed: number;
}

export interface SessionPage {
  sessions: SessionView[];
  next_cursor: string | null;
}

export interface PiecePage {
  pieces: PieceRow[];
  next: number | null;
}

/** What a reader needs to parse a session's pieces. */
export interface SessionSource {
  program: Program;
  agent_id: string;
}

export interface RemovalRow {
  prompt: number;
  from_at: string;
  to_at: string;
  by: string;
  at: string;
}

/** A removed turn's place: its prompt, the time span cut, and the piece that held the prompt. */
export interface TurnMark {
  prompt: number;
  from_at: string;
  to_at: string;
  piece: number;
}

export interface RewrittenPiece {
  at: number;
  record: PieceRecord;
}

export interface TurnRemoved {
  view: SessionView;
  /** The rewritten pieces' old R2 keys, for the caller to delete. */
  old: string[];
}

/** A piece read again by a reindex. */
export interface PieceReread {
  at: number;
  facts: PieceFacts;
  redactions: number;
}

export interface SessionFilters {
  person: string | null;
  program: string | null;
  repo: string | null;
  branch: string | null;
  state: "active" | "inactive" | null;
  cursor: string | null;
  limit: number;
}

interface CommitRow extends Row {
  session: string;
  repo: string;
  sha: string;
  line: number;
  branch: string | null;
  ord: number | null;
  title: string;
  committed_at: string;
  on_main: number;
  model: string | null;
}

interface SessionRow extends Row {
  id: string;
  person: string | null;
  machine: string | null;
  program: string | null;
  agent_id: string | null;
  repo: string | null;
  branch: string | null;
  parent: string | null;
  started_at: string | null;
  last_at: string | null;
  end_cursor: number;
  model: string | null;
  prompts: number;
  tool_calls: number;
  images: number;
  redactions: number;
  bytes: number;
  deleted_by: string | null;
  deleted_at: string | null;
}

export interface StoreHooks {
  publish(e: StreamEvent): void;
}

function gone(id: string): never {
  throw new HttpError(410, "session_deleted", `session ${id} was deleted; nothing more is recorded for it`);
}

export class SessionStore {
  constructor(
    private sql: SqlStorage,
    private hooks: StoreHooks,
  ) {}

  private rows<T extends Row>(query: string, ...args: SqlStorageValue[]): T[] {
    return this.sql.exec<T>(query, ...args).toArray();
  }

  private row<T extends Row>(query: string, ...args: SqlStorageValue[]): T | null {
    return this.rows<T>(query, ...args)[0] ?? null;
  }

  private session(id: string): SessionRow | null {
    return this.row<SessionRow>("SELECT * FROM sessions WHERE id = ?", id);
  }

  /** Where the next piece must start, refused for a deleted session or another person's. */
  end(id: string, login: string | null): SessionEnd {
    const s = this.session(id);

    if (!s) return { end: 0, carry_model: null, carry_at: null, exists: false };

    if (s.deleted_at) gone(id);

    if (login !== null && s.person !== login) throw new HttpError(403, "not_your_session", `session ${id} is ${s.person}'s`);

    return { end: s.end_cursor, carry_model: s.model, carry_at: s.last_at, exists: true };
  }

  /**
   * Take a piece at the session's end, or refuse it (409 with the end, which the sender resumes from). Makes the
   * session on its first piece. Publishes session.started or session.updated.
   */
  append(id: string, at: number, next: number, start: SessionStart, by: Sender, piece: PieceRecord): SessionView {
    const s = this.session(id);

    if (s?.deleted_at) gone(id);

    if (s && s.person !== by.login) throw new HttpError(403, "not_your_session", `session ${id} is ${s.person}'s`);
    const end = s?.end_cursor ?? 0;

    if (at !== end) throw new HttpError(409, "not_at_end", `the session ends at ${end}; send the piece that starts there`, { end });
    const t = now();

    if (!s) {
      this.sql.exec(
        "INSERT INTO sessions (id, person, machine, program, agent_id, repo, branch, parent, appended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id, by.login, by.machine, start.program, start.agent_id, start.repo, start.branch, start.parent, t,
      );
    }

    const prior = this.row<{ n: number }>("SELECT COALESCE(SUM(prompts + removed), 0) AS n FROM session_pieces WHERE session = ?", id)!.n;
    this.sql.exec(
      `INSERT INTO session_pieces (session, at, next, key, bytes, lines, first_at, last_at, carry_at, carry_model, prompt_first, prompts, tool_calls, images, redactions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, at, next, piece.key, piece.bytes, piece.facts.lines, piece.facts.first_at, piece.facts.last_at, s?.last_at ?? null, s?.model ?? null,
      prior + 1, piece.facts.prompts, piece.facts.tool_calls, piece.facts.images, piece.redactions,
    );
    this.keepModels(id, at, piece.facts);
    this.sql.exec("UPDATE sessions SET end_cursor = ?, machine = ?, appended_at = ?, model = COALESCE(?, model) WHERE id = ?", next, by.machine, t, piece.facts.model_after, id);

    const view = this.totals(id);
    this.publish(s ? "session.updated" : "session.started", view);

    return view;
  }

  private keepModels(id: string, at: number, f: PieceFacts): void {
    for (const [model, answers] of f.answers) {
      const lastUse = [...f.model_changes].reverse().find((c) => c.model === model)?.at ?? f.last_at;
      this.sql.exec("INSERT OR REPLACE INTO session_piece_models (session, piece, model, answers, last_at) VALUES (?, ?, ?, ?, ?)", id, at, model, answers, lastUse);
    }

    for (const c of f.model_changes) this.sql.exec("INSERT INTO session_model_changes (session, piece, at, model) VALUES (?, ?, ?, ?)", id, at, c.at, c.model);
  }

  /** The session's numbers summed again from its pieces; its view. */
  private totals(id: string): SessionView {
    const t = this.row<{ first: string | null; last: string | null; prompts: number; tools: number; images: number; red: number; bytes: number }>(
      `SELECT MIN(first_at) AS first, MAX(last_at) AS last, COALESCE(SUM(prompts), 0) AS prompts, COALESCE(SUM(tool_calls), 0) AS tools,
              COALESCE(SUM(images), 0) AS images, COALESCE(SUM(redactions), 0) AS red, COALESCE(SUM(bytes), 0) AS bytes FROM session_pieces WHERE session = ?`,
      id,
    )!;

    this.sql.exec(
      "UPDATE sessions SET started_at = ?, last_at = ?, prompts = ?, tool_calls = ?, images = ?, redactions = ?, bytes = ? WHERE id = ?",
      t.first, t.last, t.prompts, t.tools, t.images, t.red, t.bytes, id,
    );
    const view = this.view(this.session(id)!);

    if (view.state === "deleted") throw new HttpError(410, "session_deleted", `session ${id} was deleted`);

    return view;
  }

  /** Models by answers, then the latest used (DETERMINISM.md row 5). */
  private models(id: string): ModelCount[] {
    return this.rows<{ model: string; answers: number }>(
      "SELECT model, SUM(answers) AS answers, MAX(last_at) AS used FROM session_piece_models WHERE session = ? GROUP BY model ORDER BY answers DESC, used DESC, model",
      id,
    ).map((r) => ({ model: r.model, answers: r.answers }));
  }

  private view(s: SessionRow): SessionView | DeletedView {
    if (s.deleted_at) return { id: s.id, state: "deleted", deleted_by: s.deleted_by ?? "", deleted_at: s.deleted_at };
    const active = s.last_at !== null && Date.now() - Date.parse(s.last_at) < ACTIVE_MS;

    return {
      id: s.id,
      state: active ? "active" : "inactive",
      person: s.person ?? "",
      machine: s.machine ?? "",
      // SAFETY: append() writes program only from a checked SessionStart.
      program: s.program as Program,
      models: this.models(s.id),
      repo: s.repo,
      branch: s.branch,
      parent: s.parent,
      subagents: this.row<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE parent = ? AND deleted_at IS NULL", s.id)!.n,
      started_at: s.started_at,
      last_at: s.last_at,
      prompts: s.prompts,
      tool_calls: s.tool_calls,
      images: s.images,
      redactions: s.redactions,
      bytes: s.bytes,
      end: s.end_cursor,
      removed: this.rows<{ prompt: number; by: string; at: string }>("SELECT prompt, by, at FROM session_removals WHERE session = ? ORDER BY prompt", s.id),
      commits: this.commitRows("c.session = ?", s.id).map((r) => this.commitOf(r)),
    };
  }

  get(id: string): SessionView | DeletedView {
    const s = this.session(id);

    if (!s) throw new HttpError(404, "not_found", `no session ${id}`);

    return this.view(s);
  }

  /** Sessions by last activity, newest first; deleted ones are not listed. The cursor is `<last_at>|<id>`. */
  list(f: SessionFilters): SessionPage {
    const where = ["deleted_at IS NULL", "last_at IS NOT NULL"];
    const args: SqlStorageValue[] = [];

    for (const [col, v] of [["person", f.person], ["program", f.program]] as const) {
      if (v === null) continue;
      where.push(`${col} = ?`);
      args.push(v);
    }

    // Where it ran, or where its commits are (DETERMINISM.md row 23).
    if (f.repo !== null && f.branch !== null) {
      where.push("((repo = ? AND branch = ?) OR id IN (SELECT session FROM session_commits WHERE repo = ? AND branch = ? AND (gone = 0 OR on_main = 1)))");
      args.push(f.repo, f.branch, f.repo, f.branch);
    } else if (f.repo !== null) {
      where.push("(repo = ? OR id IN (SELECT session FROM session_commits WHERE repo = ?))");
      args.push(f.repo, f.repo);
    }

    const since = new Date(Date.now() - ACTIVE_MS).toISOString();

    if (f.state === "active") {
      where.push("last_at > ?");
      args.push(since);
    } else if (f.state === "inactive") {
      where.push("last_at <= ?");
      args.push(since);
    }

    if (f.cursor) {
      const bar = f.cursor.lastIndexOf("|");
      where.push("(last_at < ? OR (last_at = ? AND id < ?))");
      args.push(f.cursor.slice(0, bar), f.cursor.slice(0, bar), f.cursor.slice(bar + 1));
    }

    const rows = this.rows<SessionRow>(`SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY last_at DESC, id DESC LIMIT ?`, ...args, f.limit + 1);
    const page = rows.slice(0, f.limit);
    const last = page.at(-1);

    return {
      // SAFETY: deleted rows are excluded by the query, so every view is a SessionView.
      sessions: page.map((r) => this.view(r) as SessionView),
      next_cursor: rows.length > f.limit && last ? `${last.last_at}|${last.id}` : null,
    };
  }

  /** Pieces from `from` on, in order, until `budget` stored bytes are reached (at least one). */
  pieces(id: string, from: number, budget: number): PiecePage {
    this.get(id);
    const out: PieceRow[] = [];
    let used = 0;
    let next: number | null = null;

    for (const p of this.rows<PieceRow & Row>("SELECT at, next, key, bytes, first_at, last_at, carry_at, carry_model, prompt_first, prompts, removed FROM session_pieces WHERE session = ? AND at >= ? ORDER BY at", id, from)) {
      if (out.length && used + p.bytes > budget) {
        next = p.at;
        break;
      }

      out.push(p);
      used += p.bytes;
    }

    return { pieces: out, next };
  }

  /** Every piece, for a reindex or a turn's removal. */
  allPieces(id: string): PieceRow[] {
    return this.pieces(id, 0, Number.MAX_SAFE_INTEGER).pieces;
  }

  /** Removed turns, as the reader places their marks. */
  removals(id: string): RemovalRow[] {
    return this.rows<RemovalRow & Row>("SELECT prompt, from_at, to_at, by, at FROM session_removals WHERE session = ? ORDER BY prompt", id);
  }

  /** The program and agent id a reader needs (OpenCode's export names the session). */
  source(id: string): SessionSource {
    const s = this.session(id);

    if (!s) throw new HttpError(404, "not_found", `no session ${id}`);

    if (s.deleted_at) gone(id);

    // SAFETY: append() writes program only from a checked SessionStart.
    return { program: s.program as Program, agent_id: s.agent_id ?? "" };
  }

  /** Who may delete or edit it: its person, or an owner of the repository. */
  private mayChange(s: SessionRow, login: string, owner: boolean): void {
    if (s.person !== login && !owner) throw new HttpError(403, "not_your_session", `only ${s.person} or an owner can change session ${s.id}`);
  }

  /** Delete at once and for good: a stub row stays (who, when) for the commits that name it. The caller empties R2. */
  delete(id: string, login: string, owner: boolean): DeletedView {
    const s = this.session(id);

    if (!s) throw new HttpError(404, "not_found", `no session ${id}`);

    if (s.deleted_at) return { id, state: "deleted", deleted_by: s.deleted_by ?? "", deleted_at: s.deleted_at };
    this.mayChange(s, login, owner);
    const t = now();

    for (const table of ["session_pieces", "session_piece_models", "session_model_changes", "session_removals"]) this.sql.exec(`DELETE FROM ${table} WHERE session = ?`, id);
    this.sql.exec(
      `UPDATE sessions SET person = NULL, machine = NULL, program = NULL, agent_id = NULL, repo = NULL, branch = NULL, parent = NULL, started_at = NULL,
       last_at = NULL, model = NULL, prompts = 0, tool_calls = 0, images = 0, redactions = 0, bytes = 0, deleted_by = ?, deleted_at = ? WHERE id = ?`,
      login, t, id,
    );
    const view: DeletedView = { id, state: "deleted", deleted_by: login, deleted_at: t };
    this.hooks.publish({ kind: "session.deleted", collection: "sessions", key: id, op: "delete", repo: s.repo, actor: login, machine: null, agent: null, row: view, topics: ["sessions", `session:${id}`] });

    return view;
  }

  /** Check a turn may be removed by this person; its prompt must exist and not be removed already. */
  mayRemove(id: string, prompt: number, login: string, owner: boolean): void {
    const s = this.session(id);

    if (!s) throw new HttpError(404, "not_found", `no session ${id}`);

    if (s.deleted_at) gone(id);
    this.mayChange(s, login, owner);

    if (this.row("SELECT 1 FROM session_removals WHERE session = ? AND prompt = ?", id, prompt)) throw new HttpError(409, "already_removed", `prompt ${prompt} was removed already`);
  }

  /**
   * Record a removed turn: its pieces' new keys and facts (the reader rewrote them without the turn's lines), and the
   * mark. Pieces keep their place in the numbering (`removed` counts in the piece that held the prompt). Old keys are
   * returned for the caller to delete from R2.
   */
  removeTurn(id: string, mark: TurnMark, rewritten: RewrittenPiece[], by: string): TurnRemoved {
    const old: string[] = [];

    for (const r of rewritten) {
      const p = this.row<{ key: string }>("SELECT key FROM session_pieces WHERE session = ? AND at = ?", id, r.at);

      if (!p) continue;
      old.push(p.key);
      const f = r.record.facts;
      this.sql.exec(
        "UPDATE session_pieces SET key = ?, bytes = ?, lines = ?, first_at = ?, last_at = ?, prompts = ?, tool_calls = ?, images = ?, redactions = ? WHERE session = ? AND at = ?",
        r.record.key, r.record.bytes, f.lines, f.first_at, f.last_at, f.prompts, f.tool_calls, f.images, r.record.redactions, id, r.at,
      );
      this.sql.exec("DELETE FROM session_piece_models WHERE session = ? AND piece = ?", id, r.at);
      this.sql.exec("DELETE FROM session_model_changes WHERE session = ? AND piece = ?", id, r.at);
      this.keepModels(id, r.at, f);
    }

    this.sql.exec("UPDATE session_pieces SET removed = removed + 1 WHERE session = ? AND at = ?", id, mark.piece);
    this.sql.exec("INSERT INTO session_removals (session, prompt, from_at, to_at, by, at) VALUES (?, ?, ?, ?, ?, ?)", id, mark.prompt, mark.from_at, mark.to_at, by, now());
    const view = this.totals(id);
    this.publish("session.updated", view);

    return { view, old } satisfies TurnRemoved;
  }

  /** Rebuild every piece's facts from a fresh read of the stored pieces (a parser fix reaches old sessions). */
  reindex(id: string, read: PieceReread[]): SessionView {
    this.source(id);
    let carryModel: string | null = null;
    let carryAt: string | null = null;

    for (const r of read) {
      const p = this.row<{ removed: number }>("SELECT removed FROM session_pieces WHERE session = ? AND at = ?", id, r.at);

      if (!p) continue;
      const prior = this.row<{ n: number }>("SELECT COALESCE(SUM(prompts + removed), 0) AS n FROM session_pieces WHERE session = ? AND at < ?", id, r.at)!.n;
      this.sql.exec(
        "UPDATE session_pieces SET lines = ?, first_at = ?, last_at = ?, carry_at = ?, carry_model = ?, prompt_first = ?, prompts = ?, tool_calls = ?, images = ?, redactions = ? WHERE session = ? AND at = ?",
        r.facts.lines, r.facts.first_at, r.facts.last_at, carryAt, carryModel, prior + 1, r.facts.prompts, r.facts.tool_calls, r.facts.images, r.redactions, id, r.at,
      );
      this.sql.exec("DELETE FROM session_piece_models WHERE session = ? AND piece = ?", id, r.at);
      this.sql.exec("DELETE FROM session_model_changes WHERE session = ? AND piece = ?", id, r.at);
      this.keepModels(id, r.at, r.facts);
      carryModel = r.facts.model_after ?? carryModel;
      carryAt = r.facts.last_at ?? carryAt;
    }

    this.sql.exec("UPDATE sessions SET model = ? WHERE id = ?", carryModel, id);
    const view = this.totals(id);
    this.publish("session.updated", view);

    return view;
  }

  /** Commit rows with the model in force at each commit's time (DETERMINISM.md row 22): the last change at or before it. */
  private commitRows(where: string, ...args: SqlStorageValue[]): CommitRow[] {
    return this.rows<CommitRow>(
      `SELECT c.session, c.repo, c.sha, c.line, c.branch, c.ord, c.title, c.committed_at, c.on_main,
              (SELECT m.model FROM session_model_changes m WHERE m.session = c.session AND m.at <= c.committed_at ORDER BY m.at DESC LIMIT 1) AS model
       FROM session_commits c WHERE ${where} AND (c.gone = 0 OR c.on_main = 1) ORDER BY c.committed_at, c.sha LIMIT 500`,
      ...args,
    );
  }

  private commitOf(r: CommitRow): SessionCommit {
    return { repo: r.repo, sha: r.sha, branch: r.branch, title: r.title, committed_at: r.committed_at, on_main: r.on_main === 1, model: r.model };
  }

  /**
   * A branch's own commits, as its facts just read them: each session line kept, rows of commits no longer on the branch
   * marked gone (a rewrite) unless they reached main. Sessions whose commits changed are published.
   */
  linkBranch(repo: string, branch: string, refs: SessionCommitRef[]): void {
    const key = (session: string, sha: string) => `${session} ${sha}`;
    const before = new Set(this.rows<{ session: string; sha: string }>("SELECT session, sha FROM session_commits WHERE repo = ? AND branch = ? AND gone = 0", repo, branch).map((r) => key(r.session, r.sha)));
    const after = new Set(refs.flatMap((r) => r.sessions.map((s) => key(s, r.sha))));
    this.sql.exec("UPDATE session_commits SET gone = 1 WHERE repo = ? AND branch = ? AND on_main = 0", repo, branch);

    for (const r of refs) {
      for (const [line, session] of r.sessions.entries()) {
        this.sql.exec(
          `INSERT INTO session_commits (session, repo, sha, line, branch, ord, title, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (session, repo, sha) DO UPDATE SET branch = excluded.branch, ord = excluded.ord, line = excluded.line, gone = 0`,
          session, repo, r.sha, line, branch, r.ord, r.title, r.committed_at,
        );
      }
    }

    const changed = new Set([...before, ...after].flatMap((k) => (before.has(k) !== after.has(k) ? [k.split(" ")[0]] : [])));
    this.publishChanged(changed);
  }

  /** Commits that reached main: their sessions' rows say so, made if the branch's facts never saw them. */
  onMain(repo: string, refs: SessionCommitRef[]): void {
    const changed = new Set<string>();

    for (const r of refs) {
      for (const [line, session] of r.sessions.entries()) {
        const had = this.row<{ on_main: number }>("SELECT on_main FROM session_commits WHERE session = ? AND repo = ? AND sha = ?", session, repo, r.sha);

        if (had?.on_main === 1) continue;
        this.sql.exec(
          `INSERT INTO session_commits (session, repo, sha, line, title, committed_at, on_main) VALUES (?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT (session, repo, sha) DO UPDATE SET on_main = 1, gone = 0`,
          session, repo, r.sha, line, r.title, r.committed_at,
        );
        changed.add(session);
      }
    }

    this.publishChanged(changed);
  }

  private publishChanged(ids: Set<string>): void {
    for (const id of ids) {
      const s = this.session(id);

      if (s && !s.deleted_at) this.publish("session.updated", this.totals(id));
    }
  }

  /**
   * A branch's sessions: those its commits name, numbered 1, 2, 3 by their earliest commit in branch order (DETERMINISM.md
   * row 28), then those that ran in its worktree with no commit there yet. And each commit's session numbers.
   */
  branchSessions(repo: string, branch: string): BranchSessions {
    const rows = this.commitRows("c.repo = ? AND c.branch = ?", repo, branch);
    const bySession = new Map<string, CommitRow[]>();

    for (const r of rows) bySession.set(r.session, [...(bySession.get(r.session) ?? []), r]);
    const oldest = (list: CommitRow[]) => Math.max(...list.map((r) => r.ord ?? -1));
    const ordered = [...bySession].sort((a, b) => oldest(b[1]) - oldest(a[1]) || a[0].localeCompare(b[0]));
    const numbers = new Map(ordered.map(([id], i) => [id, i + 1]));

    const viewOf = (id: string) => {
      const s = this.session(id);

      return s ? this.view(s) : null;
    };

    const sessions: BranchSession[] = ordered.map(([id, list]) => ({
      number: numbers.get(id) ?? null,
      id,
      session: viewOf(id),
      commits: [...list].sort((a, b) => (b.ord ?? -1) - (a.ord ?? -1)).map((r) => this.commitOf(r)),
    }));

    for (const s of this.rows<SessionRow>("SELECT * FROM sessions WHERE repo = ? AND branch = ? AND deleted_at IS NULL AND last_at IS NOT NULL ORDER BY last_at DESC", repo, branch)) {
      if (!numbers.has(s.id)) sessions.push({ number: null, id: s.id, session: this.view(s), commits: [] });
    }

    const byCommit = new Map<string, CommitRow[]>();

    for (const r of rows) byCommit.set(r.sha, [...(byCommit.get(r.sha) ?? []), r]);

    const commits: BranchCommit[] = [...byCommit]
      .sort((a, b) => (a[1][0].ord ?? 0) - (b[1][0].ord ?? 0))
      .map(([sha, list]) => {
        const lines = [...list].sort((a, b) => a.line - b.line);
        const models = new Set(lines.map((r) => r.model));

        // No model when its sessions disagree or one is not known: nothing shown rests on a guess.
        return { sha, sessions: lines.map((r) => numbers.get(r.session) ?? 0), model: models.size === 1 ? lines[0].model : null };
      });

    return { sessions, commits };
  }

  private publish(kind: "session.started" | "session.updated", view: SessionView): void {
    this.hooks.publish({ kind, collection: "sessions", key: view.id, op: "upsert", repo: view.repo, actor: view.person, machine: view.machine, agent: null, row: view, topics: ["sessions", `session:${view.id}`] });
  }
}
