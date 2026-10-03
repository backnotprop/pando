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
export type CredentialKind = "machine" | "sandbox" | "bootstrap" | "browser";

/**
 * A browser session lives while it is used: it ends after this many days
 * without use (a number for the owner), on sign-out, or when revoked. Each
 * use pushes the end back, at most one write a day.
 */
export const SESSION_IDLE_DAYS = 30;
const DAY_MS = 86_400_000;

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
  /** Browser sessions only: when it ends unless used before then. */
  expires_at?: string | null;
}

export interface NewCredentialRow {
  hash: string;
  name: string;
  kind: CredentialKind;
  /** Browser sessions: the WorkOS session, ended on sign-out. */
  workos_sid?: string | null;
}

export interface Member {
  login: string;
  /** The user's display name, if known. */
  name: string | null;
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

export interface Invite {
  email: string;
  role: MemberRole;
  invited_by: string;
  created_at: string;
}

/** Who WorkOS says signed in. Only an id and an email; WorkOS tokens never reach Pando's storage. */
export interface SignedIn {
  workos_id: string;
  email: string;
  email_verified: boolean;
  name: string | null;
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
CREATE TABLE IF NOT EXISTS invites (
  monorepo TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, invited_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (monorepo, email));
CREATE INDEX IF NOT EXISTS invites_email ON invites (email);
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
    // Added with WorkOS sign-in: the WorkOS user id behind a Pando user.
    const cols = this.rows<{ name: string }>("PRAGMA table_info(users)").map((c) => c.name);
    if (!cols.includes("workos_id")) this.sql.exec("ALTER TABLE users ADD COLUMN workos_id TEXT");
    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_workos ON users (workos_id)");
    // Added with browser sign-in: a session's end, and its WorkOS session.
    const ccols = this.rows<{ name: string }>("PRAGMA table_info(credentials)").map((c) => c.name);
    if (!ccols.includes("expires_at")) this.sql.exec("ALTER TABLE credentials ADD COLUMN expires_at TEXT");
    if (!ccols.includes("workos_sid")) this.sql.exec("ALTER TABLE credentials ADD COLUMN workos_sid TEXT");
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

  private insertCredential(login: string, c: NewCredentialRow): Credential {
    const id = randomId("cred_");
    const at = now();
    const expires = c.kind === "browser" ? new Date(Date.now() + SESSION_IDLE_DAYS * DAY_MS).toISOString() : null;
    this.sql.exec(
      "INSERT INTO credentials (id, hash, login, name, kind, created_at, expires_at, workos_sid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id, c.hash, login, c.name, c.kind, at, expires, c.workos_sid ?? null,
    );
    return { id, name: c.name, kind: c.kind, created_at: at, last_used_at: null, expires_at: expires };
  }

  /** Sign-out: revoke the browser session with this hash; its WorkOS session id, to end that too. */
  endBrowserSession(hash: string): { revoked: boolean; workos_sid: string | null } {
    const c = this.row<{ id: string; workos_sid: string | null }>(
      "SELECT id, workos_sid FROM credentials WHERE hash = ? AND kind = 'browser' AND revoked_at IS NULL",
      hash,
    );
    if (!c) return { revoked: false, workos_sid: null };
    this.sql.exec("UPDATE credentials SET revoked_at = ? WHERE id = ?", now(), c.id);
    return { revoked: true, workos_sid: c.workos_sid };
  }

  addCredential(login: string, c: NewCredentialRow): Credential {
    return this.insertCredential(login, c);
  }

  listCredentials(login: string): Credential[] {
    return this.rows<Credential>(
      "SELECT id, name, kind, created_at, last_used_at, expires_at FROM credentials WHERE login = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at",
      login, now(),
    );
  }

  revokeCredential(login: string, id: string): boolean {
    return this.sql.exec("UPDATE credentials SET revoked_at = ? WHERE login = ? AND id = ? AND revoked_at IS NULL", now(), login, id).rowsWritten > 0;
  }

