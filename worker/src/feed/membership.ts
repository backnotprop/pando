// Membership hooks for the feed (C25): after a membership change in the
// accounts, the API queues one `member` message per person; the consumer
// reads the accounts and joins or leaves (consumer.ts). Nothing here can fail
// the change itself: a lost message is repaired when the person's home next
// loads (the routes reconcile the feed's index with the accounts).

import type { Env } from "../env";
import { accounts } from "../accounts/auth";
import type { FeedMessage } from "./shape";

export async function feedMembership(env: Env, monorepo: string, logins: string[]): Promise<void> {
  if (!env.FEED_QUEUE || !logins.length) return;

  try {
    const msgs: { body: FeedMessage }[] = [...new Set(logins)].map((login) => ({ body: { type: "member", monorepo, login } }));

    for (let i = 0; i < msgs.length; i += 100) await env.FEED_QUEUE.sendBatch(msgs.slice(i, i + 100));
  } catch (err) {
    console.error(`feed: membership messages for ${monorepo} not sent (repaired on the next home load):`, err instanceof Error ? err.message : String(err));
  }
}

/** Members of a monorepo about to be deleted, to tell their feeds after. */
export async function membersBeforeDelete(env: Env, monorepo: string): Promise<string[]> {
  try {
    return (await accounts(env).members(monorepo)).map((m) => m.login);
  } catch {
    return [];
  }
}
