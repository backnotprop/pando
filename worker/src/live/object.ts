// Meta layer object: one per monorepo. It keeps every saved version in SQLite,
// sends each accepted change to every other machine over a hibernating
// WebSocket, and commits changes to the meta layer's main after 10 s of quiet.
// Owned by the live lane. The wire is docs/contracts/meta-sync.md.
import { DurableObject } from "cloudflare:workers";
import type * as Contract from "@pando/contract";
import { checkBytes, checkPath, checkPointer, MAX_BYTES, type Refusal } from "./rules";
import { blobKey, parsePointer } from "./blobs";
import { exactBuffer, fromBase64, gitBlobSha, toBase64 } from "./bytes";
import { gitWriter, type CommitEnv, type FileChange, type GitWriter } from "./commit";
import { parse as parseToml } from "smol-toml";
import type { MonorepoObject } from "../monorepo/object";
import type { KeyedEvent, StreamEvent } from "../monorepo/types";
import { EVENT_STREAM } from "../monorepo/stream";
import { isBusy, LEASE_MS, retryBusy } from "../monorepo/gate";
import { addGate, timed } from "../timing";
import { closeLogins } from "../sockets";
import { isRecord, isText, isWholeNumber, parseJson, type Json, type JsonObject } from "../parse";

// MONOREPO: the monorepo object, whose event stream gets meta.saved and
// machine.connected / machine.disconnected (absent in the live lane's test Worker).
// META_TEST: tests only, "1" lets testOutbox fail, lose or crash the next sends.
export type MetaEnv = CommitEnv & { MONOREPO?: DurableObjectNamespace<MonorepoObject>; META_TEST?: string };

const QUIET_MS = 10_000; // commit a path after this much quiet

// ...or this long after its first save not yet in git, if it never goes quiet
// (CODE-VS-MODEL M6; the owner's choice, 2026-10-04). META_COMMIT_MAX_WAIT_MS sets it.
const MAX_WAIT_MS = 60_000;

const TREE_LIMIT = 1000; // GET tree: files per page by default

const TREE_MAX = 5000; // and at most

const EVENTS_FLUSH_MS = 250; // meta events go to the monorepo's stream in one call per this much time

const OUTBOX_BATCH = 100; // events per call to the monorepo object

const OUTBOX_RETRY_MS = [1_000, 5_000, 30_000, 300_000]; // a failed send is tried again after these, then every 5 min

export const META_DELETED = 4404; // WebSocket close code: the monorepo was deleted

const GROUP_MS = 2_000; // paths due within this of each other share a commit

const RETRY_MIN_MS = 30_000;

const RETRY_MAX_MS = 600_000;

const PAGE_BYTES = 4 * 1024 * 1024; // catch-up page size

const PAGE_ROWS = 1000;

const INIT_WINDOW_MS = 30 * 60_000; // pando init's first upload, at most this long

const COMMIT_FILES = 1000; // one commit holds at most this many files

const COMMIT_BYTES = 24 * 1024 * 1024; // and about this many bytes (gitwrite packs in memory)

// The versions a commit of path ?1 at version ?2 carries: every one since the
// path's last version in git, up to ?2. Saves folded into a later one count,
// whoever made them; a save replaced by a merge from main does not.
const CARRIED = `path = ?1 AND version <= ?2 AND version > COALESCE(
  (SELECT MAX(version) FROM versions WHERE path = ?1 AND version < ?2 AND commit_sha IS NOT NULL), 0)`;

type Op = "save" | "delete" | "rename";

type Source = "live" | "restore" | "main";

interface Attachment {
  id: string;
  author: string;
  login?: string | null; // the user's login, from the Worker (route.ts); null without a credential
  machine: string;
  agent: string | null;
  fixed: boolean; // identity came from the Worker, not from hello
  hello: boolean;
  live: boolean; // caught up: receives every new change
  connected_at?: string;
  client?: string | null; // the client's own name, from hello
}

type VersionRow = {
  version: number;
  path: string;
  op: Op;
  sha: string | null;
  size: number | null;
  deleted: number;
  moved: string | null; // a rename's other path
  author: string;
  login: string | null; // the saver's login (null: before 2026-10-03, or no credential)
  machine: string;
  agent: string | null;
  at: number;
  source: Source;
  restored_from: number | null;
  commit_sha: string | null;
  lfs_oid: string | null; // a large file's SHA-256 when the version is its pointer
  lfs_size: number | null; // and the large file's own size
};

/** Tests only (META_TEST=1): what the next event sends do, and the next updates from main. */
export interface MetaOutboxTest {
  fail: number;
  lose: number;
  crash: boolean;
  /** The next n applyFromMain calls fail before applying anything. */
  applyFail: number;
  /** The next n apply everything, then fail: the caller's answer is lost. */
  applyLose: number;
  /** The next reservation waits this long once its paths are reserved, before anything else. */
  reserveHoldMs: number;
}

/** The outbox as it is: rows waiting and the failed tries in a row, with the test switches. */
export interface MetaOutboxState extends MetaOutboxTest {
  waiting: number;
  tries: number;
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
  login?: string | null;
  machine: string;
  agent: string | null;
  source: Source;
  restored_from?: number | null;
  commit_sha?: string | null;
  lfs?: { oid: string; size: number } | null; // read from bytes when not given
}

/** A change as sockets receive it (meta-sync.md, "change"). */
interface ChangeMessage {
  type: "change";
  op: Op;
  path: string;
  version: number;
  sha: string | null;
  size: number | null;
  deleted: boolean;
  author: string;
  login: string | null;
  machine: string;
  agent: string | null;
  at: number;
  source: Source;
  bytes?: string;
  from?: string | null;
  from_version?: number;
  restored_from?: number;
}

/** A path's state in a stale answer: absent, or its current version with its bytes (meta-sync.md). */
interface StaleState {
  version: number;
  sha: string | null;
  deleted: boolean;
  author?: string;
  machine?: string;
  agent?: string | null;
  at?: number;
  bytes?: string;
}

/** Every frame this object sends on a socket (meta-sync.md, "The WebSocket"). */
type ServerFrame =
  | ChangeMessage
  | { type: "error"; message: string }
  | { type: "welcome"; head: number; monorepo: string | null; max_bytes: number }
  | { type: "caught_up"; head: number; more: boolean }
  | { type: "accepted"; id: string; path: string; version: number; sha: string | null; from?: string; from_version?: number }
  | { type: "refused"; id: string; status: number; path: Json | undefined; reason: string; message: string }
  | { type: "stale"; id: string; status: 409; path: string; base_version: number; current: StaleState };

/** A change from main with its bytes hashed: a delete, or bytes with their git sha. */
type Hashed = { path: string; bytes: null } | { path: string; bytes: Uint8Array; sha: string };

async function hashed(c: MainChange): Promise<Hashed> {
  if (c.bytes === null) return { path: c.path, bytes: null };
  const bytes = c.bytes instanceof Uint8Array ? c.bytes : new Uint8Array(c.bytes);

  return { path: c.path, bytes, sha: await gitBlobSha(bytes) };
}

/** A save's decoded bytes, ready for change(): decoded and hashed before it, the only await. */
interface Upload {
  bytes: Uint8Array;
  sha: string;
  /** A large file's pointer whose bytes are not in R2 yet. */
  blobMissing: boolean;
}

export interface MainChange {
  path: string;
  bytes: Uint8Array | ArrayBuffer | null; // null: deleted
}

/** A text field of a client's JSON; empty when absent or not text. */
function text(v: Json | undefined): string {
  return isText(v) ? v : "";
}

