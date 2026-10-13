// Tests only (RISK_TEST=1 and the bootstrap secret): POST /v1/_risk/test
// {monorepo, fail?, score?, model?, script?} sets risk-based review's switch
// for that monorepo (its id): the next `fail` scorings fail as a clef error
// would; `score` (0 to 1, or null) stands in for clef; reviewer agents run
// on `model` and are given `script` (the scripted model's tool lines).

import type { Env } from "../env";
import { isNumber, isRecord, isText, isWholeNumber, type Json } from "../parse";
import type { RiskTest } from "./store";

const refuse = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

export async function riskTestRoute(request: Request, env: Env): Promise<Response> {
  if (env.RISK_TEST !== "1") return refuse(404, "not_found", "no such route");
  const { credential } = await import("../http");
  const { isBootstrap } = await import("../monorepo/session");

  if (!(await isBootstrap(env, credential(request)))) return refuse(401, "unauthorized", "the bootstrap secret only");
  const b = request.method === "POST" ? await request.json<Json>().catch(() => null) : null;

  if (!isRecord(b) || !isText(b.monorepo)) return refuse(400, "bad_request", "monorepo (its id)");
  const t: Partial<RiskTest> = {};

  if (isWholeNumber(b.fail)) t.fail = b.fail;

  if (b.score === null || (isNumber(b.score) && b.score >= 0 && b.score <= 1)) t.score = b.score;

  if (b.model === null || isText(b.model)) t.model = b.model;

  if (b.script === null || isText(b.script)) t.script = b.script;

  return Response.json(await env.MONOREPO.getByName(b.monorepo).testRisk(t));
}
