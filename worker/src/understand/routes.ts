// Understand (docs/understand/DESIGN.md), members only, under /v1/monorepos/{owner}/{name}:
//   POST /understand                  ask: {question, scope?, model?}; 201, the page, building
//   GET  /understand                  the repository's pages, newest first (?before, ?limit)
//   GET  /understand/{n}              one page, its records as they read now
//   POST /understand/{n}/follow-ups   {question}: its asker only
//   POST /understand/{n}/lookups      {tool, args}: the page's own session only
//   POST /understand/{n}/blocks       {blocks}: the page's own session only (its place tool)
//
// Asking records the page, runs the first pass (no model: blame on the lines asked about, the sessions,
// agents, issues and shared files their commits name; for a free question, a
// search of the shared files and the sessions), launches an agent session of
// kind understand with the question and what the first pass found, and answers
// the page as it stands; the session builds the rest.

import type { Context, Hono } from "hono";
import type * as Contract from "@pando/contract";
import type { Env } from "../env";
import { HttpError } from "../http";
import type { ApiVars } from "../monorepo/api";
import { cachedRepo } from "../monorepo/session";
import type { Outcome } from "../monorepo/types";
import { isRecord, isText, type Json, type JsonObject } from "../parse";
import { DEFAULT_MODEL } from "../../../agents/src/protocol";
import { launch } from "../agents/routes";
import { type LookupCtx, lookupText, type LookupResult, lookBehind, parseLookup, runLookup } from "./lookups";
import type { From, Scope } from "./store";

type C = Context<{ Bindings: Env; Variables: ApiVars }>;

const QUESTION_MAX = 2000;

const LIST_DEFAULT = 30;

const LIST_MAX = 100;

/** Words a free question's search leaves out. */
const STOP = new Set(["why", "what", "where", "when", "who", "how", "the", "this", "that", "these", "those", "are", "was", "were", "is", "does", "did", "and", "for", "from", "with", "way", "they", "its", "our", "came", "come", "here", "there", "have", "has", "been", "made", "done"]);

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

function numberOf(c: C): number {
  const n = c.req.param("n") ?? "";

  if (!/^[1-9][0-9]{0,8}$/.test(n)) throw new HttpError(404, "not_found", `no Understand page ${n}`);

  return Number(n);
}

function questionOf(v: Json | undefined): string {
  if (!isText(v) || !v.trim()) bad("question: what to ask about the code");

  if (v.length > QUESTION_MAX) throw new HttpError(413, "too_large", `question: at most ${QUESTION_MAX} characters`);

  return v.trim();
}

/** The words of a free question worth searching for. */
export function questionWords(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 6);
}

/** The scope as sent: lines {repo, path, ref, start, end} or a commit {repo, sha}; the ref resolved to its commit. */
async function scopeOf(c: C, v: Json | undefined): Promise<Scope | null> {
  if (v === undefined || v === null) return null;

  if (!isRecord(v) || !isText(v.repo)) bad("scope: {kind, repo, ...}");
  const r = await cachedRepo(c.env, c.get("m"), v.repo);

  if (!r) bad(`scope.repo: no project ${v.repo}`);

  const shaOf = async (ref: Json | undefined) => {
    if (!isText(ref) || !ref) bad("scope: a commit's sha or a branch");

    if (/^[0-9a-f]{40}$/.test(ref)) return ref;
    const head = await c.get("stub").refHead(r.name, ref);

    return head ?? bad(`scope: no branch ${ref}`);
  };

  if (v.kind === "lines") {
    const start = Number(v.start);
    const end = Number(v.end);

    if (!isText(v.path) || !v.path || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 400) bad("scope: {kind: lines, repo, path, ref, start, end}, at most 400 lines");

    return { kind: "lines", repo: r.name, path: v.path.replace(/^\/+/, ""), commit: await shaOf(v.ref ?? v.commit), start, end };
  }

  if (v.kind === "commit") return { kind: "commit", repo: r.name, sha: await shaOf(v.sha) };

  return bad("scope.kind: lines or commit");
}

/** Where it was asked, as sent: {kind: files_changed | commit | assistant, branch?}. */
function fromOf(v: Json | undefined): From | null {
  if (v === undefined || v === null) return null;

  if (!isRecord(v) || (v.kind !== "files_changed" && v.kind !== "commit" && v.kind !== "assistant")) bad("from: {kind: files_changed, commit or assistant, branch?}");

  return { kind: v.kind, branch: isText(v.branch) && v.branch ? v.branch.slice(0, 200) : null };
}

/** The context a lookup runs in: the page's project, else the monorepo's only one. */
async function ctxOf(c: C, scope: Scope | null, known: string[] = []): Promise<LookupCtx> {
  const repos = await c.get("stub").listRepos();

  return { env: c.env, m: c.get("m"), stub: c.get("stub"), repo: scope?.repo ?? (repos.length === 1 ? repos[0].name : null), known };
}

