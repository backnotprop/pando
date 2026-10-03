// The pando-feed queue consumer (C25). Messages come from monorepo objects
// (events, summary ticks) and from membership changes (member):
// - events: one message per burst of activity in a small monorepo, with its
//   member list; one FeedObject call per member's feed per batch.
// - summary: a monorepo's line changed; one call per member's feed.
// - member: a person's membership may have changed. The accounts are read
//   (the truth), the monorepo object gets the fresh member list, and the
//   person's feed joins (with a backfill of BACKFILL events) or leaves. A
//   repeated or out-of-order member message therefore lands in the right
//   state.
// Deliveries are at least once and in any order; every write here is
// idempotent (pointers are unique on (monorepo, seq); older summaries are
// dropped).

import type { Env } from "../env";
import { accounts } from "../accounts/auth";
import { monorepoStub } from "../monorepo/session";
import { timed, timedStub } from "../timing";
import { pool } from "../monorepo/views";
import type { FeedObject } from "./object";
import { BACKFILL, type FeedEvent, type FeedMessage } from "./shape";

export function feedStub(env: Env, login: string): DurableObjectStub<FeedObject> {
  return timedStub(env.FEED.getByName(login));
}

/** Feed calls at once in one invocation. */
const PARALLEL = 20;

export async function handleFeedBatch(batch: MessageBatch<FeedMessage>, env: Env): Promise<void> {
  await timed("queue", { route: "feed", messages: batch.messages.length }, () => runBatch(batch, env));
}

async function runBatch(batch: MessageBatch<FeedMessage>, env: Env): Promise<void> {
  const failed = new Set<Message<FeedMessage>>();
  // Events: group by person, then by monorepo, so each feed gets one call.
  const perLogin = new Map<string, { msgs: Message<FeedMessage>[]; groups: Map<string, FeedEvent[]> }>();
  for (const msg of batch.messages) {
    const b = msg.body;
    if (b.type !== "events") continue;
    for (const login of b.members) {
      const p = perLogin.get(login) ?? { msgs: [] as Message<FeedMessage>[], groups: new Map<string, FeedEvent[]>() };
      p.msgs.push(msg);
      p.groups.set(b.monorepo, [...(p.groups.get(b.monorepo) ?? []), ...b.events]);
      perLogin.set(login, p);
    }
  }
  await pool([...perLogin], PARALLEL, async ([login, p]) => {
    try {
      await feedStub(env, login).addEvents([...p.groups].map(([monorepo, events]) => ({ monorepo, events })));
    } catch (err) {
      console.error(`feed: events to ${login} failed:`, err instanceof Error ? err.message : String(err));
      for (const m of p.msgs) failed.add(m);
    }
  });
  // Summaries and memberships, one message at a time (each fans out or reads on its own).
  for (const msg of batch.messages) {
    const b = msg.body;
    try {
      if (b.type === "summary") await summary(env, b);
      else if (b.type === "member") await member(env, b.monorepo, b.login);
    } catch (err) {
      console.error(`feed: ${b.type} for ${b.monorepo} failed:`, err instanceof Error ? err.message : String(err));
      failed.add(msg);
    }
  }
  for (const msg of batch.messages) {
    if (failed.has(msg)) msg.retry({ delaySeconds: Math.min(60, 5 * msg.attempts) });
    else msg.ack();
  }
}

async function summary(env: Env, b: Extract<FeedMessage, { type: "summary" }>): Promise<void> {
  const members = b.members ?? (await monorepoStub(env, b.monorepo).feedMembers());
  const errors: unknown[] = [];
  await pool(members, PARALLEL, async (login) => {
    try {
      await feedStub(env, login).putSummary(b.monorepo, b.summary, b.needs_changed, b.needs_more);
    } catch (err) {
      errors.push(err);
    }
  });
  if (errors.length) throw errors[0];
}

/** Make one person's feed match the accounts for one monorepo: join with a backfill, or leave. */
export async function member(env: Env, monorepo: string, login: string): Promise<"joined" | "left"> {
  const members = (await accounts(env).members(monorepo)).map((m) => m.login);
  const stub = monorepoStub(env, monorepo);
  const data = await stub.feedJoin(members, members.includes(login) ? login : null, BACKFILL);
  const feed = feedStub(env, login);
  if (!data || !members.includes(login)) {
    await feed.leave(monorepo);
    return "left";
  }
  await feed.join(monorepo, data);
  return "joined";
}
