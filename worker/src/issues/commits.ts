// Closing keywords in a branch's own commits (those on its head, not on main): with the branch facts, and
// by a merge whose stored facts are not for the head and main it merges.
import { compareWith, type CommitReader } from "../monorepo/graph";
import { closingRefs } from "./refs";

/** The newest commits of a branch read for keywords (an owner limit: one or two Artifacts reads). */
export const COMMITS_READ_MAX = 250;

/** Each issue number the branch's commits close, with the newest commit naming it. */
export async function commitClosings(read: CommitReader, base: string, head: string, names: readonly string[]): Promise<{ number: number; sha: string }[]> {
  const { aheadCommits } = await compareWith(read, base, head);

  return closingsIn(read, aheadCommits, names);
}

/** The same, for commits already listed newest first. */
export async function closingsIn(read: CommitReader, newestFirst: string[], names: readonly string[]): Promise<{ number: number; sha: string }[]> {
  const out = new Map<number, string>();

  for (const sha of newestFirst.slice(0, COMMITS_READ_MAX)) {
    for (const n of closingRefs((await read(sha)).message ?? "", names)) if (!out.has(n)) out.set(n, sha);
  }

  return [...out].map(([number, sha]) => ({ number, sha }));
}
