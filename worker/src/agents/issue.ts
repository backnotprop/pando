// "Address with agent" on an issue (owner, 2026-10-04: "more generic depending
// on issue not always a fix"), members only:
//   POST /v1/monorepos/{owner}/{name}/issues/{n}/agent   {prompt?, repo?, model?}
//
// It makes the branch agent/<n>-<the title's words> off main, titled as the
// issue and linked to it, so merging the branch closes the issue, and
// launches a session acting as the caller with a prompt built from the issue
// (its title, body and comments, and what the person added). The session
// shows on the issue through agent.updated (topic issue:<n>) and GET
// .../agents?issue=<n>; its comments and its merge show as "person, cloud-<n>".

import type { Context, Hono } from "hono";
import type * as Contract from "@pando/contract";
import type { Env } from "../env";
import { HttpError } from "../http";
import { createBranch, type ApiVars } from "../monorepo/api";
import type { Outcome } from "../monorepo/types";
import { isRecord, isText, type Json } from "../parse";
import type { IssueView, TimelineView } from "../issues/store";
import { DEFAULT_MODEL } from "../../../agents/src/protocol";
import { launch } from "./routes";

type C = Context<{ Bindings: Env; Variables: ApiVars }>;

const PROMPT_MAX = 65536;

function unwrap<T>(o: Outcome<T>): T {
  if (o.ok) return o.value;
  throw new HttpError(o.status, o.code, o.message, o.extra ?? {});
}

function bad(message: string): never {
  throw new HttpError(400, "bad_request", message);
}

/** The branch's name: agent/<n>- and the title's first words, lower case. */
export function issueBranch(n: number, title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

  return words ? `agent/${n}-${words}` : `agent/${n}`;
}

/** What the agent is told: the issue as people wrote it, then how Pando works for it. */
export function issuePrompt(full: string, issue: IssueView, comments: TimelineView[], branch: string, extra: string | null): string {
  const said = comments.flatMap((x) => (x.kind === "comment" && x.comment.body ? [`${x.comment.author}${x.comment.machine ? `, ${x.comment.machine}` : ""}:\n${x.comment.body}`] : []));

  return [
    `Address issue #${issue.number} in ${full}: ${issue.title}`,
    `Opened by ${issue.author}.${issue.project ? ` Project: ${issue.project_path ?? issue.project}.` : ""}`,
    "",
    issue.body.trim() || "(The issue has no description.)",
    ...(said.length ? ["", "Comments, oldest first:", "", said.join("\n\n")] : []),
    ...(extra ? ["", "The person who started you adds:", extra] : []),
    "",
    `Your branch ${branch} is linked to #${issue.number}: merging it closes the issue.`,
    "First read the repository's AGENTS.md or CLAUDE.md if there is one. Then make the change, run the tests you find, and commit and push after each working step.",
    `When you are done, comment on #${issue.number} with a short report: what you changed and how you checked it. Then merge ${branch} with the merge tool. If Pando refuses because required checks are still running, stop there: Pando tells you when they are green. If they fail, fix them.`,
  ].join("\n");
}

export function issueAgentRoutes(api: Hono<{ Bindings: Env; Variables: ApiVars }>): void {
  api.post("/v1/monorepos/:o/:m/issues/:n/agent", async (c: C) => {
    const n = c.req.param("n") ?? "";

    if (!/^[1-9][0-9]{0,8}$/.test(n)) throw new HttpError(404, "not_found", `no issue ${n}`);
    const b = await c.req.json<Json>().catch(() => ({}));
    const body = isRecord(b) ? b : bad("the body must be a JSON object");
    const extra = body.prompt === undefined ? null : isText(body.prompt) ? body.prompt : bad("prompt: what to add for the agent");

    if (extra !== null && extra.length > PROMPT_MAX) throw new HttpError(413, "too_large", `prompt: at most ${PROMPT_MAX} characters`);

    if (body.model !== undefined && !isText(body.model)) bad("model: a model id");

    if (body.repo !== undefined && !isText(body.repo)) bad("repo: a project's name");

    const stub = c.get("stub");
    const issue = unwrap(await stub.issueGet(Number(n)));

    if (issue.state !== "open") throw new HttpError(409, "issue_closed", `#${issue.number} is closed`);
    const repos = await stub.listRepos();
    const name = isText(body.repo) ? body.repo : (issue.project ?? (repos.length === 1 ? repos[0].name : bad("repo: which project the agent works in (the issue names none)")));
    const repo = repos.find((r) => r.name === name) ?? bad(`no repo ${name}`);
    // A branch already there (an earlier agent on this issue) gets a number after the name.
    const base = issueBranch(issue.number, issue.title);
    let branch = base;

    for (let i = 2; ; i++) {
      try {
        await createBranch(c, repo, branch, repo.default_branch, issue.title, `Addresses #${issue.number}.`);
        break;
      } catch (err) {
        if (!(err instanceof HttpError) || err.code !== "branch_exists") throw err;
        branch = `${base}-${i}`;
      }
    }

    unwrap(await stub.issueUpdate(issue.number, { link: [{ repo: repo.name, branch }] }, c.get("identity")));
    const timeline = unwrap(await stub.issueTimeline(issue.number, { cursor: null, limit: 100, last: null }));
    const prompt = issuePrompt(c.get("full"), issue, timeline.items, branch, extra?.trim() || null);
    const session = await launch(c, { kind: "issue", prompt, repo: repo.name, branch, model: isText(body.model) ? body.model : DEFAULT_MODEL, issue: issue.number });

    return c.json(session satisfies typeof Contract.AgentSession.Encoded, 201);
  });
}
