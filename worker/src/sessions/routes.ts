// Agent session routes (members only), under /v1/monorepos/{owner}/{name}:
//   POST   /sessions/{id}/pieces?at=&next=   append whole lines at the session's end (header Pando-Session; gzip optional)
//   GET    /sessions                          by last activity (?person ?agent ?repo ?branch ?state ?cursor ?limit)
//   GET    /sessions/on-branch?repo=&branch=  a branch's sessions, numbered by their earliest commit there, and its commits' numbers
//   GET    /sessions/{id}                     one session (its `end` is where the next piece starts)
//   GET    /sessions/{id}/entries?from=       a page of its conversation, parsed on read
//   DELETE /sessions/{id}                     at once and for good: its person or an owner
//   DELETE /sessions/{id}/prompts/{n}         remove prompt n's turn, leaving a mark: its person or an owner
//   POST   /sessions/{id}/reindex             rebuild its numbers from the stored pieces
import type { Context, Hono } from "hono";
import type * as Contract from "@pando/contract";
import type { Env } from "../env";
import { HttpError } from "../http";
import type { ApiVars } from "../monorepo/api";
import { isOneOf, isRecord, isText, parseJson, type Json } from "../parse";
import { appendPiece, unwrap } from "./append";
import { PROGRAMS, SESSION_ID_RE } from "./ids";
import { pieceText } from "./pieces";
import { deleteSession, readEntries, reindex, removeTurn } from "./read";
import { LIST_MAX, type SessionFilters, type SessionStart } from "./store";

type C = Context<{ Bindings: Env; Variables: ApiVars }>;

const NAME_RE = /^[A-Za-z0-9._/-]{1,200}$/;

function bad(message: string): never {
  throw new HttpError(400, "bad_request", message);
}

function idOf(c: C): string {
  const id = c.req.param("id") ?? "";

  if (!SESSION_ID_RE.test(id)) throw new HttpError(404, "not_found", `no session ${id}`);

  return id;
}

function cursorParam(c: C, name: string, fallback: number | null): number {
  const v = c.req.query(name);

  if (v === undefined && fallback !== null) return fallback;
  const n = Number(v);

  return Number.isSafeInteger(n) && n >= 0 ? n : bad(`${name}: a whole number`);
}

/** The Pando-Session header: what the sender knows about the session without reading it. */
function startOf(c: C): SessionStart {
  const h = parseJson(c.req.header("pando-session") ?? "");

  if (!isRecord(h)) bad("send the Pando-Session header: {program, agent_id, repo, branch, parent}");
  const name = (v: Json | undefined, field: string) => (v === null || v === undefined ? null : isText(v) && NAME_RE.test(v) ? v : bad(`${field}: a name, or null`));
  const program = isText(h.program) && isOneOf(PROGRAMS, h.program) ? h.program : bad(`program: one of ${PROGRAMS.join(", ")}`);
  const agentId = isText(h.agent_id) && h.agent_id.length > 0 && h.agent_id.length <= 200 ? h.agent_id : bad("agent_id: the agent's own session id");
  const parent = h.parent === null || h.parent === undefined ? null : isText(h.parent) && SESSION_ID_RE.test(h.parent) ? h.parent : bad("parent: a session id, or null");

  return { program, agent_id: agentId, repo: name(h.repo, "repo"), branch: name(h.branch, "branch"), parent };
}

function filtersOf(c: C): SessionFilters {
  const q = (k: string) => c.req.query(k) ?? null;
  const state = q("state");

  if (state !== null && state !== "active" && state !== "inactive") bad("state: active or inactive");
  const limit = cursorParam(c, "limit", 30);

  if (limit < 1 || limit > LIST_MAX) bad(`limit: 1 to ${LIST_MAX}`);
  const person = q("person");

  return { person: person === "@me" ? c.get("identity").login : person, program: q("agent"), repo: q("repo"), branch: q("branch"), state, cursor: q("cursor"), limit };
}

export function sessionRoutes(api: Hono<{ Bindings: Env; Variables: ApiVars }>): void {
  const base = "/v1/monorepos/:o/:m/sessions";
  const one = `${base}/:id`;

  api.post(`${one}/pieces`, async (c) => {
    const who = c.get("identity");

    if (who.credential_id === "status-token") throw new HttpError(403, "forbidden", "a status token cannot record sessions");
    const id = idOf(c);
    const start = startOf(c);
    const at = cursorParam(c, "at", null);
    const next = cursorParam(c, "next", null);
    const gzip = (c.req.header("content-encoding") ?? "").toLowerCase() === "gzip";
    const lines = await pieceText(c.req.raw.body, gzip);
    const view = await appendPiece(c.env, c.get("m"), { login: who.login, machine: who.credential_name }, { session: id, at, next, start, lines });

    return c.json(view satisfies typeof Contract.Session.Encoded);
  });

  api.get(base, async (c) => c.json(unwrap(await c.get("stub").sessionList(filtersOf(c))) satisfies typeof Contract.SessionList.Encoded));

  // Before /sessions/:id, which would take "on-branch" for an id.
  api.get(`${base}/on-branch`, async (c) => {
    const repo = c.req.query("repo") ?? bad("repo: the repo's name");
    const branch = c.req.query("branch") ?? bad("branch: its name");

    return c.json(unwrap(await c.get("stub").sessionsOnBranch(repo, branch)) satisfies typeof Contract.BranchSessions.Encoded);
  });

  api.get(one, async (c) => c.json(unwrap(await c.get("stub").sessionGet(idOf(c))) satisfies typeof Contract.SessionAny.Encoded));

  api.get(`${one}/entries`, async (c) => c.json((await readEntries(c.env, c.get("m"), idOf(c), cursorParam(c, "from", 0))) satisfies typeof Contract.SessionEntries.Encoded));

  api.delete(one, async (c) => {
    const who = c.get("identity");

    return c.json((await deleteSession(c.env, c.get("m"), idOf(c), who.login, who.role === "owner")) satisfies typeof Contract.SessionDeleted.Encoded);
  });

  api.delete(`${one}/prompts/:n`, async (c) => {
    const who = c.get("identity");
    const n = Number(c.req.param("n"));

    if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, "not_found", "no such prompt");

    return c.json((await removeTurn(c.env, c.get("m"), idOf(c), n, who.login, who.role === "owner")) satisfies typeof Contract.Session.Encoded);
  });

  api.post(`${one}/reindex`, async (c) => c.json((await reindex(c.env, c.get("m"), idOf(c))) satisfies typeof Contract.Session.Encoded));
}
