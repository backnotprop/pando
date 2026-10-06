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
CREATE TABLE IF NOT EXISTS release_files (
  release TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, content_type TEXT NOT NULL,
  uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL, PRIMARY KEY (release, name));

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, environment TEXT NOT NULL, sha TEXT NOT NULL, release TEXT, state TEXT NOT NULL,
  url TEXT, description TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS deployments_env ON deployments (repo, environment, created_at DESC);
CREATE INDEX IF NOT EXISTS deployments_repo ON deployments (repo, created_at DESC);
`;

/** Files per release (lane limit, approved 2026-10-06; GitHub allows 1,000). */
export const FILES_MAX = 20;

/** One release file, in bytes: under the Workers request body limit (100 MB on the Free and Pro plans), approved 2026-10-06. */
export const FILE_MAX_BYTES = 100_000_000;

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

/** A file of a release; its bytes are in R2 (BLOBS) at fileKey(). */
export type ReleaseFileView = {
  name: string;
  size: number;
  sha256: string;
  content_type: string;
  uploaded_by: string;
  uploaded_at: string;
};

type FileRow = ReleaseFileView & { release: string };

/** Where a release's files live in R2 (BLOBS): one prefix per release, so deleting it deletes them all. */
export function filesPrefix(monorepo: string, repo: string, releaseId: string): string {
  return `releases/${monorepo}/${repo}/${releaseId}/`;
}

/** What an upload needs before it sends bytes: the release's id (for the R2 key), and whether one more file fits. */
export interface FileSlot {
  release_id: string;
  replacing: boolean;
}

/** A file to download: where its bytes are, and its record. */
export interface FileFound {
  key: string;
  file: ReleaseFileView;
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
  files: ReleaseFileView[];
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

export type DeploymentState = "in_progress" | "success" | "failure";

/** A deployment as recorded: a commit (and its release, if any) reached an environment, posted by the CI or a deploy script. */
export type DeploymentView = {
  id: string;
  repo: string;
  environment: string;
  sha: string;
  /** The published release at that commit (named, or found), or null. */
  release: string | null;
  state: DeploymentState;
  url: string | null;
  description: string | null;
  created_by: string;
  created_at: string;
};

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

    // The per-project switch "Anyone can download releases" (off: members only).
    if (!this.rows<{ name: string }>("PRAGMA table_info(repos)").some((c) => c.name === "releases_public")) {
      this.sql.exec("ALTER TABLE repos ADD COLUMN releases_public INTEGER NOT NULL DEFAULT 0");
    }
  }

  // ── The download switch ──────────────────────────────────────────────────

  releasesPublic(repo: string): boolean {
    return this.row<{ v: number }>("SELECT releases_public AS v FROM repos WHERE name = ?", repo)?.v === 1;
  }

  setReleasesPublic(repo: string, on: boolean): void {
    this.sql.exec("UPDATE repos SET releases_public = ? WHERE name = ?", on ? 1 : 0, repo);
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
    const files = this.rows<FileRow>("SELECT * FROM release_files WHERE release = ? ORDER BY name", r.id).map(({ release: _r, ...f }) => f);

    return {
      repo: r.repo, tag: r.tag, sha: r.sha, title: r.title, notes: r.notes, draft: r.draft === 1, forced: r.forced === 1,
      created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, published_by: r.published_by, published_at: r.published_at, files,
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
    this.sql.exec("DELETE FROM release_files WHERE release = ?", r.id);
    this.announce("release.deleted", r, by);

    return r.id;
  }

  // ── Files (bytes in R2, written and read by the Worker) ──────────────────

  /** Before an upload: the release, and whether this name fits (a new name past FILES_MAX does not; a replaced one does). */
  fileSlot(repo: string, tag: string, name: string): FileSlot {
    const r = this.releaseRow(repo, tag) ?? fail(404, "not_found", `no release ${tag}`);
    const replacing = !!this.row("SELECT name FROM release_files WHERE release = ? AND name = ?", r.id, name);
    const n = this.row<{ n: number }>("SELECT COUNT(*) AS n FROM release_files WHERE release = ?", r.id)?.n ?? 0;

    if (!replacing && n >= FILES_MAX) fail(409, "too_many_files", `${tag} has ${FILES_MAX} files, the most a release keeps; delete one first`);

    return { release_id: r.id, replacing };
  }

  /** After the bytes are in R2: the file's record (a name uploaded again replaces it). Refused when the release went or filled up meanwhile. */
  addFile(repo: string, tag: string, releaseId: string, f: Omit<ReleaseFileView, "uploaded_by" | "uploaded_at">, by: Identity): ReleaseView {
    const r = this.releaseRow(repo, tag);

    if (!r || r.id !== releaseId) fail(404, "not_found", `release ${tag} was deleted while the file was uploading`);
    this.fileSlot(repo, tag, f.name);
    const at = now();
    this.sql.exec(
      `INSERT INTO release_files (release, name, size, sha256, content_type, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (release, name) DO UPDATE SET size = excluded.size, sha256 = excluded.sha256, content_type = excluded.content_type,
         uploaded_by = excluded.uploaded_by, uploaded_at = excluded.uploaded_at`,
      r.id, f.name, f.size, f.sha256, f.content_type, by.login, at,
    );
    this.sql.exec("UPDATE releases SET updated_at = ? WHERE id = ?", at, r.id);
    const row = this.releaseRow(repo, tag)!;
    this.announce("release.updated", row, by);

    return this.view(row);
  }

  /** A file's record and its R2 key; `latest` is the newest published release's. */
  file(monorepo: string, repo: string, tag: string, name: string): FileFound | null {
    const r = tag === "latest" ? this.row<ReleaseRow>("SELECT * FROM releases WHERE repo = ? AND draft = 0 ORDER BY published_at DESC, id DESC LIMIT 1", repo) : this.releaseRow(repo, tag);
    const f = r ? this.row<FileRow>("SELECT * FROM release_files WHERE release = ? AND name = ?", r.id, name) : null;

    if (!r || !f) return null;
    const { release: _r, ...file } = f;

    return { key: `${filesPrefix(monorepo, repo, r.id)}${name}`, file };
  }

  /** Delete one file's record; answers its R2 key. */
  deleteFile(monorepo: string, repo: string, tag: string, name: string, by: Identity): string {
    const r = this.releaseRow(repo, tag) ?? fail(404, "not_found", `no release ${tag}`);

    if (!this.sql.exec("DELETE FROM release_files WHERE release = ? AND name = ?", r.id, name).rowsWritten) fail(404, "not_found", `${tag} has no file ${name}`);
    this.sql.exec("UPDATE releases SET updated_at = ? WHERE id = ?", now(), r.id);
    this.announce("release.updated", this.releaseRow(repo, tag)!, by);

    return `${filesPrefix(monorepo, repo, r.id)}${name}`;
  }

  // ── Deployments (recorded only: the CI or a deploy script deploys and posts) ──

  /** Record one. `release` named must be a published release; else the newest published release at its commit, if any. */
  addDeployment(repo: string, d: { environment: string; sha: string; release: string | null; state: DeploymentState; url: string | null; description: string | null }, by: Identity): DeploymentView {
    let release = d.release;

    if (release !== null && !this.row("SELECT id FROM releases WHERE repo = ? AND tag = ? AND draft = 0", repo, release)) fail(404, "not_found", `no published release ${release}`);
    release ??= this.row<{ tag: string }>("SELECT tag FROM releases WHERE repo = ? AND sha = ? AND draft = 0 ORDER BY published_at DESC LIMIT 1", repo, d.sha)?.tag ?? null;
    const id = hexId("dep_");
    this.sql.exec(
      "INSERT INTO deployments (id, repo, environment, sha, release, state, url, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, repo, d.environment, d.sha, release, d.state, d.url, d.description, by.login, now(),
    );

    return this.row<DeploymentView>("SELECT * FROM deployments WHERE id = ?", id)!;
  }

  /** Newest first, of one environment or all. */
  deployments(repo: string, environment: string | null, limit: number): DeploymentView[] {
    const n = Math.min(Math.max(limit, 1), RELEASES_PAGE_MAX);

    return environment
      ? this.rows<DeploymentView>("SELECT * FROM deployments WHERE repo = ? AND environment = ? ORDER BY created_at DESC, id DESC LIMIT ?", repo, environment, n)
      : this.rows<DeploymentView>("SELECT * FROM deployments WHERE repo = ? ORDER BY created_at DESC, id DESC LIMIT ?", repo, n);
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