/** Keeps a lookup on page n; answers the text the model reads. */
async function keep(c: C, n: number, result: LookupResult): Promise<{ text: string; refs: string[] }> {
  const stub = c.get("stub");

  // The lines asked about are the first pass's blame of the scope; the assistant's own blames are steps, not the page's lines.
  if (result.lines && result.step.by === "first_pass") unwrap(await stub.understandSetLines(n, result.lines));
  const ids = unwrap(await stub.understandRecord(n, result.step, result.found));

  return { text: lookupText(result, ids), refs: ids.filter((x): x is string => x !== null) };
}

/** What went wrong, in words, from a caught value. */
const whyOf = (error: Error | string) => (error instanceof Error ? error.message : error);

/** A lookup that failed is kept as a step that says why, never fatal to the page. */
async function keepFailed(c: C, n: number, tool: string, asked: string, why: string, by: "first_pass" | "assistant"): Promise<string> {
  await c.get("stub").understandRecord(n, { tool, asked, found: "skipped", ms: 0, by, error: why }, []);

  return `${asked}: skipped (${why}).`;
}

/** Pando's first pass, with no model: what the scope's own records lead to. Answers the text for the session's first prompt. */
async function firstPass(c: C, n: number, question: string, scope: Scope | null): Promise<string> {
  const ctx = await ctxOf(c, scope);
  const texts: string[] = [];

  const run = async (tool: string, asked: string, look: () => Promise<LookupResult>) => {
    try {
      const result = await look();

      texts.push((await keep(c, n, result)).text);

      return result;
    } catch (error) {
      texts.push(await keepFailed(c, n, tool, asked, whyOf(error instanceof Error ? error : String(error)), "first_pass"));

      return null;
    }
  };

  if (scope?.kind === "lines") {
    const b = await run("blame", `lines ${scope.start} to ${scope.end} of ${scope.path}`, () => runLookup(ctx, { tool: "blame", path: scope.path, start: scope.start, end: scope.end, ref: scope.commit, repo: scope.repo }, "first_pass"));
    const commits = (b?.found ?? []).flatMap((f) => (f.card.kind === "commit" ? [f.card] : []));
    const code = b?.lines?.lines.map((l) => l.text).join("\n") ?? "";

    if (commits.length) await run("behind", "what those commits name", () => lookBehind(ctx, commits, scope.path, code));
  } else if (scope?.kind === "commit") {
    await run("commit", `commit ${scope.sha.slice(0, 7)}`, () => runLookup(ctx, { tool: "commit", sha: scope.sha, repo: scope.repo }, "first_pass"));
  } else {
    const words = questionWords(question);

    if (words.length) {
      await run("search_shared", "the shared files", () => runLookup(ctx, { tool: "search_shared", words }, "first_pass"));
      await run("search_sessions", "the sessions' prompts", () => runLookup(ctx, { tool: "search_sessions", words }, "first_pass"));
    }
  }

  return texts.join("\n\n");
}

function scopeWords(scope: Scope | null): string {
  if (!scope) return "the repository as a whole";

  if (scope.kind === "commit") return `commit ${scope.sha} of project ${scope.repo}`;

  return `lines ${scope.start} to ${scope.end} of ${scope.path} in project ${scope.repo}, at commit ${scope.commit}`;
}

/** The first pass, then the session. A failure is kept on the page (failed, with why), never thrown. */
async function build(c: C, n: number, question: string, scope: Scope | null, model: string): Promise<void> {
  const stub = c.get("stub");

  try {
    const found = await firstPass(c, n, question, scope);
    const prompt = [`Question: ${question}`, `Asked about: ${scopeWords(scope)}.`, "", "Pando's first pass found:", found || "(nothing)", "", "Investigate further if you need to, then write the page with place."].join("\n");

    await launch(c, { kind: "understand", prompt, repo: scope?.repo ?? null, branch: null, model, issue: null, page: n });
  } catch (error) {
    await stub.understandFail(n, error instanceof HttpError ? error.message : `the page could not be built: ${whyOf(error instanceof Error ? error : String(error))}`);
  }
}

/** Runs the session's lookup for page n: search_sessions reads the page's own sessions first. */
async function lookup(c: C, n: number, body: JsonObject): Promise<{ text: string; refs: string[] }> {
  const args = parseLookup(body);
  const page = unwrap(await c.get("stub").understandGet(n));
  const ctx = await ctxOf(c, page.scope, page.refs.flatMap((r) => (r.card?.kind === "commit" ? [r.card.sha] : [])));
  const sessions = page.refs.flatMap((r) => (r.card?.kind === "session" ? [r.card.id] : []));

  return keep(c, n, await runLookup(ctx, args, "assistant", sessions));
}

