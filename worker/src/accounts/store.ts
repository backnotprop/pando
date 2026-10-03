// Accounts on D1 (C8): users, their credentials (hashed), monorepos, members
// and invites, for the whole Pando instance.
//
// Authentication reads from the nearest read replica (the Sessions API).
// Anything a replica cannot confirm (an unknown credential, an ended session,
// a missing monorepo, a non-member) is asked once more of the primary before
// the answer is no, so a credential or a monorepo made a moment ago works at
// once. Every other read, and every write, goes to the primary, so the next
// request sees a change.
//
// Identity is GitHub-like (decisions/RULINGS.md): a person is a user; a
// machine or a cloud sandbox holds a credential for that user, and git and
// every agent there act as the user.

import { HttpError, now } from "../http";
import type { Outcome } from "../monorepo/types";
import { note, timeD1 } from "../timing";

export type MemberRole = "owner" | "member";
export type CredentialKind = "machine" | "sandbox" | "bootstrap" | "browser";

/**
 * A browser session lives while it is used: it ends after this many days
 * without use (a number for the owner), on sign-out, or when revoked. Each
 * use pushes the end back, at most one write a day.
 */
export const SESSION_IDLE_DAYS = 30;
const DAY_MS = 86_400_000;
/** last_used_at is written at most this often per credential. */
const USED_EVERY_MS = 60_000;

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

/**
 * Whether an answer stands without asking the primary (and may be cached):
 * a known credential, and when a monorepo was asked about, one that exists
 * with the caller as a member. A no may only be a replica behind.
 */
export function confirmed(auth: Auth | null, monorepo: string | null): boolean {
  if (!auth) return false;
  if (monorepo === null) return true;
  return auth.monorepo !== null && auth.role !== null;
}

interface AuthRow {
  id: string;
  login: string;
  name: string;
  kind: CredentialKind;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  user_name: string | null;
  user_email: string | null;
  user_created_at: string;
  role: MemberRole | null;
  m_name: string | null;
  m_kind: "monorepo" | "repo" | null;
  m_created_at: string | null;
}

// One round trip: the credential, its user, the role and the monorepo.
const AUTH_SQL = `
SELECT c.id, c.login, c.name, c.kind, c.created_at, c.last_used_at, c.expires_at,
       u.name AS user_name, u.email AS user_email, u.created_at AS user_created_at,
       (SELECT role FROM members WHERE monorepo = ?2 AND login = c.login) AS role,
       m.name AS m_name, m.kind AS m_kind, m.created_at AS m_created_at
FROM credentials c
JOIN users u ON u.login = c.login
LEFT JOIN monorepos m ON m.name = ?2
WHERE c.hash = ?1 AND c.revoked_at IS NULL`;

const MEMBER_SQL =
  "SELECT m.login, u.name, m.role, m.added_at, m.added_by FROM members m LEFT JOIN users u ON u.login = m.login";

function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

