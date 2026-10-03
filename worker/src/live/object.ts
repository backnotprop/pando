// Meta layer object: one per monorepo. It keeps every saved version in SQLite,
// sends each accepted change to every other machine over a hibernating
// WebSocket, and commits changes to the meta layer's main after 10 s of quiet.
// Owned by the live lane. The wire is docs/contracts/meta-sync.md.
import { DurableObject } from "cloudflare:workers";
import { checkBytes, checkPath, MAX_BYTES, type Refusal } from "./rules";
import { exactBuffer, fromBase64, gitBlobSha, toBase64 } from "./bytes";
import { gitWriter, type CommitEnv, type FileChange, type GitWriter } from "./commit";

export type MetaEnv = CommitEnv;

const QUIET_MS = 10_000; // commit a path after this much quiet
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 600_000;
const PAGE_BYTES = 4 * 1024 * 1024; // catch-up page size
const PAGE_ROWS = 1000;

type Op = "save" | "delete" | "rename";
type Source = "live" | "restore" | "main";

interface Attachment {
  id: string;
  author: string;
  machine: string;
  agent: string | null;
  fixed: boolean; // identity came from the Worker, not from hello
  hello: boolean;
  live: boolean; // caught up: receives every new change
}

interface VersionRow {
  version: number;
  path: string;
  op: Op;
  sha: string | null;
  size: number | null;
  deleted: number;
  moved: string | null; // a rename's other path
  author: string;
  machine: string;
  agent: string | null;
  at: number;
  source: Source;
  restored_from: number | null;
  commit_sha: string | null;
}

interface Current {
  version: number;
  sha: string | null;
  deleted: boolean;
}

interface NewVersion {
  path: string;
  op: Op;
  sha: string | null;
  bytes?: Uint8Array;
  size: number | null;
  deleted: boolean;
  moved?: string | null;
  author: string;
  machine: string;
  agent: string | null;
  source: Source;
  restored_from?: number | null;
  commit_sha?: string | null;
}

