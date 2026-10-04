// The home's routes (C25), across every monorepo a person belongs to:
//   GET /v1/events                 the activity log (JSON pages; with Upgrade, the person's live socket);
//                                  ?in=owner/name narrows to one monorepo, ?owner=<owner> to one owner's
//   GET /v1/monorepos?summary=1    the monorepo list with each one's line (wired in monorepo/api.ts)
//   GET /v1/branches               "needs you": open branches that are ready, conflicting or failing
//   /v1/_feed/test                 tests only (FEED_TEST=1 and the bootstrap secret)
// Cookie or Bearer; with the cookie, the socket upgrade must come from
// Pando's own origin (accounts/auth.ts).

import type * as Contract from "@pando/contract";
import type { Env } from "../env";
import { credential, HttpError, toErrorResponse } from "../http";
import { accounts, authenticateRequest } from "../accounts/auth";
import { isBootstrap, monorepoStub } from "../monorepo/session";
import { monorepoRef, validNamespace } from "../monorepo/names";
import { pool } from "../monorepo/views";
import { finishTiming, runTimed, startTiming } from "../timing";
import { isRecord, isWholeNumber, type Json } from "../parse";
import { fanOut, feedStub } from "./consumer";
import {
  decodeCursor, encodeCursor, feedMessageOf, LOGS_MAX, mergePages, NEED_STATES, needStatesOf, NEEDS_MONOREPOS_MAX, PAGE_DEFAULT, PAGE_MAX,
  textOf, uncovered, type FeedEvent, type FeedMessage,
} from "./shape";

export function isFeedPath(path: string): boolean {
  return path === "/v1/events" || path === "/v1/branches" || path === "/v1/_feed/test";
}

export async function handleFeed(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const t = startTiming("api", { method: request.method, path, monorepo: null, repo: null });

  const res = await runTimed(t, async () => {
    try {
      return await route(request, env);
    } catch (err) {
      return toErrorResponse(err);
    }
  });

  finishTiming(t, { status: res.status });

  return res;
}

function bad(message: string): never {
  throw new HttpError(400, "bad_request", message);
}

function int(v: string | null, dflt: number, min: number, max: number, name: string): number {
  if (v === null || v === "") return dflt;
  const n = Number(v);

  if (!Number.isInteger(n) || n < min || n > max) bad(`${name} is ${min} to ${max}`);

  return n;
}

/** `in=owner/name` (an old name works too): the monorepo's id and its owner/name, or null for all. */
async function monorepoParam(env: Env, url: URL): Promise<{ id: string; full: string } | null> {
  const v = url.searchParams.get("in");

  if (v === null || v === "") return null;
  const [o, n, extra] = v.split("/");
  const ref = extra === undefined ? monorepoRef(o, n) : null;

  if (!ref) bad("in: one monorepo's owner/name (the home narrows by monorepo only)");
  const m = await accounts(env).resolve(ref);

  if (!m) throw new HttpError(404, "not_found", `no monorepo ${ref.owner}/${ref.name} among yours`);

  return { id: m.id, full: m.full_name };
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/v1/_feed/test") return testRoute(request, env);

  if (request.method !== "GET") throw new HttpError(405, "method", "method not allowed");
  const auth = await authenticateRequest(env, request, null);

  if (!auth) throw new HttpError(401, "unauthorized", "unknown, expired or revoked credential");
  const login = auth.user.login;

  if (url.pathname === "/v1/events") {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const headers = new Headers(request.headers);
      headers.set("x-pando-login", login);

      return feedStub(env, login).fetch(new Request(request, { headers }));
    }

    return Response.json((await eventsPage(env, login, url)) satisfies typeof Contract.EventsPage.Encoded);
  }

  return Response.json((await needsPage(env, login, url)) satisfies typeof Contract.NeedsPage.Encoded);
}

/** Queue `member` messages (the consumer joins or leaves). */
async function queueMembers(env: Env, pairs: { monorepo: string; login: string }[]): Promise<void> {
  if (!pairs.length || !env.FEED_QUEUE) return;

  const msgs = pairs.map((p) => {
    const body: FeedMessage = { type: "member", monorepo: p.monorepo, login: p.login };

    return { body };
  });

  for (let i = 0; i < msgs.length; i += 100) await env.FEED_QUEUE.sendBatch(msgs.slice(i, i + 100));
}

