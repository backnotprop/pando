// A push's line in the feed carries how many commits it brought and the head
// commit's title. The branch-facts job computes them (C25): it walks the same
// commits for the branch's facts moments later, so the reads land in the
// isolate's commit cache (graph.ts) and cost no extra Artifacts round trips
// beyond the first. The push's event then goes out to feeds from the monorepo
// object (feedPush). A failure here still sends the event, without numbers.

import type { Env } from "../env";
import { HttpError } from "../http";
import { withRepo } from "../monorepo/artifacts";
import { commitReader, compareWith } from "../monorepo/graph";
import { ZERO } from "../monorepo/names";
import type { RepoRecord } from "../monorepo/types";

/** A new branch with no main to compare against counts at most this many commits (`commits_more` past it). */
const LOG_MAX = 250;

type Stub = {
  currentMain(repo: string): Promise<string | null>;
  feedPush(seq: number, summary: Record<string, unknown>): Promise<boolean>;
};

export async function sendPushSummary(env: Env, stub: Stub, r: RepoRecord, push: { seq: number; before: string }, head: string, isMain: boolean): Promise<void> {
  const summary: Record<string, unknown> = { commits: null, head_title: null };
  try {
    await withRepo(env, r.artifacts_name, async (repo) => {
      const read = commitReader(repo);
      summary.head_title = ((await read(head)).message ?? "").split("\n")[0] || null;
      if (push.before !== ZERO) {
        summary.commits = (await compareWith(read, push.before, head)).ahead;
        return;
      }
      const main = isMain ? null : await stub.currentMain(r.name);
      if (main === head) summary.commits = 0;
      else if (main) summary.commits = (await compareWith(read, main, head)).ahead;
      else {
        const log = await repo.log({ ref: head, limit: LOG_MAX });
        summary.commits = log.length;
        if (log.length >= LOG_MAX) summary.commits_more = true;
      }
    });
  } catch (err) {
    // A repo deleted before its job ran (tests do this) is expected: a warning, not an error.
    const log = err instanceof HttpError && err.status === 404 ? console.warn : console.error;
    log(`feed: push summary for ${r.name}@${head.slice(0, 12)} failed; sent without numbers:`, err instanceof Error ? err.message : String(err));
  }
  await stub.feedPush(push.seq, summary);
}
