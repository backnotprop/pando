// The repository assistant (owner, 2026-10-04: "per chat is fine"): one
// session per conversation, per person, members only:
//   GET   /v1/monorepos/{owner}/{name}/assistant   the caller's chats, newest first (?before, ?limit)
//   POST  /v1/monorepos/{owner}/{name}/assistant   a new chat: {prompt, repo?, model?}
//
// A chat is a session of kind chat. It answers from Pando's read tools with
// the caller's access and no sandbox; asked for a change, it starts its own
// branch, assistant/<n>, and works as a task does. A chat is its person's
// alone: it is not in the Agents tab, and nobody else can open it. Follow-ups
// and Stop are the agents routes'.

import type { Context, Hono } from "hono";
import type * as Contract from "@pando/contract";
import type { Env } from "../env";
import { HttpError } from "../http";
import type { ApiVars } from "../monorepo/api";
import type { Outcome } from "../monorepo/types";
import { isRecord, isText, type Json } from "../parse";
import { DEFAULT_MODEL } from "../../../agents/src/protocol";
import { filtersOf, launch } from "./routes";

type C = Context<{ Bindings: Env; Variables: ApiVars }>;

const PROMPT_MAX = 65536;

function unwrap<T>(o: Outcome<T>): T {
  if (o.ok) return o.value;
  throw new HttpError(o.status, o.code, o.message, o.extra ?? {});
}

function bad(message: string): never {
  throw new HttpError(400, "bad_request", message);
}

export function assistantRoutes(api: Hono<{ Bindings: Env; Variables: ApiVars }>): void {
  const base = "/v1/monorepos/:o/:m/assistant";

  api.get(base, async (c: C) => {
    const page = await c.get("stub").agentList(filtersOf(c, c.get("identity").login));

    return c.json(unwrap(page) satisfies typeof Contract.AgentSessionList.Encoded);
  });

  api.post(base, async (c: C) => {
    const b = await c.req.json<Json>().catch(() => bad("the body must be JSON"));
    const body = isRecord(b) ? b : bad("the body must be a JSON object");

    if (!isText(body.prompt) || !body.prompt.trim()) bad("prompt: what to ask");

    if (body.prompt.length > PROMPT_MAX) throw new HttpError(413, "too_large", `prompt: at most ${PROMPT_MAX} characters`);

    if (body.repo !== undefined && !isText(body.repo)) bad("repo: a project's name");

    if (body.model !== undefined && !isText(body.model)) bad("model: a model id");

    const session = await launch(c, {
      kind: "chat",
      prompt: body.prompt,
      repo: isText(body.repo) ? body.repo : null,
      branch: null,
      model: isText(body.model) ? body.model : DEFAULT_MODEL,
      issue: null,
    });

    return c.json(session satisfies typeof Contract.AgentSession.Encoded, 201);
  });
}
