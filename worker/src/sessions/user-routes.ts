// A person's session settings, the signed-in person's own (D1, migration 0009_sessions.sql):
//   GET /v1/user/session-exclusions     the repositories and projects they do not record, on every machine
//   PUT /v1/user/session-exclusions     replace that list: {exclusions: [{monorepo: "owner/name", project: "projects/web" | null}]}
//   PUT /v1/user/session-machine        this machine says whether it records and which stores it reads
//   GET /v1/user/session-machines       each of their machines, as it last said
import type * as Contract from "@pando/contract";
import { HttpError, now } from "../http";
import { isRecord, isText, type Json } from "../parse";
import { accounts } from "../accounts/auth";
import { bad, jsonBody } from "../accounts/org-routes";
import { monorepoRef, validNamespace } from "../monorepo/names";
import { monorepoStub } from "../monorepo/session";
import { unwrap } from "./append";
import { dayIn, sundayOf, winners } from "./marks";
import type { UserApp, UserContext } from "../monorepo/api";
import { PROGRAMS } from "./ids";

/** At most this many exclusions per person, and stores per machine: a person's own list, kept short. */
const EXCLUSIONS_MAX = 200;

const STORES_MAX = 50;

const PROJECT_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Whether a person does not record sessions of this repository, or of the project the session ran in (its repo's name). */
export async function isExcluded(db: D1Database, login: string, monorepoId: string, repo: string | null): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM session_exclusions WHERE login = ?1 AND monorepo_id = ?2 AND (project = '' OR REPLACE(project, '/', '-') = ?3) LIMIT 1")
    .bind(login, monorepoId, repo ?? "")
    .first();

  return row !== null;
}

function list(v: Json | undefined, field: string, max: number) {
  if (!Array.isArray(v) || v.length > max) bad(`${field}: a list of at most ${max}`);

  return v;
}

export function sessionUserRoutes(users: UserApp): void {
  users.get("/v1/user/session-exclusions", async (c) => {
    const rows = await c.env.ACCOUNTS_DB.prepare(
      "SELECT m.owner || '/' || m.name AS monorepo, e.monorepo_id, e.project FROM session_exclusions e JOIN monorepos m ON m.id = e.monorepo_id WHERE e.login = ?1 ORDER BY monorepo, e.project",
    )
      .bind(c.get("auth").user.login)
      .all<{ monorepo: string; monorepo_id: string; project: string }>();

    return c.json({ exclusions: rows.results.map((r) => ({ monorepo: r.monorepo, monorepo_id: r.monorepo_id, project: r.project || null })) } satisfies typeof Contract.SessionExclusions.Encoded);
  });

  users.put("/v1/user/session-exclusions", async (c) => {
    const login = c.get("auth").user.login;
    const b = await jsonBody(c);
    const rows: { id: string; project: string }[] = [];

    for (const x of list(b.exclusions, "exclusions", EXCLUSIONS_MAX)) {
      if (!isRecord(x) || !isText(x.monorepo)) bad("each exclusion: {monorepo: \"owner/name\", project: \"projects/<name>\" | null}");
      const [owner, name] = x.monorepo.split("/");
      const ref = monorepoRef(owner, name);
      const info = ref ? await accounts(c.env).resolve(ref) : null;

      if (!info) throw new HttpError(404, "not_found", `no monorepo ${x.monorepo}`);
      const project = x.project === null || x.project === undefined ? "" : isText(x.project) && PROJECT_RE.test(x.project) ? x.project : bad("project: a project's path, or null");
      rows.push({ id: info.id, project });
    }

    const t = now();
    await c.env.ACCOUNTS_DB.batch([
      c.env.ACCOUNTS_DB.prepare("DELETE FROM session_exclusions WHERE login = ?1").bind(login),
      ...rows.map((r) => c.env.ACCOUNTS_DB.prepare("INSERT OR IGNORE INTO session_exclusions (login, monorepo_id, project, created_at) VALUES (?1, ?2, ?3, ?4)").bind(login, r.id, r.project, t)),
    ]);

    return c.body(null, 204);
  });

  users.put("/v1/user/session-machine", async (c) => {
    const a = c.get("auth");
    const b = await jsonBody(c);

    if (b.recording !== true && b.recording !== false) bad("recording: true or false");

    const stores = list(b.stores, "stores", STORES_MAX).map((s) =>
      isRecord(s) && isText(s.program) && PROGRAMS.some((p) => p === s.program) && isText(s.path) && s.path.length <= 1000 && isText(s.found) && s.found.length <= 40
        ? { program: s.program, path: s.path, found: s.found }
        : bad("each store: {program, path, found}"),
    );

    await c.env.ACCOUNTS_DB.prepare(
      "INSERT INTO session_machines (credential_id, login, recording, stores, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (credential_id) DO UPDATE SET recording = ?3, stores = ?4, updated_at = ?5",
    )
      .bind(a.credential.id, a.user.login, b.recording ? 1 : 0, JSON.stringify(stores), now())
      .run();

    return c.body(null, 204);
  });

  users.get("/v1/user/session-machines", async (c) => {
    const rows = await c.env.ACCOUNTS_DB.prepare(
      "SELECT s.credential_id, c.name, s.recording, s.stores, s.updated_at FROM session_machines s JOIN credentials c ON c.id = s.credential_id WHERE s.login = ?1 AND c.revoked_at IS NULL ORDER BY c.name",
    )
      .bind(c.get("auth").user.login)
      .all<{ credential_id: string; name: string; recording: number; stores: string; updated_at: string }>();

    return c.json({
      machines: rows.results.map((r) => ({
        credential_id: r.credential_id,
        machine: r.name,
        recording: r.recording === 1,
        // SAFETY: PUT /v1/user/session-machine is the only writer: JSON of checked {program, path, found} objects.
        stores: JSON.parse(r.stores) as { program: "claude-code" | "codex" | "pi" | "opencode"; path: string; found: string }[],
        updated_at: r.updated_at,
      })),
    } satisfies typeof Contract.SessionMachines.Encoded);
  });
}

