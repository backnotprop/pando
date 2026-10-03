// The accounts object: where users, credentials and members lived before
// they moved to D1 (C8, accounts/store.ts). It is kept for one job, the
// one-time copy of its rows into D1, and goes after launch (a deleted_classes
// migration) together with the copy call in auth.ts.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { now } from "../http";

export type {
  Auth, Credential, CredentialKind, Invite, Member, MemberRole, MonorepoEntry, MonorepoInfo, MonorepoRef, NewCredentialRow, SignedIn, User,
} from "./store";

// The tables as they were, so an object that never ran still answers.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (login TEXT PRIMARY KEY, name TEXT, email TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, login TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS monorepos (name TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (
  monorepo TEXT NOT NULL, login TEXT NOT NULL, role TEXT NOT NULL, added_at TEXT NOT NULL, added_by TEXT,
  PRIMARY KEY (monorepo, login));
CREATE TABLE IF NOT EXISTS invites (
  monorepo TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, invited_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (monorepo, email));
CREATE TABLE IF NOT EXISTS copied_to_d1 (at TEXT NOT NULL, rows INTEGER NOT NULL);
`;

type Row = Record<string, SqlStorageValue>;

/**
 * The object's tables, as D1 now keeps them (migration 0003): every user is
 * also a namespace; a monorepo's old name is its id and its creator its owner.
 */
const COPY: { from: string; to: string; map: (r: Row) => Row }[] = [
  { from: "users", to: "users", map: (r) => r },
  { from: "users", to: "namespaces", map: (r) => ({ name: r.login, kind: "user", created_at: r.created_at }) },
  { from: "credentials", to: "credentials", map: (r) => r },
  {
    from: "monorepos",
    to: "monorepos",
    map: (r) => ({ id: r.name, owner: r.created_by, name: r.name, kind: r.kind, created_at: r.created_at, created_by: r.created_by }),
  },
  { from: "members", to: "members", map: ({ monorepo, ...r }) => ({ monorepo_id: monorepo, ...r }) },
  { from: "invites", to: "invites", map: ({ monorepo, ...r }) => ({ monorepo_id: monorepo, ...r }) },
];

/** Statements per D1 batch while copying. */
const COPY_BATCH = 50;

export class AccountsObject extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
  }

  /**
   * Copy every row into D1, once. Later calls (and calls waiting while it
   * runs) return at once. A row D1 already has is kept as it is.
   */
  async copyToD1(): Promise<{ copied: boolean; rows: number }> {
    let out = { copied: false, rows: 0 };
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.sql.exec("SELECT at FROM copied_to_d1").toArray().length) return;
      const db = this.env.ACCOUNTS_DB;
      const stmts: D1PreparedStatement[] = [];

      for (const { from, to, map } of COPY) {
        for (const raw of this.sql.exec(`SELECT * FROM ${from}`).toArray()) {
          const r = map(raw as Row);
          const cols = Object.keys(r);
          stmts.push(
            db
              .prepare(`INSERT OR IGNORE INTO ${to} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`)
              .bind(...cols.map((c) => r[c] ?? null)),
          );
        }
      }

      for (let i = 0; i < stmts.length; i += COPY_BATCH) await db.batch(stmts.slice(i, i + COPY_BATCH));
      this.sql.exec("INSERT INTO copied_to_d1 (at, rows) VALUES (?, ?)", now(), stmts.length);
      console.log({ msg: "pando.accounts", copied_to_d1: stmts.length });
      out = { copied: true, rows: stmts.length };
    });

    return out;
  }
}
