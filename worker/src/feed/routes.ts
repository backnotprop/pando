// The home's routes (C25), across every monorepo a person belongs to:
//   GET /v1/events                 the activity log (JSON pages; with Upgrade, the person's live socket)
//   GET /v1/monorepos?summary=1    the monorepo list with each one's line (wired in monorepo/api.ts)
//   GET /v1/branches               "needs you": open branches that are ready, conflicting or failing
//   /v1/_feed/test                 tests only (FEED_TEST=1 and the bootstrap secret)
// Cookie or Bearer; with the cookie, the socket upgrade must come from
// Pando's own origin (accounts/auth.ts).

import type { Env } from "../env";
import { credential, HttpError, toErrorResponse } from "../http";
import { accounts, authenticateRequest } from "../accounts/auth";
import { isBootstrap, monorepoStub } from "../monorepo/session";
import { monorepoRef } from "../monorepo/names";
import { pool } from "../monorepo/views";
import { finishTiming, runTimed, startTiming } from "../timing";
import { feedStub, handleFeedBatch } from "./consumer";
import type { IndexRow, WindowPage } from "./object";
import {
  decodeCursor, encodeCursor, LOGS_MAX, mergePages, NEED_STATES, NEEDS_MONOREPOS_MAX, PAGE_DEFAULT, PAGE_MAX, uncovered,
  type FeedEvent, type FeedMessage, type NeedRow, type NeedState,
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
    return Response.json(await eventsPage(env, login, url));
  }
  return Response.json(await needsPage(env, login, url));
}

/** Queue `member` messages (the consumer joins or leaves). */
async function queueMembers(env: Env, pairs: { monorepo: string; login: string }[]): Promise<void> {
  if (!pairs.length || !env.FEED_QUEUE) return;
  const msgs = pairs.map((p) => ({ body: { type: "member", ...p } as FeedMessage }));
  for (let i = 0; i < msgs.length; i += 100) await env.FEED_QUEUE.sendBatch(msgs.slice(i, i + 100));
}

/** The person's monorepos from the accounts (the truth), and the feed's index made to match. */
async function reconcile(env: Env, login: string) {
  const list = await accounts(env).monoreposOf(login);
  const r = await feedStub(env, login).reconcile(list.map((m) => ({ name: m.id, kind: m.kind, label: m.full_name })));
  await queueMembers(env, r.added.map((monorepo) => ({ monorepo, login }))).catch((err) =>
    console.error("feed: joins not queued (retried on the next load):", err instanceof Error ? err.message : String(err)),
  );
  return { list, rows: r.rows as IndexRow[] };
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
  const only = inn?.id ?? null;
  const feed = feedStub(env, login);
  let p = (await feed.page(cursor, limit, only)) as unknown as WindowPage;
  if (p.need_list) {
    await reconcile(env, login);
    p = (await feed.page(cursor, limit, only)) as unknown as WindowPage;
  }
  if (inn && !p.known) throw new HttpError(404, "not_found", `no monorepo ${inn.full} among yours`);
  const readLog = (name: string) => monorepoStub(env, name).eventsBefore(cursor, limit) as Promise<FeedEvent[]>;
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
  const needs = (q ? q.split(",").map((s) => s.trim()).filter(Boolean) : NEED_STATES) as NeedState[];
  if (!needs.length || needs.some((n) => !NEED_STATES.includes(n))) bad("needs: some of ready, conflicts, failing");
  const inn = await monorepoParam(env, url);
  const limit = int(url.searchParams.get("limit"), 100, 1, 500, "limit");
  const { rows } = await reconcile(env, login);
  let targets = rows.filter((r) => !inn || r.name === inn.id);
  if (inn && !targets.length) throw new HttpError(404, "not_found", `no monorepo ${inn.full} among yours`);
  // Ask only monorepos whose count is not zero (or not known yet).
  targets = targets.filter((r) => !r.summary || r.pending || needs.some((n) => (r.summary!.needs?.[n] ?? 0) > 0));
  const ordered = targets.map((r) => ({ name: r.name, label: r.label ?? r.name, last: r.summary?.last_activity_at ?? null })).sort(byLast);
  const ask = ordered.slice(0, NEEDS_MONOREPOS_MAX);
  const skipped = ordered.slice(NEEDS_MONOREPOS_MAX).map((x) => x.label);
  const lists = await pool(ask, 10, async (m) =>
    ((await monorepoStub(env, m.name).needsYou(needs, limit)) as NeedRow[]).map((r) => ({ monorepo: m.label, monorepo_id: m.name, ...r })),
  );
  const all = lists.flat().sort((a, b) => ((a.updated_at ?? "") < (b.updated_at ?? "") ? 1 : -1));
  return { branches: all.slice(0, limit), truncated: all.length > limit, skipped };
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
  const b = (await request.json()) as {
    deliver?: FeedMessage[];
    trim?: { login: string; days: number };
    outbox?: { monorepo: string; crash?: "before" | "after"; fail?: number };
  };
  if (b.trim) return Response.json(await feedStub(env, b.trim.login).trim(b.trim.days));
  if (b.outbox) {
    const { monorepo, ...set } = b.outbox;
    return Response.json(await monorepoStub(env, monorepo).feedTestOutbox(set));
  }
  const out: string[] = [];
  for (const body of b.deliver ?? []) {
    let result = "ack";
    const msg = {
      id: crypto.randomUUID(), timestamp: new Date(), body, attempts: 1,
      ack() {}, retry() {
        result = "retry";
      },
    } as unknown as Message<FeedMessage>;
    await handleFeedBatch({ queue: "pando-feed", messages: [msg], ackAll() {}, retryAll() {} } as unknown as MessageBatch<FeedMessage>, env);
    out.push(result);
  }
  return Response.json({ results: out });
}
