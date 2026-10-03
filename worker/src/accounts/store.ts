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
import { newMonorepoId, RESERVED_NAMESPACES } from "../monorepo/names";
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
  /** Their WorkOS profile picture (https), refreshed on each sign-in; null when none. */
  picture_url: string | null;
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
  /** Their profile picture, or null (the web draws one). */
  picture_url: string | null;
  role: MemberRole;
  added_at: string;
  added_by: string | null;
  /** The newest last_used_at of any of their credentials (written at most once a minute); null if never. */
  last_active_at: string | null;
}

/** A path's owner and monorepo name, lower case (names.ts monorepoRef). */
export interface MonorepoRef {
  owner: string;
  name: string;
}

/** A monorepo as the API shows it. `id` is permanent; `owner/name` is its current label. */
export interface MonorepoInfo {
  id: string;
  owner: string;
  name: string;
  full_name: string;
  kind: "monorepo" | "repo";
  created_at: string;
}

export interface MonorepoEntry extends MonorepoInfo {
  role: MemberRole;
}

/** An old name that led to another monorepo and now leads to this one (never silent). */
export interface ReplacedAlias {
  full_name: string;
  pointed_to: string | null;
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
  /** WorkOS's profile_picture_url, if https. */
  picture_url: string | null;
}

export interface Auth {
  user: User;
  credential: Credential;
  /** The user's role in the monorepo asked about; null if not a member or none asked. */
  role: MemberRole | null;
  /** The monorepo asked about (by its name or an old name), if it exists. */
  monorepo: MonorepoInfo | null;
}

/**
 * Whether an answer stands without asking the primary (and may be cached):
 * a known credential, and when a monorepo was asked about, one that exists
 * with the caller as a member. A no may only be a replica behind.
 */
export function confirmed(auth: Auth | null, monorepo: MonorepoRef | string | null): boolean {
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
  user_picture_url: string | null;
  user_created_at: string;
  role: MemberRole | null;
  m_id: string | null;
  m_owner: string | null;
  m_name: string | null;
  m_kind: "monorepo" | "repo" | null;
  m_created_at: string | null;
}

// The monorepo a path names: by its name, else by an old name (an alias).
const RESOLVE = `COALESCE(
  (SELECT id FROM monorepos WHERE owner = ?2 AND name = ?3),
  (SELECT monorepo_id FROM monorepo_aliases WHERE owner = ?2 AND name = ?3))`;

// One round trip: the credential, its user, the monorepo and the role in it.
const AUTH_SQL = `
SELECT c.id, c.login, c.name, c.kind, c.created_at, c.last_used_at, c.expires_at,
       u.name AS user_name, u.email AS user_email, u.picture_url AS user_picture_url, u.created_at AS user_created_at,
       (SELECT role FROM members WHERE monorepo_id = m.id AND login = c.login) AS role,
       m.id AS m_id, m.owner AS m_owner, m.name AS m_name, m.kind AS m_kind, m.created_at AS m_created_at
FROM credentials c
JOIN users u ON u.login = c.login
LEFT JOIN monorepos m ON m.id = ${RESOLVE}
WHERE c.hash = ?1 AND c.revoked_at IS NULL`;

const MONOREPO_COLS = "m.id, m.owner, m.name, m.owner || '/' || m.name AS full_name, m.kind, m.created_at";

const MEMBER_SQL = `
SELECT m.login, u.name, u.picture_url, m.role, m.added_at, m.added_by,
       (SELECT MAX(last_used_at) FROM credentials WHERE login = m.login) AS last_active_at
FROM members m LEFT JOIN users u ON u.login = m.login`;

function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

