// When someone's access to a monorepo ends, their open sockets on it close at
// once, with NO_ACCESS (sockets.ts): the event socket (the monorepo object) and
// the shared files' live socket (the meta object). Access ends when an owner
// removes them, when they leave or are removed from the org that owns it, or
// when a transfer moves it away from the org they had it through. Before
// (until 2026-10-04) those sockets kept delivering until a reconnect.
//
// Each change reads who still has access after it (the accounts, on the
// primary), so a person who still has the monorepo another way (their own
// row, or the org) keeps their sockets. Closing never fails the change: the
// accounts are already right, and a socket left open is the old behaviour.

import type { Env } from "../env";
import { accounts } from "../accounts/auth";
import type { Member, MonorepoInfo } from "../accounts/store";
import { monorepoStub } from "./session";
import { pool } from "./views";

type Lost = Pick<MonorepoInfo, "id" | "kind">;

/** Close these people's sockets on one monorepo. */
async function closeOn(env: Env, m: Lost, logins: string[]): Promise<void> {
  if (!logins.length) return;

  try {
    await Promise.all([
      monorepoStub(env, m.id).closeSockets(logins),
      // A plain git repo has no meta layer (and no meta object to wake).
      m.kind === "monorepo" ? env.META.get(env.META.idFromName(m.id)).closeSockets(logins) : 0,
    ]);
  } catch (err) {
    console.error(`access: the sockets of ${logins.join(", ")} on ${m.id} not closed:`, err instanceof Error ? err.message : String(err));
  }
}

/** An owner removed `login` from the monorepo: close their sockets unless the org still gives it to them. */
export async function closeIfRemoved(env: Env, m: Lost, login: string): Promise<void> {
  try {
    if (!(await accounts(env).members(m.id, login)).length) await closeOn(env, m, [login]);
  } catch (err) {
    console.error(`access: ${login}'s sockets on ${m.id} not closed:`, err instanceof Error ? err.message : String(err));
  }
}

/** A transfer: close the sockets of those who could open it before (`before`) and cannot now. */
export async function closeAfterTransfer(env: Env, m: Lost, before: Member[], after: Member[]): Promise<void> {
  const still = new Set(after.map((x) => x.login));
  await closeOn(env, m, before.flatMap((x) => (still.has(x.login) ? [] : [x.login])));
}

/** `login` left an org: close their sockets on each of its monorepos they had only through it. */
export async function closeAfterOrgLeave(env: Env, org: string, login: string): Promise<void> {
  try {
    await pool(await accounts(env).orgMonoreposWithout(org, login), 10, (m) => closeOn(env, m, [login]));
  } catch (err) {
    console.error(`access: ${login}'s sockets on ${org}'s monorepos not closed:`, err instanceof Error ? err.message : String(err));
  }
}
