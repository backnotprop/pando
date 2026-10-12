// The monorepo object's artifacts: documents uploaded to a branch's page (the pull request), never in git
// (research/plans/artifacts-2026-10-12/SPEC.md). Rows here, bytes in R2 (BLOBS), written and read by the Worker.
//
// An artifact is keyed by (repo, branch, the branch row's created_at, name), so a branch name used again later
// starts with no artifacts. The same name again is the next version; every version is kept, each under its own
// R2 prefix (an upload's own, so two uploads at once never write over each other's bytes).
//
// Comments are Plannotator's annotations: the anchor is stored as the browser wrote it and never read here.
// Pando keeps the thread: replies one level deep, open or resolved on the root.
//
// One instance lives in each MonorepoObject and shares its SQLite.

import { HttpError, now } from "../http";
import type { Identity, RefusalExtra, StreamEvent } from "../monorepo/types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT NOT NULL, branch_created_at TEXT NOT NULL,
  name TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, version INTEGER NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (repo, branch, branch_created_at, name));
CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact TEXT NOT NULL, n INTEGER NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, files TEXT NOT NULL,
  prefix TEXT NOT NULL, uploaded_by TEXT NOT NULL, machine TEXT, via TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (artifact, n));
CREATE TABLE IF NOT EXISTS artifact_comments (
  id TEXT PRIMARY KEY, artifact TEXT NOT NULL, version INTEGER NOT NULL, thread TEXT NOT NULL, in_reply_to TEXT,
  anchor TEXT, body TEXT, body_version INTEGER NOT NULL, author TEXT NOT NULL, machine TEXT, mentions TEXT NOT NULL,
  state TEXT NOT NULL, resolved_by TEXT, resolved_at TEXT, request_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS artifact_comments_artifact ON artifact_comments (artifact, created_at);
CREATE INDEX IF NOT EXISTS artifact_comments_thread ON artifact_comments (thread);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_comments_request ON artifact_comments (author, request_key) WHERE request_key IS NOT NULL
`;

/** Artifacts on one branch: one list, read in one request with its comment counts (owner, 2026-10-12). */
export const ARTIFACTS_MAX = 100;

/** Threads on one artifact version: each is placed again in the browser on every render. */
export const THREADS_MAX = 500;

/** Replies in one thread: a longer talk belongs in an issue. */
export const REPLIES_MAX = 100;

/** A comment body in a live event; over this it is null there (as issue comments). */
const EVENT_BODY_MAX = 16 * 1024;

type Row = Record<string, SqlStorageValue>;

export type ArtifactKind = "markdown" | "html" | "image";

export interface FileEntry {
  path: string;
  size: number;
  sha256: string;
  type: string;
}

export interface VersionView {
  n: number;
  size: number;
  sha256: string;
  files: FileEntry[];
  uploaded_by: string;
  machine: string | null;
  via: "web" | "cli";
  created_at: string;
}

export interface Counts {
  open: number;
  resolved: number;
}

export interface ArtifactView {
  id: string;
  repo: string;
  branch: string;
  name: string;
  kind: ArtifactKind;
  title: string | null;
  latest: VersionView;
  versions: number;
  comments: Counts;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CommentView {
  id: string;
  artifact: string;
  version: number;
  thread: string;
  in_reply_to: string | null;
  anchor: object | null;
  body: string | null;
  body_version: number;
  author: string;
  machine: string | null;
  mentions: string[];
  state: "open" | "resolved";
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ThreadView = CommentView & { replies: CommentView[] };

export interface ThreadsView {
  threads: ThreadView[];
  counts: Counts;
}

/** Where a version's bytes are, and its files. */
export interface VersionFound {
  artifact: { id: string; name: string; kind: ArtifactKind };
  prefix: string;
  files: FileEntry[];
}

/** A version to record, once its bytes are in R2. */
export interface NewVersion {
  /** The id to give a new artifact (the one the Worker put in the R2 key). */
  id: string;
  branch_created_at: string;
  name: string;
  kind: ArtifactKind;
  title: string | null;
  files: FileEntry[];
  prefix: string;
  machine: string | null;
  via: "web" | "cli";
}

/** Before an upload sends bytes: the artifact's id and the branch's key. */
export interface Slot {
  id: string;
  branch_created_at: string;
}

export interface VersionAdded {
  artifact: ArtifactView;
  created: boolean;
}

export interface CommentAdded {
  comment: CommentView;
  /** An Idempotency-Key seen before: the comment it made. */
  replayed: boolean;
}

export interface NewComment {
  version: number | null;
  /** JSON text, checked by the Worker; null: the whole artifact (and always on a reply). */
  anchor: string | null;
  body: string;
  in_reply_to: string | null;
  mentions: string[];
  machine: string | null;
}

type ArtifactRow = {
  id: string; repo: string; branch: string; branch_created_at: string; name: string; kind: string; title: string | null;
  version: number; created_by: string; created_at: string; updated_at: string;
};

type VersionRow = {
  artifact: string; n: number; size: number; sha256: string; files: string; prefix: string; uploaded_by: string;
  machine: string | null; via: string; created_at: string;
};

type CommentRow = {
  id: string; artifact: string; version: number; thread: string; in_reply_to: string | null; anchor: string | null; body: string | null;
  body_version: number; author: string; machine: string | null; mentions: string; state: string; resolved_by: string | null;
  resolved_at: string | null; request_key: string | null; created_at: string; updated_at: string;
};

export interface ArtifactHost {
  publish(e: StreamEvent): number;
}

function fail(status: number, code: string, message: string, extra: RefusalExtra = {}): never {
  throw new HttpError(status, code, message, extra);
}

function hexId(prefix: string): string {
  return prefix + [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function parsed<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;

  try {
    // SAFETY: only this store writes these columns, as JSON of the shape asked for.
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function kindOf(v: string): ArtifactKind {
  return v === "html" || v === "image" ? v : "markdown";
}

function who(by: Identity, machine: string | null): Pick<StreamEvent, "actor" | "machine" | "agent" | "via"> {
  return { actor: by.login, machine, agent: by.agent ?? null, via: { credential_id: by.credential_id, credential_kind: by.credential_kind ?? null } };
}

export class ArtifactStore {
  constructor(
    private sql: SqlStorage,
    private host: ArtifactHost,
  ) {}

  private rows<T extends Row>(q: string, ...args: SqlStorageValue[]): T[] {
    return this.sql.exec<T>(q, ...args).toArray();
  }

  private row<T extends Row>(q: string, ...args: SqlStorageValue[]): T | null {
    return this.rows<T>(q, ...args)[0] ?? null;
  }

  ensureSchema(): void {
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
  }

  // ── Artifacts and versions ───────────────────────────────────────────────

  /** The branch's created_at (its artifacts' key); 404 when the branch is not recorded. */
  branchKey(repo: string, branch: string): string {
    const b = this.row<{ created_at: string | null }>("SELECT created_at FROM branches WHERE repo = ? AND name = ? AND deleted_at IS NULL", repo, branch);

    return b ? (b.created_at ?? "") : fail(404, "not_found", `no branch ${branch}`);
  }

  private versionView(v: VersionRow): VersionView {
    return {
      n: v.n, size: v.size, sha256: v.sha256, files: parsed<FileEntry[]>(v.files, []), uploaded_by: v.uploaded_by, machine: v.machine,
      via: v.via === "web" ? "web" : "cli", created_at: v.created_at,
    };
  }

  private counts(where: string, ...args: SqlStorageValue[]): Counts {
    const out = { open: 0, resolved: 0 };

    for (const r of this.rows<{ state: string; n: number }>(`SELECT state, COUNT(*) AS n FROM artifact_comments WHERE in_reply_to IS NULL AND ${where} GROUP BY state`, ...args)) {
      if (r.state === "resolved") out.resolved = r.n;
      else out.open += r.n;
    }

    return out;
  }

  private view(a: ArtifactRow): ArtifactView {
    const latest = this.row<VersionRow>("SELECT * FROM artifact_versions WHERE artifact = ? AND n = ?", a.id, a.version)!;
    const versions = this.row<{ n: number }>("SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact = ?", a.id)?.n ?? 0;

    return {
      id: a.id, repo: a.repo, branch: a.branch, name: a.name, kind: kindOf(a.kind), title: a.title, latest: this.versionView(latest), versions,
      comments: this.counts("artifact = ?", a.id), created_by: a.created_by, created_at: a.created_at, updated_at: a.updated_at,
    };
  }

  private artifactRow(id: string): ArtifactRow | null {
    return this.row<ArtifactRow>("SELECT * FROM artifacts WHERE id = ?", id);
  }

  private byName(repo: string, branch: string, key: string, name: string): ArtifactRow | null {
    return this.row<ArtifactRow>("SELECT * FROM artifacts WHERE repo = ? AND branch = ? AND branch_created_at = ? AND name = ?", repo, branch, key, name);
  }

  private onBranch(repo: string, branch: string, key: string): number {
    return this.row<{ n: number }>("SELECT COUNT(*) AS n FROM artifacts WHERE repo = ? AND branch = ? AND branch_created_at = ?", repo, branch, key)?.n ?? 0;
  }

  /** Before an upload sends bytes: the branch's key, and the artifact's id (a new one for a new name, refused past ARTIFACTS_MAX). */
  slot(repo: string, branch: string, name: string): Slot {
    const key = this.branchKey(repo, branch);
    const had = this.byName(repo, branch, key, name);

    if (had) return { id: had.id, branch_created_at: key };

    if (this.onBranch(repo, branch, key) >= ARTIFACTS_MAX) fail(409, "too_many_artifacts", `${branch} has ${ARTIFACTS_MAX} artifacts, the most a branch keeps; delete one first`);

    return { id: hexId("art_"), branch_created_at: key };
  }

  /** After the bytes are in R2: the next version of the artifact with that name, or a new artifact. */
  addVersion(repo: string, branch: string, v: NewVersion, by: Identity): VersionAdded {
    if (this.branchKey(repo, branch) !== v.branch_created_at) fail(409, "branch_changed", `${branch} was deleted or made again while the files were uploading; upload again`);
    let a = this.byName(repo, branch, v.branch_created_at, v.name);
    const created = !a;
    const at = now();

    if (!a) {
      if (this.onBranch(repo, branch, v.branch_created_at) >= ARTIFACTS_MAX) fail(409, "too_many_artifacts", `${branch} has ${ARTIFACTS_MAX} artifacts, the most a branch keeps; delete one first`);
      this.sql.exec(
        "INSERT INTO artifacts (id, repo, branch, branch_created_at, name, kind, title, version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
        v.id, repo, branch, v.branch_created_at, v.name, v.kind, v.title, by.login, at, at,
      );
      a = this.artifactRow(v.id)!;
    }

    const n = a.version + 1;
    const size = v.files.reduce((sum, f) => sum + f.size, 0);
    this.sql.exec(
      "INSERT INTO artifact_versions (artifact, n, size, sha256, files, prefix, uploaded_by, machine, via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      a.id, n, size, v.files[0]!.sha256, JSON.stringify(v.files), v.prefix, by.login, v.machine, v.via, at,
    );
    this.sql.exec("UPDATE artifacts SET version = ?, kind = ?, title = ?, updated_at = ? WHERE id = ?", n, v.kind, v.title, at, a.id);
    const view = this.view(this.artifactRow(a.id)!);
    this.host.publish({
      kind: created ? "artifact.added" : "artifact.versioned", collection: "artifacts", key: `${repo}/${a.id}`, op: "upsert", repo, branch,
      ...who(by, v.machine), row: view,
    });

    return { artifact: view, created };
  }

  /** The branch's artifacts, newest first by their newest version. */
  list(repo: string, branch: string): ArtifactView[] {
    const key = this.branchKey(repo, branch);

    return this.rows<ArtifactRow>("SELECT * FROM artifacts WHERE repo = ? AND branch = ? AND branch_created_at = ? ORDER BY updated_at DESC, id DESC", repo, branch, key).map((a) => this.view(a));
  }

  /** One artifact with every version, oldest first. */
  get(id: string): (ArtifactView & { all_versions: VersionView[] }) | null {
    const a = this.artifactRow(id);

    if (!a) return null;

    return { ...this.view(a), all_versions: this.rows<VersionRow>("SELECT * FROM artifact_versions WHERE artifact = ? ORDER BY n", id).map((v) => this.versionView(v)) };
  }

  /** A version's R2 prefix and files. */
  version(id: string, n: number): VersionFound | null {
    const a = this.artifactRow(id);
    const v = a ? this.row<VersionRow>("SELECT * FROM artifact_versions WHERE artifact = ? AND n = ?", id, n) : null;

    if (!a || !v) return null;

    return { artifact: { id: a.id, name: a.name, kind: kindOf(a.kind) }, prefix: v.prefix, files: parsed<FileEntry[]>(v.files, []) };
  }

  /** Delete an artifact, every version and every comment (any member; no undo). Answers its versions' R2 prefixes. */
  delete(id: string, by: Identity, machine: string | null): string[] {
    const a = this.artifactRow(id) ?? fail(404, "not_found", `no artifact ${id}`);
    const prefixes = this.rows<{ prefix: string }>("SELECT prefix FROM artifact_versions WHERE artifact = ?", id).map((p) => p.prefix);
    this.sql.exec("DELETE FROM artifact_comments WHERE artifact = ?", id);
    this.sql.exec("DELETE FROM artifact_versions WHERE artifact = ?", id);
    this.sql.exec("DELETE FROM artifacts WHERE id = ?", id);
    this.host.publish({
      kind: "artifact.deleted", collection: "artifacts", key: `${a.repo}/${id}`, op: "delete", repo: a.repo, branch: a.branch,
      ...who(by, machine), row: { repo: a.repo, branch: a.branch, id, name: a.name },
    });

    return prefixes;
  }

  // ── Comments ─────────────────────────────────────────────────────────────

  private commentView(c: CommentRow, forEvent = false): CommentView {
    return {
      id: c.id, artifact: c.artifact, version: c.version, thread: c.thread, in_reply_to: c.in_reply_to, anchor: parsed<object | null>(c.anchor, null),
      body: forEvent && c.body !== null && c.body.length > EVENT_BODY_MAX ? null : c.body, body_version: c.body_version, author: c.author,
      machine: c.machine, mentions: parsed<string[]>(c.mentions, []), state: c.state === "resolved" ? "resolved" : "open",
      resolved_by: c.resolved_by, resolved_at: c.resolved_at, created_at: c.created_at, updated_at: c.updated_at,
    };
  }

  private commentRow(id: string): CommentRow | null {
    return this.row<CommentRow>("SELECT * FROM artifact_comments WHERE id = ?", id);
  }

  private announce(kind: string, a: ArtifactRow, c: CommentRow, by: Identity, machine: string | null): void {
    this.host.publish({
      kind, collection: "artifact_comments", key: `${a.repo}/${c.id}`, op: "upsert", repo: a.repo, branch: a.branch,
      ...who(by, machine), row: this.commentView(c, true),
    });
  }

  private announceGone(a: ArtifactRow, c: CommentRow, by: Identity, machine: string | null): void {
    this.host.publish({
      kind: "artifact_comment.deleted", collection: "artifact_comments", key: `${a.repo}/${c.id}`, op: "delete", repo: a.repo, branch: a.branch,
      ...who(by, machine), row: { id: c.id, artifact: c.artifact, thread: c.thread },
    });
  }

  /** A thread or a reply. Answers the comment, and whether it was an Idempotency-Key seen before. */
  addComment(artifactId: string, input: NewComment, by: Identity, key: string | null): CommentAdded {
    const a = this.artifactRow(artifactId) ?? fail(404, "not_found", `no artifact ${artifactId}`);

    if (key) {
      const had = this.row<CommentRow>("SELECT * FROM artifact_comments WHERE author = ? AND request_key = ?", by.login, key);

      if (had) return { comment: this.commentView(had), replayed: true };
    }

    let version = input.version ?? a.version;
    let thread: string | null = null;

    if (input.in_reply_to !== null) {
      const parent = this.commentRow(input.in_reply_to);

      if (!parent || parent.artifact !== a.id) fail(404, "not_found", `no comment ${input.in_reply_to} on ${a.name}`);
      thread = parent.thread;
      version = input.version ?? parent.version;
      const replies = this.row<{ n: number }>("SELECT COUNT(*) AS n FROM artifact_comments WHERE thread = ? AND id != thread", thread)?.n ?? 0;

      if (replies >= REPLIES_MAX) fail(409, "too_many_replies", `this thread has ${REPLIES_MAX} replies, the most one keeps; a longer talk belongs in an issue`);
    }

    if (version < 1 || version > a.version) fail(400, "bad_request", `version: 1 to ${a.version}, the versions of ${a.name}`);

    if (thread === null) {
      const threads = this.row<{ n: number }>("SELECT COUNT(*) AS n FROM artifact_comments WHERE artifact = ? AND version = ? AND in_reply_to IS NULL", a.id, version)?.n ?? 0;

      if (threads >= THREADS_MAX) fail(409, "too_many_threads", `v${version} of ${a.name} has ${THREADS_MAX} threads, the most one version keeps; resolve or delete some, or upload a new version`);
    }

    const id = hexId("ac_");
    const at = now();
    this.sql.exec(
      `INSERT INTO artifact_comments (id, artifact, version, thread, in_reply_to, anchor, body, body_version, author, machine, mentions, state, request_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'open', ?, ?, ?)`,
      id, a.id, version, thread ?? id, thread, thread === null ? input.anchor : null, input.body, by.login, input.machine, JSON.stringify(input.mentions), key, at, at,
    );
    const row = this.commentRow(id)!;
    this.announce("artifact_comment.added", a, row, by, input.machine);

    return { comment: this.commentView(row), replayed: false };
  }

  getComment(id: string): CommentView | null {
    const c = this.commentRow(id);

    return c ? this.commentView(c) : null;
  }

  /** Edit your own comment's body. `baseVersion` stale: 409 edited, with the comment as it is now. */
  editComment(id: string, body: string, mentions: string[], baseVersion: number | null, by: Identity, machine: string | null): CommentView {
    const c = this.commentRow(id) ?? fail(404, "not_found", `no comment ${id}`);

    if (c.author !== by.login) fail(403, "not_author", "only its author can edit a comment");

    if (c.body === null) fail(409, "deleted", "this comment was deleted");

    if (baseVersion !== null && baseVersion !== c.body_version) fail(409, "edited", "this comment changed since you opened it", { current: this.commentView(c) });
    this.sql.exec("UPDATE artifact_comments SET body = ?, mentions = ?, body_version = body_version + 1, updated_at = ? WHERE id = ?", body, JSON.stringify(mentions), now(), id);
    const row = this.commentRow(id)!;
    this.announce("artifact_comment.edited", this.artifactRow(c.artifact)!, row, by, machine);

    return this.commentView(row);
  }

  /** Resolve or reopen the thread a comment is in (any member). Answers the thread's root. */
  setState(id: string, state: "open" | "resolved", by: Identity, machine: string | null): CommentView {
    const c = this.commentRow(id) ?? fail(404, "not_found", `no comment ${id}`);
    const root = this.commentRow(c.thread)!;

    if (root.state === state) return this.commentView(root);
    const at = now();

    if (state === "resolved") this.sql.exec("UPDATE artifact_comments SET state = 'resolved', resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?", by.login, at, at, root.id);
    else this.sql.exec("UPDATE artifact_comments SET state = 'open', resolved_by = NULL, resolved_at = NULL, updated_at = ? WHERE id = ?", at, root.id);
    const row = this.commentRow(root.id)!;
    this.announce(state === "resolved" ? "artifact_comment.resolved" : "artifact_comment.reopened", this.artifactRow(c.artifact)!, row, by, machine);

    return this.commentView(row);
  }

  /**
   * Delete your own comment. A root with replies keeps its place with its body gone; a deleted root goes once its
   * last reply does.
   */
  deleteComment(id: string, by: Identity, machine: string | null): void {
    const c = this.commentRow(id) ?? fail(404, "not_found", `no comment ${id}`);

    if (c.author !== by.login) fail(403, "not_author", "only its author can delete a comment");
    const a = this.artifactRow(c.artifact)!;
    const replies = (thread: string) => this.row<{ n: number }>("SELECT COUNT(*) AS n FROM artifact_comments WHERE thread = ? AND id != thread", thread)?.n ?? 0;

    if (c.id === c.thread && replies(c.id) > 0) {
      if (c.body === null) return;
      this.sql.exec("UPDATE artifact_comments SET body = NULL, mentions = '[]', updated_at = ? WHERE id = ?", now(), id);
      this.announce("artifact_comment.deleted", a, this.commentRow(id)!, by, machine);

      return;
    }

    this.sql.exec("DELETE FROM artifact_comments WHERE id = ?", id);
    this.announceGone(a, c, by, machine);
    const root = c.id === c.thread ? null : this.commentRow(c.thread);

    if (root && root.body === null && replies(root.id) === 0) {
      this.sql.exec("DELETE FROM artifact_comments WHERE id = ?", root.id);
      this.announceGone(a, root, by, machine);
    }
  }

  private threads(where: string, args: SqlStorageValue[], state: "open" | "resolved" | null): ThreadsView {
    const all = this.rows<CommentRow>(`SELECT * FROM artifact_comments WHERE ${where} ORDER BY created_at, id`, ...args);
    const replies = new Map<string, CommentView[]>();

    for (const c of all) if (c.in_reply_to !== null) replies.set(c.thread, [...(replies.get(c.thread) ?? []), this.commentView(c)]);
    const roots = all.filter((c) => c.in_reply_to === null);

    return {
      threads: roots.filter((c) => state === null || c.state === state).map((c) => ({ ...this.commentView(c), replies: replies.get(c.id) ?? [] })),
      counts: { open: roots.filter((c) => c.state !== "resolved").length, resolved: roots.filter((c) => c.state === "resolved").length },
    };
  }

  /** An artifact's threads on every version, oldest first. */
  artifactThreads(id: string, state: "open" | "resolved" | null): ThreadsView {
    if (!this.artifactRow(id)) fail(404, "not_found", `no artifact ${id}`);

    return this.threads("artifact = ?", [id], state);
  }

  /** Every artifact's threads on a branch. */
  branchThreads(repo: string, branch: string, state: "open" | "resolved" | null): ThreadsView {
    const key = this.branchKey(repo, branch);

    return this.threads("artifact IN (SELECT id FROM artifacts WHERE repo = ? AND branch = ? AND branch_created_at = ?)", [repo, branch, key], state);
  }
}
