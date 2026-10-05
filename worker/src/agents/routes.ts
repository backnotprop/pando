// Agent session routes, members only, under /v1/monorepos/{owner}/{name}:
//   GET   /agents                     the repository's sessions, newest first (?before, ?limit, ?issue); not the assistant's chats
//   GET   /assistant, POST /assistant the caller's own chats with the repository assistant (assistant.ts)
//   POST  /issues/{n}/agent           "Address with agent" (issue.ts)
//   POST  /agents/review              "Review with agent" on a branch (review.ts)
//   GET   /agents/models              the models a session may use
//   POST  /agents                     launch one: {prompt, branch, repo?, model?}
//   GET   /agents/{n}                 one session
//   GET   /agents/{n}/transcript      its transcript, from its object in pando-agents
//   GET   /agents/{n}/live            the live view's socket (Upgrade: websocket): the transcript as it grows
//   POST  /agents/{n}/messages        {prompt}: a follow-up, from the person who launched it
//   POST  /agents/{n}/stop            abort the run and stop the sandbox: its launcher or an owner
//
// Launching mints a sandbox credential for the person who pressed the button
// (named cloud-<n>, the session's machine), limited to this one repository, records the session in the
// monorepo object, and starts its Durable Object in pando-agents over the
// AGENTS service binding. The agent acts as that person. Revoking the
// credential (Machines) cuts the agent off at once.

import type { Context, Hono } from "hono";
import type * as Contract from "@pando/contract";
import { accounts } from "../accounts/auth";
import type { Env } from "../env";
import { HttpError, now } from "../http";
import type { ApiVars } from "../monorepo/api";
import { hashToken, newToken } from "../monorepo/session";
import type { Outcome } from "../monorepo/types";
import { isRecord, isText, type Json, type JsonObject } from "../parse";
import { DEFAULT_MODEL, type SessionKind, type SessionSpec } from "../../../agents/src/protocol";
import type { AgentFilters, AgentView } from "./store";

type C = Context<{ Bindings: Env; Variables: ApiVars }>;

const PROMPT_MAX = 65536;

const LIST_DEFAULT = 30;

const LIST_MAX = 100;

export const BRANCH = /^(?!main$)(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

function unwrap<T>(o: Outcome<T>): T {
  if (o.ok) return o.value;
  throw new HttpError(o.status, o.code, o.message, o.extra ?? {});
}

function bad(message: string): never {
  throw new HttpError(400, "bad_request", message);
}

async function bodyOf(c: C): Promise<JsonObject> {
  const b = await c.req.json<Json>().catch(() => bad("the body must be JSON"));

  return isRecord(b) ? b : bad("the body must be a JSON object");
}

function promptOf(v: Json | undefined): string {
  if (!isText(v) || !v.trim()) bad("prompt: what the agent is to do");

  if (v.length > PROMPT_MAX) throw new HttpError(413, "too_large", `prompt: at most ${PROMPT_MAX} characters`);

  return v;
}

function numberOf(c: C): number {
  const n = c.req.param("n") ?? "";

  if (!/^[1-9][0-9]{0,8}$/.test(n)) throw new HttpError(404, "not_found", `no agent session ${n}`);

  return Number(n);
}

/** The pando-agents binding, or a plain 503 where it is not set up. */
function agentsOf(c: C): NonNullable<Env["AGENTS"]> {
  const a = c.env.AGENTS;

  if (!a) throw new HttpError(503, "agents_unavailable", "Cloudflare-run agents are not set up on this server");

  return a;
}

const NUMBER = /^[1-9][0-9]{0,8}$/;

/** A list's filters from the address (?before, ?limit, ?issue, ?status, ?person, ?kind); `chatsOf` for the assistant's list. */
export function filtersOf(c: C, chatsOf: string | null): AgentFilters {
  const q = (k: string) => c.req.query(k);
  const limit = Number(q("limit") ?? LIST_DEFAULT);

  const num = (k: string) => {
    const v = q(k);

    if (v !== undefined && !NUMBER.test(v)) bad(`${k}: a number`);

    return v === undefined ? null : Number(v);
  };

  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) bad(`limit: 1 to ${LIST_MAX}`);
  const status = q("status") ?? null;

  if (status !== null && status !== "working" && status !== "waiting") bad("status: working or waiting");
  const kind = q("kind") ?? null;

  if (kind !== null && kind !== "task" && kind !== "issue" && kind !== "review") bad("kind: task, issue or review");

  return { before: num("before"), limit, issue: num("issue"), status, person: q("person") ?? null, kind, chatsOf };
}

/** Session n as the caller may see it: the assistant's chats are their person's alone (404 for anyone else). */
async function sessionOf(c: C, n: number): Promise<AgentView> {
  const s = unwrap(await c.get("stub").agentGet(n));

  if (s.kind === "chat" && s.launched_by !== c.get("identity").login) throw new HttpError(404, "not_found", `no agent session ${n}`);

  return s;
}

/** The session's state, recorded as failed with this reason. */
async function failed(c: C, s: AgentView, reason: string): Promise<AgentView> {
  return (await c.get("stub").agentReport({ number: s.number, status: "failed", reason, model: s.model, branch: s.branch ?? "", repo: s.repo, sandbox: "stopped", updated_at: now() })) ?? s;
}

