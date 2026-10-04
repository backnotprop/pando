// Membership hooks for the feed (C25): after a membership change in the
// accounts, the API queues one `member` message per (monorepo, person); the
// consumer reads the accounts and joins or leaves (consumer.ts). Nothing here
// can fail the change itself: a lost message is repaired when the person's
// home next loads (the routes reconcile the feed's index with the accounts).

import type { Env } from "../env";
import { accounts } from "../accounts/auth";
import type { FeedMessage } from "./shape";

/** One message per (monorepo, person), each pair once. */
export async function feedMemberPairs(env: Env, pairs: { monorepo: string; login: string }[]): Promise<void> {
  if (!env.FEED_QUEUE || !pairs.length) return;

  try {
    const once = new Map(pairs.map((p) => [`${p.monorepo}\n${p.login}`, p]));
    const msgs: { body: FeedMessage }[] = [...once.values()].map(({ monorepo, login }) => ({ body: { type: "member", monorepo, login } }));

    for (let i = 0; i < msgs.length; i += 100) await env.FEED_QUEUE.sendBatch(msgs.slice(i, i + 100));
  } catch (err) {
    console.error(`feed: ${pairs.length} membership messages not sent (repaired on the next home load):`, err instanceof Error ? err.message : String(err));
  }
}

/** Several people's membership of one monorepo changed. */
export async function feedMembership(env: Env, monorepo: string, logins: string[]): Promise<void> {
  await feedMemberPairs(env, logins.map((login) => ({ monorepo, login })));
}

/** One person joined or left an org: their membership of each of its monorepos changed. */
export async function feedOrgMembership(env: Env, org: string, login: string): Promise<void> {
  try {
    await feedMemberPairs(env, (await accounts(env).orgMonorepos(org)).map((monorepo) => ({ monorepo, login })));
  } catch (err) {
    console.error(`feed: ${login}'s membership messages for ${org} not sent (repaired on the next home load):`, err instanceof Error ? err.message : String(err));
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