/** The person's monorepos from the accounts (the truth), and the feed's index made to match. */
async function reconcile(env: Env, login: string) {
  const list = await accounts(env).monoreposOf(login);
  const r = await feedStub(env, login).reconcile(list.map((m) => ({ name: m.id, kind: m.kind, label: m.full_name })));
  await queueMembers(env, r.added.map((monorepo) => ({ monorepo, login }))).catch((err) =>
    console.error("feed: joins not queued (retried on the next load):", err instanceof Error ? err.message : String(err)),
  );

  return { list, rows: r.rows };
}

const byLast = (a: { last: string | null }, b: { last: string | null }) => ((b.last ?? "") < (a.last ?? "") ? -1 : (b.last ?? "") > (a.last ?? "") ? 1 : 0);

/**
 * One page, newest first: the feed's window, merged with the logs of large
 * monorepos and of small ones the window does not cover this far back
 * (LOGS_MAX logs in all; the rest are named in `skipped`).
 */
async function eventsPage(env: Env, login: string, url: URL) {
  const limit = int(url.searchParams.get("limit"), PAGE_DEFAULT, 1, PAGE_MAX, "limit");
  const c = url.searchParams.get("cursor");
  const cursor = c ? decodeCursor(c) : null;

  if (c && !cursor) bad("cursor: pass back a `next` from an earlier page");
  const inn = await monorepoParam(env, url);
  const owner = url.searchParams.get("owner")?.toLowerCase() || null;

  if (owner !== null && inn) bad("in or owner, not both");
  let only = inn ? [inn.id] : null;

  if (owner !== null) {
    // The person's monorepos under that owner, from the accounts (the truth); none is an empty page.
    only = validNamespace(owner) ? (await accounts(env).monoreposOf(login, undefined, owner)).map((m) => m.id) : [];

    if (!only.length) return { events: [], next: null, from_logs: false, skipped: [] };
  }

  const feed = feedStub(env, login);
  let p = await feed.page(cursor, limit, only);

  if (p.need_list) {
    await reconcile(env, login);
    p = await feed.page(cursor, limit, only);
  }

  if (inn && !p.known) throw new HttpError(404, "not_found", `no monorepo ${inn.full} among yours`);
  const readLog = (name: string) => monorepoStub(env, name).eventsBefore(cursor, limit);
  const large = [...p.large].sort(byLast);
  const reading = large.slice(0, LOGS_MAX);
  // skipped: owner/names, for people.
  const skipped = large.slice(LOGS_MAX).map((x) => x.label ?? x.name);
  const lists: FeedEvent[][] = [p.events, ...(await Promise.all(reading.map((x) => readLog(x.name))))];
  let page = mergePages(lists, limit);
  const boundary = page.length === limit ? page[limit - 1].at : null;
  const unc = p.uncovered.filter((u) => uncovered(u.after, boundary)).sort(byLast);
  let fromLogs = false;

  if (unc.length) {
    const room = Math.max(0, LOGS_MAX - reading.length);
    const now = unc.slice(0, room);
    skipped.push(...unc.slice(room).map((u) => u.label ?? u.name));

    if (now.length) {
      lists.push(...(await Promise.all(now.map((u) => readLog(u.name)))));
      page = mergePages(lists, limit);
      fromLogs = true;
    }
  }

  return { events: page, next: page.length === limit ? encodeCursor(page[limit - 1]) : null, from_logs: fromLogs, skipped };
}

/** GET /v1/monorepos?summary=1: the accounts' list, each with its line, most recently active first. */
export async function monoreposSummary(env: Env, login: string) {
  const { list, rows } = await reconcile(env, login);
  const by = new Map(rows.map((r) => [r.name, r]));

  const monorepos = list.map((m) => {
    const s = by.get(m.id)?.summary ?? null;

    return {
      ...m,
      last_activity_at: s?.last_activity_at ?? null,
      worktrees_active: s?.worktrees_active ?? null,
      machines_active: s?.machines_active ?? null,
      needs: s?.needs ?? null,
      members: s?.members ?? null,
      large: s?.large ?? null,
      repos: s?.repos ?? null,
      open_branches: s?.open_branches ?? null,
      assigned: s?.assigned ?? null,
    };
  });

  monorepos.sort((a, b) => ((b.last_activity_at ?? "") < (a.last_activity_at ?? "") ? -1 : (b.last_activity_at ?? "") > (a.last_activity_at ?? "") ? 1 : a.full_name < b.full_name ? -1 : 1));

  return { monorepos };
}

