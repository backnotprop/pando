// The lookups of an Understand page (docs/understand/DESIGN.md, "How the
// assistant builds it"), run on the Worker for the page: each reads Pando's
// own records (git objects through the Objects cache, the monorepo object's
// sessions and issues, the meta layer object's shared files) and answers what
// it found as records (cards) with how each was found. The routes keep them
// on the page (understand/routes.ts); the first pass runs some with no model.

import { accounts } from "../accounts/auth";
import type { Env } from "../env";
import { HttpError } from "../http";
import { type CommitMeta, JOB_BUDGET, resolveCommit, walkHistory, Walker } from "../monorepo/files";
import type { MonorepoObject } from "../monorepo/object";
import { cachedRepo } from "../monorepo/session";
import type { Outcome, RepoRecord } from "../monorepo/types";
import { pandoTrailers } from "../monorepo/views";
import { objectsClient } from "../objects";
import { sessionLines } from "../sessions/ids";
import type { Entry } from "../sessions/parse";
import { readEntries } from "../sessions/read";
import { blame } from "./blame";
import { wordsOf } from "./meta-search";
import { isInteger, isRecord, isText, isTextList, type Json, type JsonObject } from "../parse";
import type { Card, Found, Lines, Step } from "./store";

type Stub = DurableObjectStub<MonorepoObject>;

export interface LookupCtx {
  env: Env;
  /** The monorepo's id. */
  m: string;
  stub: Stub;
  /** The page's own project (its scope's), else the monorepo's only one; null in a monorepo asked as a whole. */
  repo: string | null;
  /** The commits the page already has: a short sha the model copies from them reads as the full one. */
  known: string[];
}

/** A lookup the assistant (or the first pass) asked for, parsed (parseLookup). */
export type LookupArgs =
  | { tool: "blame"; path: string; start: number; end: number; ref: string | null; repo: string | null }
  | { tool: "history"; path: string; ref: string | null; repo: string | null }
  | { tool: "commit"; sha: string; repo: string | null }
  | { tool: "search_shared"; words: string[] }
  | { tool: "search_sessions"; words: string[] }
  | { tool: "issue"; number: number };

type Args<T extends LookupArgs["tool"]> = Extract<LookupArgs, { tool: T }>;

/** A lookup's request body ({tool, args}) as its typed arguments; a 400 saying what is wrong otherwise. */
export function parseLookup(body: JsonObject): LookupArgs {
  const a = isRecord(body.args) ? body.args : {};
  const text = (v: Json | undefined) => (isText(v) && v ? v : null);
  const path = () => text(a.path)?.replace(/^\/+/, "") ?? bad("path: a file's path in the project");
  const words = () => (isTextList(a.words) ? wordsOf(a.words) : []).filter(Boolean);

  switch (body.tool) {
    case "blame": {
      const start = isInteger(a.start) ? a.start : bad("start: a line number");
      const end = isInteger(a.end) ? a.end : start;

      if (start < 1 || end < start || end - start > 400) bad("start and end: line numbers, start first, at most 400 lines");

      return { tool: "blame", path: path(), start, end, ref: text(a.ref), repo: text(a.repo) };
    }

    case "history":
      return { tool: "history", path: path(), ref: text(a.ref), repo: text(a.repo) };
    case "commit":
      return { tool: "commit", sha: text(a.sha) ?? bad("sha: a commit's sha"), repo: text(a.repo) };
    case "search_shared":
    case "search_sessions": {
      const w = words();

      return w.length ? { tool: body.tool, words: w } : bad("words: one or more words of three letters or more");
    }

    case "issue":
      return { tool: "issue", number: isInteger(a.number) && a.number > 0 ? a.number : bad("number: an issue's number") };
    default:
      return bad("tool: one of blame, history, commit, search_shared, search_sessions, issue");
  }
}

/** What a lookup answers: its step (without ids yet) and its records. `lines` only from blame. */
export interface LookupResult {
  step: Omit<Step, "refs">;
  found: Found[];
  lines?: Lines;
}

/** Sessions search_sessions reads at most, and history's commits (DESIGN.md, "Limits"). */
export const SESSIONS_READ = 30;

const HISTORY_MAX = 20;

const PROMPT_MAX = 600;

function unwrap<T>(o: Outcome<T>): T {
  if (o.ok) return o.value;
  throw new HttpError(o.status, o.code, o.message, o.extra ?? {});
}

