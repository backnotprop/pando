// Writing members' feeds (C25), for two callers:
// - FeedDrain, the Worker entrypoint each monorepo object calls (by
//   ctx.exports RPC) to drain its outbox at once: events and summary ticks;
// - the pando-feed queue consumer: membership changes (member), and any
//   events or summaries still queued from before the outbox drained by RPC.
// Message kinds:
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

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env";
import { accounts } from "../accounts/auth";
import { monorepoStub } from "../monorepo/session";
import { note, timed, timedStub } from "../timing";
import { pool } from "../monorepo/views";
import type { FeedObject } from "./object";
import { BACKFILL, type FeedEvent, type FeedMessage } from "./shape";

export function feedStub(env: Env, login: string): DurableObjectStub<FeedObject> {
  return timedStub(env.FEED.getByName(login));
}

/** Feed calls at once in one invocation. */
const PARALLEL = 20;

/** Per hop (timing.ts line): event_age_ms, the oldest line's age since its monorepo recorded it (a push's includes the facts job). */
function ageFields(msgs: FeedMessage[], t: number): Record<string, number> {
  let age = 0;
  let lines = 0;

  for (const m of msgs) {
    if (m.type !== "events") continue;
    lines += m.events.length;

    for (const e of m.events) age = Math.max(age, t - Date.parse(e.at));
  }

  return lines ? { lines, event_age_ms: age } : {};
}

export async function handleFeedBatch(batch: MessageBatch<FeedMessage>, env: Env): Promise<void> {
  // queue_delay_ms: the longest a message of this batch waited in pando-feed.
  const t = Date.now();

  const fields = {
    route: "feed",
    messages: batch.messages.length,
    queue_delay_ms: Math.max(0, ...batch.messages.map((m) => t - m.timestamp.getTime())),
    ...ageFields(batch.messages.map((m) => m.body), t),
  };

  await timed("queue", fields, async () => {
    const ok = await fanOut(env, batch.messages.map((m) => m.body));
    batch.messages.forEach((msg, i) => (ok[i] ? msg.ack() : msg.retry({ delaySeconds: Math.min(60, 5 * msg.attempts) })));
  });
}

/**
 * The monorepo objects' drain (C25-LIVE-HOME.md): one call per drain of up to
 * 100 outbox rows. Answers per message whether every feed took it; the object
 * deletes those rows and retries the rest.
 */
// RPC methods only: no fetch(). Workers Caching is on for this Worker
// (wrangler.jsonc); RPC calls are never cached, a fetch() here could be.
export class FeedDrain extends WorkerEntrypoint<Env> {
  async deliver(msgs: FeedMessage[]): Promise<{ ok: boolean[]; error: string | null }> {
    const fields = { route: "feed.drain", monorepo: msgs[0]?.monorepo ?? null, messages: msgs.length, ...ageFields(msgs, Date.now()) };
    let error: string | null = null;

    const ok = await timed("drain", fields, () =>
      fanOut(this.env, msgs, (err) => {
        error ??= err instanceof Error ? err.message : String(err);
      }),
    );

    return { ok, error };
  }
}

/** Deliver messages; one answer per message (true: done; false: try again, every write is idempotent). */
export async function fanOut(env: Env, msgs: FeedMessage[], onError?: (err: unknown) => void): Promise<boolean[]> {
  const ok = msgs.map(() => true);

  const fail = (i: number, what: string, err: unknown) => {
    ok[i] = false;
    onError?.(err);
    console.error(`feed: ${what} failed:`, err instanceof Error ? err.message : String(err));
  };

  // Events: group by person, then by monorepo, so each feed gets one call.
  const perLogin = new Map<string, { msgs: number[]; groups: Map<string, FeedEvent[]> }>();
  msgs.forEach((b, i) => {
    if (b.type !== "events") return;

    for (const login of b.members) {
      const p = perLogin.get(login) ?? { msgs: [] as number[], groups: new Map<string, FeedEvent[]>() };
      p.msgs.push(i);
      p.groups.set(b.monorepo, [...(p.groups.get(b.monorepo) ?? []), ...b.events]);
      perLogin.set(login, p);
    }
  });
  const w0 = Date.now();
  await pool([...perLogin], PARALLEL, async ([login, p]) => {
    try {
      await feedStub(env, login).addEvents([...p.groups].map(([monorepo, events]) => ({ monorepo, events })));
    } catch (err) {
      for (const i of p.msgs) fail(i, `events to ${login}`, err);
    }
  });

  if (perLogin.size) note({ feed_write_ms: Date.now() - w0, feeds: perLogin.size });

  // Summaries and memberships, one message at a time (each fans out or reads on its own).
  for (let i = 0; i < msgs.length; i++) {
    const b = msgs[i];

    try {
      if (b.type === "summary") await summary(env, b);
      else if (b.type === "member") await member(env, b.monorepo, b.login);
    } catch (err) {
      fail(i, `${b.type} for ${b.monorepo}`, err);
    }
  }

  return ok;
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
