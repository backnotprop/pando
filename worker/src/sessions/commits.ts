// Commits and the sessions their Pando-Session lines name: read with the branch facts (a branch's own commits, the
// ones not on main) and with the contribution credits (the commits that reached main). Only pushed commits count.
import { COMMITS_READ_MAX } from "../issues/commits";
import type { CommitInfo, CommitReader } from "../monorepo/graph";

/** One commit that names sessions: `ord` is its place among the branch's own commits, 0 the newest. */
export interface SessionCommitRef {
  sha: string;
  sessions: string[];
  title: string;
  committed_at: string;
  ord: number;
}

export function titleOf(message: string | undefined): string {
  return (message ?? "").split("\n", 1)[0].slice(0, 200);
}

export function refOf(sha: string, c: CommitInfo, ord: number): SessionCommitRef | null {
  if (!c.sessions?.length || c.parents.length > 1) return null;

  return { sha, sessions: c.sessions, title: titleOf(c.message), committed_at: new Date(c.time * 1000).toISOString(), ord };
}

/** The branch's own commits (newest first, as the facts walk listed them) that name a session; at most 250 read. */
export async function sessionCommitsIn(read: CommitReader, newestFirst: string[]): Promise<SessionCommitRef[]> {
  const out: SessionCommitRef[] = [];

  for (const [i, sha] of newestFirst.slice(0, COMMITS_READ_MAX).entries()) {
    const ref = refOf(sha, await read(sha), i);

    if (ref) out.push(ref);
  }

  return out;
}