const short = (sha: string) => sha.slice(0, 7);

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "an unknown day");

/** The project a lookup reads: the one named, else the page's. */
async function repoOf(ctx: LookupCtx, name: string | null): Promise<RepoRecord> {
  const want = name ?? ctx.repo;

  if (!want) throw new HttpError(400, "bad_request", "repo: which project to read (this page is about the whole repository)");
  const r = await cachedRepo(ctx.env, ctx.m, want);

  if (!r) throw new HttpError(404, "not_found", `no project ${want}`);

  return r;
}

function walker(r: RepoRecord) {
  const obj = objectsClient();

  return { w: new Walker(obj, r, JOB_BUDGET), obj };
}

async function commitAt(ctx: LookupCtx, r: RepoRecord, w: Walker, ref: string | null): Promise<CommitMeta> {
  const full = ref && /^[0-9a-f]{7,39}$/.test(ref) ? ctx.known.find((sha) => sha.startsWith(ref)) : undefined;
  const at = await resolveCommit(ctx.env, w, (b) => ctx.stub.refHead(r.name, b), full ?? ref);

  return at.commit;
}

/** The model in force in a session at a time: its last change at or before it, else its most used model. */
async function modelAt(ctx: LookupCtx, id: string, at: string): Promise<string | null> {
  const changes = unwrap(await ctx.stub.sessionModelChanges(id));
  const before = changes.filter((c) => c.at <= at).at(-1) ?? changes[0];

  return before?.model ?? null;
}

/** The commit's record: its message, author (and their Pando login), trailers, sessions, and the model of the session that names it. */
async function commitCard(ctx: LookupCtx, r: RepoRecord, c: CommitMeta): Promise<Extract<Card, { kind: "commit" }>> {
  const message = c.message ?? "";
  const [title, ...rest] = message.split("\n");
  const trailers = pandoTrailers(message);
  const sessions = sessionLines(message);
  const at = new Date(c.authoredAt * 1000).toISOString();
  const email = c.author.email.toLowerCase();
  const login = /^([a-z0-9-]+)@users\.pando\.invalid$/.exec(email)?.[1];
  const [person] = await accounts(ctx.env).creditees(ctx.m, login ? [] : [email], login ? [login] : []).catch(() => []);
  const model = sessions.length ? await modelAt(ctx, sessions[0], at).catch(() => null) : null;

  return {
    kind: "commit", repo: r.name, sha: c.hash, title: title ?? "", body: rest.join("\n").trim().slice(0, 1000),
    author: { name: c.author.name, email: c.author.email }, person: person?.login ?? null, committed_at: at,
    machine: trailers.machine, agent: trailers.agent, model, sessions,
  };
}

/** The tool step that changed `path` at or before `at` (a little after, for the commit's own clock), and the prompt of its turn. */
function turnThatWrote(entries: Entry[], path: string | null, at: string | null) {
  const limit = at ? new Date(Date.parse(at) + 5 * 60_000).toISOString() : null;
  const inTime = (e: Entry) => !limit || !e.at || e.at <= limit;
  const tail = path ? path.split("/").slice(-2).join("/") : null;
  const stepAt = tail ? entries.findLastIndex((e) => e.kind === "tool" && inTime(e) && (e.input ?? "").includes(tail)) : -1;
  const upTo = stepAt >= 0 ? stepAt : entries.findLastIndex((e) => inTime(e));
  const promptAt = entries.slice(0, upTo + 1).findLastIndex((e) => e.kind === "prompt");

  return { prompt: promptAt >= 0 ? entries[promptAt] : null, step: stepAt >= 0 ? entries[stepAt] : null } satisfies { prompt: Entry | null; step: Entry | null };
}

