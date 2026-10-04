// Branch facts (ahead, behind, merge base, mergeable), computed on change and
// stored in the monorepo object, so a branch list answers at once.
//
// - When main moves (a merge, main's first push), the object's outbox
//   (facts-out.ts) holds one "sweep" for that repo and that main, drained at
//   once into FactsDrain by RPC. The sweep walks the open branches
//   pushed in the last SWEEP_DAYS, newest first, at most SWEEP_MAX, SWEEP_PARALLEL
//   at a time, and stops when main moves on (the newer main has its own sweep).
// - When a branch's head moves, the outbox holds a one-branch job.
// - A branch's facts are skipped when already stored for its (main, head).
// - Branches no sweep reaches are computed when listed: at most INLINE_MAX per
//   list call, once they have been stale for STALE_GRACE_MS.
// The object never calls Artifacts for this; FactsDrain and the list route do.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env";
import type { FactsJob } from "./facts-out";
import { HttpError } from "../http";
import { isRecord, isText, isWholeNumber, type Json } from "../parse";
import { currentTiming, note, timed, timedStub } from "../timing";
import { withRepo } from "./artifacts";
import { requiredKept } from "./checks";
import { commitReader, compareWith, type CommitReader } from "./graph";
import { MainMoved, mergeableOf, pool } from "./views";
import type { RepoRecord } from "./types";
import { sendPushSummary } from "../feed/push";
import { runReconcile } from "./reconcile";

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
  /** On "conflicts": every path changed differently on both sides (the dry run's own list). */
  conflict_paths: string[] | null;
}

export type FactsMessage = (
  // monorepo: the monorepo's id (for one made before namespaces, its old name).
  | { type: "sweep"; monorepo: string; repo: string; main: string }
  | { type: "branch"; monorepo: string; repo: string; branch: string; head: string }
  // The refs compare (CODE-VS-MODEL.md P1): Artifacts' refs against the records, every branch.
  | { type: "refs"; monorepo: string; repo: string }
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

    const dry = base ? await mergeableOf(env, r, main, head, ahead) : { mergeable: "unknown", conflict_paths: null };

    return { main, head, ahead, behind, merge_base: base, mergeable: dry.mergeable, conflict_paths: dry.conflict_paths };
  };

  return read ? go(read) : withRepo(env, r.artifacts_name, (repo) => go(commitReader(repo)));
}

function stubOf(env: Env, monorepo: string) {
  return timedStub(env.MONOREPO.getByName(monorepo));
}

/**
 * The facts drain (C25-LIVE-HOME.md step 2): the monorepo object's outbox
 * calls this by RPC with its due jobs. One-branch jobs run SWEEP_PARALLEL at
 * a time, sweeps one after another. Answers, per
 * job, whether it is done: main having moved on, or the repo being gone,
 * counts as done; anything else is retried by the object.
 */
export class FactsDrain extends WorkerEntrypoint<Env> {
  async run(jobs: FactsJob[]): Promise<{ ok: boolean[]; error: string | null }> {
    const ok = jobs.map(() => false);
    let error: string | null = null;

    const one = async (i: number) => {
      const b = jobs[i];

      try {
        await timed("drain", { route: `facts.${b.type}`, monorepo_id: b.monorepo, repo: b.repo, facts_age_ms: Math.max(0, Date.now() - b.created) }, () =>
          runFacts(this.env, b).finally(() => {
            const t = currentTiming();

            if (t) t.fields.facts_job_ms = Date.now() - t.start - Number(t.fields.push_summary_ms ?? 0);
          }),
        );
        ok[i] = true;
      } catch (err) {
        if (err instanceof MainMoved || (err instanceof HttpError && err.status === 404)) {
          ok[i] = true; // main moved on (its own sweep recomputes), or the repo is gone

          return;
        }

        error ??= err instanceof Error ? err.message : String(err);
        console.error(`branch facts (${b.type} ${b.repo}) failed:`, err instanceof Error ? err.message : String(err));
      }
    };

    const idx = jobs.map((_, i) => i);
    await pool(idx.filter((i) => jobs[i].type === "branch"), SWEEP_PARALLEL, one);

    for (const i of idx.filter((i) => jobs[i].type !== "branch")) await one(i);

    return { ok, error };
  }
}

export async function runFacts(env: Env, m: FactsMessage): Promise<{ computed: number; abandoned: boolean }> {
  const stub = stubOf(env, m.monorepo);
  const [r, info] = await Promise.all([stub.getRepo(m.repo), stub.info()]);

  if (!r || !info) return { computed: 0, abandoned: true };

  if (m.type === "refs") return { computed: await runReconcile(env, stub, r, { all: true }), abandoned: false };

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

/**
 * Tests only (FACTS_TEST=1 and the bootstrap secret): GET
 * /v1/_facts/test?monorepo=<id> shows a monorepo's facts outbox; POST
 * {monorepo, fail} makes its next `fail` drains fail.
 */
export async function factsTestRoute(request: Request, env: Env): Promise<Response> {
  if (env.FACTS_TEST !== "1") return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
  const { credential } = await import("../http");
  const { isBootstrap } = await import("./session");

  if (!(await isBootstrap(env, credential(request)))) return Response.json({ error: { code: "unauthorized", message: "the bootstrap secret only" } }, { status: 401 });
  const url = new URL(request.url);
  const b = request.method === "POST" ? await request.json<Json>().catch(() => null) : null;
  const id = (isRecord(b) && isText(b.monorepo) ? b.monorepo : null) ?? url.searchParams.get("monorepo");

  if (!id) return Response.json({ error: { code: "bad_request", message: "monorepo (its id)" } }, { status: 400 });
  const fail = isRecord(b) && isWholeNumber(b.fail) ? b.fail : undefined;

  return Response.json(await stubOf(env, id).testFactsOutbox(fail === undefined ? {} : { fail }));
}
