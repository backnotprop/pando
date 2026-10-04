// Profiles (profile SPEC sections 3 and 6, with the owner's answers in
// decisions/RULINGS.md, "Profiles"). Signed in (cookie or Bearer), on the
// signed-in person's routes (api.ts):
//   PATCH /v1/user                              your name, bio, location and links
//   GET   /v1/users/{login}/contributions?tz=   a person's graph and timeline for the last year
//   GET   /v1/users/{login}/contributions?tz=&day=YYYY-MM-DD   one day of it
// (GET /v1/users/{name}, the header, is org-routes.ts's: a person or an org.)
// A viewer sees only work in monorepos they can open now; nothing else is
// counted for them. The counts are the person's FeedObject's, by UTC hour;
// repositories made and orgs joined come from D1.

import type * as Contract from "@pando/contract";
import { HttpError } from "../http";
import { isText, type Json } from "../parse";
import { validNamespace } from "../monorepo/names";
import type { UserApp, UserContext as C } from "../monorepo/api";
import { feedStub } from "../feed/consumer";
import type { ContribKind } from "../feed/object";
import { accounts } from "./auth";
import type { ProfileContext, ProfilePatch, Shown } from "./store";
import { bad, jsonBody, text } from "./org-routes";

/** Edit profile's limits (profile SPEC section 9): GitHub's bio and 4 links; a link as long as a picture URL may be. */
export const PROFILE_LIMITS = { name: 100, bio: 160, location: 100, links: 4, link: 2048 } as const;

const DAY_MS = 86_400_000;

const HOUR_MS = 3_600_000;

const KINDS: readonly ContribKind[] = ["commit", "branch", "review"];

/** The UTC hour a time falls in ("2026-10-03T17"), or the first that starts at or after it. */
const floorHour = (ms: number) => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13);

