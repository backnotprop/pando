// "Review with agent" on a branch, members only:
//   POST /v1/monorepos/{owner}/{name}/agents/review   {branch, repo?, prompt?, model?, profile?}
//
// It launches a session (kind review) acting as the caller on that branch,
// which reads it, may run its tests in its sandbox, and posts one review
// through Pando's review route (comment or request_changes, never approve).
// It has no tool that writes a file, merges or comments on an issue. A
// profile (review/profiles.ts: correctness, security, tests, docs) gives it
// one focus; risk-based review launches the same sessions by itself.

import type { Context, Hono } from "hono";
import type * as Contract from "@pando/contract";
import type { Env } from "../env";
import { HttpError } from "../http";
import type { ApiVars } from "../monorepo/api";
import { isRecord, isText, type Json } from "../parse";
import { DEFAULT_MODEL } from "../../../agents/src/protocol";
import { profileBrief, profileOf, PROFILES, type Profile } from "../review/profiles";
import { launch } from "./routes";

type C = Context<{ Bindings: Env; Variables: ApiVars }>;

const PROMPT_MAX = 65536;

function bad(message: string): never {
  throw new HttpError(400, "bad_request", message);
}

/** What the agent is told: the branch, its profile's focus, and what the person adds. */
export function reviewPrompt(full: string, repo: string, branch: string, extra: string | null, profile: Profile | null = null): string {
  return [
    `Review branch ${branch} of ${repo} in ${full}: its changes against main (branch_diff), the code around them, and its tests.`,
    ...(profile ? ["", profileBrief(profile)] : []),
    ...(extra ? ["", "The person who started you adds:", extra] : []),
  ].join("\n");
}

export function reviewAgentRoutes(api: Hono<{ Bindings: Env; Variables: ApiVars }>): void {
  api.post("/v1/monorepos/:o/:m/agents/review", async (c: C) => {
    const b = await c.req.json<Json>().catch(() => bad("the body must be JSON"));
    const body = isRecord(b) ? b : bad("the body must be a JSON object");

    if (!isText(body.branch) || !body.branch) bad("branch: the branch to review");

    if (body.repo !== undefined && !isText(body.repo)) bad("repo: a project's name");

    if (body.model !== undefined && !isText(body.model)) bad("model: a model id");
    const profile = body.profile === undefined ? null : (isText(body.profile) && profileOf(body.profile)) || bad(`profile: one of ${PROFILES.map((p) => p.name).join(", ")}`);
    const extra = body.prompt === undefined ? null : isText(body.prompt) ? body.prompt : bad("prompt: what to add for the agent");

    if (extra !== null && extra.length > PROMPT_MAX) throw new HttpError(413, "too_large", `prompt: at most ${PROMPT_MAX} characters`);

    const stub = c.get("stub");
    const repos = await stub.listRepos();
    const repo = isText(body.repo) ? (repos.find((r) => r.name === body.repo) ?? bad(`no repo ${body.repo}`)) : repos.length === 1 ? repos[0] : bad("repo: which project the branch is in");

    if (body.branch === repo.default_branch) bad(`${repo.default_branch} is not reviewed; name a branch`);

    if (!(await stub.refHead(repo.name, body.branch))) throw new HttpError(404, "not_found", `no branch ${body.branch}`);

    const prompt = reviewPrompt(c.get("full"), repo.name, body.branch, extra?.trim() || null, profile);
    const session = await launch(c, { kind: "review", prompt, repo: repo.name, branch: body.branch, model: isText(body.model) ? body.model : DEFAULT_MODEL, issue: null });

    return c.json(session satisfies typeof Contract.AgentSession.Encoded, 201);
  });
}