function randomId(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** A login from the email's local part: base, base-2, base-3..., then a random tail. */
function* loginsFor(email: string, name: string | null): Generator<string> {
  const base =
    (email.split("@")[0] || name || "user").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "user";
  yield base;
  for (let i = 2; i < 1000; i++) yield `${base}-${i}`;
  yield `${base.slice(0, 20)}-${randomId("").slice(0, 8)}`;
}

/** Run a write after the response is sent (Workers' waitUntil), or now where there is none. */
async function later(p: Promise<unknown>): Promise<void> {
  const quiet = p.catch((err) => console.error({ msg: "pando.accounts", error: err instanceof Error ? err.message : String(err) }));
  try {
    const { waitUntil } = await import("cloudflare:workers");
    waitUntil(quiet);
  } catch {
    await quiet;
  }
}

type Reader = D1Database | D1DatabaseSession;

export class Accounts {
  /** ready: awaited before the first query (the one-time copy from the AccountsObject). */
  constructor(
    private db: D1Database,
    private ready: () => Promise<void> = async () => {},
  ) {}

  private st(query: string, ...args: unknown[]): D1PreparedStatement {
    return this.db.prepare(query).bind(...args.map((a) => (a === undefined ? null : a)));
  }

  private async read<T>(on: Reader, query: string, ...args: unknown[]): Promise<D1Result<T>> {
    await this.ready();
    return timeD1(() => on.prepare(query).bind(...args.map((a) => (a === undefined ? null : a))).all<T>());
  }

  /** Rows, read on the primary. */
  private async rows<T>(query: string, ...args: unknown[]): Promise<T[]> {
    return (await this.read<T>(this.db, query, ...args)).results;
  }

  private async row<T>(query: string, ...args: unknown[]): Promise<T | null> {
    return (await this.rows<T>(query, ...args))[0] ?? null;
  }

  /** One write on the primary; the rows it changed. */
  private async run(query: string, ...args: unknown[]): Promise<number> {
    await this.ready();
    return (await timeD1(() => this.st(query, ...args).run())).meta.changes;
  }

  /** Statements in one transaction on the primary. */
  private async batch(stmts: D1PreparedStatement[]): Promise<D1Result[]> {
    await this.ready();
    return timeD1(() => this.db.batch(stmts));
  }

  private async guard<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      if (err instanceof HttpError) return { ok: false, status: err.status, code: err.code, message: err.message };
      throw err;
    }
  }

  // ── Authentication ───────────────────────────────────────────────────────

  /** Who a credential belongs to, and their role in `monorepo` if one is named. */
  async authenticate(hash: string, monorepo: string | null): Promise<Auth | null> {
    const t = Date.now();
    let got = await this.readAuth(this.db.withSession("first-unconstrained"), hash, monorepo, t);
    const replica = got.served;
    if (!confirmed(got.auth, monorepo)) got = await this.readAuth(this.db.withSession("first-primary"), hash, monorepo, t);
    note({ d1_auth: replica === got.served ? replica : `${replica}, then ${got.served}` });
    const { auth, row } = got;
    if (!auth || !row) return null;
    // Bookkeeping on the primary, after the answer: last_used_at at most once a
    // minute, and a browser session's end pushed back at most once a day.
    const writes: D1PreparedStatement[] = [];
    if (!row.last_used_at || t - Date.parse(row.last_used_at) > USED_EVERY_MS) {
      writes.push(
        this.st(
          "UPDATE credentials SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?3)",
          new Date(t).toISOString(), row.id, new Date(t - USED_EVERY_MS).toISOString(),
        ),
      );
    }
    if (row.kind === "browser" && row.expires_at && Date.parse(row.expires_at) - t < (SESSION_IDLE_DAYS - 1) * DAY_MS) {
      const until = new Date(t + SESSION_IDLE_DAYS * DAY_MS).toISOString();
      auth.credential.expires_at = until;
      writes.push(this.st("UPDATE credentials SET expires_at = ?1 WHERE id = ?2 AND expires_at < ?1", until, row.id));
    }
    if (writes.length) void later(timeD1(() => this.db.batch(writes)));
    return auth;
  }

  private async readAuth(on: Reader, hash: string, monorepo: string | null, t: number): Promise<{ auth: Auth | null; row: AuthRow | null; served: string }> {
    const res = await this.read<AuthRow>(on, AUTH_SQL, hash, monorepo);
    const served = res.meta.served_by_primary === false ? `replica ${res.meta.served_by_region ?? "?"}` : "primary";
    const row = res.results[0] ?? null;
    // A browser session unused for too long has ended.
    if (!row || (row.expires_at && Date.parse(row.expires_at) <= t)) return { auth: null, row: null, served };
    const auth: Auth = {
      user: { login: row.login, name: row.user_name, email: row.user_email, created_at: row.user_created_at },
      credential: { id: row.id, name: row.name, kind: row.kind, created_at: row.created_at, last_used_at: row.last_used_at, expires_at: row.expires_at },
      role: monorepo ? row.role : null,
      monorepo: monorepo && row.m_name ? { name: row.m_name, kind: row.m_kind!, created_at: row.m_created_at! } : null,
    };
    return { auth, row, served };
  }

  // ── Users and credentials ────────────────────────────────────────────────

  async createUser(u: { login: string; name: string | null; email: string | null }, cred: { hash: string; name: string; kind: CredentialKind }): Promise<Outcome<{ user: User; credential: Credential }>> {
    return this.guard(async () => {
      const at = now();
      const made = await this.run(
        "INSERT INTO users (login, name, email, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (login) DO NOTHING",
        u.login, u.name, u.email, at,
      );
      if (!made) fail(409, "user_exists", `user ${u.login} exists`);
      return { user: { ...u, created_at: at }, credential: await this.insertCredential(u.login, cred) };
    });
  }

  async getUser(login: string): Promise<User | null> {
    return this.row<User>("SELECT login, name, email, created_at FROM users WHERE login = ?1", login);
  }

  private async insertCredential(login: string, c: NewCredentialRow): Promise<Credential> {
    const id = randomId("cred_");
    const at = now();
    const expires = c.kind === "browser" ? new Date(Date.now() + SESSION_IDLE_DAYS * DAY_MS).toISOString() : null;
    await this.run(
      "INSERT INTO credentials (id, hash, login, name, kind, created_at, expires_at, workos_sid) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      id, c.hash, login, c.name, c.kind, at, expires, c.workos_sid ?? null,
    );
    return { id, name: c.name, kind: c.kind, created_at: at, last_used_at: null, expires_at: expires };
  }

  /** Sign-out: revoke the browser session with this hash; its WorkOS session id, to end that too. */
  async endBrowserSession(hash: string): Promise<{ revoked: boolean; workos_sid: string | null }> {
    const r = await this.row<{ workos_sid: string | null }>(
      "UPDATE credentials SET revoked_at = ?1 WHERE hash = ?2 AND kind = 'browser' AND revoked_at IS NULL RETURNING workos_sid",
      now(), hash,
    );
    return r ? { revoked: true, workos_sid: r.workos_sid } : { revoked: false, workos_sid: null };
  }

  async addCredential(login: string, c: NewCredentialRow): Promise<Credential> {
    return this.insertCredential(login, c);
  }

  async listCredentials(login: string): Promise<Credential[]> {
    return this.rows<Credential>(
      "SELECT id, name, kind, created_at, last_used_at, expires_at FROM credentials WHERE login = ?1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?2) ORDER BY created_at",
      login, now(),
    );
  }

  async revokeCredential(login: string, id: string): Promise<boolean> {
    return (await this.run("UPDATE credentials SET revoked_at = ?1 WHERE login = ?2 AND id = ?3 AND revoked_at IS NULL", now(), login, id)) > 0;
  }

  // ── Monorepos and members ────────────────────────────────────────────────

  /** Record a new monorepo with its creator as owner. False if the name is taken. */
  async claimMonorepo(name: string, kind: "monorepo" | "repo", login: string): Promise<boolean> {
    const at = now();
    const [made] = await this.batch([
      this.st("INSERT INTO monorepos (name, kind, created_at, created_by) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (name) DO NOTHING", name, kind, at, login),
      // The owner, only for the row just made (same creator and time) and only once.
      this.st(
        `INSERT INTO members (monorepo, login, role, added_at, added_by)
         SELECT ?1, ?2, 'owner', ?3, NULL
         WHERE EXISTS (SELECT 1 FROM monorepos WHERE name = ?1 AND created_by = ?2 AND created_at = ?3)
           AND NOT EXISTS (SELECT 1 FROM members WHERE monorepo = ?1)`,
        name, login, at,
      ),
    ]);
    return made.meta.changes === 1;
  }

  /** Undo claimMonorepo when creating the monorepo failed; forget a deleted one. */
  async releaseMonorepo(name: string): Promise<void> {
    await this.batch([
      this.st("DELETE FROM invites WHERE monorepo = ?1", name),
      this.st("DELETE FROM members WHERE monorepo = ?1", name),
      this.st("DELETE FROM monorepos WHERE name = ?1", name),
    ]);
  }

  async monoreposOf(login: string): Promise<MonorepoEntry[]> {
    return this.rows<MonorepoEntry>(
      `SELECT m.name, m.kind, b.role, m.created_at FROM members b JOIN monorepos m ON m.name = b.monorepo
       WHERE b.login = ?1 ORDER BY m.name`,
      login,
    );
  }

  async members(monorepo: string): Promise<Member[]> {
    return this.rows<Member>(`${MEMBER_SQL} WHERE m.monorepo = ?1 ORDER BY m.login`, monorepo);
  }

  async putMember(monorepo: string, login: string, role: MemberRole, by: string): Promise<Outcome<Member>> {
    return this.guard(async () => {
      if (!(await this.getUser(login))) fail(404, "not_found", `no user ${login}`);
      // One statement, so two demotions at once cannot leave no owner.
      const changed = await this.run(
        `INSERT INTO members (monorepo, login, role, added_at, added_by) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (monorepo, login) DO UPDATE SET role = excluded.role
         WHERE NOT (members.role = 'owner' AND excluded.role <> 'owner'
                    AND (SELECT COUNT(*) FROM members WHERE monorepo = ?1 AND role = 'owner') = 1)`,
        monorepo, login, role, now(), by,
      );
      if (!changed) fail(409, "last_owner", "a monorepo keeps at least one owner");
      return (await this.row<Member>(`${MEMBER_SQL} WHERE m.monorepo = ?1 AND m.login = ?2`, monorepo, login))!;
    });
  }

  async removeMember(monorepo: string, login: string): Promise<Outcome<boolean>> {
    return this.guard(async () => {
      const removed = await this.run(
        `DELETE FROM members WHERE monorepo = ?1 AND login = ?2
           AND (role <> 'owner' OR (SELECT COUNT(*) FROM members WHERE monorepo = ?1 AND role = 'owner') > 1)`,
        monorepo, login,
      );
      if (removed) return true;
      if (!(await this.row("SELECT 1 AS x FROM members WHERE monorepo = ?1 AND login = ?2", monorepo, login))) fail(404, "not_found", `${login} is not a member`);
      fail(409, "last_owner", "a monorepo keeps at least one owner");
    });
  }

  // ── Sign-in and invites ──────────────────────────────────────────────────

  /**
   * After WorkOS proved who signed in: find or make the Pando user, accept any
   * invites for a verified email, and give the machine a credential.
   */
  async signIn(who: SignedIn, cred: NewCredentialRow): Promise<{ user: User; credential: Credential; joined: string[] }> {
    const email = who.email.toLowerCase();
    let login = (await this.row<{ login: string }>("SELECT login FROM users WHERE workos_id = ?1", who.workos_id))?.login;
    if (!login && who.email_verified) {
      // A user made before (the bootstrap path) with this email: this is them. Link, do not duplicate.
      login = (await this.row<{ login: string }>(
        "SELECT login FROM users WHERE lower(email) = ?1 AND workos_id IS NULL ORDER BY created_at LIMIT 1",
        email,
      ))?.login;
      if (login) await this.run("UPDATE users SET workos_id = ?1 WHERE login = ?2 AND workos_id IS NULL", who.workos_id, login);
    }
    if (login) await this.run("UPDATE users SET email = ?1, name = COALESCE(?2, name) WHERE login = ?3", email, who.name, login);
    else login = await this.newUser(email, who);
    const joined: string[] = [];
    if (who.email_verified) {
      const invites = await this.rows<{ monorepo: string; role: MemberRole; invited_by: string }>(
        "SELECT monorepo, role, invited_by FROM invites WHERE email = ?1",
        email,
      );
      if (invites.length) {
        const at = now();
        await this.batch([
          ...invites.map((inv) =>
            this.st(
              "INSERT INTO members (monorepo, login, role, added_at, added_by) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (monorepo, login) DO NOTHING",
              inv.monorepo, login, inv.role, at, inv.invited_by,
            ),
          ),
          this.st("DELETE FROM invites WHERE email = ?1", email),
        ]);
        joined.push(...invites.map((inv) => inv.monorepo));
      }
    }
    return { user: (await this.getUser(login))!, credential: await this.insertCredential(login, cred), joined };
  }

  /** A new user under the first free login. */
  private async newUser(email: string, who: SignedIn): Promise<string> {
    for (const login of loginsFor(email, who.name)) {
      try {
        const made = await this.run(
          "INSERT INTO users (login, name, email, created_at, workos_id) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (login) DO NOTHING",
          login, who.name, email, now(), who.workos_id,
        );
        if (made) return login;
      } catch (err) {
        // The same WorkOS user signing in twice at once: the other one made the user.
        const other = await this.row<{ login: string }>("SELECT login FROM users WHERE workos_id = ?1", who.workos_id);
        if (other) return other.login;
        throw err;
      }
    }
    throw new HttpError(500, "internal", "no free login");
  }

  /** Invite by email: a signed-in user with that email is added now; anyone else when they first sign in. */
  async invite(monorepo: string, email: string, role: MemberRole, by: string): Promise<Outcome<{ status: "added"; member: Member } | { status: "invited"; invite: Invite }>> {
    return this.guard(async () => {
      const e = email.toLowerCase();
      const user = await this.row<{ login: string }>("SELECT login FROM users WHERE lower(email) = ?1 AND workos_id IS NOT NULL", e);
      if (user) {
        const out = await this.putMember(monorepo, user.login, role, by);
        if (!out.ok) fail(out.status, out.code, out.message);
        return { status: "added" as const, member: out.value };
      }
      const invite = await this.row<Invite>(
        `INSERT INTO invites (monorepo, email, role, invited_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (monorepo, email) DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by
         RETURNING email, role, invited_by, created_at`,
        monorepo, e, role, by, now(),
      );
      return { status: "invited" as const, invite: invite! };
    });
  }

  async invites(monorepo: string): Promise<Invite[]> {
    return this.rows<Invite>("SELECT email, role, invited_by, created_at FROM invites WHERE monorepo = ?1 ORDER BY created_at", monorepo);
  }

  async revokeInvite(monorepo: string, email: string): Promise<boolean> {
    return (await this.run("DELETE FROM invites WHERE monorepo = ?1 AND email = ?2", monorepo, email.toLowerCase())) > 0;
  }
}
