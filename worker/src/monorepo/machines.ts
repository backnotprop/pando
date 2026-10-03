// The Machines tab (RESEARCH-2026-10-03.md, section 7): one row per machine
// in a monorepo, kept by the monorepo object in the same step as what changes
// it. A machine is a credential: the key is (login, credential id), shown by
// the credential's name, so two people's `laptop`s stay apart.
// - Every activity event made through a credential sets the row's latest
//   activity (the feed line's kind, repo, branch and summary).
// - The follower's hello on the event socket sets it connected, with its
//   worktree ids; its last socket closing sets it disconnected.
// - `machine.updated` (collection `machines`, the row) goes on the stream at
//   once for a new row, a connect, a disconnect or a change of worktrees, and
//   for activity alone at most once a minute per machine, so the log does not
//   double. Every activity event already names its actor and machine.
// - Browser sessions are credentials of kind browser: they get a row when
//   they act (a merge, a restore), never a hello.

import { now } from "../http";
import type { PushNumbers, StoredPointer } from "../feed/shape";
import type { StreamEvent } from "./types";

type Row = Record<string, SqlStorageValue>;

/** Activity alone republishes a machine's row at most this often. */
const ACTIVITY_REPUBLISH_MS = 60_000;

/** Who acted, as publish() receives it (never stored in the event's body). */
export interface Via {
  credential_id: string;
  credential_kind: string | null;
}

export interface MachineRow {
  login: string;
  credential_id: string;
  name: string;
  kind: string | null;
  connected: boolean;
  connected_at: string | null;
  last_activity: { seq: number; at: string; kind: string; repo: string | null; repo_path: string | null; branch: string | null; summary: unknown } | null;
  worktrees: { id: string; repo: string | null; branch: string | null; path: string | null }[];
  updated_at: string;
}

export class Machines {
  constructor(
    private ctx: DurableObjectState,
    private sql: SqlStorage,
    private publish: (e: StreamEvent) => number,
  ) {}

