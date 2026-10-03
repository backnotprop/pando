// The accounts object: one Durable Object (SQLite) for the whole Pando
// instance. It keeps users, their credentials (hashed) and who belongs to
// which monorepo. Owned by the server-git lane.
//
// Identity is GitHub-like (decisions/RULINGS.md): a person is a user; a
// machine or a cloud sandbox holds a credential for that user, and git and
// every agent there act as the user.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { HttpError, now } from "../http";
import type { Outcome } from "../monorepo/types";

export type MemberRole = "owner" | "member";
export type CredentialKind = "machine" | "sandbox" | "bootstrap";

export interface User {
  login: string;
  name: string | null;
  email: string | null;
  created_at: string;
}

export interface Credential {
  id: string;
  name: string;
  kind: CredentialKind;
  created_at: string;
  last_used_at: string | null;
}

export interface Member {
  login: string;
  role: MemberRole;
  added_at: string;
  added_by: string | null;
}

export interface MonorepoEntry {
  name: string;
  kind: "monorepo" | "repo";
  role: MemberRole;
  created_at: string;
}

export interface Auth {
  user: User;
  credential: Credential;
  /** The user's role in the monorepo asked about; null if not a member or none asked. */
  role: MemberRole | null;
  /** The monorepo asked about, if it exists. */
  monorepo: { name: string; kind: "monorepo" | "repo"; created_at: string } | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (login TEXT PRIMARY KEY, name TEXT, email TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, login TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
CREATE INDEX IF NOT EXISTS credentials_login ON credentials (login);
CREATE TABLE IF NOT EXISTS monorepos (name TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (
  monorepo TEXT NOT NULL, login TEXT NOT NULL, role TEXT NOT NULL, added_at TEXT NOT NULL, added_by TEXT,
  PRIMARY KEY (monorepo, login));
CREATE INDEX IF NOT EXISTS members_login ON members (login);
`;

function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

function randomId(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export class AccountsObject extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
  }

  private rows<T>(query: string, ...args: unknown[]): T[] {
    return this.sql.exec(query, ...args).toArray() as unknown as T[];
  }

  private row<T>(query: string, ...args: unknown[]): T | null {
    return this.rows<T>(query, ...args)[0] ?? null;
  }

  private guard<T>(fn: () => T): Outcome<T> {
    try {
      return { ok: true, value: fn() };
    } catch (err) {
      if (err instanceof HttpError) return { ok: false, status: err.status, code: err.code, message: err.message };
      throw err;
    }
  }

  // ── Users and credentials ────────────────────────────────────────────────

  createUser(u: { login: string; name: string | null; email: string | null }, cred: { hash: string; name: string; kind: CredentialKind }): Outcome<{ user: User; credential: Credential }> {
    return this.guard(() => {
      if (this.row("SELECT login FROM users WHERE login = ?", u.login)) fail(409, "user_exists", `user ${u.login} exists`);
      const at = now();
      this.sql.exec("INSERT INTO users (login, name, email, created_at) VALUES (?, ?, ?, ?)", u.login, u.name, u.email, at);
      return { user: { ...u, created_at: at }, credential: this.insertCredential(u.login, cred) };
    });
  }

  getUser(login: string): User | null {
    return this.row<User>("SELECT login, name, email, created_at FROM users WHERE login = ?", login);
  }

  private insertCredential(login: string, c: { hash: string; name: string; kind: CredentialKind }): Credential {
    const id = randomId("cred_");
    const at = now();
    this.sql.exec(
      "INSERT INTO credentials (id, hash, login, name, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id, c.hash, login, c.name, c.kind, at,
    );
    return { id, name: c.name, kind: c.kind, created_at: at, last_used_at: null };
  }

  addCredential(login: string, c: { hash: string; name: string; kind: CredentialKind }): Credential {
    return this.insertCredential(login, c);
  }

  listCredentials(login: string): Credential[] {
    return this.rows<Credential>(
      "SELECT id, name, kind, created_at, last_used_at FROM credentials WHERE login = ? AND revoked_at IS NULL ORDER BY created_at",
      login,
    );
  }

  revokeCredential(login: string, id: string): boolean {
    return this.sql.exec("UPDATE credentials SET revoked_at = ? WHERE login = ? AND id = ? AND revoked_at IS NULL", now(), login, id).rowsWritten > 0;
  }

  /** Who a credential belongs to, and their role in `monorepo` if one is named. */
  authenticate(hash: string, monorepo: string | null): Auth | null {
    const c = this.row<Credential & { login: string }>(
      "SELECT id, login, name, kind, created_at, last_used_at FROM credentials WHERE hash = ? AND revoked_at IS NULL",
      hash,
    );
    if (!c) return null;
    const user = this.getUser(c.login);
    if (!user) return null;
    if (!c.last_used_at || Date.now() - Date.parse(c.last_used_at) > 60_000) {
      this.sql.exec("UPDATE credentials SET last_used_at = ? WHERE id = ?", now(), c.id);
    }
    const role = monorepo
      ? (this.row<{ role: MemberRole }>("SELECT role FROM members WHERE monorepo = ? AND login = ?", monorepo, c.login)?.role ?? null)
      : null;
    const mono = monorepo
      ? this.row<{ name: string; kind: "monorepo" | "repo"; created_at: string }>("SELECT name, kind, created_at FROM monorepos WHERE name = ?", monorepo)
      : null;
    const { login: _login, ...credential } = c;
    return { user, credential, role, monorepo: mono };
  }

  // ── Monorepos and members ────────────────────────────────────────────────

  /** Record a new monorepo with its creator as owner. False if the name is taken. */
  claimMonorepo(name: string, kind: "monorepo" | "repo", login: string): boolean {
    if (this.row("SELECT name FROM monorepos WHERE name = ?", name)) return false;
    const at = now();
    this.sql.exec("INSERT INTO monorepos (name, kind, created_at, created_by) VALUES (?, ?, ?, ?)", name, kind, at, login);
    this.sql.exec("INSERT INTO members (monorepo, login, role, added_at, added_by) VALUES (?, ?, 'owner', ?, NULL)", name, login, at);
    return true;
  }

  /** Undo claimMonorepo when creating the monorepo failed. */
  releaseMonorepo(name: string): void {
    this.sql.exec("DELETE FROM members WHERE monorepo = ?", name);
    this.sql.exec("DELETE FROM monorepos WHERE name = ?", name);
  }

  monoreposOf(login: string): MonorepoEntry[] {
    return this.rows<MonorepoEntry>(
      `SELECT m.name, m.kind, b.role, m.created_at FROM members b JOIN monorepos m ON m.name = b.monorepo
       WHERE b.login = ? ORDER BY m.name`,
      login,
    );
  }

  members(monorepo: string): Member[] {
    return this.rows<Member>("SELECT login, role, added_at, added_by FROM members WHERE monorepo = ? ORDER BY login", monorepo);
  }

  putMember(monorepo: string, login: string, role: MemberRole, by: string): Outcome<Member> {
    return this.guard(() => {
      if (!this.getUser(login)) fail(404, "not_found", `no user ${login}`);
      const old = this.row<{ role: MemberRole }>("SELECT role FROM members WHERE monorepo = ? AND login = ?", monorepo, login);
      if (old?.role === "owner" && role !== "owner" && this.ownerCount(monorepo) === 1) fail(409, "last_owner", "a monorepo keeps at least one owner");
      const at = now();
      this.sql.exec(
        `INSERT INTO members (monorepo, login, role, added_at, added_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (monorepo, login) DO UPDATE SET role = excluded.role`,
        monorepo, login, role, at, by,
      );
      return this.row<Member>("SELECT login, role, added_at, added_by FROM members WHERE monorepo = ? AND login = ?", monorepo, login)!;
    });
  }

  removeMember(monorepo: string, login: string): Outcome<boolean> {
    return this.guard(() => {
      const old = this.row<{ role: MemberRole }>("SELECT role FROM members WHERE monorepo = ? AND login = ?", monorepo, login);
      if (!old) fail(404, "not_found", `${login} is not a member`);
      if (old.role === "owner" && this.ownerCount(monorepo) === 1) fail(409, "last_owner", "a monorepo keeps at least one owner");
      this.sql.exec("DELETE FROM members WHERE monorepo = ? AND login = ?", monorepo, login);
      return true;
    });
  }

  private ownerCount(monorepo: string): number {
    return this.row<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE monorepo = ? AND role = 'owner'", monorepo)!.n;
  }
}
