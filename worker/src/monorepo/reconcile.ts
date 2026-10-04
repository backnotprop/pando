// The C2 reconcile from the Worker (CODE-VS-MODEL.md P3): read what the
// monorepo object has seen (its record-move count and its kept pushes), then
// Artifacts' refs, then let the object catch its records up. If a record
// moved in between, the object answers "retry" and the refs are read again,
// at most TRIES times; what is left waits for the next list or refs compare.
// Run by a branch list with kept pushes, by the door after a lost answer, and
// by the refs compare (all: every branch).
import type { Env } from "../env";
import { listRefs } from "./artifacts";
import type { MonorepoObject } from "./object";
import type { RepoRecord } from "./types";

const TRIES = 3;

/** How many record moves it wrote. Throws when Artifacts' refs cannot be read. */
export async function runReconcile(env: Env, stub: DurableObjectStub<MonorepoObject>, r: RepoRecord, opts: { all?: boolean; pauseMs?: number } = {}): Promise<number> {
  for (let i = 0; i < TRIES; i++) {
    const seen = await stub.reconcileSeen(r.name);

    if (!seen.ids.length && !opts.all) return 0;
    const refs = await listRefs(env, r);

    // Tests only: a pause between the refs read and the write, for a push to land in.
    if (opts.pauseMs) await new Promise((res) => setTimeout(res, opts.pauseMs));
    const out = await stub.reconcile(r.name, Object.fromEntries(refs), seen, opts.all ?? false);

    if (out !== "retry") return out;
  }

  return 0;
}
