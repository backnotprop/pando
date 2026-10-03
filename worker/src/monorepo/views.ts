// Branch rows as the API returns them (api-v1.yaml, Branch). Used by the
// /v1 routes in the Worker and by the monorepo object when it publishes a
// branch to the event stream, so both send the same shape.

import type { Env } from "../env";
import { branchesOf, listRefs, withRepo } from "./artifacts";
import { combine, requiredChecks } from "./checks";
import { commitReader, compareWith } from "./graph";
import { gitwrite } from "./merge-port";
import type { BranchRecord, Checks, Kind, RepoRecord, StatusRecord } from "./types";

export interface BranchView {
  name: string;
  head: string;
  base: string | null;
  author: string | null;
  title: string | null;
  description: string | null;
  ahead: number | null;
  behind: number | null;
  mergeable: string;
  checks: Checks;
  state: "open" | "merged";
  merge_commit: string | null;
  merged_by: string | null;
  merged_at: string | null;
  merged_machine: string | null;
  merged_agent: string | null;
  forced: boolean | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface BranchList {
  default_branch: string;
  default_head: string | null;
  branches: BranchView[];
}

/** Where branch records and statuses come from: the monorepo object, locally or by RPC. */
export interface BranchStore {
  records(repo: string): Promise<BranchRecord[]> | BranchRecord[];
  statuses(repo: string, sha: string): Promise<StatusRecord[]> | StatusRecord[];
}

const mergeableCache = new Map<string, string>();

async function mergeable(env: Env, r: RepoRecord, main: string, head: string, ahead: number | null): Promise<string> {
  if (ahead === 0) return "up_to_date";
  if (!gitwrite) return "unknown";
  const key = `${r.artifacts_name}:${main}:${head}`;
  const hit = mergeableCache.get(key);
  if (hit) return hit;
  let v = "unknown";
  try {
    const out = await gitwrite.mergeCommit(
      { artifacts: env.ARTIFACTS, name: r.artifacts_name },
      { base: r.default_branch, head, baseSha: main, message: "dry run\n", author: { name: "Pando", email: "pando@pando.invalid" }, dryRun: true },
    );
    v = out.status === "mergeable" ? "clean" : out.status === "conflict" ? "conflicts" : out.status === "up_to_date" ? "up_to_date" : "unknown";
  } catch {
    v = "unknown";
  }
  if (mergeableCache.size > 5000) mergeableCache.clear();
  if (v !== "unknown") mergeableCache.set(key, v);
  return v;
}

export async function pool<T, U>(items: T[], n: number, fn: (t: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/** The repo's branches (all, or `names`), with refs read from Artifacts now. */
export async function branchViews(
  env: Env,
  monorepo: { name: string; kind: Kind },
  store: BranchStore,
  r: RepoRecord,
  names: string[] | null,
  state: "open" | "merged" | "all",
): Promise<BranchList> {
  const refs = branchesOf(await listRefs(env, r));
  const main = refs.get(r.default_branch) ?? null;
  const records = new Map((await store.records(r.name)).map((b) => [b.name, b]));
  const required = await requiredChecks(env, monorepo, r);
  const wantNames = (names ?? [...refs.keys()]).filter((n) => n !== r.default_branch && refs.has(n));
  const views = await withRepo(env, r.artifacts_name, async (repo) => {
    const read = commitReader(repo);
    return pool(wantNames, 4, async (name): Promise<BranchView> => {
      const head = refs.get(name)!;
      const rec = records.get(name) ?? null;
      let base: string | null = null;
      let ahead: number | null = null;
      let behind: number | null = null;
      if (main) {
        try {
          ({ mergeBase: base, ahead, behind } = await compareWith(read, main, head));
        } catch {
          /* too far apart: leave nulls */
        }
      }
      const checks = combine(head, required, await store.statuses(r.name, head));
      const merged = !!rec && rec.merged_head === head;
      return {
        name,
        head,
        base,
        author: rec?.creator ?? null,
        title: rec?.title ?? null,
        description: rec?.description ?? null,
        ahead,
        behind,
        mergeable: main && base ? await mergeable(env, r, main, head, ahead) : "unknown",
        checks,
        state: merged ? "merged" : "open",
        merge_commit: merged ? rec!.merge_commit : null,
        merged_by: merged ? rec!.merged_by : null,
        merged_at: merged ? rec!.merged_at : null,
        merged_machine: merged ? (rec!.merge_machine ?? null) : null,
        merged_agent: merged ? (rec!.merge_agent ?? null) : null,
        forced: merged ? rec!.merge_forced === 1 : null,
        created_at: rec?.created_at ?? null,
        updated_at: rec?.updated_at ?? null,
      };
    });
  });
  return {
    default_branch: r.default_branch,
    default_head: main,
    branches: views.filter((v) => state === "all" || v.state === state),
  };
}

/** Pando's who-made-it trailers (formats.md, section 6), from a commit message's last paragraph. */
export function pandoTrailers(message: string): { agent: string | null; worktree: string | null; machine: string | null } {
  const out = { agent: null as string | null, worktree: null as string | null, machine: null as string | null };
  const paragraphs = message.replace(/\r\n/g, "\n").trimEnd().split(/\n\s*\n/);
  const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1] : "";
  for (const line of last.split("\n")) {
    const m = line.match(/^Pando-(Agent|Worktree|Machine):\s*(.*?)\s*$/i);
    if (!m || !m[2]) continue;
    const k = m[1].toLowerCase() as "agent" | "worktree" | "machine";
    out[k] = m[2];
  }
  return out;
}

/** The most commits one call to a branch's commits returns. */
export const COMMITS_MAX = 250;
