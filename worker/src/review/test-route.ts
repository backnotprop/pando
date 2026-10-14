// Tests only (RISK_TEST=1 and the bootstrap secret): POST /v1/_risk/test
// {monorepo, fail?, score?, model?, script?} sets risk-based review's switch
// for that monorepo (its id): the next `fail` scorings fail as a clef error
// would; `score` (0 to 1, or null) stands in for clef; reviewer agents run
// on `model` and are given `script` (the scripted model's tool lines).

import type { Env } from "../env";
import { isNumber, isRecord, isText, isTextList, isWholeNumber, type Json } from "../parse";
import { commentsAndDocsOnly, DEFAULT_SETTINGS, sensitiveOf, tierOf } from "./policy";
import { classify, stateOf, type ChangedFile } from "./risk";
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

/**
 * Tests only (RISK_TEST=1 and the bootstrap secret): POST /v1/_risk/score
 * {repo, branch, title, description?, author, commits, files, sensitive}
 * scores a change as a push would (the comments-and-docs rule, then real
 * clef), with no monorepo: the calibration over Pando's own history
 * (worker/test/risk-calibrate.mjs). Each call is one real Workers AI call.
 */
export async function riskScoreRoute(request: Request, env: Env): Promise<Response> {
  if (env.RISK_TEST !== "1") return refuse(404, "not_found", "no such route");
  const { credential } = await import("../http");
  const { isBootstrap } = await import("../monorepo/session");

  if (!(await isBootstrap(env, credential(request)))) return refuse(401, "unauthorized", "the bootstrap secret only");
  const b = request.method === "POST" ? await request.json<Json>().catch(() => null) : null;

  if (!isRecord(b) || !Array.isArray(b.files) || !isTextList(b.commits) || !isTextList(b.sensitive) || !isText(b.title)) return refuse(400, "bad_request", "title, commits, files and sensitive");

  const files: ChangedFile[] = b.files.flatMap((f) =>
    isRecord(f) && isText(f.path) && isText(f.status) && Array.isArray(f.hunks)
      ? [{ path: f.path, status: f.status, additions: isWholeNumber(f.additions) ? f.additions : null, deletions: isWholeNumber(f.deletions) ? f.deletions : null, binary: f.binary === true, hunks: f.hunks.filter(isTextList) }]
      : [],
  );

  if (commentsAndDocsOnly(files)) return Response.json({ rule: "comments_and_docs", tier: "auto" });
  const hits = sensitiveOf(files.map((f) => f.path), b.sensitive);

  const state = stateOf({
    repo: "pando", branch: isText(b.branch) ? b.branch : "change", title: b.title, description: isText(b.description) ? b.description : null,
    author: isText(b.author) ? b.author : "a person", commits: b.commits, files, files_total: files.length, sensitive_patterns: b.sensitive, sensitive_hits: hits,
  });

  const scored = await classify(env, state);

  return Response.json({ rule: null, state_chars: state.length, sensitive_hits: hits, tier: tierOf(scored.ok ? scored.c.score : null, hits.length, DEFAULT_SETTINGS), scored });
}