/** A page of a person's sessions across repositories, at most. */
const PERSON_PAGE_MAX = 50;

/** The graph's window: 53 weeks and a day, as the contributions read. */
const MARKS_WINDOW_MS = 372 * 86_400_000;

/** A person's sessions and the graph's agent marks, in the repositories the viewer and the person can both open. */
export function sessionPersonRoutes(users: UserApp): void {
  const person = async (c: UserContext) => {
    const login = c.req.param("login")?.toLowerCase() ?? "";

    if (!validNamespace(login) || !(await accounts(c.env).getUser(login))) throw new HttpError(404, "not_found", `no person ${login}`);

    return { login, shared: await accounts(c.env).sharedMonorepos(login, c.get("auth").user.login) };
  };

  users.get("/v1/users/:login/sessions", async (c) => {
    const { login, shared } = await person(c);
    const limit = Number(c.req.query("limit") ?? 30);

    if (!Number.isInteger(limit) || limit < 1 || limit > PERSON_PAGE_MAX) bad(`limit: 1 to ${PERSON_PAGE_MAX}`);
    const cursor = c.req.query("cursor") ?? null;
    const q = (k: string) => c.req.query(k) ?? null;
    const state = q("state");
    const main = q("main");

    if (state !== null && state !== "active" && state !== "inactive") bad("state: active or inactive");

    if (main !== null && main !== "yes" && main !== "no") bad("main: yes or no");
    const only = q("monorepo");

    const pages = await Promise.all(
      shared
        .filter((m) => only === null || m.full_name === only)
        .map(async (m) => ({ m, page: unwrap(await monorepoStub(c.env, m.id).sessionList({ person: login, program: q("agent"), repo: null, branch: null, state, main, cursor, limit })) })),
    );

    const all = pages
      .flatMap(({ m, page }) => page.sessions.map((session) => ({ monorepo: { id: m.id, full_name: m.full_name }, session })))
      .sort((a, b) => (b.session.last_at ?? "").localeCompare(a.session.last_at ?? "") || b.session.id.localeCompare(a.session.id));

    const page = all.slice(0, limit);
    const last = page.at(-1)?.session;
    const more = all.length > limit || pages.some((p) => p.page.next_cursor !== null);
    const counts = { active: pages.reduce((n, p) => n + p.page.counts.active, 0), inactive: pages.reduce((n, p) => n + p.page.counts.inactive, 0) };

    return c.json({ sessions: page, counts, repositories: shared.map((m) => m.full_name), next_cursor: more && last ? `${last.last_at}|${last.id}` : null } satisfies typeof Contract.PersonSessions.Encoded);
  });

  users.get("/v1/users/:login/session-marks", async (c) => {
    const { login, shared } = await person(c);
    const tz = Number(c.req.query("tz") ?? 0);

    if (!Number.isInteger(tz) || tz < -720 || tz > 840) bad("tz: minutes east of UTC, -720 to 840");
    const since = new Date(Date.now() - MARKS_WINDOW_MS).toISOString();
    const commits = (await Promise.all(shared.map(async (m) => unwrap(await monorepoStub(c.env, m.id).sessionPersonCommits(login, since))))).flat();

    return c.json({
      days: winners(commits, (x) => dayIn(x.at, tz)),
      weeks: winners(commits, (x) => sundayOf(dayIn(x.at, tz))),
    } satisfies typeof Contract.SessionMarks.Encoded);
  });
}
