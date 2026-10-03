// Branch facts (ahead, behind, merge base, mergeable), computed on change and
// stored in the monorepo object, so a branch list answers at once.
//
// - When main moves (a merge, main's first push), the object queues one
//   "sweep" for that repo and that main. The consumer walks the open branches
//   pushed in the last SWEEP_DAYS, newest first, at most SWEEP_MAX, SWEEP_PARALLEL
//   at a time, and stops when main moves on (the newer main has its own sweep).
// - When a branch's head moves, the object queues a one-branch job.
// - A branch's facts are skipped when already stored for its (main, head).
// - Branches no sweep reaches are computed when listed: at most INLINE_MAX per
//   list call, once they have been stale for STALE_GRACE_MS.
// The object never calls Artifacts for this; the consumer and the list route do.

import type { Env } from "../env";
import { HttpError } from "../http";
import { currentTiming, note, timed, timedStub } from "../timing";
import { withRepo } from "./artifacts";
import { requiredKept } from "./checks";
import { commitReader, compareWith, type CommitReader } from "./graph";
import { MainMoved, mergeableOf, pool } from "./views";
import type { RepoRecord } from "./types";
import { sendPushSummary } from "../feed/push";

/** A sweep covers branches pushed within this many days (an owner limit). */
export const SWEEP_DAYS = 7;
/** At most this many branches per sweep, most recently pushed first (an owner limit). */
export const SWEEP_MAX = 100;
/** Dry runs at once within one sweep. */
export const SWEEP_PARALLEL = 6;
/** A branch list computes at most this many stale branches itself (an owner limit). */
export const INLINE_MAX = 25;
/** How long a list waits for the queue before computing a stale branch itself. */
export const STALE_GRACE_MS = 30_000;

export interface Facts {
  main: string;
  head: string;
  ahead: number | null;
  behind: number | null;
  merge_base: string | null;
  mergeable: string;
}

export type FactsMessage = (
  | { type: "sweep"; monorepo: string; repo: string; main: string }
  | { type: "branch"; monorepo: string; repo: string; branch: string; head: string }
) & {
  /** The push behind this job (C25): its event waits for the commit count and head title computed here. */
  push?: { seq: number; before: string };
};

/** One branch's facts against main. Reads Artifacts. */
export async function computeFacts(env: Env, r: RepoRecord, main: string, head: string, read?: CommitReader): Promise<Facts> {
  const go = async (rd: CommitReader): Promise<Facts> => {
    let base: string | null = null;
    let ahead: number | null = null;
    let behind: number | null = null;
    try {
      ({ mergeBase: base, ahead, behind } = await compareWith(rd, main, head));
    } catch {
      /* too far apart: unknown */
    }
    const mergeable = base ? await mergeableOf(env, r, main, head, ahead) : "unknown";
    return { main, head, ahead, behind, merge_base: base, mergeable };
  };
  return read ? go(read) : withRepo(env, r.artifacts_name, (repo) => go(commitReader(repo)));
}

function stubOf(env: Env, monorepo: string) {
  return timedStub(env.MONOREPO.getByName(monorepo));
}

/**
 * The queue consumer. One-branch jobs in a batch run SWEEP_PARALLEL at a
 * time; sweeps run one after another (each already runs SWEEP_PARALLEL dry
 * runs), so one invocation has at most SWEEP_PARALLEL in flight.
 */
export async function handleFactsBatch(batch: MessageBatch<FactsMessage>, env: Env): Promise<void> {
  const run = async (msg: Message<FactsMessage>) => {
    try {
      const b = msg.body;
      await timed("queue", { route: `facts.${b.type}`, monorepo: b.monorepo, repo: b.repo, attempt: msg.attempts, queue_delay_ms: Math.max(0, Date.now() - msg.timestamp.getTime()) }, () =>
        runFacts(env, b).finally(() => {
          // The facts themselves, apart from the push's line (push_summary_ms).
          const t = currentTiming();
          if (t) t.fields.facts_job_ms = Date.now() - t.start - Number(t.fields.push_summary_ms ?? 0);
        }),
      );
      msg.ack();
    } catch (err) {
      if (err instanceof MainMoved) {
        msg.ack(); // main moved on; its own sweep recomputes this branch
        return;
      }
      if (err instanceof HttpError && err.status === 404) {
        msg.ack(); // the repo or monorepo is gone
        return;
      }
      console.error(`branch facts (${msg.body.type} ${msg.body.repo}) failed:`, err instanceof Error ? err.message : String(err));
      msg.retry({ delaySeconds: 5 * msg.attempts });
    }
  };
  await pool(batch.messages.filter((m) => m.body.type === "branch"), SWEEP_PARALLEL, run);
  for (const m of batch.messages.filter((x) => x.body.type === "sweep")) await run(m);
}

export async function runFacts(env: Env, m: FactsMessage): Promise<{ computed: number; abandoned: boolean }> {
  const stub = stubOf(env, m.monorepo);
  const [r, info] = await Promise.all([stub.getRepo(m.repo), stub.info()]);
  if (!r || !info) return { computed: 0, abandoned: true };
  if (m.push) {
    const t0 = Date.now();
    await sendPushSummary(env, stub, r, m.push, m.type === "branch" ? m.head : m.main, m.type === "sweep");
    note({ push_summary_ms: Date.now() - t0 }); // the push's line leaves for the feed here; the facts themselves follow
  }
  if (m.type === "branch") {
    const main = await stub.currentMain(m.repo);
    if (!main) return { computed: 0, abandoned: true };
    const required = await requiredKept(env, info, r);
    const f = await computeFacts(env, r, main, m.head);
    return { computed: (await stub.writeFacts(m.repo, m.branch, f, required)) ? 1 : 0, abandoned: false };
  }
  const cands = await stub.factsCandidates(m.repo, m.main, SWEEP_DAYS, SWEEP_MAX);
  if (cands.main !== m.main) return { computed: 0, abandoned: true }; // a newer main has its own sweep
  if (!cands.branches.length) return { computed: 0, abandoned: false };
  const required = await requiredKept(env, info, r);
  let computed = 0;
  let abandoned = false;
  await withRepo(env, r.artifacts_name, async (repo) => {
    const read = commitReader(repo);
    await pool(cands.branches, SWEEP_PARALLEL, async (b) => {
      if (abandoned) return;
      if ((await stub.currentMain(m.repo)) !== m.main) {
        abandoned = true;
        return;
      }
      try {
        const f = await computeFacts(env, r, m.main, b.head, read);
        if (await stub.writeFacts(m.repo, b.name, f, required)) computed++;
      } catch (err) {
        if (!(err instanceof MainMoved)) throw err;
        abandoned = true;
      }
    });
  });
  return { computed, abandoned };
}