// A reference url as shown to people: without a user or password. New
// pointers with credentials are refused (rules.ts); older ones, or ones
// merged on main, are shown without them.
function withoutCredentials(raw: string): string {
  try {
    const u = new URL(raw);

    if (!u.username && !u.password) return raw;
    u.username = "";
    u.password = "";

    return u.toString();
  } catch {
    return raw; // git@host:path names a user, never a password
  }
}

// A name from the client (author, machine, agent), kept short: it lives in
// the socket's attachment, which holds at most 2 KB.
function name(v: Json | undefined): string {
  return text(v).slice(0, 200);
}

/** A whole number from a query parameter or stored text; the fallback when absent or not one. */
function intParam(v: string | null, fallback = 0): number {
  const n = v === null || v === "" ? Number.NaN : Number(v);

  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

/** A whole number from a field of a client's JSON (a numeric string is taken too). */
function intField(v: Json | undefined, fallback = 0): number {
  if (isWholeNumber(v)) return v;

  return isText(v) ? intParam(v, fallback) : fallback;
}

/** The socket's attachment, or null before openSocket set one. */
function attachmentOf(ws: WebSocket): Attachment | null {
  // SAFETY: only this object writes attachments (openSocket and hello serialize an Attachment), so what it reads back is one.
  return ws.deserializeAttachment() as Attachment | null;
}

function json<Body>(body: Body, status = 200): Response {
  return new Response(JSON.stringify(body) + "\n", {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Errors have the /v1 API's shape: {"error": {"code", "message"}}.
function fail(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

interface Person {
  name: string;
  email: string;
}

function parsePerson(author: string): Person {
  const m = author.match(/^\s*(.*?)\s*<([^>]*)>\s*$/);

  if (m && m[2]) return { name: m[1] || m[2], email: m[2] };

  return { name: author || "unknown", email: "unknown@pando.invalid" };
}

export class MetaLayerObject extends DurableObject<MetaEnv> {
  // Row types: each exec<Row>() names columns of a table that createSchema()
  // makes, and only this object writes those tables. They are this object's
  // own storage, not outside input.
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: MetaEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.createSchema();
    this.migrate();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    // Events written before the object last stopped go out on this wake.
    if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM event_outbox").one().n > 0) this.armDrain();
  }

  // Objects made before the lfs_* columns existed: add them, and fill them
  // from the stored pointers once.
  private migrate(): void {
    const pcols = this.sql.exec<{ name: string }>("PRAGMA table_info(pending)").toArray().map((c) => c.name);

    if (!pcols.includes("first_at")) this.sql.exec("ALTER TABLE pending ADD COLUMN first_at INTEGER");
    const cols = this.sql.exec<{ name: string }>("PRAGMA table_info(versions)").toArray().map((c) => c.name);

    if (!cols.includes("login")) this.sql.exec("ALTER TABLE versions ADD COLUMN login TEXT");

    if (cols.includes("lfs_oid")) return;
    this.sql.exec("ALTER TABLE versions ADD COLUMN lfs_oid TEXT");
    this.sql.exec("ALTER TABLE versions ADD COLUMN lfs_size INTEGER");

    const small = this.sql
      .exec<{ version: number; sha: string }>("SELECT version, sha FROM versions WHERE sha IS NOT NULL AND deleted = 0 AND size < 1024")
      .toArray();

    for (const r of small) {
      const ptr = parsePointer(new Uint8Array(this.blob(r.sha)));

      if (ptr) this.sql.exec("UPDATE versions SET lfs_oid = ?, lfs_size = ? WHERE version = ?", ptr.oid, ptr.size, r.version);
    }
  }

  private createSchema(): void {
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
        commit_sha TEXT,
        lfs_oid TEXT,
        lfs_size INTEGER,
        login TEXT
      );
      CREATE INDEX IF NOT EXISTS versions_by_path ON versions(path, version);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, version INTEGER NOT NULL, sha TEXT, deleted INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS files_by_version ON files(version);
      CREATE TABLE IF NOT EXISTS pending (path TEXT PRIMARY KEY, version INTEGER NOT NULL, due INTEGER NOT NULL, first_at INTEGER);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS event_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS applied (commit_sha TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reserved (path TEXT NOT NULL, merge TEXT NOT NULL, PRIMARY KEY (path, merge));
      CREATE TABLE IF NOT EXISTS credit_outbox (sha TEXT PRIMARY KEY, logins TEXT NOT NULL, at INTEGER NOT NULL);
    `);
  }

  // ---- deleting the monorepo (Durable Object RPC, called by DELETE /v1/monorepos/{m}) ----

  // destroy closes every socket (code 4404, so clients stop reconnecting),
  // drops the alarm and all storage, and leaves an empty object behind: a new
  // monorepo with the same name starts with nothing. R2 blobs and the Artifacts
  // repo are the caller's to delete.
  async destroy(): Promise<{ closed: number }> {
    const sockets = this.ctx.getWebSockets();

    for (const ws of sockets) {
      try {
        ws.close(META_DELETED, "this monorepo was deleted");
      } catch {
        // already closed
      }
    }

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.createSchema(); // this instance may serve the next request

    return { closed: sockets.length };
  }

  // closeSockets closes the live sockets of people who lost access
  // (monorepo/access.ts) with NO_ACCESS (4403), so their engines stop.
  closeSockets(logins: string[]): number {
    return closeLogins(this.ctx, logins, (ws) => attachmentOf(ws)?.login);
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
      case "tree":
        return this.tree(url);
      case "references":
        return this.references();
      case "init":
        if (request.method !== "POST") return fail(405, "method_not_allowed", "use POST");

        return this.init(request);
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
    // Set by the Worker from the checked credential (route.ts): the user.
    const author = request.headers.get("x-pando-author");

    const att: Attachment = {
      id: crypto.randomUUID(),
      author: author ?? "",
      login: request.headers.get("x-pando-login"),
      machine: "",
      agent: null,
      fixed: author !== null,
      hello: false,
      live: false,
      connected_at: new Date().toISOString(),
    };

    server.serializeAttachment(att);

    return new Response(null, { status: 101, webSocket: client });
  }

  private history(url: URL): Response {
    const path = url.searchParams.get("path");
    const limit = Math.min(Math.max(intParam(url.searchParams.get("limit"), 50), 1), 1000);
    let rows: VersionRow[];

    if (path) {
      const before = intParam(url.searchParams.get("before"), Number.MAX_SAFE_INTEGER);
      rows = this.sql
        .exec<VersionRow>(
          "SELECT * FROM versions WHERE path = ? AND version < ? ORDER BY version DESC LIMIT ?",
          path,
          before,
          limit,
        )
        .toArray();
    } else {
      const since = intParam(url.searchParams.get("since"));
      rows = this.sql
        .exec<VersionRow>("SELECT * FROM versions WHERE version > ? ORDER BY version ASC LIMIT ?", since, limit)
        .toArray();
    }

    return json({ path, head: this.head(), versions: rows.map((r) => this.historyEntry(r)) } satisfies typeof Contract.MetaHistory.Encoded);
  }

  private historyEntry(r: VersionRow) {
    // A large file's version is its pointer: show the file's own size and hash (insert() writes the two together).
    return {
      large: r.lfs_oid !== null && r.lfs_size !== null ? { oid: r.lfs_oid, size: r.lfs_size } : null,
      version: r.version,
      path: r.path,
      op: r.op,
      sha: r.sha,
      size: r.size,
      deleted: !!r.deleted,
      author: r.author,
      login: r.login ?? null,
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
      .exec<VersionRow>(
        "SELECT * FROM versions WHERE path = ? AND version <= ? ORDER BY version DESC LIMIT 1",
        path,
        version ?? Number.MAX_SAFE_INTEGER,
      )
      .toArray();

    return rows[0] ?? null;
  }

  private file(url: URL): Response {
    const path = url.searchParams.get("path") ?? "";
    const v = url.searchParams.get("version");
    const row = this.versionAt(path, v === null ? null : intParam(v));

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
    const body = await request.json<Json>().catch(() => undefined);

    if (body === undefined) return fail(400, "invalid_input", "send JSON");
    const b = isRecord(body) ? body : null;
    const path = text(b?.path);
    const bad = checkPath(path);

    if (bad) return fail(bad.status, bad.reason, bad.message);
    const target = this.versionAt(path, intField(b?.version));

    if (!target) return fail(404, "not_found", `${path} has no version at or before ${b?.version}`);
    const clash = target.deleted ? null : this.fileFolderClash(path);

    if (clash) return fail(clash.status, clash.reason, clash.message);

    // From here to the broadcast nothing awaits, so no other change interleaves.
    const author = request.headers.get("x-pando-author") ?? (name(b?.author) || "unknown");
    const agent = name(b?.agent) || null;
    const machine = name(b?.machine) || "unknown";
    const cur = this.current(path);
    const same = target.deleted ? !cur || cur.deleted : !!cur && !cur.deleted && cur.sha === target.sha;

    if (same) return json({ path, unchanged: true, version: cur?.version ?? 0 } satisfies typeof Contract.Restored.Encoded);

    const version = this.insert({
      path,
      op: target.deleted ? "delete" : "save",
      sha: target.deleted ? null : target.sha,
      size: target.deleted ? null : target.size,
      deleted: !!target.deleted,
      author,
      login: request.headers.get("x-pando-login"),
      machine,
      agent,
      source: "restore",
      restored_from: target.version,
      lfs: target.lfs_oid ? { oid: target.lfs_oid, size: target.lfs_size ?? 0 } : null,
    });

    this.broadcast(this.changeMessage(this.row(version)));
    await this.scheduleCommit();

    return json({ path, version, sha: target.deleted ? null : target.sha, restored_from: target.version } satisfies typeof Contract.Restored.Encoded);
  }

  // pando init's first upload. "start" opens a window, only on an empty meta
  // layer, in which .pando/ files (pando.toml, ...) may be saved like any
  // other: the first commit of a meta layer is not a live edit. "done" closes
  // it and commits everything at once.
  private async init(request: Request): Promise<Response> {
    const body = await request.json<Json>().catch(() => undefined);

    if (body === undefined) return fail(400, "invalid_input", "send JSON");
    const action = isRecord(body) ? body.action : undefined;

    if (action === "start") {
      if (!this.initializing() && this.head() > 0) {
        return fail(409, "not_empty", "this meta layer already has files: use pando clone");
      }

      this.setKv("init_started", String(Date.now()));

      return json({ initializing: true, head: this.head() });
    }

    if (action === "done") {
      if (!this.initializing()) return fail(409, "not_initializing", "no first upload is open");
      this.setKv("init_started", null);
      this.setKv("init_commit", "1");
      this.sql.exec("UPDATE pending SET due = ?", Date.now());
      await this.scheduleCommit();

      return json({ initializing: false, head: this.head() });
    }

    return fail(400, "invalid_input", 'action is "start" or "done"');
  }

  /** The longest a path saved again and again waits for its commit (META_COMMIT_MAX_WAIT_MS, else 60 s). */
  private maxWait(): number {
    return intParam(this.env.META_COMMIT_MAX_WAIT_MS ?? null, MAX_WAIT_MS) || MAX_WAIT_MS;
  }

  private initializing(): boolean {
    const started = intParam(this.kv("init_started"), 0);

    return started > 0 && Date.now() - started < INIT_WINDOW_MS;
  }

  private status() {
    const files = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM files WHERE deleted = 0").one().n;
    const uncommitted = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending").one().n;

    return {
      monorepo: this.kv("monorepo"),
      head: this.head(),
      files,
      uncommitted,
      sockets: this.ctx.getWebSockets().length,
      connections: this.connections(),
      last_commit: this.kv("parent"),
      commit_error: gitWriter(this.env) ? this.kv("commit_error") : "no Artifacts binding: versions are kept, not committed",
    };
  }

  // ---- WebSocket ----

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (raw instanceof ArrayBuffer) return this.send(ws, { type: "error", message: "send JSON text frames" });
    const msg = parseJson(raw);

    if (msg === null) return this.send(ws, { type: "error", message: "bad JSON" });
    const type = isRecord(msg) ? msg.type : undefined;

    if (!isRecord(msg) || (type !== "hello" && type !== "save" && type !== "delete" && type !== "rename")) {
      return this.send(ws, { type: "error", message: `unknown message type ${JSON.stringify(type)}` });
    }

    const att = attachmentOf(ws);

    if (!att) return this.send(ws, { type: "error", message: "this socket was not opened by the meta layer" });

    if (type === "hello") return this.hello(ws, att, msg);

    if (!att.hello) return this.send(ws, { type: "error", message: "send hello first" });

    // Decode and hash first: the only await. change() then reads, checks the
    // base and writes with no await, so no other change can slip in between.
    const upload = type === "save" ? await this.decodeSave(msg) : null;

    if (this.change(ws, att, msg, upload)) await this.scheduleCommit();
  }

  /** A save's bytes from base64, their git sha, and whether a large file's bytes are missing from R2; null when the bytes are absent or not base64. */
  private async decodeSave(msg: JsonObject): Promise<Upload | null> {
    if (!isText(msg.bytes)) return null;
    const bytes = fromBase64(msg.bytes);

    if (!bytes) return null;
    const sha = await gitBlobSha(bytes);
    // A large file arrives as a pointer: its bytes must be in R2 first.
    const ptr = parsePointer(bytes);
    const monorepo = this.kv("monorepo");
    let blobMissing = false;

    if (ptr && monorepo) {
      const head = await this.env.BLOBS?.head(blobKey(monorepo, ptr.oid));
      blobMissing = !head || head.size !== ptr.size;
    } else if (ptr) {
      blobMissing = true;
    }

    return { bytes, sha, blobMissing };
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = attachmentOf(ws);

    if (att?.hello) this.emitConnection("machine.disconnected", "delete", att);

    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(_ws: WebSocket): Promise<void> {}

  private send(ws: WebSocket, msg: ServerFrame): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // the socket went away; its close event cleans up
    }
  }

  private broadcast(msg: ChangeMessage, exceptId?: string): void {
    const frame = JSON.stringify(msg);

    for (const ws of this.ctx.getWebSockets()) {
      const a = attachmentOf(ws);

      if (!a?.live || a.id === exceptId) continue;

      try {
        ws.send(frame);
      } catch {
        // closed
      }
    }
  }

  private hello(ws: WebSocket, att: Attachment, msg: JsonObject): void {
    if (!att.fixed) att.author = name(msg.author) || "unknown";
    att.machine = name(msg.machine) || "unknown";
    att.agent = name(msg.agent) || null; // agents act as their user; the trailers name them
    att.client = name(msg.client) || null;
    const first = !att.hello;
    att.hello = true;

    if (first) this.emitConnection("machine.connected", "upsert", att);
    const head = this.head();
    let since = intField(msg.since);

    if (since > head) since = 0; // the client saw a different history: send everything
    this.send(ws, { type: "welcome", head, monorepo: this.kv("monorepo"), max_bytes: MAX_BYTES });

    // One page of the latest change per path above `since`. No awaits here, so
    // marking the socket live below cannot miss a change.
    // A machine starting from 0 has nothing to delete, so it gets no deletes.
    const skipDeleted = since === 0 ? 1 : 0;

    const rows = this.sql
      .exec<{ version: number }>(
        "SELECT version FROM files WHERE version > ? AND NOT (deleted = 1 AND ? = 1) ORDER BY version LIMIT ?",
        since,
        skipDeleted,
        PAGE_ROWS,
      )
      .toArray();

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
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM files WHERE version > ? AND NOT (deleted = 1 AND ? = 1)", last, skipDeleted)
        .one().n > 0;

    att.live = !more;
    ws.serializeAttachment(att);
    this.send(ws, { type: "caught_up", head: more ? last : head, more });
  }

  // change applies a save, delete or rename. It returns true when a version was added.
  private change(ws: WebSocket, att: Attachment, msg: JsonObject, upload: Upload | null): boolean {
    const id = text(msg.id);

    const refuse = (path: Json | undefined, r: Refusal) => {
      this.send(ws, { type: "refused", id, status: r.status, path, reason: r.reason, message: r.message });

      return false;
    };

    const who = { author: att.author, login: att.login ?? null, machine: att.machine, agent: att.agent };

    // During pando init's first upload, .pando/ (but not .pando/local/) may be saved.
    const check = (p: string) => {
      const bad = checkPath(p);

      return bad?.reason === "protected" && this.initializing() ? null : bad;
    };

    if (msg.type === "save") {
      const path = text(msg.path);
      const badPath = check(path);

      if (badPath) return refuse(msg.path, badPath);

      if (!upload) return refuse(path, { reason: "bad_sha", status: 400, message: "bytes missing or not base64" });
      const { bytes, sha } = upload;
      const badBytes = checkBytes(bytes);

      if (badBytes) return refuse(path, badBytes);

      if (msg.sha !== sha) return refuse(path, { reason: "bad_sha", status: 400, message: "sha does not match bytes" });

      if (upload.blobMissing) {
        return refuse(path, { reason: "missing_blob", status: 400, message: "upload the file's bytes to meta/blobs first" });
      }

      const badPointer = checkPointer(path, bytes);

      if (badPointer) return refuse(path, badPointer);
      const clash = this.fileFolderClash(path);

      if (clash) return refuse(path, clash);
      const base = intField(msg.base_version, -1);
      const cur = this.current(path);

      // A merge landing on this path waits for no save: the saver keeps a conflict copy.
      if (!this.baseMatches(cur, base) || this.reserved(path)) return this.stale(ws, id, path, base, cur);

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
      const path = text(msg.path);
      const badPath = check(path);

      if (badPath) return refuse(msg.path, badPath);
      const base = intField(msg.base_version, -1);
      const cur = this.current(path);

      if (!cur || cur.deleted) {
        this.send(ws, { type: "accepted", id, path, version: cur?.version ?? 0, sha: null }); // already absent

        return false;
      }

      if (cur.version !== base || this.reserved(path)) return this.stale(ws, id, path, base, cur);
      const version = this.insert({ path, op: "delete", sha: null, size: null, deleted: true, ...who, source: "live" });
      this.send(ws, { type: "accepted", id, path, version, sha: null });
      this.broadcast(this.changeMessage(this.row(version)), att.id);

      return true;
    }

    // rename
    const from = text(msg.from);
    const path = text(msg.path);
    const badFrom = checkPath(from);

    if (badFrom) return refuse(msg.from, badFrom);
    const badTo = checkPath(path) ?? this.fileFolderClash(path, from);

    if (badTo) return refuse(msg.path, badTo);
    const base = intField(msg.base_version, -1);
    const curFrom = this.current(from);

    if (!curFrom || curFrom.deleted || curFrom.version !== base || this.reserved(from)) return this.stale(ws, id, from, base, curFrom);

    if (msg.sha !== curFrom.sha) {
      return refuse(from, { reason: "bad_sha", status: 400, message: "a rename moves bytes unchanged; send a delete and a save" });
    }

    const toBase = intField(msg.to_base_version, -1);
    const curTo = this.current(path);

    if (!this.baseMatches(curTo, toBase) || this.reserved(path)) return this.stale(ws, id, path, toBase, curTo);
    const fromRow = this.row(curFrom.version);
    const badPointer = fromRow.sha ? checkPointer(path, new Uint8Array(this.blob(fromRow.sha))) : null;

    if (badPointer) return refuse(path, badPointer);
    let fromVersion = 0;
    let version = 0;
    this.ctx.storage.transactionSync(() => {
      fromVersion = this.insert({ path: from, op: "rename", sha: null, size: null, deleted: true, moved: path, ...who, source: "live" });
      version = this.insert({
        path, op: "rename", sha: fromRow.sha, size: fromRow.size, deleted: false, moved: from, ...who, source: "live",
        lfs: fromRow.lfs_oid ? { oid: fromRow.lfs_oid, size: fromRow.lfs_size ?? 0 } : null,
      });
    });
    this.send(ws, { type: "accepted", id, path, version, sha: fromRow.sha, from, from_version: fromVersion });
    this.broadcast(this.changeMessage(this.row(version)), att.id);

    return true;
  }

  /**
   * A file named like a live folder, or a path inside a live file: git holds
   * no such pair, and every commit would fail (CODE-VS-MODEL M5). The second
   * of the pair is refused; case-only twins (Notes.md, notes.md) are allowed,
   * as git allows them (the owner's choice, 2026-10-04). `moving`: a
   * rename's own `from`, gone once it lands.
   */
  private fileFolderClash(path: string, moving = ""): Refusal | null {
    const parts = path.split("/");

    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const cur = this.current(dir);

      if (dir !== moving && cur && !cur.deleted) return { reason: "file_folder", status: 409, message: `${dir} is a file here` };
    }

    // Every path inside the folder sorts between "<path>/" and "<path>0" ("0" follows "/").
    const inside = this.sql.exec("SELECT 1 FROM files WHERE deleted = 0 AND path > ? AND path < ? AND path != ? LIMIT 1", `${path}/`, `${path}0`, moving).toArray();

    return inside.length ? { reason: "file_folder", status: 409, message: `${path} is a folder here` } : null;
  }

  private baseMatches(cur: Current | null, base: number): boolean {
    if (!cur) return base === 0;

    return cur.version === base || (cur.deleted && base === 0);
  }

  private stale(ws: WebSocket, id: string, path: string, base: number, cur: Current | null): boolean {
    const current: StaleState = cur ? this.staleState(cur) : { version: 0, sha: null, deleted: true };

    this.send(ws, { type: "stale", id, status: 409, path, base_version: base, current });

    return false;
  }

  /** The path's current state as a stale answer carries it, its bytes included (meta-sync.md). */
  private staleState(cur: Current): StaleState {
    const r = this.row(cur.version);

    return {
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

  // ---- storage ----

  private kv(k: string): string | null {
    const rows = this.sql.exec<{ v: string | null }>("SELECT v FROM kv WHERE k = ?", k).toArray();

    return rows.length ? rows[0].v : null;
  }

  private setKv(k: string, v: string | null): void {
    this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  private head(): number {
    return this.sql.exec<{ head: number }>("SELECT COALESCE(MAX(version), 0) AS head FROM versions").one().head;
  }

  private current(path: string): Current | null {
    const rows = this.sql.exec<{ version: number; sha: string | null; deleted: number }>("SELECT version, sha, deleted FROM files WHERE path = ?", path).toArray();

    if (!rows.length) return null;

    return { version: rows[0].version, sha: rows[0].sha, deleted: !!rows[0].deleted };
  }

  private row(version: number): VersionRow {
    return this.sql.exec<VersionRow>("SELECT * FROM versions WHERE version = ?", version).one();
  }

  private blob(sha: string): ArrayBuffer {
    return this.sql.exec<{ bytes: ArrayBuffer }>("SELECT bytes FROM blobs WHERE sha = ?", sha).one().bytes;
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
    const lfs = n.lfs !== undefined ? n.lfs : n.bytes && n.bytes.length < 1024 ? parsePointer(n.bytes) : null;

    const version = this.sql
      .exec<{ version: number }>(
        `INSERT INTO versions (path, op, sha, size, deleted, moved, author, machine, agent, at, source, restored_from, commit_sha, lfs_oid, lfs_size, login)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING version`,
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
        lfs?.oid ?? null,
        lfs?.size ?? null,
        n.login ?? null,
      )
      .one().version;

    this.sql.exec(
      `INSERT INTO files (path, version, sha, deleted) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET version = excluded.version, sha = excluded.sha, deleted = excluded.deleted`,
      n.path,
      version,
      n.sha,
      n.deleted ? 1 : 0,
    );

    // Due after 10 s of quiet, but never later than the maximum wait after
    // the path's first save not yet in git (first_at, kept across saves).
    if (n.source !== "main") {
      const wait = this.maxWait();
      this.sql.exec(
        `INSERT INTO pending (path, version, due, first_at) VALUES (?1, ?2, MIN(?3 + ?4, ?3 + ?5), ?3)
         ON CONFLICT(path) DO UPDATE SET version = excluded.version,
           due = MIN(?3 + ?4, COALESCE(pending.first_at, ?3) + ?5), first_at = COALESCE(pending.first_at, ?3)`,
        n.path,
        version,
        at,
        QUIET_MS,
        wait,
      );
    }

    // To the event stream, only when it is on, and not during pando init's first upload
    // (thousands of files; machines catch up from history, the web refetches the tree).
    // The row is built only then: one row read per save.
    if (EVENT_STREAM && this.env.MONOREPO && !this.initializing()) {
      this.emit({
        kind: "meta.saved", collection: "meta_files", key: n.path, op: n.deleted ? "delete" : "upsert",
        repo: "meta", actor: null, machine: n.machine, agent: n.agent, row: this.historyEntry(this.row(version)),
      }, version);
    }

    return version;
  }

  // ---- the write gate (held by the monorepo object) ----

  private async gated<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const monorepo = this.kv("monorepo");

    if (!monorepo || !this.env.MONOREPO) return fn(); // the live lane's test Worker has no gate
    const stub = this.env.MONOREPO.getByName(monorepo);
    const g0 = Date.now();
    const slot = await stub.acquireWrite(key);
    addGate(slot.ok ? slot.value.waited_ms : Date.now() - g0);

    if (!slot.ok) throw new Error(slot.message || "the repo is busy");

    const lease = slot.value.lease;

    const renew = setInterval(() => {
      stub.renewWrite(key, lease).catch(() => {});
    }, LEASE_MS / 3);

    try {
      return await fn();
    } finally {
      clearInterval(renew);
      await stub.releaseWrite(key, lease).catch(() => false);
    }
  }

  // ---- the monorepo's event stream (A9) ----
  //
  // Each event is a row in event_outbox, written in the same step as the
  // change it records (a save's version and its event commit together). A
  // drain sends the rows in order, OUTBOX_BATCH per call, and deletes them
  // once the monorepo object has them. A failed send is tried again on the
  // alarm (OUTBOX_RETRY_MS); rows left when the object stopped go out on its
  // next wake (any request, a socket message, or the commit alarm a save
  // sets; presence events are whole snapshots, and a stop closes every socket,
  // so the reconnects send fresh ones). The monorepo object publishes each (source, version) once, so a
  // batch sent again after a lost answer doubles nothing: a meta.saved is
  // keyed by its version, a presence event by its outbox row.

  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> = Promise.resolve();

  /**
   * Write an event to the outbox; a burst is sent in one call after
   * EVENTS_FLUSH_MS, never awaited by the saver. While a failed send waits
   * for its retry, new events wait with it.
   */
  private emit(e: StreamEvent, version: number | null = null): void {
    if (!EVENT_STREAM || !this.env.MONOREPO) return;
    this.sql.exec("INSERT INTO event_outbox (version, body) VALUES (?, ?)", version, JSON.stringify(e));

    if (this.kv("outbox_tries") === null) this.armDrain();
  }

  private armDrain(): void {
    if (this.drainTimer) return;

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.ctx.waitUntil(this.drain());
    }, EVENTS_FLUSH_MS);
  }

  /** Send the outbox; one drain at a time, so rows go out in order. */
  private drain(): Promise<void> {
    this.sending = this.sending
      .then(() => this.drainNow())
      .catch((err) => console.error("meta events: drain failed:", err instanceof Error ? err.message : String(err)));

    return this.sending;
  }

  private async drainNow(): Promise<void> {
    const monorepo = this.kv("monorepo");

    if (!monorepo || !this.env.MONOREPO) return;
    const stub = this.env.MONOREPO.getByName(monorepo);

    for (;;) {
      const rows = this.sql.exec<{ id: number; version: number | null; body: string }>("SELECT id, version, body FROM event_outbox ORDER BY id LIMIT ?", OUTBOX_BATCH).toArray();

      if (!rows.length) return;
      const batch = rows.map((r): KeyedEvent => (r.version === null ? { source: "meta.presence", version: r.id, event: JSON.parse(r.body) } : { source: "meta", version: r.version, event: JSON.parse(r.body) }));

      this.testCrash();

      try {
        this.testFail();
        await stub.publishMeta(batch);
        this.testAfterSend();
      } catch (err) {
        const tries = intParam(this.kv("outbox_tries"), 0) + 1;
        const wait = OUTBOX_RETRY_MS[Math.min(tries, OUTBOX_RETRY_MS.length) - 1];

        this.setKv("outbox_tries", String(tries));
        console.error(`meta events not sent (try ${tries}, again in ${wait} ms):`, err instanceof Error ? err.message : String(err));
        await this.alarmBy(Date.now() + wait);

        return;
      }

      this.sql.exec("DELETE FROM event_outbox WHERE id <= ?", rows[rows.length - 1].id);
      this.setKv("outbox_tries", null);
    }
  }

  // ---- credits for the commits it makes (the profile's graph) ----
  //
  // Each commit's savers are written to credit_outbox in the commit's own
  // step, and sent to the monorepo object, which queues one credit per person
  // through its facts outbox (keyed by the commit, so a repeat counts once).
  // A failed send waits for the alarm.

  private async drainCredits(): Promise<void> {
    const monorepo = this.kv("monorepo");

    if (!monorepo || !this.env.MONOREPO) return;
    const stub = this.env.MONOREPO.getByName(monorepo);

    for (const r of this.sql.exec<{ sha: string; logins: string; at: number }>("SELECT sha, logins, at FROM credit_outbox ORDER BY at").toArray()) {
      try {
        // SAFETY: commitRows is the only writer of logins: JSON of a list of logins.
        await stub.queueSavedCredit(r.sha, JSON.parse(r.logins) as string[], r.at);
      } catch (err) {
        console.error("meta credits not sent:", err instanceof Error ? err.message : String(err));
        await this.alarmBy(Date.now() + OUTBOX_RETRY_MS[1]);

        return;
      }

      this.sql.exec("DELETE FROM credit_outbox WHERE sha = ?", r.sha);
    }
  }

  /** Set the alarm for `at` unless one is set sooner (the commit timer and the outbox retries share it). */
  private async alarmBy(at: number): Promise<void> {
    const set = await this.ctx.storage.getAlarm();

    if (set === null || set > at) await this.ctx.storage.setAlarm(at);
  }

  // ---- tests only (META_TEST=1) ----

  private testSet: MetaOutboxTest = { fail: 0, lose: 0, crash: false, applyFail: 0, applyLose: 0, reserveHoldMs: 0 };

  /** Fail the next `fail` sends, lose the answer of the next `lose` (sent, then taken as failed), crash the object before the next send; and the outbox as it is. */
  testOutbox(set: Partial<MetaOutboxTest> = {}): MetaOutboxState {
    if (this.env.META_TEST === "1") this.testSet = { ...this.testSet, ...set };
    const waiting = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM event_outbox").one().n;

    return { waiting, tries: intParam(this.kv("outbox_tries"), 0), ...this.testSet };
  }

  private testCrash(): void {
    if (this.env.META_TEST !== "1" || !this.testSet.crash) return;
    this.testSet.crash = false;
    this.ctx.abort("meta test: the object stops before its events are sent");
  }

  private testFail(): void {
    if (this.env.META_TEST !== "1" || this.testSet.fail <= 0) return;
    this.testSet.fail--;
    throw new Error("meta test: the send failed");
  }

  /** Throws for the next `applyFail` applyFromMain calls (`lose`: for the next `applyLose`, after applying). */
  private testApply(lose: boolean): void {
    if (this.env.META_TEST !== "1") return;

    if (lose && this.testSet.applyLose > 0) {
      this.testSet.applyLose--;
      throw new Error("meta test: applied, and the answer was lost");
    }

    if (!lose && this.testSet.applyFail > 0) {
      this.testSet.applyFail--;
      throw new Error("meta test: applyFromMain failed");
    }
  }

  /** Tests only: hold the next reservation open for reserveHoldMs. */
  private async testHold(): Promise<void> {
    const ms = this.env.META_TEST === "1" ? this.testSet.reserveHoldMs : 0;

    if (ms <= 0) return;
    this.testSet.reserveHoldMs = 0;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private testAfterSend(): void {
    if (this.env.META_TEST !== "1" || this.testSet.lose <= 0) return;
    this.testSet.lose--;
    throw new Error("meta test: the answer was lost");
  }

  private connectionRow(att: Attachment) {
    return {
      id: att.id,
      author: att.author,
      machine: att.machine,
      agent: att.agent,
      client: att.client ?? null,
      connected_at: att.connected_at ?? null,
    };
  }

  // Presence is sent whole (who is connected now, from the live sockets), not as deltas:
  // a close is not always reported, so a client never has to piece it together.
  private emitConnection(kind: string, _op: "upsert" | "delete", att: Attachment): void {
    if (!EVENT_STREAM || !this.env.MONOREPO) return;
    this.emit({
      kind, collection: "presence", key: "meta", op: "upsert", repo: "meta", actor: null,
      machine: att.machine, agent: att.agent,
      // The changing socket's attachment may not be saved yet: leave it out, then add it on connect.
      row: { connections: [...this.connections(att.id), ...(kind === "machine.connected" ? [this.connectionRow(att)] : [])] },
      connection: this.connectionRow(att),
    });
  }

  // Who is connected now: every socket that said hello (A11), less one that is closing.
  private connections(except: string | null = null) {
    const out: ReturnType<MetaLayerObject["connectionRow"]>[] = [];

    for (const ws of this.ctx.getWebSockets()) {
      const a = attachmentOf(ws);

      if (a?.hello && a.id !== except) out.push(this.connectionRow(a));
    }

    return out;
  }

  // ---- the tree and references (A10) ----

  // Current paths, sorted, a page at a time (meta-sync.md, "GET tree").
  //   ?prefix=  paths that start with it (a plain string match)
  //   ?dir=     one folder: its files, and on the first page its subfolders with file counts
  //   ?limit=   1 to 5000, default 1000;  ?after=<path> continues from `next`
  // Both filters are a range on the path index; nothing reads the whole tree
  // into memory, and the object keeps serving saves between pages.
  private tree(url: URL): Response {
    const q = url.searchParams;
    const dir = q.get("dir");

    if (dir !== null && q.get("prefix") !== null) return fail(400, "invalid_input", "send prefix or dir, not both");
    const folder = dir === null ? null : dir.replace(/^\/+|\/+$/g, "");
    const prefix = folder === null ? (q.get("prefix") ?? "") : folder === "" ? "" : `${folder}/`;
    const limit = Math.min(Math.max(intParam(q.get("limit"), TREE_LIMIT), 1), TREE_MAX);
    const after = q.get("after") ?? "";
    // Every path that starts with `prefix` sorts in [prefix, prefix + U+10FFFF):
    // SQLite compares UTF-8 bytes, and U+10FFFF is the largest character.
    const upper = prefix + "\u{10FFFF}";
    const onlyHere = folder === null ? "" : "AND instr(substr(f.path, length(?1) + 1), '/') = 0";

    const rows = this.sql
      .exec<VersionRow>(
        `SELECT v.* FROM files f JOIN versions v ON v.version = f.version
         WHERE f.deleted = 0 AND f.path >= ?1 AND f.path < ?2 AND f.path > ?3 ${onlyHere}
         ORDER BY f.path LIMIT ?4`,
        prefix,
        upper,
        after,
        limit + 1,
      )
      .toArray();

    const more = rows.length > limit;

    if (more) rows.pop();

    const page = {
      head: this.head(),
      prefix,
      files: rows.map((r) => this.historyEntry(r)),
      next: more ? rows[rows.length - 1].path : null,
    };

    if (folder === null) return json(page satisfies typeof Contract.MetaTree.Encoded);

    if (after) return json({ ...page, dir: folder } satisfies typeof Contract.MetaTree.Encoded);

    return json({ ...page, dir: folder, folders: this.folders(prefix, upper) } satisfies typeof Contract.MetaTree.Encoded);
  }

  // Each subfolder under prefix with its file count and `last`: the newest
  // version anywhere under it, a delete or a rename included. One query: the
  // files rows hold each path's newest version.
  private folders(prefix: string, upper: string) {
    const rows = this.sql
          .exec<VersionRow & { name: string; files: number }>(
            `SELECT g.name, g.files, v.* FROM (
               SELECT substr(rest, 1, instr(rest, '/') - 1) AS name, SUM(deleted = 0) AS files, MAX(version) AS last FROM (
                 SELECT substr(path, length(?1) + 1) AS rest, deleted, version FROM files
                 WHERE path >= ?1 AND path < ?2
               ) WHERE instr(rest, '/') > 0 GROUP BY name HAVING SUM(deleted = 0) > 0
             ) g JOIN versions v ON v.version = g.last ORDER BY g.name`,
            prefix,
            upper,
          )
          .toArray();

    return rows.map((r) => ({ name: r.name, files: r.files, last: this.historyEntry(r) }));
  }

  // References (formats.md, section 4): each pointer under .pando/references/, parsed.
  private references(): Response {
    const prefix = ".pando/references/";

    const rows = this.sql
      .exec<{ path: string; version: number; sha: string }>(
        `SELECT f.path, f.version, f.sha FROM files f
         WHERE f.deleted = 0 AND substr(f.path, 1, ?) = ? AND f.path LIKE '%.toml' ORDER BY f.path`,
        prefix.length,
        prefix,
      )
      .toArray();

    const references = rows.map((r) => {
      const path = r.path.slice(prefix.length, -".toml".length);

      try {
        const t = parseToml(new TextDecoder().decode(this.blob(r.sha)));

        return {
          path,
          url: isText(t.url) ? withoutCredentials(t.url) : null,
          ref: isText(t.ref) ? t.ref : null,
          commit: isText(t.commit) ? t.commit : null,
          version: r.version,
          error: null,
        };
      } catch (err) {
        return { path, url: null, ref: null, commit: null, version: r.version, error: `not a reference pointer: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) };
      }
    });

    return json({ head: this.head(), references });
  }

  private changeMessage(r: VersionRow): ChangeMessage {
    const msg: ChangeMessage = {
      type: "change",
      op: r.op,
      path: r.path,
      version: r.version,
      sha: r.sha,
      size: r.size,
      deleted: !!r.deleted,
      author: r.author,
      login: r.login ?? null,
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

  // ---- one file for the root raw route (Durable Object RPC, monorepo/raw.ts) ----

  // The path as it is now, or at a version (its latest change at or before
  // it); null when it did not exist then or was deleted. A large file's
  // version is its pointer: `large` names the R2 blob.
  readFile(path: string, version: number | null): { version: number; sha: string; bytes: ArrayBuffer; large: { oid: string; size: number } | null } | null {
    const row = this.versionAt(path, version);

    if (!row || row.deleted || !row.sha) return null;

    return { version: row.version, sha: row.sha, bytes: this.blob(row.sha), large: row.lfs_oid ? { oid: row.lfs_oid, size: row.lfs_size ?? 0 } : null };
  }

  // ---- updates from main (Durable Object RPC, called by the monorepo object) ----

  //
  // Idempotent per merge commit (CODE-VS-MODEL M2): the monorepo object tries
  // again until a call succeeds, so a call whose answer was lost may come
  // twice. A commit already applied changes nothing, so a live save made
  // since is never replaced a second time.
  //
  // Each path it changes drops its `pending` row: an older live save there
  // was replaced by the merge, so a later commit must never put it back on
  // git main (CODE-VS-MODEL M1). It ends the merge's reservation.
  async applyFromMain(input: { monorepo?: string; commit: string; author?: string; login?: string; changes: MainChange[]; merge?: string }): Promise<{ versions: number[] }> {
    this.testApply(false);

    if (this.applied(input.commit)) return this.endReservation(input.merge, []);
    // Hash first, the only await: the loop below reads and writes with no await.
    const changes = await Promise.all(input.changes.map((c) => hashed(c)));

    if (this.applied(input.commit)) return this.endReservation(input.merge, []); // the same commit, applied by a call that ran meanwhile

    if (input.monorepo && this.kv("monorepo") !== input.monorepo) this.setKv("monorepo", input.monorepo);
    const versions: number[] = [];

    for (const c of changes) {
      const bad = checkPath(c.path);

      if (bad && bad.reason !== "protected") continue; // .pando/ arrives this way; projects/ and local paths never
      const cur = this.current(c.path);
      let version: number;

      if (c.bytes === null) {
        if (!cur || cur.deleted) continue;
        version = this.insert({
          path: c.path, op: "delete", sha: null, size: null, deleted: true,
          author: input.author ?? "main", login: input.login ?? null, machine: "server", agent: null, source: "main", commit_sha: input.commit,
        });
      } else {
        const { bytes, sha } = c;

        if (bytes.length > MAX_BYTES) continue; // large files arrive as pointers (M7)

        if (cur && !cur.deleted && cur.sha === sha) continue;
        version = this.insert({
          path: c.path, op: "save", sha, bytes, size: bytes.length, deleted: false,
          author: input.author ?? "main", login: input.login ?? null, machine: "server", agent: null, source: "main", commit_sha: input.commit,
        });
      }

      this.sql.exec("DELETE FROM pending WHERE path = ? AND version < ?", c.path, version);
      versions.push(version);
      this.broadcast(this.changeMessage(this.row(version)));
    }

    this.sql.exec("INSERT INTO applied (commit_sha, at) VALUES (?, ?)", input.commit, Date.now());
    this.setKv("parent", input.commit);
    const out = await this.endReservation(input.merge, versions);
    this.testApply(true);

    return out;
  }

  // ---- a merge's reservation (Durable Object RPC, called by the monorepo object) ----
  //
  // A merge into the meta layer reserves the paths its branch changes before
  // it lands, and applyFromMain or release ends that (CODE-VS-MODEL M1, the
  // design TLC checked). The merge waits for live saves (the owner's choice,
  // 2026-10-04):
  // - reserve commits any live save of these paths still waiting for its
  //   commit at once, and answers git main's sha: the merge merges against
  //   it, so a branch that changed the same file is refused as a conflict;
  // - while a path is reserved, no commit carries it, and a live save,
  //   delete or rename of it is answered `stale` (the saver keeps a conflict
  //   copy), until the merge is applied or released.
  // So no live save is replaced silently, and git main and the live files
  // agree once the merge is applied.

  /**
   * Reserve paths for a merge. A commit of any of them already on its way
   * lands (or fails) first; then their waiting live saves are committed.
   * Answers git main's sha after that commit (null when none was needed) and
   * the paths it carried. Throws when that commit failed.
   */
  async reserve(merge: string, paths: string[]): Promise<{ sha: string | null; committed: string[] }> {
    for (const p of paths) this.sql.exec("INSERT OR IGNORE INTO reserved (path, merge) VALUES (?, ?)", p, merge);
    await this.testHold();
    const busy = this.committing;

    if (busy && paths.some((p) => busy.paths.has(p))) await busy.done;
    const writer = gitWriter(this.env);

    const rows = this.sql
      .exec<VersionRow>(
        "SELECT v.* FROM pending p JOIN versions v ON v.version = p.version WHERE p.path IN (SELECT path FROM reserved WHERE merge = ?) ORDER BY v.version",
        merge,
      )
      .toArray();

    if (!writer || !rows.length) return { sha: null, committed: [] };
    await this.commitRows(writer, rows, false);

    return { sha: this.kv("parent"), committed: rows.map((r) => r.path) };
  }

  private reserved(path: string): boolean {
    return this.sql.exec("SELECT 1 FROM reserved WHERE path = ? LIMIT 1", path).toArray().length > 0;
  }

  /** End a merge's reservation (the merge did not land). Saves that waited are committed as usual. */
  async release(merge: string): Promise<void> {
    await this.endReservation(merge, []);
  }

  private async endReservation(merge: string | undefined, versions: number[]): Promise<{ versions: number[] }> {
    if (merge) this.sql.exec("DELETE FROM reserved WHERE merge = ?", merge);
    await this.scheduleCommit();

    return { versions };
  }

  private applied(commit: string): boolean {
    return this.sql.exec("SELECT 1 FROM applied WHERE commit_sha = ?", commit).toArray().length > 0;
  }

  // ---- commits after quiet ----

  private async scheduleCommit(): Promise<void> {
    if (!gitWriter(this.env)) return; // no Artifacts binding: versions are kept, not committed

    if (this.initializing()) return; // pando init commits everything when it is done
    const next = this.sql.exec<{ due: number | null }>("SELECT MIN(due) AS due FROM pending WHERE path NOT IN (SELECT path FROM reserved)").one().due;

    if (next === null) return;
    await this.alarmBy(next);
  }

  /** The commit on its way, if any: its paths, and when it is done (landed or failed). */
  private committing: { paths: Set<string>; done: Promise<void> } | null = null;

  // One commit per alarm, so each gets its own CPU budget; the next alarm is
  // set right away while more is due. Paths reserved by a merge wait.
  async alarm(): Promise<void> {
    if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM event_outbox").one().n > 0) await this.drain();

    if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM credit_outbox").one().n > 0) await this.drainCredits();
    const writer = gitWriter(this.env);

    if (!writer || this.initializing()) return;

    const due = this.sql
      .exec<{ path: string; version: number }>(
        "SELECT path, version FROM pending WHERE due <= ? AND path NOT IN (SELECT path FROM reserved) ORDER BY version",
        Date.now() + GROUP_MS,
      )
      .toArray();

    if (!due.length) return this.scheduleCommit();

    // Paths due together share a commit, up to COMMIT_FILES files and about
    // COMMIT_BYTES bytes: all of them ("window", the default), or those with
    // the first one's author, machine and agent ("author").
    const first = this.row(due[0].version);
    const window = this.env.META_COMMIT_GROUPING !== "author";
    const key = (r: VersionRow) => (window ? "" : JSON.stringify([r.author, r.machine, r.agent]));
    const rows: VersionRow[] = [];
    let bytes = 0;

    for (const p of due) {
      const r = p.version === first.version ? first : this.row(p.version);

      if (key(r) !== key(first)) continue;

      if (rows.length && (rows.length >= COMMIT_FILES || bytes + (r.size ?? 0) > COMMIT_BYTES)) break;
      rows.push(r);
      bytes += r.size ?? 0;
    }

    const run = timed(
      "object",
      { route: "meta.commit", monorepo_id: this.kv("monorepo"), repo: "meta", files: rows.length },
      () => this.commitRows(writer, rows, this.kv("init_commit") === "1"),
    );

    // A merge reserving one of these paths waits for this commit (reserve).
    this.committing = { paths: new Set(rows.map((r) => r.path)), done: run.then(() => undefined, () => undefined) };

    try {
      await run;
    } catch (e) {
      this.setKv("commit_error", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      const retry = Math.min(intParam(this.kv("retry_ms"), RETRY_MIN_MS) * (this.kv("retry_ms") ? 2 : 1), RETRY_MAX_MS);
      this.setKv("retry_ms", String(retry));
      await this.alarmBy(Date.now() + retry);

      return;
    } finally {
      this.committing = null;
    }

    this.setKv("retry_ms", null);

    if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending").one().n === 0) this.setKv("init_commit", null);
    await this.scheduleCommit();
  }

  private async commitRows(writer: GitWriter, rows: VersionRow[], first: boolean): Promise<void> {
    const changes: FileChange[] = rows.map((r) =>
      r.deleted || !r.sha ? { path: r.path, delete: true } : { path: r.path, content: new Uint8Array(this.blob(r.sha)) },
    );

    const last = rows[rows.length - 1];
    const author = { ...parsePerson(last.author), date: new Date(last.at) };
    const repoName = this.kv("meta_repo") ?? this.kv("monorepo");

    if (!repoName) throw new Error("the object does not know its monorepo yet");
    const carried = rows.flatMap((r) => this.sql.exec<VersionRow>(`SELECT * FROM versions WHERE ${CARRIED}`, r.path, r.version).toArray());
    const opts = { parent: this.kv("parent"), changes, message: commitMessage(rows, first, carried), author };

    // Through the repo's write gate (merges into the meta layer push to the same repo), retrying Artifacts' "busy".
    const commit = (o: typeof opts) =>
      this.gated(repoName, () => retryBusy(() => writer.commit(repoName, "main", o), (e) => isBusy(e instanceof Error ? e.message : String(e))));

    let res = await commit(opts);

    if (res.status === "ref_moved") {
      res = await commit({ ...opts, parent: res.actual });
    }

    if (res.status === "ref_moved") throw new Error(`main moved twice (expected ${res.expected}, saw ${res.actual})`);
    const sha = res.sha;
    // Nothing awaits from here on: mark versions committed, clear what is done.
    this.setKv("parent", sha);
    this.setKv("commit_error", null);
    // The commit counts once for each person whose save it carries (their profile's graph), sent on after this step.
    const savers = [...new Set(carried.flatMap((r) => (r.login ? [r.login] : [])))];

    if (savers.length) {
      this.sql.exec("INSERT OR IGNORE INTO credit_outbox (sha, logins, at) VALUES (?, ?, ?)", sha, JSON.stringify(savers), last.at);
      this.ctx.waitUntil(this.drainCredits());
    }

    const wait = this.maxWait();

    for (const r of rows) {
      this.sql.exec(`UPDATE versions SET commit_sha = ?3 WHERE ${CARRIED}`, r.path, r.version, sha);
      this.sql.exec("DELETE FROM pending WHERE path = ? AND version = ?", r.path, r.version);
      // Saved again meanwhile: its maximum wait starts at the first save after this commit.
      this.sql.exec(
        `UPDATE pending SET first_at = (SELECT MIN(at) FROM versions WHERE path = ?1 AND version > ?2),
           due = MIN((SELECT at FROM versions WHERE version = pending.version) + ?3, (SELECT MIN(at) FROM versions WHERE path = ?1 AND version > ?2) + ?4)
         WHERE path = ?1`,
        r.path, r.version, QUIET_MS, wait,
      );
    }
  }
}

function verb(r: VersionRow): string {
  if (r.source === "restore") return "Restore";

  if (r.op === "rename") return r.deleted ? "Rename" : "Rename to";

  return r.deleted ? "Delete" : "Save";
}

/**
 * A commit's message: a title for its rows, then the who-made-it trailers for
 * every version it carries (`carried`, the rows themselves by default): a
 * save folded into a later one names its saver too (CODE-VS-MODEL M7).
 */
export function commitMessage(rows: VersionRow[], first = false, carried: VersionRow[] = rows): string {
  let title: string;
  let body = "";
  const renameTo = rows.find((r) => r.op === "rename" && !r.deleted);
  const renameFrom = renameTo && rows.find((r) => r.op === "rename" && r.deleted && r.path === renameTo.moved);

  if (first) {
    title = "Start the meta layer";
  } else if (rows.length === 1) {
    const r = rows[0];

    if (r.source === "restore") title = `Restore ${r.path} to version ${r.restored_from}`;
    else if (r.deleted) title = `Delete ${r.path}`;
    else title = `Save ${r.path}`;
  } else if (rows.length === 2 && renameTo && renameFrom) {
    title = `Rename ${renameFrom.path} to ${renameTo.path}`;
  } else {
    title = `Save ${rows.length} files`;
  }

  if (rows.length > 1 && !(rows.length === 2 && renameTo && renameFrom)) {
    const listed = rows.slice(0, 50).map((r) => `${verb(r)} ${r.path}`);

    if (rows.length > 50) listed.push(`and ${rows.length - 50} more`);
    body = listed.join("\n") + "\n\n";
  }

  // The last saver is the author (commitRows). Everyone else whose save the
  // commit carries is a Co-authored-by line; every agent and machine gets its
  // own line, in the order they first saved. With one author, machine and
  // agent this is the shape formats.md section 6 gives.
  const last = rows[rows.length - 1];
  const savers = [...carried].sort((a, b) => a.version - b.version);

  const distinct = (pick: (r: VersionRow) => string | null) => [
    ...new Set(
      savers.flatMap((r) => {
        const v = pick(r);

        return v ? [v] : [];
      }),
    ),
  ];

  const lastPerson = parsePerson(last.author);

  const coAuthors = distinct((r) => {
    const p = parsePerson(r.author);

    return p.email === lastPerson.email && p.name === lastPerson.name ? null : `${p.name} <${p.email}>`;
  });

  const trailers = [
    ...coAuthors.map((a) => `Co-authored-by: ${a}`),
    ...distinct((r) => r.agent).map((a) => `Pando-Agent: ${a}`),
    ...distinct((r) => r.machine).map((m) => `Pando-Machine: ${m}`),
    `Pando-Version: ${Math.max(...rows.map((r) => r.version))}`,
  ];

  return `${title}\n\n${body}${trailers.join("\n")}\n`;
}