/** GET /v1/branches?state=open&needs=...: from the stored facts of the monorepos whose count is not zero. */
async function needsPage(env: Env, login: string, url: URL) {
  const state = url.searchParams.get("state") ?? "open";

  if (state !== "open") bad("state: open (needs-you is about open branches)");
  const q = url.searchParams.get("needs");
  const needs = q ? needStatesOf(q) : NEED_STATES;

  if (!needs?.length) bad("needs: some of ready, conflicts, failing");
  const inn = await monorepoParam(env, url);
  const limit = int(url.searchParams.get("limit"), 100, 1, 500, "limit");
  const { rows } = await reconcile(env, login);
  let targets = rows.filter((r) => !inn || r.name === inn.id);

  if (inn && !targets.length) throw new HttpError(404, "not_found", `no monorepo ${inn.full} among yours`);

  // Issues assigned to the person: from each monorepo's summary line (no call), most recently updated first.
  const issues = targets.flatMap((r) => {
    const a = r.summary?.assigned[login];

    return a ? [{ monorepo: r.label ?? r.name, monorepo_id: r.name, ...a }] : [];
  }).sort((x, y) => (x.newest.updated_at < y.newest.updated_at ? 1 : -1));

  // Ask only monorepos whose count is not zero (or not known yet).
  targets = targets.filter((r) => !r.summary || r.pending || needs.some((n) => (r.summary!.needs?.[n] ?? 0) > 0));
  const ordered = targets.map((r) => ({ name: r.name, label: r.label ?? r.name, last: r.summary?.last_activity_at ?? null })).sort(byLast);
  const ask = ordered.slice(0, NEEDS_MONOREPOS_MAX);
  const skipped = ordered.slice(NEEDS_MONOREPOS_MAX).map((x) => x.label);

  const lists = await pool(ask, 10, async (m) =>
    (await monorepoStub(env, m.name).needsYou(needs, limit)).map((r) => ({ monorepo: m.label, monorepo_id: m.name, ...r })),
  );

  const all = lists.flat().sort((a, b) => ((a.updated_at ?? "") < (b.updated_at ?? "") ? 1 : -1));

  return { branches: all.slice(0, limit), issues, truncated: all.length > limit, skipped };
}

// ── Tests only ──────────────────────────────────────────────────────────────
//
// With FEED_TEST=1 (wrangler dev --var FEED_TEST:1) and the bootstrap secret:
//   POST {deliver: [FeedMessage...]}  run queue messages now, one at a time, in this order
//   POST {trim: {login, days}}        trim a feed's window to `days`
//   GET  ?login=<l>                    a feed's index and pointer counts
//   GET  ?monorepo=<id>                a monorepo's member list, summary line and feed outbox
//   POST {outbox: {monorepo: <id>, crash, fail}}  its next drain dies ("before" or "after" its call), or the next `fail` drains fail

async function testRoute(request: Request, env: Env): Promise<Response> {
  if (env.FEED_TEST !== "1") throw new HttpError(404, "not_found", "no such route");

  if (!(await isBootstrap(env, credential(request)))) throw new HttpError(401, "unauthorized", "the bootstrap secret only");
  const url = new URL(request.url);

  if (request.method === "GET") {
    const login = url.searchParams.get("login");

    if (login) return Response.json(await feedStub(env, login).debugState());
    const m = url.searchParams.get("monorepo");

    if (m) {
      const stub = monorepoStub(env, m);

      return Response.json({ members: await stub.feedMembers(), summary: await stub.feedSummary(), outbox: await stub.feedTestOutbox() });
    }

    bad("login or monorepo");
  }

  const b = await request.json<Json>();

  if (!isRecord(b)) bad("a JSON object");

  if (isRecord(b.trim)) {
    const login = textOf(b.trim.login);
    const days = b.trim.days;

    if (login === null || !isWholeNumber(days)) bad("trim: {login, days}");

    return Response.json(await feedStub(env, login).trim(days));
  }

  if (isRecord(b.outbox)) {
    const monorepo = textOf(b.outbox.monorepo);
    const crash = b.outbox.crash === "before" || b.outbox.crash === "after" ? b.outbox.crash : undefined;
    const fail = isWholeNumber(b.outbox.fail) ? b.outbox.fail : undefined;

    if (monorepo === null) bad("outbox: {monorepo, crash?, fail?}");

    return Response.json(await monorepoStub(env, monorepo).feedTestOutbox({ crash, fail }));
  }

  const deliver = Array.isArray(b.deliver) ? b.deliver.map(feedMessageOf) : [];
  const out: string[] = [];

  // One at a time, in this order, as the queue would deliver them: true is an ack, false a retry.
  for (const msg of deliver) {
    if (msg === null) bad("deliver: messages as the queue carries them");
    const [ok] = await fanOut(env, [msg]);
    out.push(ok ? "ack" : "retry");
  }

  return Response.json({ results: out });
}