function randomId(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Hyphens off both ends (after any cut, so a suffix never makes "--"). */
function trimHyphens(s: string): string {
  return s.replace(/^-+|-+$/g, "");
}

/**
 * Logins for a first-time person, from their email's local part (NAMESPACES.md
 * section 3): base, base-2 ... base-999, then base cut to 20 plus 8 random hex.
 * Reserved names are skipped here; taken ones by the database.
 */
export function* loginsFor(email: string, name: string | null): Generator<string> {
  const base = trimHyphens((email.split("@")[0] || name || "user").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32)) || "user";
  const all = function* () {
    yield base;
    for (let i = 2; i < 1000; i++) yield `${base}-${i}`;
    yield `${trimHyphens(base.slice(0, 20)) || "user"}-${randomId("").slice(0, 8)}`;
  };
  for (const login of all()) if (!RESERVED_NAMESPACES.has(login)) yield login;
}

function monorepoOf(r: AuthRow): MonorepoInfo | null {
  if (!r.m_id) return null;
  return { id: r.m_id, owner: r.m_owner!, name: r.m_name!, full_name: `${r.m_owner}/${r.m_name}`, kind: r.m_kind!, created_at: r.m_created_at! };
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
  /** `monorepo`: the path's owner/name (lower case), matched by name or old name. */
  async authenticate(hash: string, monorepo: MonorepoRef | null): Promise<Auth | null> {
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

  private async readAuth(on: Reader, hash: string, monorepo: MonorepoRef | null, t: number): Promise<{ auth: Auth | null; row: AuthRow | null; served: string }> {
    const res = await this.read<AuthRow>(on, AUTH_SQL, hash, monorepo?.owner ?? null, monorepo?.name ?? null);
    const served = res.meta.served_by_primary === false ? `replica ${res.meta.served_by_region ?? "?"}` : "primary";
    const row = res.results[0] ?? null;
    // A browser session unused for too long has ended.
    if (!row || (row.expires_at && Date.parse(row.expires_at) <= t)) return { auth: null, row: null, served };
    const auth: Auth = {
      user: { login: row.login, name: row.user_name, email: row.user_email, picture_url: row.user_picture_url, created_at: row.user_created_at },
      credential: { id: row.id, name: row.name, kind: row.kind, created_at: row.created_at, last_used_at: row.last_used_at, expires_at: row.expires_at },
      role: monorepo ? row.role : null,
      monorepo: monorepo ? monorepoOf(row) : null,
    };
    return { auth, row, served };
  }

  /**
   * A monorepo by its owner/name or an old name, without a credential (the
   * git door's hook read tokens, which Artifacts checks itself). Replica
   * first; a miss is asked of the primary.
   */
  async resolve(ref: MonorepoRef): Promise<MonorepoInfo | null> {
    const q = `SELECT ${MONOREPO_COLS} FROM monorepos m WHERE m.id = ${RESOLVE.replaceAll("?2", "?1").replaceAll("?3", "?2")}`;
    const first = (await this.read<MonorepoInfo>(this.db.withSession("first-unconstrained"), q, ref.owner, ref.name)).results[0];
    return first ?? (await this.read<MonorepoInfo>(this.db.withSession("first-primary"), q, ref.owner, ref.name)).results[0] ?? null;
  }

  // ── Users and credentials ────────────────────────────────────────────────

  async createUser(u: { login: string; name: string | null; email: string | null }, cred: { hash: string; name: string; kind: CredentialKind }): Promise<Outcome<{ user: User; credential: Credential }>> {
    return this.guard(async () => {
      const at = now();
      if (!(await this.claimLogin(u.login, u.name, u.email, null, null, at))) fail(409, "namespace_taken", `${u.login} is taken (a user or an organization)`);
      return { user: { ...u, picture_url: null, created_at: at }, credential: await this.insertCredential(u.login, cred) };
    });
  }

  async getUser(login: string): Promise<User | null> {
    return this.row<User>("SELECT login, name, email, picture_url, created_at FROM users WHERE login = ?1", login);
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

  /**
   * A new monorepo owner/name with a new id and its creator as owner. Null if
   * the name is taken in that namespace. An old name of another monorepo is
   * taken over, and reported.
   */
  async claimMonorepo(owner: string, name: string, kind: "monorepo" | "repo", login: string): Promise<{ info: MonorepoInfo; replaced_alias: ReplacedAlias | null } | null> {
    const id = newMonorepoId();
    const at = now();
    const [alias, made] = await this.batch([
      this.st(
        `SELECT a.monorepo_id, m.owner || '/' || m.name AS pointed_to FROM monorepo_aliases a
         LEFT JOIN monorepos m ON m.id = a.monorepo_id WHERE a.owner = ?1 AND a.name = ?2`,
        owner, name,
      ),
      this.st(
        "INSERT INTO monorepos (id, owner, name, kind, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (owner, name) DO NOTHING",
        id, owner, name, kind, at, login,
      ),
      this.st("INSERT INTO members (monorepo_id, login, role, added_at, added_by) SELECT ?1, ?2, 'owner', ?3, NULL WHERE EXISTS (SELECT 1 FROM monorepos WHERE id = ?1)", id, login, at),
      this.st("DELETE FROM monorepo_aliases WHERE owner = ?1 AND name = ?2 AND EXISTS (SELECT 1 FROM monorepos WHERE id = ?3)", owner, name, id),
    ]);
    if (made.meta.changes !== 1) return null;
    const was = (alias.results as { monorepo_id: string; pointed_to: string | null }[])[0];
    return {
      info: { id, owner, name, full_name: `${owner}/${name}`, kind, created_at: at },
      replaced_alias: was ? { full_name: `${owner}/${name}`, pointed_to: was.pointed_to } : null,
    };
  }

  /** Undo claimMonorepo when creating the monorepo failed; forget a deleted one, with its old names. */
  async releaseMonorepo(id: string): Promise<void> {
    await this.batch([
      this.st("DELETE FROM invites WHERE monorepo_id = ?1", id),
      this.st("DELETE FROM members WHERE monorepo_id = ?1", id),
      this.st("DELETE FROM monorepo_aliases WHERE monorepo_id = ?1", id),
      this.st("DELETE FROM monorepos WHERE id = ?1", id),
    ]);
  }

  /**
   * Rename or transfer: the label moves, the id stays. The old name becomes
   * an alias; an alias the new name had (to another monorepo) is dropped and
   * reported.
   */
  async renameMonorepo(id: string, to: MonorepoRef): Promise<Outcome<{ info: MonorepoInfo; replaced_alias: ReplacedAlias | null }>> {
    return this.guard(async () => {
      const cur = await this.row<MonorepoInfo>(`SELECT ${MONOREPO_COLS} FROM monorepos m WHERE m.id = ?1`, id);
      if (!cur) fail(404, "not_found", "no such monorepo");
      if (cur.owner === to.owner && cur.name === to.name) fail(400, "bad_request", `${cur.full_name} already has that name`);
      if (to.owner !== cur.owner) {
        // A transfer, for now to a person who is already an owner of it (organizations come later).
        const role = (await this.row<{ role: MemberRole }>("SELECT role FROM members WHERE monorepo_id = ?1 AND login = ?2", id, to.owner))?.role;
        if (role !== "owner") fail(400, "bad_owner", `${to.owner} must be a person who is already an owner of ${cur.full_name} (organizations come later)`);
      }
      const at = now();
      const done = "EXISTS (SELECT 1 FROM monorepos WHERE id = ?1 AND owner = ?2 AND name = ?3)";
      const [alias, moved] = await this.batch([
        this.st(
          `SELECT a.monorepo_id, m.owner || '/' || m.name AS pointed_to FROM monorepo_aliases a
           LEFT JOIN monorepos m ON m.id = a.monorepo_id WHERE a.owner = ?1 AND a.name = ?2`,
          to.owner, to.name,
        ),
        this.st(
          "UPDATE monorepos SET owner = ?2, name = ?3 WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM monorepos WHERE owner = ?2 AND name = ?3)",
          id, to.owner, to.name,
        ),
        this.st(
          `INSERT INTO monorepo_aliases (owner, name, monorepo_id, created_at) SELECT ?4, ?5, ?1, ?6 WHERE ${done}
           ON CONFLICT (owner, name) DO UPDATE SET monorepo_id = excluded.monorepo_id, created_at = excluded.created_at`,
          id, to.owner, to.name, cur.owner, cur.name, at,
        ),
        this.st(`DELETE FROM monorepo_aliases WHERE owner = ?2 AND name = ?3 AND ${done}`, id, to.owner, to.name),
      ]);
      if (moved.meta.changes !== 1) fail(409, "monorepo_exists", `${to.owner}/${to.name} exists`);
      const was = (alias.results as { monorepo_id: string; pointed_to: string | null }[])[0];
      return {
        info: { ...cur, owner: to.owner, name: to.name, full_name: `${to.owner}/${to.name}` },
        // Its own old name coming back is no loss; another monorepo's is.
        replaced_alias: was && was.monorepo_id !== id ? { full_name: `${to.owner}/${to.name}`, pointed_to: was.pointed_to } : null,
      };
    });
  }

  /** The caller's monorepos, or only those named `name` (any owner), their own namespace first. */
  async monoreposOf(login: string, name?: string): Promise<MonorepoEntry[]> {
    return this.rows<MonorepoEntry>(
      `SELECT ${MONOREPO_COLS}, b.role FROM members b JOIN monorepos m ON m.id = b.monorepo_id
       WHERE b.login = ?1 AND (?2 IS NULL OR m.name = ?2)
       ORDER BY m.owner <> ?1, m.owner, m.name`,
      login, name ?? null,
    );
  }

  async members(monorepoId: string): Promise<Member[]> {
    return this.rows<Member>(`${MEMBER_SQL} WHERE m.monorepo_id = ?1 ORDER BY m.login`, monorepoId);
  }

  async putMember(monorepoId: string, login: string, role: MemberRole, by: string): Promise<Outcome<Member>> {
    return this.guard(async () => {
      if (!(await this.getUser(login))) fail(404, "not_found", `no user ${login}`);
      // One statement, so two demotions at once cannot leave no owner.
      const changed = await this.run(
        `INSERT INTO members (monorepo_id, login, role, added_at, added_by) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (monorepo_id, login) DO UPDATE SET role = excluded.role
         WHERE NOT (members.role = 'owner' AND excluded.role <> 'owner'
                    AND (SELECT COUNT(*) FROM members WHERE monorepo_id = ?1 AND role = 'owner') = 1)`,
        monorepoId, login, role, now(), by,
      );
      if (!changed) fail(409, "last_owner", "a monorepo keeps at least one owner");
      return (await this.row<Member>(`${MEMBER_SQL} WHERE m.monorepo_id = ?1 AND m.login = ?2`, monorepoId, login))!;
    });
  }

  async removeMember(monorepoId: string, login: string): Promise<Outcome<boolean>> {
    return this.guard(async () => {
      const removed = await this.run(
        `DELETE FROM members WHERE monorepo_id = ?1 AND login = ?2
           AND (role <> 'owner' OR (SELECT COUNT(*) FROM members WHERE monorepo_id = ?1 AND role = 'owner') > 1)`,
        monorepoId, login,
      );
      if (removed) return true;
      if (!(await this.row("SELECT 1 AS x FROM members WHERE monorepo_id = ?1 AND login = ?2", monorepoId, login))) fail(404, "not_found", `${login} is not a member`);
      fail(409, "last_owner", "a monorepo keeps at least one owner");
    });
  }

  // ── Sign-in and invites ──────────────────────────────────────────────────

  /**
   * After WorkOS proved who signed in: find or make the Pando user, accept any
   * invites for a verified email, and give the machine a credential.
   */
  async signIn(who: SignedIn, cred: NewCredentialRow): Promise<{ user: User; credential: Credential; joined: { id: string; full_name: string }[] }> {
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
    // The picture follows WorkOS on every sign-in, a removed one too.
    if (login) await this.run("UPDATE users SET email = ?1, name = COALESCE(?2, name), picture_url = ?3 WHERE login = ?4", email, who.name, who.picture_url, login);
    else login = await this.newUser(email, who);
    const joined: { id: string; full_name: string }[] = [];
    if (who.email_verified) {
      const invites = await this.rows<{ monorepo_id: string; full_name: string; role: MemberRole; invited_by: string }>(
        `SELECT i.monorepo_id, m.owner || '/' || m.name AS full_name, i.role, i.invited_by
         FROM invites i JOIN monorepos m ON m.id = i.monorepo_id WHERE i.email = ?1`,
        email,
      );
      if (invites.length) {
        const at = now();
        await this.batch([
          ...invites.map((inv) =>
            this.st(
              "INSERT INTO members (monorepo_id, login, role, added_at, added_by) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (monorepo_id, login) DO NOTHING",
              inv.monorepo_id, login, inv.role, at, inv.invited_by,
            ),
          ),
          this.st("DELETE FROM invites WHERE email = ?1", email),
        ]);
        joined.push(...invites.map((inv) => ({ id: inv.monorepo_id, full_name: inv.full_name })));
      }
    }
    return { user: (await this.getUser(login))!, credential: await this.insertCredential(login, cred), joined };
  }

  /** A new user under the first free login (not reserved, not a person's or an org's namespace). */
  private async newUser(email: string, who: SignedIn): Promise<string> {
    for (const login of loginsFor(email, who.name)) {
      try {
        if (await this.claimLogin(login, who.name, email, who.picture_url, who.workos_id, now())) return login;
      } catch (err) {
        // The same WorkOS user signing in twice at once: the other one made the user.
        const other = await this.row<{ login: string }>("SELECT login FROM users WHERE workos_id = ?1", who.workos_id);
        if (other) return other.login;
        throw err;
      }
    }
    throw new HttpError(500, "internal", "no free login");
  }

  /**
   * A user and their namespace, in one batch: made only when the name is
   * free as a namespace and as a login. True when made.
   */
  private async claimLogin(login: string, name: string | null, email: string | null, picture: string | null, workosId: string | null, at: string): Promise<boolean> {
    const [, made] = await this.batch([
      this.st("INSERT INTO namespaces (name, kind, created_at) VALUES (?1, 'user', ?2) ON CONFLICT (name) DO NOTHING", login, at),
      this.st(
        `INSERT INTO users (login, name, email, picture_url, created_at, workos_id)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE (SELECT kind FROM namespaces WHERE name = ?1) = 'user' AND NOT EXISTS (SELECT 1 FROM users WHERE login = ?1)`,
        login, name, email, picture, at, workosId,
      ),
    ]);
    return made.meta.changes === 1;
  }

  /** Invite by email: a signed-in user with that email is added now; anyone else when they first sign in. */
  async invite(monorepoId: string, email: string, role: MemberRole, by: string): Promise<Outcome<{ status: "added"; member: Member } | { status: "invited"; invite: Invite }>> {
    return this.guard(async () => {
      const e = email.toLowerCase();
      const user = await this.row<{ login: string }>("SELECT login FROM users WHERE lower(email) = ?1 AND workos_id IS NOT NULL", e);
      if (user) {
        const out = await this.putMember(monorepoId, user.login, role, by);
        if (!out.ok) fail(out.status, out.code, out.message);
        return { status: "added" as const, member: out.value };
      }
      const invite = await this.row<Invite>(
        `INSERT INTO invites (monorepo_id, email, role, invited_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (monorepo_id, email) DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by
         RETURNING email, role, invited_by, created_at`,
        monorepoId, e, role, by, now(),
      );
      return { status: "invited" as const, invite: invite! };
    });
  }

  async invites(monorepoId: string): Promise<Invite[]> {
    return this.rows<Invite>("SELECT email, role, invited_by, created_at FROM invites WHERE monorepo_id = ?1 ORDER BY created_at", monorepoId);
  }

  async revokeInvite(monorepoId: string, email: string): Promise<boolean> {
    return (await this.run("DELETE FROM invites WHERE monorepo_id = ?1 AND email = ?2", monorepoId, email.toLowerCase())) > 0;
  }
}