/** A recorded session's record, with the turn that wrote `path` (or the last prompt before `at`), or the prompt `match` finds. */
async function sessionCard(ctx: LookupCtx, id: string, opts: { path?: string | null; at?: string | null; match?: (text: string) => boolean }): Promise<Extract<Card, { kind: "session" }> | null> {
  const got = await ctx.stub.sessionGet(id);

  if (!got.ok || got.value.state === "deleted") return null;
  const s = got.value;
  const entries = (await readEntries(ctx.env, ctx.m, id, 0).catch(() => null))?.entries ?? [];
  let prompt: Extract<Card, { kind: "session" }>["prompt"] = null;
  let step: Extract<Card, { kind: "session" }>["step"] = null;

  if (opts.match) {
    const hit = entries.find((e) => e.kind === "prompt" && e.text !== null && opts.match!(e.text));

    if (!hit) return null;
    prompt = { number: hit.prompt ?? 0, at: hit.at, text: (hit.text ?? "").slice(0, PROMPT_MAX), why: "match" };
  } else {
    const t = turnThatWrote(entries, opts.path ?? null, opts.at ?? null);

    if (t.prompt) prompt = { number: t.prompt.prompt ?? 0, at: t.prompt.at, text: (t.prompt.text ?? "").slice(0, PROMPT_MAX), why: t.step ? "wrote" : "before" };

    if (t.step) step = { tool: t.step.tool ?? "tool", at: t.step.at, input: opts.path && (t.step.input ?? "").includes(opts.path.split("/").slice(-2).join("/")) ? opts.path : (t.step.input ?? "").slice(0, 200) };
  }

  const model = (opts.at ? await modelAt(ctx, id, opts.at).catch(() => null) : null) ?? s.models[0]?.model ?? null;

  return { kind: "session", id, program: s.program, person: s.person, machine: s.machine, model, prompt, step };
}

/** A Cloudflare-run agent session named by a commit's machine (cloud-<n>). */
async function agentCard(ctx: LookupCtx, machine: string | null): Promise<Extract<Card, { kind: "agent" }> | null> {
  const n = /^cloud-([1-9][0-9]{0,8})$/.exec(machine ?? "")?.[1];

  if (!n) return null;
  const got = await ctx.stub.agentGet(Number(n));

  if (!got.ok) return null;
  const a = got.value;

  return { kind: "agent", number: a.number, agent_kind: a.kind, launched_by: a.launched_by, model: a.model, status: a.status, branch: a.branch };
}

/** An issue's record. */
async function issueCard(ctx: LookupCtx, n: number): Promise<Extract<Card, { kind: "issue" }> | null> {
  const got = await ctx.stub.issueGet(n);

  if (!got.ok) return null;
  const i = got.value;

  return { kind: "issue", number: i.number, title: i.title, state: i.state, author: i.author, created_at: i.created_at, excerpt: i.body.slice(0, 300) };
}

/** Shared files that hold the words, or the named paths, as records. */
async function sharedCards(ctx: LookupCtx, words: string[], paths: string[]): Promise<{ cards: Extract<Card, { kind: "meta" }>[]; read: number; named: Set<string> }> {
  const meta = ctx.env.META.get(ctx.env.META.idFromName(ctx.m));
  const out = await meta.understandSearch(words, paths);

  return {
    cards: out.hits.map((h) => ({ kind: "meta", path: h.path, version: h.version, saved_by: h.saved_by, login: h.login, machine: h.machine, agent: h.agent, saved_at: h.saved_at, excerpt: h.excerpt })),
    read: out.read,
    named: new Set(out.hits.filter((h) => h.named).map((h) => h.path)),
  };
}

/** The key a record keeps on its page, so one found twice has one id. */
export function keyOf(card: Card): string {
  switch (card.kind) {
    case "commit":
      return `commit:${card.repo}@${card.sha}`;
    case "session":
      return `session:${card.id}`;
    case "agent":
      return `agent:${card.number}`;
    case "meta":
      return `meta:${card.path}@${card.version}`;
    case "issue":
      return `issue:${card.number}`;
  }
}