  /** Who a credential belongs to, and their role in `monorepo` if one is named. */
  authenticate(hash: string, monorepo: string | null): Auth | null {
    const c = this.row<Credential & { login: string }>(
      "SELECT id, login, name, kind, created_at, last_used_at, expires_at FROM credentials WHERE hash = ? AND revoked_at IS NULL",
      hash,
    );
    if (!c) return null;
    const t = Date.now();
    if (c.expires_at && Date.parse(c.expires_at) <= t) return null; // a browser session unused for too long
    const user = this.getUser(c.login);
    if (!user) return null;
    if (!c.last_used_at || t - Date.parse(c.last_used_at) > 60_000) {
      this.sql.exec("UPDATE credentials SET last_used_at = ? WHERE id = ?", now(), c.id);
    }
    // Sliding: each use pushes a session's end back (at most one write a day).
    if (c.kind === "browser" && c.expires_at && Date.parse(c.expires_at) - t < (SESSION_IDLE_DAYS - 1) * DAY_MS) {
      c.expires_at = new Date(t + SESSION_IDLE_DAYS * DAY_MS).toISOString();
      this.sql.exec("UPDATE credentials SET expires_at = ? WHERE id = ?", c.expires_at, c.id);
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
    this.sql.exec("DELETE FROM invites WHERE monorepo = ?", name);
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
    return this.rows<Member>(
      "SELECT m.login, u.name, m.role, m.added_at, m.added_by FROM members m LEFT JOIN users u ON u.login = m.login WHERE m.monorepo = ? ORDER BY m.login",
      monorepo,
    );
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
      return this.row<Member>(
        "SELECT m.login, u.name, m.role, m.added_at, m.added_by FROM members m LEFT JOIN users u ON u.login = m.login WHERE m.monorepo = ? AND m.login = ?",
        monorepo, login,
      )!;
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

  // ── Sign-in and invites ──────────────────────────────────────────────────

  /**
   * After WorkOS proved who signed in: find or make the Pando user, accept any
   * invites for a verified email, and give the machine a credential.
   */
  signIn(who: SignedIn, cred: NewCredentialRow): { user: User; credential: Credential; joined: string[] } {
    const email = who.email.toLowerCase();
    let login = this.row<{ login: string }>("SELECT login FROM users WHERE workos_id = ?", who.workos_id)?.login;
    if (!login && who.email_verified) {
      // A user made before (the bootstrap path) with this email: this is them. Link, do not duplicate.
      login = this.row<{ login: string }>(
        "SELECT login FROM users WHERE lower(email) = ? AND workos_id IS NULL ORDER BY created_at LIMIT 1",
        email,
      )?.login;
      if (login) this.sql.exec("UPDATE users SET workos_id = ? WHERE login = ?", who.workos_id, login);
    }
    if (login) {
      this.sql.exec("UPDATE users SET email = ?, name = COALESCE(?, name) WHERE login = ?", email, who.name, login);
    } else {
      login = this.freeLogin(email, who.name);
      this.sql.exec("INSERT INTO users (login, name, email, created_at, workos_id) VALUES (?, ?, ?, ?, ?)", login, who.name, email, now(), who.workos_id);
    }
    const joined: string[] = [];
    if (who.email_verified) {
      for (const inv of this.rows<{ monorepo: string; role: MemberRole; invited_by: string }>("SELECT monorepo, role, invited_by FROM invites WHERE email = ?", email)) {
        this.sql.exec(
          `INSERT INTO members (monorepo, login, role, added_at, added_by) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (monorepo, login) DO NOTHING`,
          inv.monorepo, login, inv.role, now(), inv.invited_by,
        );
        joined.push(inv.monorepo);
      }
      this.sql.exec("DELETE FROM invites WHERE email = ?", email);
    }
    return { user: this.getUser(login)!, credential: this.insertCredential(login, cred), joined };
  }

  /** A login from the email's local part, made unique. */
  private freeLogin(email: string, name: string | null): string {
    const base =
      (email.split("@")[0] || name || "user").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "user";
    for (let i = 1; i < 1000; i++) {
      const candidate = i === 1 ? base : `${base}-${i}`;
      if (!this.row("SELECT login FROM users WHERE login = ?", candidate)) return candidate;
    }
    return `${base.slice(0, 20)}-${randomId("").slice(0, 8)}`;
  }

  /** Invite by email: a signed-in user with that email is added now; anyone else when they first sign in. */
  invite(monorepo: string, email: string, role: MemberRole, by: string): Outcome<{ status: "added"; member: Member } | { status: "invited"; invite: Invite }> {
    return this.guard(() => {
      const e = email.toLowerCase();
      const user = this.row<{ login: string }>("SELECT login FROM users WHERE lower(email) = ? AND workos_id IS NOT NULL", e);
      if (user) {
        const out = this.putMember(monorepo, user.login, role, by);
        if (!out.ok) fail(out.status, out.code, out.message);
        return { status: "added" as const, member: out.value };
      }
      const at = now();
      this.sql.exec(
        `INSERT INTO invites (monorepo, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (monorepo, email) DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by`,
        monorepo, e, role, by, at,
      );
      return { status: "invited" as const, invite: this.row<Invite>("SELECT email, role, invited_by, created_at FROM invites WHERE monorepo = ? AND email = ?", monorepo, e)! };
    });
  }

  invites(monorepo: string): Invite[] {
    return this.rows<Invite>("SELECT email, role, invited_by, created_at FROM invites WHERE monorepo = ? ORDER BY created_at", monorepo);
  }

  revokeInvite(monorepo: string, email: string): boolean {
    return this.sql.exec("DELETE FROM invites WHERE monorepo = ? AND email = ?", monorepo, email.toLowerCase()).rowsWritten > 0;
  }

  private ownerCount(monorepo: string): number {
    return this.row<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE monorepo = ? AND role = 'owner'", monorepo)!.n;
  }
}