export interface MainChange {
  path: string;
  bytes: Uint8Array | ArrayBuffer | null; // null: deleted
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function int(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body) + "\n", {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Errors have the /v1 API's shape: {"error": {"code", "message"}}.
function fail(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function parsePerson(author: string): { name: string; email: string } {
  const m = author.match(/^\s*(.*?)\s*<([^>]*)>\s*$/);
  if (m && m[2]) return { name: m[1] || m[2], email: m[2] };
  return { name: author || "unknown", email: "unknown@pando.invalid" };
}

export class MetaLayerObject extends DurableObject<MetaEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: MetaEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS blobs (sha TEXT PRIMARY KEY, size INTEGER NOT NULL, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (
        version INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        op TEXT NOT NULL,
        sha TEXT,
        size INTEGER,
        deleted INTEGER NOT NULL,
        moved TEXT,
        author TEXT NOT NULL,
        machine TEXT NOT NULL,
        agent TEXT,
        at INTEGER NOT NULL,
        source TEXT NOT NULL,
        restored_from INTEGER,
        commit_sha TEXT
      );
      CREATE INDEX IF NOT EXISTS versions_by_path ON versions(path, version);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, version INTEGER NOT NULL, sha TEXT, deleted INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS files_by_version ON files(version);
      CREATE TABLE IF NOT EXISTS pending (path TEXT PRIMARY KEY, version INTEGER NOT NULL, due INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    `);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---- HTTP ----

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const monorepo = request.headers.get("x-pando-monorepo");
    if (monorepo && this.kv("monorepo") !== monorepo) this.setKv("monorepo", monorepo);
    const metaRepo = request.headers.get("x-pando-meta-repo");
    if (metaRepo && this.kv("meta_repo") !== metaRepo) this.setKv("meta_repo", metaRepo);

    const action = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    switch (action) {
      case "socket":
        return this.openSocket(request);
      case "history":
        return this.history(url);
      case "file":
        return this.file(url);
      case "restore":
        if (request.method !== "POST") return fail(405, "method_not_allowed", "use POST");
        return this.restore(request);
      case "status":
        return json(this.status());
    }
    return fail(404, "not_found", "no such meta layer route");
  }

  private openSocket(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return fail(426, "upgrade_required", "expected a WebSocket upgrade");
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    // Set by the Worker from the checked token (route.ts); absent until auth is wired.
    const author = request.headers.get("x-pando-author");
    const agent = request.headers.get("x-pando-agent");
    const att: Attachment = {
      id: crypto.randomUUID(),
      author: author ?? "",
      machine: "",
      agent: agent || null,
      fixed: author !== null,
      hello: false,
      live: false,
    };
    server.serializeAttachment(att);
    return new Response(null, { status: 101, webSocket: client });
  }

  private history(url: URL): Response {
    const path = url.searchParams.get("path");
    const limit = Math.min(Math.max(int(url.searchParams.get("limit"), 50), 1), 1000);
    let rows: VersionRow[];
    if (path) {
      const before = int(url.searchParams.get("before"), Number.MAX_SAFE_INTEGER);
      rows = this.sql
        .exec<any>(
          "SELECT * FROM versions WHERE path = ? AND version < ? ORDER BY version DESC LIMIT ?",
          path,
          before,
          limit,
        )
        .toArray() as VersionRow[];
    } else {
      const since = int(url.searchParams.get("since"));
      rows = this.sql
        .exec<any>("SELECT * FROM versions WHERE version > ? ORDER BY version ASC LIMIT ?", since, limit)
        .toArray() as VersionRow[];
    }
    return json({ path, head: this.head(), versions: rows.map((r) => this.historyEntry(r)) });
  }

  private historyEntry(r: VersionRow) {
    return {
      version: r.version,
      path: r.path,
      op: r.op,
      sha: r.sha,
      size: r.size,
      deleted: !!r.deleted,
      author: r.author,
      machine: r.machine,
      agent: r.agent,
      at: r.at,
      source: r.source,
      from: r.op === "rename" && !r.deleted ? r.moved : null,
      to: r.op === "rename" && r.deleted ? r.moved : null,
      restored_from: r.restored_from,
      commit: r.commit_sha,
    };
  }

  // The path as it was at a version (its latest change at or before it).
  private versionAt(path: string, version: number | null): VersionRow | null {
    const rows = this.sql
      .exec<any>(
        "SELECT * FROM versions WHERE path = ? AND version <= ? ORDER BY version DESC LIMIT 1",
        path,
        version ?? Number.MAX_SAFE_INTEGER,
      )
      .toArray() as VersionRow[];
    return rows[0] ?? null;
  }

  private file(url: URL): Response {
    const path = url.searchParams.get("path") ?? "";
    const v = url.searchParams.get("version");
    const row = this.versionAt(path, v === null ? null : int(v));
    if (!row || row.deleted || !row.sha) return fail(404, "not_found", "no such file at that version");
    return new Response(this.blob(row.sha), {
      headers: {
        "content-type": "application/octet-stream",
        "x-pando-version": String(row.version),
        "x-pando-sha": row.sha,
      },
    });
  }

  private async restore(request: Request): Promise<Response> {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return fail(400, "invalid_input", "send JSON");
    }
    const path = str(body?.path);
    const bad = checkPath(path);
    if (bad) return fail(bad.status, bad.reason, bad.message);
    const target = this.versionAt(path, int(body?.version));
    if (!target) return fail(404, "not_found", `${path} has no version at or before ${body?.version}`);

    // From here to the broadcast nothing awaits, so no other change interleaves.
    const fixed = request.headers.get("x-pando-author");
    const author = fixed ?? (str(body?.author) || "unknown");
    const agent = fixed !== null ? request.headers.get("x-pando-agent") || null : str(body?.agent) || null;
    const machine = str(body?.machine) || "unknown";
    const cur = this.current(path);
    const same = target.deleted ? !cur || cur.deleted : !!cur && !cur.deleted && cur.sha === target.sha;
    if (same) return json({ path, unchanged: true, version: cur?.version ?? 0 });

    const version = this.insert({
      path,
      op: target.deleted ? "delete" : "save",
      sha: target.deleted ? null : target.sha,
      size: target.deleted ? null : target.size,
      deleted: !!target.deleted,
      author,
      machine,
      agent,
      source: "restore",
      restored_from: target.version,
    });
    this.broadcast(this.changeMessage(this.row(version)));
    await this.scheduleCommit();
    return json({ path, version, sha: target.deleted ? null : target.sha, restored_from: target.version });
  }

  private status() {
    const files = this.sql.exec<any>("SELECT COUNT(*) AS n FROM files WHERE deleted = 0").one().n as number;
    const uncommitted = this.sql.exec<any>("SELECT COUNT(*) AS n FROM pending").one().n as number;
    return {
      monorepo: this.kv("monorepo"),
      head: this.head(),
      files,
      uncommitted,
      sockets: this.ctx.getWebSockets().length,
      last_commit: this.kv("parent"),
      commit_error: gitWriter(this.env) ? this.kv("commit_error") : "gitwrite is not wired yet",
    };
  }

  // ---- WebSocket ----

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return this.send(ws, { type: "error", message: "send JSON text frames" });
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(ws, { type: "error", message: "bad JSON" });
    }
    const att = ws.deserializeAttachment() as Attachment;
    switch (msg?.type) {
      case "hello":
        return this.hello(ws, att, msg);
      case "save":
      case "delete":
      case "rename":
        if (!att.hello) return this.send(ws, { type: "error", message: "send hello first" });
        // Decode and hash first: the only await. change() then reads, checks the
        // base and writes with no await, so no other change can slip in between.
        if (msg.type === "save" && typeof msg.bytes === "string") {
          const bytes = fromBase64(msg.bytes);
          if (bytes) {
            msg.decoded = bytes;
            msg.computedSha = await gitBlobSha(bytes);
          }
        }
        if (this.change(ws, att, msg)) await this.scheduleCommit();
        return;
    }
    this.send(ws, { type: "error", message: `unknown message type ${JSON.stringify(msg?.type)}` });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(_ws: WebSocket): Promise<void> {}

  private send(ws: WebSocket, msg: unknown): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // the socket went away; its close event cleans up
    }
  }

  private broadcast(msg: unknown, exceptId?: string): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a?.live || a.id === exceptId) continue;
      try {
        ws.send(text);
      } catch {
        // closed
      }
    }
  }

  private hello(ws: WebSocket, att: Attachment, msg: any): void {
    if (!att.fixed) {
      att.author = str(msg.author) || "unknown";
      att.agent = str(msg.agent) || null;
    }
    att.machine = str(msg.machine) || "unknown";
    att.hello = true;
    const head = this.head();
    let since = int(msg.since);
    if (since > head) since = 0; // the client saw a different history: send everything
    this.send(ws, { type: "welcome", head, monorepo: this.kv("monorepo"), max_bytes: MAX_BYTES });

    // One page of the latest change per path above `since`. No awaits here, so
    // marking the socket live below cannot miss a change.
    // A machine starting from 0 has nothing to delete, so it gets no deletes.
    const skipDeleted = since === 0 ? 1 : 0;
    const rows = this.sql
      .exec<any>(
        "SELECT version FROM files WHERE version > ? AND NOT (deleted = 1 AND ? = 1) ORDER BY version LIMIT ?",
        since,
        skipDeleted,
        PAGE_ROWS,
      )
      .toArray() as { version: number }[];
    let bytes = 0;
    let last = since;
    for (const r of rows) {
      const change = this.changeMessage(this.row(r.version));
      this.send(ws, change);
      bytes += change.size ?? 0;
      last = r.version;
      if (bytes >= PAGE_BYTES) break;
    }
    const more =
      this.sql
        .exec<any>("SELECT COUNT(*) AS n FROM files WHERE version > ? AND NOT (deleted = 1 AND ? = 1)", last, skipDeleted)
        .one().n > 0;
    att.live = !more;
    ws.serializeAttachment(att);
    this.send(ws, { type: "caught_up", head: more ? last : head, more });
  }

  // change applies a save, delete or rename. It returns true when a version was added.
  private change(ws: WebSocket, att: Attachment, msg: any): boolean {
    const id = str(msg.id);
    const refuse = (path: unknown, r: Refusal) => {
      this.send(ws, { type: "refused", id, status: r.status, path, reason: r.reason, message: r.message });
      return false;
    };
    const who = { author: att.author, machine: att.machine, agent: att.agent };

    if (msg.type === "save") {
      const path = str(msg.path);
      const badPath = checkPath(path);
      if (badPath) return refuse(msg.path, badPath);
      const bytes = msg.decoded as Uint8Array | undefined;
      if (!bytes) return refuse(path, { reason: "bad_sha", status: 400, message: "bytes missing or not base64" });
      const badBytes = checkBytes(bytes);
      if (badBytes) return refuse(path, badBytes);
      const sha = msg.computedSha as string;
      if (msg.sha !== sha) return refuse(path, { reason: "bad_sha", status: 400, message: "sha does not match bytes" });
      const base = int(msg.base_version, -1);
      const cur = this.current(path);
      if (!this.baseMatches(cur, base)) return this.stale(ws, id, path, base, cur);
      if (cur && !cur.deleted && cur.sha === sha) {
        this.send(ws, { type: "accepted", id, path, version: cur.version, sha }); // nothing changed
        return false;
      }
      const version = this.insert({ path, op: "save", sha, bytes, size: bytes.length, deleted: false, ...who, source: "live" });
      this.send(ws, { type: "accepted", id, path, version, sha });
      this.broadcast(this.changeMessage(this.row(version)), att.id);
      return true;
    }

    if (msg.type === "delete") {
      const path = str(msg.path);
      const badPath = checkPath(path);
      if (badPath) return refuse(msg.path, badPath);
      const base = int(msg.base_version, -1);
      const cur = this.current(path);
      if (!cur || cur.deleted) {
        this.send(ws, { type: "accepted", id, path, version: cur?.version ?? 0, sha: null }); // already absent
        return false;
      }
      if (cur.version !== base) return this.stale(ws, id, path, base, cur);
      const version = this.insert({ path, op: "delete", sha: null, size: null, deleted: true, ...who, source: "live" });
      this.send(ws, { type: "accepted", id, path, version, sha: null });
      this.broadcast(this.changeMessage(this.row(version)), att.id);
      return true;
    }

    // rename
    const from = str(msg.from);
    const path = str(msg.path);
    const badFrom = checkPath(from);
    if (badFrom) return refuse(msg.from, badFrom);
    const badTo = checkPath(path);
    if (badTo) return refuse(msg.path, badTo);
    const base = int(msg.base_version, -1);
    const curFrom = this.current(from);
    if (!curFrom || curFrom.deleted || curFrom.version !== base) return this.stale(ws, id, from, base, curFrom);
    if (msg.sha !== curFrom.sha) {
      return refuse(from, { reason: "bad_sha", status: 400, message: "a rename moves bytes unchanged; send a delete and a save" });
    }
    const toBase = int(msg.to_base_version, -1);
    const curTo = this.current(path);
    if (!this.baseMatches(curTo, toBase)) return this.stale(ws, id, path, toBase, curTo);
    const fromRow = this.row(curFrom.version);
    let fromVersion = 0;
    let version = 0;
    this.ctx.storage.transactionSync(() => {
      fromVersion = this.insert({ path: from, op: "rename", sha: null, size: null, deleted: true, moved: path, ...who, source: "live" });
      version = this.insert({ path, op: "rename", sha: fromRow.sha, size: fromRow.size, deleted: false, moved: from, ...who, source: "live" });
    });
    this.send(ws, { type: "accepted", id, path, version, sha: fromRow.sha, from, from_version: fromVersion });
    this.broadcast(this.changeMessage(this.row(version)), att.id);
    return true;
  }

  private baseMatches(cur: Current | null, base: number): boolean {
    if (!cur) return base === 0;
    return cur.version === base || (cur.deleted && base === 0);
  }

  private stale(ws: WebSocket, id: string, path: string, base: number, cur: Current | null): boolean {
    let current: Record<string, unknown> = { version: 0, sha: null, deleted: true };
    if (cur) {
      const r = this.row(cur.version);
      current = {
        version: r.version,
        sha: r.sha,
        deleted: !!r.deleted,
        author: r.author,
        machine: r.machine,
        agent: r.agent,
        at: r.at,
        bytes: r.deleted || !r.sha ? undefined : toBase64(new Uint8Array(this.blob(r.sha))),
      };
    }
    this.send(ws, { type: "stale", id, status: 409, path, base_version: base, current });
    return false;
  }

  // ---- storage ----

  private kv(k: string): string | null {
    const rows = this.sql.exec<any>("SELECT v FROM kv WHERE k = ?", k).toArray();
    return rows.length ? (rows[0].v as string | null) : null;
  }

  private setKv(k: string, v: string | null): void {
    this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  private head(): number {
    return this.sql.exec<any>("SELECT COALESCE(MAX(version), 0) AS head FROM versions").one().head as number;
  }

  private current(path: string): Current | null {
    const rows = this.sql.exec<any>("SELECT version, sha, deleted FROM files WHERE path = ?", path).toArray();
    if (!rows.length) return null;
    return { version: rows[0].version, sha: rows[0].sha, deleted: !!rows[0].deleted };
  }

  private row(version: number): VersionRow {
    return this.sql.exec<any>("SELECT * FROM versions WHERE version = ?", version).one() as VersionRow;
  }

  private blob(sha: string): ArrayBuffer {
    return this.sql.exec<any>("SELECT bytes FROM blobs WHERE sha = ?", sha).one().bytes as ArrayBuffer;
  }

  private insert(n: NewVersion): number {
    if (n.sha && n.bytes) {
      this.sql.exec(
        "INSERT OR IGNORE INTO blobs (sha, size, bytes) VALUES (?, ?, ?)",
        n.sha,
        n.bytes.length,
        exactBuffer(n.bytes),
      );
    }
    const at = Date.now();
    const version = this.sql
      .exec<any>(
        `INSERT INTO versions (path, op, sha, size, deleted, moved, author, machine, agent, at, source, restored_from, commit_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING version`,
        n.path,
        n.op,
        n.sha,
        n.size,
        n.deleted ? 1 : 0,
        n.moved ?? null,
        n.author,
        n.machine,
        n.agent,
        at,
        n.source,
        n.restored_from ?? null,
        n.commit_sha ?? null,
      )
      .one().version as number;
    this.sql.exec(
      `INSERT INTO files (path, version, sha, deleted) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET version = excluded.version, sha = excluded.sha, deleted = excluded.deleted`,
      n.path,
      version,
      n.sha,
      n.deleted ? 1 : 0,
    );
    if (n.source !== "main") {
      this.sql.exec(
        `INSERT INTO pending (path, version, due) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET version = excluded.version, due = excluded.due`,
        n.path,
        version,
        at + QUIET_MS,
      );
    }
    return version;
  }

  private changeMessage(r: VersionRow) {
    const msg: Record<string, unknown> & { size: number | null } = {
      type: "change",
      op: r.op,
      path: r.path,
      version: r.version,
      sha: r.sha,
      size: r.size,
      deleted: !!r.deleted,
      author: r.author,
      machine: r.machine,
      agent: r.agent,
      at: r.at,
      source: r.source,
    };
    if (!r.deleted && r.sha) msg.bytes = toBase64(new Uint8Array(this.blob(r.sha)));
    if (r.op === "rename" && !r.deleted) {
      msg.from = r.moved;
      msg.from_version = r.version - 1; // a rename takes two consecutive versions
    }
    if (r.restored_from !== null) msg.restored_from = r.restored_from;
    return msg;
  }

  // ---- updates from main (Durable Object RPC, called by the monorepo object) ----

  async applyFromMain(input: { monorepo?: string; commit: string; author?: string; changes: MainChange[] }): Promise<{ versions: number[] }> {
    const shas = await Promise.all(
      input.changes.map((c) => (c.bytes === null ? null : gitBlobSha(c.bytes instanceof Uint8Array ? c.bytes : new Uint8Array(c.bytes)))),
    );
    if (input.monorepo && this.kv("monorepo") !== input.monorepo) this.setKv("monorepo", input.monorepo);
    const versions: number[] = [];
    for (const [i, c] of input.changes.entries()) {
      const bad = checkPath(c.path);
      if (bad && bad.reason !== "protected") continue; // .pando/ arrives this way; projects/ and local paths never
      const cur = this.current(c.path);
      let version: number;
      if (c.bytes === null) {
        if (!cur || cur.deleted) continue;
        version = this.insert({
          path: c.path, op: "delete", sha: null, size: null, deleted: true,
          author: input.author ?? "main", machine: "server", agent: null, source: "main", commit_sha: input.commit,
        });
      } else {
        const bytes = c.bytes instanceof Uint8Array ? c.bytes : new Uint8Array(c.bytes);
        if (bytes.length > MAX_BYTES) continue; // large files arrive as pointers (M7)
        const sha = shas[i] as string;
        if (cur && !cur.deleted && cur.sha === sha) continue;
        version = this.insert({
          path: c.path, op: "save", sha, bytes, size: bytes.length, deleted: false,
          author: input.author ?? "main", machine: "server", agent: null, source: "main", commit_sha: input.commit,
        });
      }
      versions.push(version);
      this.broadcast(this.changeMessage(this.row(version)));
    }
    this.setKv("parent", input.commit);
    return { versions };
  }

  // ---- commits after quiet ----

  private async scheduleCommit(): Promise<void> {
    if (!gitWriter(this.env)) return; // versions wait, uncommitted, until gitwrite is wired
    const next = this.sql.exec<any>("SELECT MIN(due) AS due FROM pending").one().due as number | null;
    if (next === null) return;
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > next) await this.ctx.storage.setAlarm(next);
  }

  async alarm(): Promise<void> {
    const writer = gitWriter(this.env);
    if (!writer) return;
    const due = this.sql
      .exec<any>("SELECT path, version FROM pending WHERE due <= ? ORDER BY version", Date.now())
      .toArray() as { path: string; version: number }[];

    // Paths due together with the same author, machine and agent share a commit.
    const groups = new Map<string, VersionRow[]>();
    for (const p of due) {
      const r = this.row(p.version);
      const key = JSON.stringify([r.author, r.machine, r.agent]);
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    let failed = false;
    for (const rows of groups.values()) {
      try {
        await this.commitRows(writer, rows);
      } catch (e) {
        failed = true;
        this.setKv("commit_error", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      }
    }
    if (failed) {
      const retry = Math.min(int(this.kv("retry_ms"), RETRY_MIN_MS) * (this.kv("retry_ms") ? 2 : 1), RETRY_MAX_MS);
      this.setKv("retry_ms", String(retry));
      await this.ctx.storage.setAlarm(Date.now() + retry);
      return;
    }
    this.setKv("retry_ms", null);
    await this.scheduleCommit();
  }

  private async commitRows(writer: GitWriter, rows: VersionRow[]): Promise<void> {
    const changes: FileChange[] = rows.map((r) =>
      r.deleted || !r.sha ? { path: r.path, delete: true } : { path: r.path, content: new Uint8Array(this.blob(r.sha)) },
    );
    const last = rows[rows.length - 1];
    const author = { ...parsePerson(last.author), date: new Date(last.at) };
    const repoName = this.kv("meta_repo") ?? this.kv("monorepo");
    if (!repoName) throw new Error("the object does not know its monorepo yet");
    const opts = { parent: this.kv("parent"), changes, message: commitMessage(rows), author };
    let res = await writer.commit(repoName, "main", opts);
    if (res.status === "ref_moved") {
      res = await writer.commit(repoName, "main", { ...opts, parent: res.actual });
    }
    if (res.status === "ref_moved") throw new Error(`main moved twice (expected ${res.expected}, saw ${res.actual})`);
    const sha = res.sha;
    // Nothing awaits from here on: mark versions committed, clear what is done.
    this.setKv("parent", sha);
    this.setKv("commit_error", null);
    for (const r of rows) {
      this.sql.exec(
        "UPDATE versions SET commit_sha = ? WHERE path = ? AND version <= ? AND commit_sha IS NULL AND source != 'main'",
        sha,
        r.path,
        r.version,
      );
      this.sql.exec("DELETE FROM pending WHERE path = ? AND version = ?", r.path, r.version);
    }
  }
}

function verb(r: VersionRow): string {
  if (r.source === "restore") return "Restore";
  if (r.op === "rename") return r.deleted ? "Rename" : "Rename to";
  return r.deleted ? "Delete" : "Save";
}

export function commitMessage(rows: VersionRow[]): string {
  let title: string;
  let body = "";
  const renameTo = rows.find((r) => r.op === "rename" && !r.deleted);
  const renameFrom = renameTo && rows.find((r) => r.op === "rename" && r.deleted && r.path === renameTo.moved);
  if (rows.length === 1) {
    const r = rows[0];
    if (r.source === "restore") title = `Restore ${r.path} to version ${r.restored_from}`;
    else if (r.deleted) title = `Delete ${r.path}`;
    else title = `Save ${r.path}`;
  } else if (rows.length === 2 && renameTo && renameFrom) {
    title = `Rename ${renameFrom.path} to ${renameTo.path}`;
  } else {
    title = `Save ${rows.length} files`;
    body = rows.map((r) => `${verb(r)} ${r.path}`).join("\n") + "\n\n";
  }
  const last = rows[rows.length - 1];
  const trailers = [
    ...(last.agent ? [`Pando-Agent: ${last.agent}`] : []),
    `Pando-Machine: ${last.machine}`,
    `Pando-Version: ${Math.max(...rows.map((r) => r.version))}`,
  ];
  return `${title}\n\n${body}${trailers.join("\n")}\n`;
}
