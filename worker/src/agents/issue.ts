// "Address with agent" on an issue (owner, 2026-10-04: "more generic depending
// on issue not always a fix"), members only:
//   POST /v1/monorepos/{owner}/{name}/issues/{n}/agent   {prompt?, repo?, model?, branch?}
//
// It makes the branch <n>-<the title's words> (or the name given) off main, titled as the
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
import { agentsReachable, BRANCH, launch } from "./routes";

type C = Context<{ Bindings: Env; Variables: ApiVars }>;

const PROMPT_MAX = 65536;

function unwrap<T>(o: Outcome<T>): T {
  if (o.ok) return o.value;
  throw new HttpError(o.status, o.code, o.message, o.extra ?? {});
}

function bad(message: string): never {
  throw new HttpError(400, "bad_request", message);
}


/** What the agent is told: the issue as people wrote it, then how Pando works for it. */
/** Small words a branch name does not end on. */
const TRAILING_SMALL = /(-(a|an|and|at|by|for|from|in|of|on|or|the|to|with))+$/;

/** Title words a branch name keeps, at most. */
const NAME_MAX = 30;

/**
 * The branch's name (owner, 2026-10-05: "a new branch has to have a semantic
 * name ... derived from the issue"): the issue's number and its title's first
 * words, lower case, cut at a word up to 30 characters: 41-login-page-flashes-white.
 * It becomes the worktree folder on every machine. The server makes it, and
 * Address with agent shows it before it is sent.
 * The contract's issueBranchName is the same rule, for the web (the Worker
 * takes types only from the contract, M5).
 */
function issueBranchName(n: number, title: string): string {
  let words = "";

  for (const w of title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (words && words.length + 1 + w.length > NAME_MAX) break;
    words = words ? `${words}-${w}` : w.slice(0, NAME_MAX);
  }

  // A name does not end on a small word ("41-login-page-flashes-white", not "...-white-in").
  words = words.replace(TRAILING_SMALL, "");

  return words ? `${n}-${words}` : String(n);
}

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

    if (body.branch !== undefined && (!isText(body.branch) || !BRANCH.test(body.branch))) bad("branch: a branch name other than main");

    const stub = c.get("stub");
    const issue = unwrap(await stub.issueGet(Number(n)));

    if (issue.state !== "open") throw new HttpError(409, "issue_closed", `#${issue.number} is closed`);
    const repos = await stub.listRepos();
    const name = isText(body.repo) ? body.repo : (issue.project ?? (repos.length === 1 ? repos[0].name : bad("repo: which project the agent works in (the issue names none)")));
    const repo = repos.find((r) => r.name === name) ?? bad(`no repo ${name}`);
    // The name the person gave, else the issue's. One that exists is used as it is (another agent's, or theirs);
    // a new one is made off main.
    const branch = isText(body.branch) ? body.branch : issueBranchName(issue.number, issue.title);

    // Nothing is made (no branch, no link) when the agent could not start.
    await agentsReachable(c);

    try {
      await createBranch(c, repo, branch, repo.default_branch, issue.title, `Addresses #${issue.number}.`);
    } catch (err) {
      if (!(err instanceof HttpError) || err.code !== "branch_exists") throw err;
    }

    unwrap(await stub.issueUpdate(issue.number, { link: [{ repo: repo.name, branch }] }, c.get("identity")));
    const timeline = unwrap(await stub.issueTimeline(issue.number, { cursor: null, limit: 100, last: null }));
    const prompt = issuePrompt(c.get("full"), issue, timeline.items, branch, extra?.trim() || null);
    const session = await launch(c, { kind: "issue", prompt, repo: repo.name, branch, model: isText(body.model) ? body.model : DEFAULT_MODEL, issue: issue.number });

    return c.json(session satisfies typeof Contract.AgentSession.Encoded, 201);
  });
}
