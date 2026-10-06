// The monorepo object's tags and releases (research/plans/releases-2026-10-04).
//
// Tags are recorded by the git door from refs/tags/* as pushes land (an
// annotated tag peeled to its commit), with tag.created and tag.deleted on
// the stream and a `tag` hook event. A release is a tag on a project's main
// with a title and notes; a published release freezes its tag (the door
// refuses to move or delete it) until the release is deleted.
//
// One instance lives in each MonorepoObject and shares its SQLite. Git reads
// (peeling, "is this commit on main") happen in the Worker before it calls in.

import { HttpError, now } from "../http";
import type { PushVerdict } from "../monorepo/object";
import type { RefCommand } from "../monorepo/pktline";
import type { Identity, ObjectInfo, RepoEvent, StreamEvent } from "../monorepo/types";
import { ZERO } from "../monorepo/names";
import { notesMarkdown, walkMerges, type NotesLine } from "./notes";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tags (
  repo TEXT NOT NULL, name TEXT NOT NULL, object TEXT NOT NULL, sha TEXT,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (repo, name));
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, tag TEXT NOT NULL, sha TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL,
  draft INTEGER NOT NULL, forced INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, published_by TEXT, published_at TEXT, sort_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS releases_tag ON releases (repo, tag);
CREATE INDEX IF NOT EXISTS releases_sort ON releases (repo, sort_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS merges_commit ON merges (repo, merge_commit);
`;

/** Releases per page (lane limit, approved 2026-10-06). */
export const RELEASES_PAGE = 30;

export const RELEASES_PAGE_MAX = 100;

type Row = Record<string, SqlStorageValue>;

type TagRow = { repo: string; name: string; object: string; sha: string | null; created_by: string | null; created_at: string; updated_at: string };

type ReleaseRow = {
  id: string;
  repo: string;
  tag: string;
  sha: string;
  title: string;
  notes: string;
  draft: number;
  forced: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  published_by: string | null;
  published_at: string | null;
  sort_at: string;
};

/** A tag as the API lists it. */
export interface TagView {
  name: string;
  /** The commit it names (an annotated tag peeled); null until Pando has read it. */
  sha: string | null;
  /** An annotated tag: a tag object of its own, not the commit. */
  annotated: boolean;
  /** Who pushed it (null when the refs were found, not pushed through Pando). */
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** A published release holds it: git can't move or delete it. */
  frozen: boolean;
}

export interface ReleaseView {
  repo: string;
  tag: string;
  sha: string;
  title: string;
  notes: string;
  draft: boolean;
  /** Published past red or missing required checks. */
  forced: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  published_by: string | null;
  published_at: string | null;
}

export interface ReleasesPage {
  releases: ReleaseView[];
  next_cursor: string | null;
}

/** Generated notes: the Markdown, how many merges it lists and counts past the limit, and the release it starts from. */
export interface GeneratedNotes {
  markdown: string;
  merges: number;
  more: number;
  since: string | null;
}

export interface ReleaseHost {
  info(): ObjectInfo | null;
  publish(e: StreamEvent): number;
}

function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

function hexId(prefix: string, bytes = 8): string {
  return prefix + [...crypto.getRandomValues(new Uint8Array(bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function cursorOf(sortAt: string, id: string): string {
  return btoa(`${sortAt} ${id}`);
}

function decodeCursor(s: string): { sort_at: string; id: string } | null {
  try {
    const [sort_at, id] = atob(s).split(" ");

    return sort_at && id ? { sort_at, id } : null;
  } catch {
    return null;
  }
}

export class ReleaseStore {
  constructor(
    private sql: SqlStorage,
    private host: ReleaseHost,
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

  // ── Tags ─────────────────────────────────────────────────────────────────

  private published(repo: string, tag: string): boolean {
    return !!this.row("SELECT id FROM releases WHERE repo = ? AND tag = ? AND draft = 0", repo, tag);
  }

  /** The door's rule for tags: a published release's tag is never moved or deleted by a push. */
  frozenRefusals(repo: string, commands: RefCommand[]): PushVerdict[] {
    return commands.flatMap((c) => {
      if (!c.ref.startsWith("refs/tags/")) return [];
      const tag = c.ref.slice(10);

      return this.published(repo, tag)
        ? [{ ref: c.ref, reason: `tag ${tag} belongs to the published release ${tag}; delete the release first to move or delete it (pando release delete ${tag})` }]
        : [];
    });
  }

  private tagView(t: TagRow): TagView {
    return {
      name: t.name, sha: t.sha, annotated: t.sha !== null && t.sha !== t.object, created_by: t.created_by,
      created_at: t.created_at, updated_at: t.updated_at, frozen: this.published(t.repo, t.name),
    };
  }

  /**
   * Record the tag commands of a landed push (or a tag Pando made): each
   * created, moved or deleted, with its event on the stream. `commits` maps
   * a tag's name to its commit when the door peeled it. Returns the `tag`
   * hook events.
   */
  recordTags(repo: string, by: Identity | null, commands: RefCommand[], commits: Record<string, string>): RepoEvent[] {
    const events: RepoEvent[] = [];
    const at = now();
    const who = { actor: by?.login ?? null, machine: by?.credential_name ?? null, agent: by?.agent ?? null };

    for (const c of commands) {
      if (!c.ref.startsWith("refs/tags/")) continue;
      const name = c.ref.slice(10);
      const base = { event: "tag" as const, repo, branch: name, ref: c.ref, before: c.old, base: null, author: by?.login ?? null, pusher: by?.login ?? null, title: null, description: null, tag: name };

      if (c.new === ZERO) {
        this.sql.exec("DELETE FROM tags WHERE repo = ? AND name = ?", repo, name);
        const seq = this.host.publish({ kind: "tag.deleted", collection: "tags", key: `${repo}/${name}`, op: "delete", repo, ...who, row: { repo, name } });
        events.push({ ...base, head: ZERO, seq: seq || null });
        continue;
      }

      const sha = commits[name] ?? null;
      this.sql.exec(
        `INSERT INTO tags (repo, name, object, sha, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, name) DO UPDATE SET object = excluded.object, sha = excluded.sha, created_by = excluded.created_by, updated_at = excluded.updated_at`,
        repo, name, c.new, sha, by?.login ?? null, at, at,
      );
      const view = this.tagView(this.row<TagRow>("SELECT * FROM tags WHERE repo = ? AND name = ?", repo, name)!);
      const seq = this.host.publish({ kind: "tag.created", collection: "tags", key: `${repo}/${name}`, op: "upsert", repo, ...who, row: { repo, ...view } });
      events.push({ ...base, head: sha ?? c.new, seq: seq || null });
    }

    return events;
  }

  /** Commits read for tags recorded without one (the door's read failed), by name. */
  setTagCommits(repo: string, commits: Record<string, string>): void {
    for (const [name, sha] of Object.entries(commits)) this.sql.exec("UPDATE tags SET sha = ? WHERE repo = ? AND name = ? AND sha IS NULL", sha, repo, name);
  }

  tags(repo: string): TagView[] {
    return this.rows<TagRow>("SELECT * FROM tags WHERE repo = ? ORDER BY created_at DESC, name DESC", repo).map((t) => this.tagView(t));
  }

  tag(repo: string, name: string): TagView | null {
    const t = this.row<TagRow>("SELECT * FROM tags WHERE repo = ? AND name = ?", repo, name);

    return t ? this.tagView(t) : null;
  }

  // ── Releases ─────────────────────────────────────────────────────────────

  private view(r: ReleaseRow): ReleaseView {
    return {
      repo: r.repo, tag: r.tag, sha: r.sha, title: r.title, notes: r.notes, draft: r.draft === 1, forced: r.forced === 1,
      created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, published_by: r.published_by, published_at: r.published_at,
    };
  }

  private releaseRow(repo: string, tag: string): ReleaseRow | null {
    return this.row<ReleaseRow>("SELECT * FROM releases WHERE repo = ? AND tag = ?", repo, tag);
  }

  private announce(kind: string, r: ReleaseRow, by: Identity): void {
    this.host.publish({
      kind, collection: "releases", key: `${r.repo}/${r.tag}`, op: kind === "release.deleted" ? "delete" : "upsert", repo: r.repo,
      actor: by.login, machine: by.credential_name, agent: by.agent ?? null,
      row: kind === "release.deleted" ? { repo: r.repo, tag: r.tag } : this.view(r),
    });
  }

  release(repo: string, tag: string): ReleaseView | null {
    const r = this.releaseRow(repo, tag);

    return r ? this.view(r) : null;
  }

  /** The newest published release. */
  latest(repo: string): ReleaseView | null {
    const r = this.row<ReleaseRow>("SELECT * FROM releases WHERE repo = ? AND draft = 0 ORDER BY published_at DESC, id DESC LIMIT 1", repo);

    return r ? this.view(r) : null;
  }

  /** Newest first: a draft by when it was made, a published release by when it was published. */
  releases(repo: string, limit: number, cursor: string | null): ReleasesPage {
    const n = Math.min(Math.max(limit, 1), RELEASES_PAGE_MAX);
    const k = cursor ? (decodeCursor(cursor) ?? fail(400, "bad_request", "cursor: pass back next_cursor as it came")) : null;

    const rows = k
      ? this.rows<ReleaseRow>("SELECT * FROM releases WHERE repo = ? AND (sort_at < ? OR (sort_at = ? AND id < ?)) ORDER BY sort_at DESC, id DESC LIMIT ?", repo, k.sort_at, k.sort_at, k.id, n + 1)
      : this.rows<ReleaseRow>("SELECT * FROM releases WHERE repo = ? ORDER BY sort_at DESC, id DESC LIMIT ?", repo, n + 1);

    const page = rows.slice(0, n);
    const last = page.at(-1);

    return { releases: page.map((r) => this.view(r)), next_cursor: rows.length > n && last ? cursorOf(last.sort_at, last.id) : null };
  }

  /** A draft release at a commit the Worker found on main. Published by publish(). */
  createRelease(repo: string, r: { tag: string; sha: string; title: string; notes: string }, by: Identity): ReleaseView {
    if (this.releaseRow(repo, r.tag)) fail(409, "release_exists", `${r.tag} has a release already`);
    const at = now();
    const id = hexId("rel_");
    this.sql.exec(
      "INSERT INTO releases (id, repo, tag, sha, title, notes, draft, created_by, created_at, updated_at, sort_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
      id, repo, r.tag, r.sha, r.title, r.notes, by.login, at, at, at,
    );
    const row = this.releaseRow(repo, r.tag)!;
    this.announce("release.created", row, by);

    return this.view(row);
  }

  updateRelease(repo: string, tag: string, patch: { title?: string; notes?: string }, by: Identity): ReleaseView {
    const r = this.releaseRow(repo, tag) ?? fail(404, "not_found", `no release ${tag}`);
    this.sql.exec("UPDATE releases SET title = ?, notes = ?, updated_at = ? WHERE id = ?", patch.title ?? r.title, patch.notes ?? r.notes, now(), r.id);
    const row = this.releaseRow(repo, tag)!;
    this.announce("release.updated", row, by);

    return this.view(row);
  }

  /** Publish a draft whose checks the Worker passed (or forced) and whose tag is at its commit. Its tag is frozen from now on. */
  publishDraft(repo: string, tag: string, forced: boolean, by: Identity): ReleaseView {
    const r = this.releaseRow(repo, tag) ?? fail(404, "not_found", `no release ${tag}`);

    if (r.draft === 0) fail(409, "published", `${tag} is published already`);
    const t = this.row<TagRow>("SELECT * FROM tags WHERE repo = ? AND name = ?", repo, tag);

    if (!t || t.sha !== r.sha) fail(409, "tag_moved", `tag ${tag} is not at ${r.sha.slice(0, 12)} any more; delete this draft and make it again`);
    const at = now();
    this.sql.exec("UPDATE releases SET draft = 0, forced = ?, published_by = ?, published_at = ?, updated_at = ?, sort_at = ? WHERE id = ?", forced ? 1 : 0, by.login, at, at, at, r.id);
    const row = this.releaseRow(repo, tag)!;
    this.announce("release.published", row, by);

    return this.view(row);
  }

  /** Delete a release (its tag stays, and is free again). Returns its id, for its files. */
  deleteRelease(repo: string, tag: string, by: Identity): string {
    const r = this.releaseRow(repo, tag) ?? fail(404, "not_found", `no release ${tag}`);
    this.sql.exec("DELETE FROM releases WHERE id = ?", r.id);
    this.announce("release.deleted", r, by);

    return r.id;
  }

  // ── Notes ────────────────────────────────────────────────────────────────

  /** Notes written from the merges that brought main to `sha` since the newest other published release on its way. */
  generateNotes(repo: string, sha: string, tag: string): GeneratedNotes {
    const stops = new Map(
      this.rows<{ sha: string; tag: string }>("SELECT sha, tag FROM releases WHERE repo = ? AND draft = 0 AND tag != ? ORDER BY published_at", repo, tag).map((r) => [r.sha, r.tag]),
    );

    type MergeRow = { id: number; branch: string; base_before: string; merged_by: string };

    const walk = walkMerges(
      sha,
      (c) => this.row<MergeRow>("SELECT id, branch, base_before, merged_by FROM merges WHERE repo = ? AND merge_commit = ? ORDER BY id DESC LIMIT 1", repo, c),
      stops,
    );

    const ids = walk.merges.map((m) => m.id);
    const closes = new Map<number, number[]>();

    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);

      for (const x of this.rows<{ number: number; merge: number }>(
        `SELECT number, closed_by_merge AS merge FROM issues WHERE closed_by_merge IN (${chunk.map(() => "?").join(",")}) ORDER BY number`, ...chunk,
      )) {
        closes.set(x.merge, [...(closes.get(x.merge) ?? []), x.number]);
      }
    }

    const lines: NotesLine[] = walk.merges.map((m) => ({
      branch: m.branch,
      title: this.row<{ title: string | null }>("SELECT title FROM branches WHERE repo = ? AND name = ?", repo, m.branch)?.title ?? null,
      merged_by: m.merged_by,
      closes: closes.get(m.id) ?? [],
    }));

    return { markdown: notesMarkdown(lines, walk.more, walk.since), merges: lines.length, more: walk.more, since: walk.since };
  }
}