export function understandRoutes(api: Hono<{ Bindings: Env; Variables: ApiVars }>): void {
  const base = "/v1/monorepos/:o/:m/understand";
  const one = `${base}/:n`;

  api.post(base, async (c: C) => {
    const b = await bodyOf(c);
    const question = questionOf(b.question);
    const scope = await scopeOf(c, b.scope);

    if (b.model !== undefined && !isText(b.model)) bad("model: a model id");
    const model = isText(b.model) ? b.model : DEFAULT_MODEL;
    const row = unwrap(await c.get("stub").understandCreate({ question, scope, from: fromOf(b.from), model }, c.get("identity")));

    // The first pass is quick (a second or two) and its records are what the page first shows: it runs before the
    // answer, then the session is launched and builds the rest.
    await build(c, row.number, question, scope, model);

    return c.json(unwrap(await c.get("stub").understandGet(row.number)) satisfies typeof Contract.UnderstandPage.Encoded, 201);
  });

  api.get(base, async (c: C) => {
    const limit = Number(c.req.query("limit") ?? LIST_DEFAULT);
    const before = c.req.query("before");

    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) bad(`limit: 1 to ${LIST_MAX}`);

    if (before !== undefined && !/^[1-9][0-9]{0,8}$/.test(before)) bad("before: a page's number");

    return c.json(unwrap(await c.get("stub").understandList(before === undefined ? null : Number(before), limit)) satisfies typeof Contract.UnderstandList.Encoded);
  });

  api.get(one, async (c: C) => c.json(unwrap(await c.get("stub").understandGet(numberOf(c))) satisfies typeof Contract.UnderstandPage.Encoded));

  api.post(`${one}/follow-ups`, async (c: C) => {
    const n = numberOf(c);
    const question = questionOf((await bodyOf(c)).question);
    const stub = c.get("stub");
    const before = unwrap(await stub.understandGet(n));

    if (before.asked_by !== c.get("identity").login) throw new HttpError(403, "not_asker", `only ${before.asked_by}, who asked, can ask a follow-up here`);

    if (before.session === null) throw new HttpError(409, "not_started", "this page's session has not started; ask again in a moment");
    const agents = c.env.AGENTS ?? (() => { throw new HttpError(503, "agents_unavailable", "Cloudflare-run agents are not set up on this server"); })();

    unwrap(await stub.understandFollowUp(n, c.get("identity").login));
    const outline = before.blocks.map((x) => `${x.id} (${x.type}): ${x.text}`).join("\n");
    const prompt = [`Follow-up question: ${question}`, "", "The page's paragraphs now:", outline || "(none)", "", "Look further if you need to, then place paragraphs: the same id replaces one, a new id adds one."].join("\n");

    // The session reports its own states (working, then waiting): a quick answer's waiting can land in the same
    // millisecond as send's working, so send's answer is not reported again here.
    try {
      await agents.send(c.get("m"), before.session, prompt);
    } catch (error) {
      console.error(`pando-agents: ${error instanceof Error ? error.message : String(error)}`);
      unwrap(await stub.understandFail(n, "Cloudflare-run agents cannot be reached right now; try again in a moment"));
    }

    return c.json(unwrap(await stub.understandGet(n)) satisfies typeof Contract.UnderstandPage.Encoded);
  });

  api.post(`${one}/lookups`, async (c: C) => {
    const n = numberOf(c);

    unwrap(await c.get("stub").understandWriter(n, c.get("identity").credential_id));
    const b = await bodyOf(c);

    try {
      return c.json((await lookup(c, n, b)) satisfies typeof Contract.UnderstandLookup.Encoded);
    } catch (error) {
      // A refused lookup is kept as a step, then refused to the model with Pando's reason.
      if (error instanceof HttpError && error.status !== 429) await keepFailed(c, n, isText(b.tool) ? b.tool : "lookup", isText(b.tool) ? b.tool : "a lookup", error.message, "assistant").catch(() => undefined);

      throw error;
    }
  });

  api.post(`${one}/blocks`, async (c: C) => {
    const n = numberOf(c);

    unwrap(await c.get("stub").understandWriter(n, c.get("identity").credential_id));
    const b = await bodyOf(c);

    if (!Array.isArray(b.blocks) || !b.blocks.length) bad("blocks: one or more blocks");

    const text = (v: Json | undefined) => (isText(v) ? v : null);
    const blocks = b.blocks.filter(isRecord).map((x) => ({ id: text(x.id), type: text(x.type), text: text(x.text) }));

    return c.json(unwrap(await c.get("stub").understandPlace(n, blocks)) satisfies typeof Contract.UnderstandPlaced.Encoded);
  });
}