const ceilHour = (ms: number) => new Date(Math.ceil(ms / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13);

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A time's day in the viewer's zone (minutes east of UTC). */
const localDay = (iso: string, tz: number) => dayOf(Date.parse(iso) + tz * 60_000);

/**
 * The graph's window in the viewer's zone: from the Sunday 52 weeks before
 * this week's Sunday to today, as days, and as the UTC hours whose start
 * falls in it (hours are the stored unit; a half-hour zone rounds).
 */
interface GraphWindow {
  from: string;
  to: string;
  fromMs: number;
  firstHour: string;
  lastHour: string;
}

function windowOf(tz: number, now = Date.now()): GraphWindow {
  const local = new Date(now + tz * 60_000);
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const fromMs = today - (local.getUTCDay() + 52 * 7) * DAY_MS;

  return { from: dayOf(fromMs), to: dayOf(today), fromMs, firstHour: ceilHour(fromMs - tz * 60_000), lastHour: floorHour(today + DAY_MS - tz * 60_000 - 1) };
}

/** The calendar months from `from` to `to` (YYYY-MM-DD), oldest first. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const end = to.slice(0, 7);

  for (;;) {
    const month = `${y}-${String(m).padStart(2, "0")}`;
    out.push(month);

    if (month >= end) return out;
    m = m === 12 ? 1 : m + 1;

    if (m === 1) y++;
  }
}

/** The lowest count of shades 1 to 4: the quartiles of the non-empty days, each above the one before. */
function levelsOf(counts: number[]): [number, number, number, number] {
  const s = counts.filter((n) => n > 0).sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 1;
  const l: [number, number, number, number] = [1, q(0.25), q(0.5), q(0.75)];

  for (let i = 1; i < 4; i++) l[i] = Math.max(l[i], l[i - 1] + 1);

  return l;
}

/** The viewer's zone from `?tz=`: minutes east of UTC, -720 to 840; 0 when left out. */
function tzOf(c: C): number {
  const v = c.req.query("tz");

  if (v === undefined || v === "") return 0;
  const n = Number(v);

  if (!Number.isInteger(n) || n < -720 || n > 840) bad("tz: minutes east of UTC, -720 to 840 (the browser's -getTimezoneOffset())");

  return n;
}

/** Links from Edit profile: at most 4 https URLs; empty ones are dropped. */
function linksOf(v: Json | undefined): string[] | undefined {
  if (v === undefined) return undefined;

  if (v === null) return [];

  if (!Array.isArray(v)) bad("links: a list of https URLs");
  const links = v.map((x) => (isText(x) ? x.trim() : bad("links: a list of https URLs"))).filter(Boolean);

  if (links.length > PROFILE_LIMITS.links) bad(`links: at most ${PROFILE_LIMITS.links}`);

  for (const l of links) {
    let ok = false;

    try {
      ok = l.length <= PROFILE_LIMITS.link && new URL(l).protocol === "https:";
    } catch {
      ok = false;
    }

    if (!ok) bad(`links: ${l.slice(0, 80)} is not an https URL of at most ${PROFILE_LIMITS.link} characters`);
  }

  return links;
}

type Period = typeof Contract.ContributionPeriod.Encoded;

/** A square of the graph, while it is added up. */
interface DayRow {
  date: string;
  n: number;
  commit: number;
  branch: number;
  review: number;
  created: number;
}

/** A period's lists from counts by monorepo id and kind, each list most first. */
function periodOf(period: string, counts: { monorepo: string; kind: ContribKind; n: number }[], names: Map<string, Shown>, ctx: ProfileContext, inPeriod: (iso: string) => boolean): Period {
  const list = (kind: ContribKind) => {
    const by = new Map<string, number>();

    for (const r of counts) {
      const m = names.get(r.monorepo);

      if (r.kind === kind && m) by.set(m.full_name, (by.get(m.full_name) ?? 0) + r.n);
    }

    return [...by].map(([full_name, n]) => ({ full_name, n })).sort((a, b) => b.n - a.n || a.full_name.localeCompare(b.full_name));
  };

  return {
    period,
    commit: list("commit"),
    branch: list("branch"),
    review: list("review"),
    created: ctx.shown.flatMap((m) => (m.created_at && inPeriod(m.created_at) ? [{ full_name: m.full_name, at: m.created_at }] : [])),
    joined: ctx.orgs.filter((o) => inPeriod(o.at)),
  };
}

/** Whether a period says anything. */
const hasAny = (p: Period) => p.commit.length + p.branch.length + p.review.length + p.created.length + p.joined.length > 0;

export function profileRoutes(app: UserApp): void {
  app.patch("/v1/user", async (c) => {
    const me = c.get("auth").user.login;
    const b = await jsonBody(c);

    const patch: ProfilePatch = {
      name: text(b.name, "name", PROFILE_LIMITS.name),
      bio: text(b.bio, "bio", PROFILE_LIMITS.bio),
      location: text(b.location, "location", PROFILE_LIMITS.location),
      links: linksOf(b.links),
    };

    const acc = accounts(c.env);
    await acc.updateProfile(me, patch);

    return c.json((await acc.profile(me, me))! satisfies typeof Contract.Profile.Encoded);
  });

  app.get("/v1/users/:login/contributions", async (c) => {
    const login = c.req.param("login").toLowerCase();
    const viewer = c.get("auth").user.login;
    const tz = tzOf(c);
    const acc = accounts(c.env);

    if (!validNamespace(login) || !(await acc.getUser(login))) throw new HttpError(404, "not_found", `no person ${login}`);
    const w = windowOf(tz);
    const day = c.req.query("day");

    if (day !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < w.from || day > w.to)) bad(`day: a date from ${w.from} to ${w.to}`);
    const start = day === undefined ? 0 : Date.parse(`${day}T00:00:00Z`) - tz * 60_000;
    const [first, last] = day === undefined ? [w.firstHour, w.lastHour] : [ceilHour(start), floorHour(start + DAY_MS - 1)];
    // The person's monorepos with counts, then which of them (and of those they made) this viewer can open, then the counts in those.
    const feed = feedStub(c.env, login);
    const ctx = await acc.profileContext(login, viewer, await feed.contributedIds(first, last), new Date(w.fromMs - tz * 60_000).toISOString());
    const names = new Map(ctx.shown.map((m) => [m.id, m]));
    const ids = ctx.shown.map((m) => m.id);

    if (day !== undefined) {
      const counts = await feed.contributionDay(ids, first, last);

      return c.json(periodOf(day, counts, names, ctx, (iso) => localDay(iso, tz) === day) satisfies typeof Contract.ContributionPeriod.Encoded);
    }

    const sums = await feed.contributions(ids, tz, first, last);
    const inWindow = (d: string) => d >= w.from && d <= w.to;
    const days = new Map<string, DayRow>();
    const dayRow = (date: string) => days.get(date) ?? days.set(date, { date, n: 0, commit: 0, branch: 0, review: 0, created: 0 }).get(date)!;

    for (const r of sums.days) {
      if (!inWindow(r.date)) continue;
      const d = dayRow(r.date);
      d[r.kind] += r.n;
      d.n += r.n;
    }

    const made = ctx.shown.filter((m) => m.created_at && inWindow(localDay(m.created_at, tz)));

    for (const m of made) {
      const d = dayRow(localDay(m.created_at!, tz));
      d.created++;
      d.n++;
    }

    const list = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    const kinds = { commit: 0, branch: 0, review: 0, created: made.length };

    for (const d of list) for (const k of KINDS) kinds[k] += d[k];

    // Each monorepo's count by month (its making included), for the cards' bars.
    const months = monthsBetween(w.from, w.to);
    const perMonorepo = new Map<string, number[]>();

    const add = (id: string, month: string, n: number) => {
      const i = months.indexOf(month);

      if (i < 0 || !names.has(id)) return;
      const row = perMonorepo.get(id) ?? perMonorepo.set(id, months.map(() => 0)).get(id)!;
      row[i] += n;
    };

    for (const r of sums.months) add(r.monorepo, r.month, r.n);

    for (const m of made) add(m.id, localDay(m.created_at!, tz).slice(0, 7), 1);

    const monorepos = [...perMonorepo].flatMap(([id, byMonth]) => {
      const m = names.get(id)!;
      const n = byMonth.reduce((a, b) => a + b, 0);

      return n ? [{ full_name: m.full_name, owner_type: m.owner_type, kind: m.kind, n, months: byMonth }] : [];
    });

    monorepos.sort((a, b) => b.n - a.n || a.full_name.localeCompare(b.full_name));
    const inMonth = (month: string) => (iso: string) => localDay(iso, tz).slice(0, 7) === month;

    const timeline = months
      .toReversed()
      .map((month) => periodOf(month, sums.months.filter((r) => r.month === month), names, ctx, inMonth(month)))
      .filter(hasAny);

    return c.json({
      login, tz, from: w.from, to: w.to,
      total: list.reduce((a, d) => a + d.n, 0),
      levels: levelsOf(list.map((d) => d.n)),
      days: list,
      monorepos,
      kinds,
      months: timeline,
    } satisfies typeof Contract.Contributions.Encoded);
  });
}
