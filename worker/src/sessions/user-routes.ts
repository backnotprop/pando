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
import { monorepoRef } from "../monorepo/names";
import type { UserApp } from "../monorepo/api";
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