  private rows<T>(q: string, ...args: unknown[]): T[] {
    return this.sql.exec<Row>(q, ...args).toArray() as unknown as T[];
  }

  ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS machines (
      login TEXT NOT NULL, credential_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT,
      connected INTEGER NOT NULL DEFAULT 0, connected_at TEXT, last TEXT, last_at TEXT,
      worktrees TEXT NOT NULL DEFAULT '[]', published_at INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      PRIMARY KEY (login, credential_id))`);
  }

  /** After an event is published: an activity line made through a credential updates its machine. */
  onEvent(seq: number, at: string, e: StreamEvent, line: StoredPointer | null): void {
    const via = e.via as Via | undefined;

    if (!line || !via?.credential_id || !e.actor) return;
    const name = (e.machine as string | null) ?? via.credential_id;
    const last = JSON.stringify({ seq, at, kind: line.kind, repo: line.repo, repo_path: line.repo_path, branch: line.branch, summary: line.summary });
    const old = this.get(e.actor as string, via.credential_id);
    this.sql.exec(
      `INSERT INTO machines (login, credential_id, name, kind, last, last_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (login, credential_id) DO UPDATE SET name = excluded.name, kind = COALESCE(excluded.kind, machines.kind),
         last = excluded.last, last_at = excluded.last_at, updated_at = excluded.updated_at`,
      e.actor, via.credential_id, name, via.credential_kind, last, at, now(),
    );

    if (!old || old.name !== name || Date.now() - old.published_at >= ACTIVITY_REPUBLISH_MS) this.announce(e.actor as string, via.credential_id);
  }

  /** A push's commit count and head title arrived (the facts job): the machine whose latest activity it is shows them. */
  pushSummary(seq: number, summary: PushNumbers): void {
    for (const r of this.rows<{ login: string; credential_id: string; last: string }>("SELECT login, credential_id, last FROM machines WHERE json_extract(last, '$.seq') = ?", seq)) {
      const last = JSON.parse(r.last) as { summary: Record<string, unknown> | null };
      last.summary = { ...(last.summary ?? {}), ...summary };
      this.sql.exec("UPDATE machines SET last = ? WHERE login = ? AND credential_id = ?", JSON.stringify(last), r.login, r.credential_id);
    }
  }

  /** A follower said hello (after the feed counted it): connected, with its worktrees. */
  hello(att: { login?: string; cid?: string; machine?: string; kind?: string }, worktrees: string[]): void {
    if (!att.login || !att.cid) return;
    const old = this.get(att.login, att.cid);
    const ids = JSON.stringify([...new Set(worktrees)].sort());
    this.sql.exec(
      `INSERT INTO machines (login, credential_id, name, kind, connected, connected_at, worktrees, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (login, credential_id) DO UPDATE SET connected = 1, connected_at = COALESCE(machines.connected_at, excluded.connected_at),
         worktrees = excluded.worktrees, updated_at = excluded.updated_at`,
      att.login, att.cid, att.machine || att.cid, att.kind ?? null, now(), ids, now(),
    );

    if (!old || !old.connected || old.worktrees !== ids) this.announce(att.login, att.cid);
  }

  /** A socket closed (after the feed dropped its presence): disconnected when it was the machine's last. */
  gone(ws: WebSocket, live: Set<string>): void {
    let att: { login?: string; cid?: string } | null;

    try {
      att = ws.deserializeAttachment() as { login?: string; cid?: string } | null;
    } catch {
      return;
    }

    const login = att?.login;
    const cid = att?.cid;

    if (!login || !cid) return;

    if (this.connectedSockets(login, cid, live, ws) > 0) return;
    const w = this.sql.exec("UPDATE machines SET connected = 0, connected_at = NULL, updated_at = ? WHERE login = ? AND credential_id = ? AND connected = 1", now(), login, cid).rowsWritten;

    if (w) this.announce(login, cid);
  }

  /** Every machine, latest activity first (connected ones without activity next). `live`: socket ids that said hello. */
  list(live: Set<string>): MachineRow[] {
    // A machine marked connected whose sockets went without a close (a restart) is not.
    for (const r of this.rows<{ login: string; credential_id: string }>("SELECT login, credential_id FROM machines WHERE connected = 1")) {
      if (!this.connectedSockets(r.login, r.credential_id, live, null)) {
        this.sql.exec("UPDATE machines SET connected = 0, connected_at = NULL WHERE login = ? AND credential_id = ?", r.login, r.credential_id);
      }
    }

    return this.rows<Record<string, unknown>>("SELECT * FROM machines ORDER BY last_at IS NULL, last_at DESC, connected DESC, name").map((r) => this.view(r));
  }

  private connectedSockets(login: string, cid: string, live: Set<string>, except: WebSocket | null): number {
    let n = 0;

    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;

      try {
        const a = ws.deserializeAttachment() as { login?: string; cid?: string; sid?: string } | null;

        if (a?.login === login && a.cid === cid && a.sid && live.has(a.sid)) n++;
      } catch {
        // no attachment
      }
    }

    return n;
  }

  private get(login: string, cid: string): { name: string; connected: number; worktrees: string; published_at: number } | null {
    return this.rows<{ name: string; connected: number; worktrees: string; published_at: number }>(
      "SELECT name, connected, worktrees, published_at FROM machines WHERE login = ? AND credential_id = ?", login, cid,
    )[0] ?? null;
  }

  private view(r: Record<string, unknown>): MachineRow {
    const ids = JSON.parse((r.worktrees as string) || "[]") as string[];

    const known = new Map(
      (ids.length
        ? this.rows<{ id: string; repo: string; branch: string; path: string }>(
            `SELECT id, repo, branch, path FROM worktrees WHERE id IN (${ids.slice(0, 90).map(() => "?").join(",")})`, ...ids.slice(0, 90),
          )
        : []
      ).map((w) => [w.id, w]),
    );

    return {
      login: r.login as string,
      credential_id: r.credential_id as string,
      name: r.name as string,
      kind: (r.kind as string | null) ?? null,
      connected: r.connected === 1,
      connected_at: (r.connected_at as string | null) ?? null,
      last_activity: r.last ? JSON.parse(r.last as string) : null,
      worktrees: ids.map((id) => ({ id, repo: known.get(id)?.repo ?? null, branch: known.get(id)?.branch ?? null, path: known.get(id)?.path ?? null })),
      updated_at: r.updated_at as string,
    };
  }

  /** Publish the row as `machine.updated` (after the event that changed it has gone out). */
  private announce(login: string, cid: string): void {
    this.sql.exec("UPDATE machines SET published_at = ? WHERE login = ? AND credential_id = ?", Date.now(), login, cid);
    const r = this.rows<Record<string, unknown>>("SELECT * FROM machines WHERE login = ? AND credential_id = ?", login, cid)[0];

    if (!r) return;
    const row = this.view(r);
    this.publish({ kind: "machine.updated", collection: "machines", key: `${login}/${cid}`, op: "upsert", repo: null, actor: login, machine: row.name, agent: null, row });
  }
}
