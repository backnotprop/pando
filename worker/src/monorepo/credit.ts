// Contribution credits (profile SPEC section 3.2, with the owner's answers in
// decisions/RULINGS.md, "Profiles"). The monorepo object writes a credit job
// to its facts outbox in the same step as the work, and FactsDrain runs it:
// - "credit" with `from`: a merge's new commits on main (compareWith);
// - "credit" without `from`: a repo's main arriving with its history, walked
//   back to the graph's window a page at a time, each page its own job;
// - "credit_one": a branch opened or a review, for the person who did it.
// A commit counts once for its author and once for each Co-authored-by
// person, matched by their one sign-in email (or Pando's
// <login>@users.pando.invalid), if they can open the monorepo now. Merge
// commits never count. Each person's FeedObject applies a credit's key once,
// so a job run again after a lost answer adds nothing.

import type { Env } from "../env";
import { HttpError } from "../http";
import { note } from "../timing";
import { accounts } from "../accounts/auth";
import { feedStub } from "../feed/consumer";
import type { ContribKind, ContribRow } from "../feed/object";
import { withRepo } from "./artifacts";
import { commitReader, compareWith, walkSince, type CommitInfo, type CommitReader } from "./graph";
import { validNamespace } from "./names";
import type { ObjectInfo, RepoRecord } from "./types";

/** How far back commits count: the graph's 53 weeks and a day. */
const WINDOW_S = 372 * 86_400;

/** Commits read per page of a history (one job each, so no single drain runs long). */
export const HISTORY_PAGE = 1000;

const PANDO_EMAIL = /^([a-z0-9-]+)@users\.pando\.invalid$/;

export type CreditMessage =
  // Commits that reached `repo`'s main: those of `to` not in `from` (a merge), or, with `from` null, its history.
  | { type: "credit"; monorepo: string; repo: string; from: string | null; to: string; frontier?: string[]; page?: number }
  | { type: "credit_one"; monorepo: string; repo: string; login: string; kind: "branch" | "review"; at: string; key: string };

/** A history's next page, as the monorepo object queues it. */
export type NextPage = { type: "credit"; repo: string; from: null; to: string; frontier: string[]; page: number };

/** The UTC hour of a time, as the counters key it ("2026-10-03T17"). */
export const hourOf = (ms: number) => new Date(ms).toISOString().slice(0, 13);

/** Who each commit credits, by login: their counter rows. Merge commits and commits older than `since` count for no one. */
async function creditsOf(env: Env, monorepo: string, commits: CommitInfo[], since: number): Promise<Map<string, ContribRow[]>> {
  const now = Date.now();
  const counted: { hour: string; emails: string[] }[] = [];

  for (const c of commits) {
    const at = c.authoredAt ?? c.time;

    if (c.parents.length > 1 || at < since) continue;
    const emails = [c.author?.email.toLowerCase() ?? "", ...(c.coauthors ?? [])].filter(Boolean);

    // A wrong clock in the future counts on the day the commit landed.
    counted.push({ hour: hourOf(Math.min(at * 1000, now)), emails: [...new Set(emails)] });
  }

  const all = [...new Set(counted.flatMap((c) => c.emails))];
  const out = new Map<string, ContribRow[]>();

  if (!all.length) return out;
  const pandoLogins = all.flatMap((e) => PANDO_EMAIL.exec(e)?.[1] ?? []).filter((l) => validNamespace(l));
  const people = await accounts(env).creditees(monorepo, all.filter((e) => !PANDO_EMAIL.test(e)), pandoLogins);
  const byEmail = new Map<string, string[]>();

  for (const p of people) {
    for (const e of [p.email, `${p.login}@users.pando.invalid`]) {
      if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), p.login]);
    }
  }

  for (const c of counted) {
    // The same person as author and co-author counts once.
    for (const login of new Set(c.emails.flatMap((e) => byEmail.get(e) ?? []))) {
      const rows = out.get(login) ?? [];
      const row = rows.find((r) => r.hour === c.hour);

      if (row) row.n++;
      else rows.push({ hour: c.hour, kind: "commit", n: 1 });
      out.set(login, rows);
    }
  }

  return out;
}

/** Apply one credit to each person's feed: the same key everywhere, so a retry adds nothing anyone already has. */
async function apply(env: Env, info: ObjectInfo, key: string, credits: Map<string, ContribRow[]>): Promise<void> {
  await Promise.all([...credits].map(([login, rows]) => feedStub(env, login).credit(key, info.id, info.label, rows)));
}

/** The commits a job credits, read through one reader, and where a history goes on. */
async function commitsFor(read: CommitReader, m: Extract<CreditMessage, { type: "credit" }>, since: number): Promise<{ shas: string[]; next: string[] }> {
  if (m.from) {
    try {
      return { shas: (await compareWith(read, m.from, m.to)).aheadCommits, next: [] };
    } catch (err) {
      // A merge bringing more than the walk's budget (5,000 commits) credits none of them.
      if (err instanceof HttpError && err.status === 422) {
        console.error(`credit: the merge to ${m.to} brought too many commits to count: ${err.message}`);

        return { shas: [], next: [] };
      }

      throw err;
    }
  }

  const w = await walkSince(read, m.frontier ?? [m.to], since, HISTORY_PAGE);

  return { shas: w.commits, next: w.next };
}

/** Run a credit job (FactsDrain). Throws to be retried. */
export async function runCredit(env: Env, r: RepoRecord, info: ObjectInfo, m: CreditMessage, queueNext: (next: NextPage) => Promise<void>): Promise<void> {
  if (m.type === "credit_one") {
    const kind: ContribKind = m.kind;
    await apply(env, info, m.key, new Map([[m.login, [{ hour: hourOf(Date.parse(m.at)), kind, n: 1 }]]]));

    return;
  }

  const since = Date.now() / 1000 - WINDOW_S;
  const page = m.page ?? 0;
  const key = m.from ? `m:${info.id}:${r.name}:${m.to}` : `h:${info.id}:${r.name}:${m.to}:${page}`;

  await withRepo(env, r.artifacts_name, async (repo) => {
    const read = commitReader(repo);
    const { shas, next } = await commitsFor(read, m, since);
    const commits: CommitInfo[] = [];

    for (const sha of shas) commits.push(await read(sha));
    const credits = await creditsOf(env, info.id, commits, since);
    await apply(env, info, key, credits);
    note({ credit_commits: shas.length, credit_people: credits.size, credit_page: m.from ? null : page });

    // The history goes on as its own job: credited first, so a retry of this one only queues the next again (its key dedupes it).
    if (next.length) await queueNext({ type: "credit", repo: r.name, from: null, to: m.to, frontier: next, page: page + 1 });
  });
}