export interface LaunchInput {
  kind: SessionKind;
  prompt: string;
  repo: string | null;
  branch: string | null;
  model: string;
  issue: number | null;
}

/**
 * Launches a session for the caller: records it, mints its credential, starts
 * its object. Shared by POST /agents and the issue's "Address with agent".
 */
export async function launch(c: C, input: LaunchInput): Promise<AgentView> {
  const agents = agentsOf(c);
  const info = c.get("info");
  const identity = c.get("identity");
  const repos = await c.get("stub").listRepos();
  const repo = input.repo === null ? (repos.length === 1 ? repos[0] : bad("repo: which project the agent works in")) : (repos.find((r) => r.name === input.repo) ?? bad(`no repo ${input.repo}`));
  const session = unwrap(await c.get("stub").agentCreate({ kind: input.kind, repo: repo.name, branch: input.branch, model: input.model, issue: input.issue }, identity));
  const secret = newToken();
  const cred = await accounts(c.env).addCredential(identity.login, { hash: await hashToken(secret), name: session.machine, kind: "sandbox", monorepo_id: info.id });

  await c.get("stub").agentSetCredential(session.number, cred.id);

  const spec: SessionSpec = {
    number: session.number,
    kind: input.kind,
    monorepo: { id: info.id, full: info.full_name, kind: info.kind },
    repo: { name: repo.name, path: repo.path },
    branch: session.branch ?? "",
    model: input.model,
    launcher: { login: identity.login, name: identity.name ?? identity.login, email: identity.email ?? `${identity.login}@users.pando.invalid` },
    credential: { id: cred.id, name: cred.name, secret },
    issue: input.issue,
  };

  try {
    const state = await agents.start(spec, input.prompt);

    return (await c.get("stub").agentReport(state)) ?? session;
  } catch (error) {
    await accounts(c.env).revokeCredential(identity.login, cred.id);

    return failed(c, session, `the agent did not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function agentRoutes(api: Hono<{ Bindings: Env; Variables: ApiVars }>): void {
  const base = "/v1/monorepos/:o/:m/agents";
  const one = `${base}/:n`;

  api.get(base, async (c) => {
    const page = await c.get("stub").agentList(filtersOf(c, null));

    return c.json(unwrap(page) satisfies typeof Contract.AgentSessionList.Encoded);
  });

  api.post(base, async (c) => {
    const b = await bodyOf(c);

    // A person names the branch (owner, 2026-10-05): Pando never invents one for a task.
    if (b.branch === undefined) throw new HttpError(400, "branch_required", "branch: name the branch for the change (an existing one is used as it is)");

    if (!isText(b.branch) || !BRANCH.test(b.branch)) bad("branch: a branch name other than main");

    if (b.model !== undefined && !isText(b.model)) bad("model: a model id");

    if (b.repo !== undefined && !isText(b.repo)) bad("repo: a project's name");

    const input: LaunchInput = {
      kind: "task",
      prompt: promptOf(b.prompt),
      repo: isText(b.repo) ? b.repo : null,
      branch: b.branch,
      model: isText(b.model) ? b.model : DEFAULT_MODEL,
      issue: null,
    };

    return c.json((await launch(c, input)) satisfies typeof Contract.AgentSession.Encoded, 201);
  });

  // The models a session may use here (registered before /agents/:n).
  api.get(`${base}/models`, async (c) => c.json({ models: await agentsOf(c).models() } satisfies typeof Contract.AgentModels.Encoded));

  api.get(one, async (c) => c.json((await sessionOf(c, numberOf(c))) satisfies typeof Contract.AgentSession.Encoded));

  api.get(`${one}/transcript`, async (c) => {
    const n = numberOf(c);

    await sessionOf(c, n);

    return c.json({ messages: await agentsOf(c).transcript(c.get("m"), n) } satisfies typeof Contract.AgentTranscript.Encoded);
  });

  api.get(`${one}/live`, async (c) => {
    const n = numberOf(c);

    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "upgrade_required", "open this with a WebSocket");
    await sessionOf(c, n);

    return agentsOf(c).fetch(new Request(`http://pando-agents/live/${encodeURIComponent(c.get("m"))}/${n}`, c.req.raw));
  });

  api.post(`${one}/messages`, async (c) => {
    const n = numberOf(c);
    const s = await sessionOf(c, n);

    if (s.launched_by !== c.get("identity").login) throw new HttpError(403, "not_launcher", `only ${s.launched_by}, who started it, can send it messages`);
    const prompt = promptOf((await bodyOf(c)).prompt);
    const state = await agentsOf(c).send(c.get("m"), n, prompt);

    return c.json(((await c.get("stub").agentReport(state)) ?? s) satisfies typeof Contract.AgentSession.Encoded);
  });

  api.post(`${one}/stop`, async (c) => {
    const n = numberOf(c);
    const s = await sessionOf(c, n);
    const who = c.get("identity");

    if (s.launched_by !== who.login && who.role !== "owner") throw new HttpError(403, "not_launcher", `only ${s.launched_by}, who started it, or an owner can stop it`);
    const state = await agentsOf(c).stop(c.get("m"), n, `stopped by ${who.login}`);

    return c.json(((await c.get("stub").agentReport(state)) ?? s) satisfies typeof Contract.AgentSession.Encoded);
  });
}