/** Issue numbers and shared-file paths a text names (#12; decisions/0010-rate-limit.md). */
export function namedIn(text: string) {
  const issues = [...new Set([...text.matchAll(/(?:^|[\s(])#([1-9][0-9]{0,6})\b/g)].map((m) => Number(m[1])))].slice(0, 5);
  const paths = [...new Set([...text.matchAll(/\b((?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.(?:md|mdx|txt|html|toml|json|ya?ml|mmd))\b/g)].map((m) => m[1]))].slice(0, 8);

  return { issues, paths };
}

/** Records a commit's own lines lead to: its sessions, its agent session, and the issues and shared files its message names. */
async function behindCommit(ctx: LookupCtx, card: Extract<Card, { kind: "commit" }>, path: string | null, extra: string): Promise<{ found: Found[]; issues: number[]; paths: string[] }> {
  const found: Found[] = [];

  for (const id of card.sessions.slice(0, 3)) {
    const s = await sessionCard(ctx, id, { path, at: card.committed_at });

    if (s) found.push({ key: keyOf(s), how: "direct", found_by: `Named by commit ${short(card.sha)}'s Pando-Session line.`, card: s });
  }

  const agent = await agentCard(ctx, card.machine);

  if (agent) found.push({ key: keyOf(agent), how: "direct", found_by: `Commit ${short(card.sha)} was made from ${card.machine}, this agent session's machine.`, card: agent });
  const prompts = found.flatMap((f) => (f.card.kind === "session" && f.card.prompt ? [f.card.prompt.text] : []));
  const named = namedIn([card.title, card.body, extra, ...prompts].join("\n"));

  return { found, ...named };
}

/** The issues and shared files named, as records found by name. */
async function namedRecords(ctx: LookupCtx, issues: number[], paths: string[], where: string): Promise<{ found: Found[]; said: string[] }> {
  const found: Found[] = [];
  const said: string[] = [];

  for (const n of issues) {
    const card = await issueCard(ctx, n);

    if (card) {
      found.push({ key: keyOf(card), how: "named", found_by: `Named in ${where}.`, card });
      said.push(`issue #${n}`);
    }
  }

  if (paths.length) {
    const shared = await sharedCards(ctx, [], paths);

    for (const card of shared.cards) {
      found.push({ key: keyOf(card), how: "named", found_by: `Named in ${where}.`, card });
      said.push(card.path);
    }
  }

  return { found, said };
}

// ── The lookups ──

export async function lookBlame(ctx: LookupCtx, args: Args<"blame">, by: Step["by"]): Promise<LookupResult> {
  const t0 = Date.now();
  const { path, start, end } = args;
  const r = await repoOf(ctx, args.repo);
  const { w, obj } = walker(r);
  const at = await commitAt(ctx, r, w, args.ref);
  const b = await blame(w, obj, r.artifacts_name, at, path, start, end);

  if (!b) return { step: { tool: "blame", asked: `lines ${start} to ${end} of ${path}`, found: `${path} is not a text file at ${short(at.hash)}`, ms: Date.now() - t0, by, error: null }, found: [] };
  const counts = new Map<string, number>();

  for (const l of b.lines) if (l.sha) counts.set(l.sha, (counts.get(l.sha) ?? 0) + 1);
  const found: Found[] = [];
  const cards: Extract<Card, { kind: "commit" }>[] = [];

  for (const [sha, k] of counts) {
    const card = await commitCard(ctx, r, b.commits.get(sha)!);

    cards.push(card);
    found.push({ key: keyOf(card), how: "direct", found_by: `Found by blame on lines ${start} to ${end}: ${k} of ${b.lines.length} lines.`, card });
  }

  const lines: Lines = {
    repo: r.name, path, commit: at.hash, start: b.lines[0]?.n ?? start, older: b.older,
    lines: b.lines.map((l) => {
      const c = l.sha ? cards.find((x) => x.sha === l.sha) : undefined;

      return { n: l.n, text: l.text, sha: l.sha, at: c?.committed_at ?? null, by: c ? (c.person ?? c.author.name) : null };
    }),
  };

  const said = [...counts].map(([sha, k]) => `${short(sha)} (${k} ${k === 1 ? "line" : "lines"})`).join(", ");

  return { step: { tool: "blame", asked: `lines ${start} to ${end} of ${path}`, found: counts.size ? `${counts.size} ${counts.size === 1 ? "commit" : "commits"}: ${said}` : "nothing", ms: Date.now() - t0, by, error: null }, found, lines };
}

export async function lookHistory(ctx: LookupCtx, args: Args<"history">, by: Step["by"]): Promise<LookupResult> {
  const t0 = Date.now();
  const path = args.path;
  const r = await repoOf(ctx, args.repo);
  const { w } = walker(r);
  const at = await commitAt(ctx, r, w, args.ref);
  const h = await walkHistory(w, at.hash, path, HISTORY_MAX, 0, async () => ({}));
  const found: Found[] = [];

  for (const line of h.changes) {
    const c = await w.commit(line.sha);

    if (!c) continue;
    const card = await commitCard(ctx, r, c);

    found.push({ key: keyOf(card), how: "direct", found_by: `Changed ${path} (its history).`, card });
  }

  return { step: { tool: "history", asked: `the history of ${path}`, found: found.length ? `${found.length} commits` : "nothing", ms: Date.now() - t0, by, error: null }, found };
}

export async function lookCommit(ctx: LookupCtx, args: Args<"commit">, by: Step["by"], path: string | null = null): Promise<LookupResult> {
  const t0 = Date.now();
  const r = await repoOf(ctx, args.repo);
  const { w } = walker(r);
  const at = await commitAt(ctx, r, w, args.sha);
  const card = await commitCard(ctx, r, at);
  const behind = await behindCommit(ctx, card, path, "");
  const named = await namedRecords(ctx, behind.issues, behind.paths, `commit ${short(card.sha)} or its session`);
  const found: Found[] = [{ key: keyOf(card), how: "direct", found_by: by === "first_pass" ? "The commit asked about." : "Read by the assistant.", card }, ...behind.found, ...named.found];
  const sessions = behind.found.filter((f) => f.card.kind === "session").length;
  const said = [`commit ${short(card.sha)}`, sessions ? `${sessions} ${sessions === 1 ? "session" : "sessions"}` : "", ...named.said].filter(Boolean).join(", ");

  return { step: { tool: "commit", asked: `commit ${short(card.sha)}`, found: said, ms: Date.now() - t0, by, error: null }, found };
}

/** After blame: what the blamed commits lead to (their sessions, agents, named issues and files), as one step. */
export async function lookBehind(ctx: LookupCtx, commits: Extract<Card, { kind: "commit" }>[], path: string, code: string): Promise<LookupResult> {
  const t0 = Date.now();
  const found: Found[] = [];
  const issues = new Set<number>();
  const paths = new Set<string>();

  for (const c of commits.slice(0, 6)) {
    const behind = await behindCommit(ctx, c, path, code);

    found.push(...behind.found);
    behind.issues.forEach((n) => issues.add(n));
    behind.paths.forEach((p) => paths.add(p));
  }

  const named = await namedRecords(ctx, [...issues], [...paths], "these commits, their sessions or the lines");
  const sessions = found.filter((f) => f.card.kind === "session").length;
  const said = [sessions ? `${sessions} ${sessions === 1 ? "session" : "sessions"}` : "", ...named.said].filter(Boolean).join(", ");

  return { step: { tool: "behind", asked: "the sessions, issues and shared files those commits name", found: said || "nothing", ms: Date.now() - t0, by: "first_pass", error: null }, found: [...found, ...named.found] };
}

export async function lookShared(ctx: LookupCtx, args: Args<"search_shared">, by: Step["by"]): Promise<LookupResult> {
  const t0 = Date.now();
  const words = args.words;
  const shared = await sharedCards(ctx, words, []);
  const found: Found[] = shared.cards.map((card) => ({ key: keyOf(card), how: "search", found_by: `Found by searching the shared files for ${words.map((x) => `"${x}"`).join(", ")}.`, card }));

  return {
    step: { tool: "search_shared", asked: `the shared files for ${words.map((x) => `"${x}"`).join(", ")}`, found: found.length ? `${found.length} ${found.length === 1 ? "file" : "files"}: ${shared.cards.map((c) => c.path).join(", ")}` : `nothing in ${shared.read} ${shared.read === 1 ? "file" : "files"}`, ms: Date.now() - t0, by, error: null },
    found,
  };
}

export async function lookSessions(ctx: LookupCtx, args: Args<"search_sessions">, by: Step["by"], first: string[] = []): Promise<LookupResult> {
  const t0 = Date.now();
  const words = args.words;
  const recent = unwrap(await ctx.stub.sessionList({ person: null, program: null, repo: null, branch: null, state: null, main: null, cursor: null, limit: SESSIONS_READ }));
  const ids = [...new Set([...first, ...recent.sessions.map((s) => s.id)])].slice(0, SESSIONS_READ);
  const match = (text: string) => words.some((x) => text.toLowerCase().includes(x));
  const found: Found[] = [];

  for (let i = 0; i < ids.length; i += 6) {
    const cards = await Promise.all(ids.slice(i, i + 6).map((id) => sessionCard(ctx, id, { match }).catch(() => null)));

    for (const card of cards) if (card) found.push({ key: keyOf(card), how: "search", found_by: `Found by searching the sessions' prompts for ${words.map((x) => `"${x}"`).join(", ")}.`, card });
  }

  return {
    step: { tool: "search_sessions", asked: `the sessions' prompts for ${words.map((x) => `"${x}"`).join(", ")}`, found: found.length ? `${found.length} ${found.length === 1 ? "prompt" : "prompts"}` : `nothing in ${ids.length} ${ids.length === 1 ? "session" : "sessions"}`, ms: Date.now() - t0, by, error: null },
    found,
  };
}

export async function lookIssue(ctx: LookupCtx, args: Args<"issue">, by: Step["by"]): Promise<LookupResult> {
  const t0 = Date.now();
  const n = args.number;
  const card = await issueCard(ctx, n);

  return {
    step: { tool: "issue", asked: `issue #${n}`, found: card ? `#${n} ${card.title}` : `no issue #${n}`, ms: Date.now() - t0, by, error: null },
    found: card ? [{ key: keyOf(card), how: "named", found_by: "Read by the assistant.", card }] : [],
  };
}

function bad(message: string): never {
  throw new HttpError(400, "bad_request", message);
}

/** Runs one parsed lookup; `sessions` are the page's own sessions, which search_sessions reads first. */
export function runLookup(ctx: LookupCtx, args: LookupArgs, by: Step["by"], sessions: string[] = []): Promise<LookupResult> {
  switch (args.tool) {
    case "blame":
      return lookBlame(ctx, args, by);
    case "history":
      return lookHistory(ctx, args, by);
    case "commit":
      return lookCommit(ctx, args, by);
    case "search_shared":
      return lookShared(ctx, args, by);
    case "search_sessions":
      return lookSessions(ctx, args, by, sessions);
    case "issue":
      return lookIssue(ctx, args, by);
  }
}

// ── What the model reads ──

/** One record, for the model: its id, what it is, and its words. */
export function describe(id: string, card: Card): string {
  switch (card.kind) {
    case "commit": {
      const made = [card.machine ? `from ${card.machine}` : "", card.agent ? `with ${card.agent}` : "", card.model ? `(${card.model})` : ""].filter(Boolean).join(" ");

      return [`[${id}] commit ${short(card.sha)} "${card.title}" by ${card.person ?? card.author.name}${made ? ` ${made}` : ""}, ${day(card.committed_at)}${card.sessions.length ? `; sessions ${card.sessions.join(", ")}` : ""}`, card.body ? `  ${card.body.slice(0, 400).replace(/\n/g, "\n  ")}` : ""].filter(Boolean).join("\n");
    }

    case "session":
      return [
        `[${id}] recorded ${card.program} session ${card.id} of ${card.person} on ${card.machine}${card.model ? ` (${card.model})` : ""}`,
        card.prompt ? `  prompt ${card.prompt.number}, ${card.prompt.at ?? ""}${card.prompt.why === "wrote" ? " (the turn that wrote the file)" : card.prompt.why === "before" ? " (the last prompt before the commit)" : ""}: "${card.prompt.text.slice(0, 400)}"` : "",
        card.step ? `  step: ${card.step.tool} ${card.step.input}` : "",
      ].filter(Boolean).join("\n");
    case "agent":
      return `[${id}] Cloudflare-run agent session #${card.number} (${card.agent_kind}) launched by ${card.launched_by}, model ${card.model}${card.branch ? `, branch ${card.branch}` : ""}`;
    case "meta":
      return [`[${id}] shared file ${card.path}, version ${card.version}, saved by ${card.saved_by} on ${day(card.saved_at)}`, card.excerpt ? card.excerpt.text.split("\n").map((l, i) => `  ${card.excerpt!.from + i}: ${l}`).join("\n") : ""].filter(Boolean).join("\n");
    case "issue":
      return [`[${id}] issue #${card.number} "${card.title}" (${card.state}), opened by ${card.author} on ${day(card.created_at)}`, card.excerpt ? `  ${card.excerpt.replace(/\n/g, " ")}` : ""].filter(Boolean).join("\n");
  }
}

/** A lookup's text for the model: what it found, each record with its id. */
export function lookupText(result: LookupResult, ids: (string | null)[]): string {
  const lines = result.found.flatMap((f, i) => (ids[i] ? [describe(ids[i]!, f.card)] : []));

  return [`${result.step.asked}: ${result.step.found}.`, ...lines].join("\n");
}
