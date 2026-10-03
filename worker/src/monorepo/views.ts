// The Branch row's shape (api-v1.yaml, Branch), the merge dry run behind
// `mergeable`, and small helpers. Rows are assembled by the monorepo object
// from stored facts (facts.ts).

import type { Env } from "../env";
import { gitwrite } from "./merge-port";
import type { Checks, RepoRecord } from "./types";

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
  /** True when ahead, behind, base and mergeable are not yet for the current main and head. */
  stale: boolean;
  /** When stale: the last known mergeable answer (mergeable says "pending"). */
  last_mergeable: string | null;
  facts_at: string | null;
}

export interface BranchList {
  default_branch: string;
  default_head: string | null;
  branches: BranchView[];
  next_cursor: string | null;
  /** Stale branches past the grace period, for the caller to compute (facts.ts). */
  due: string[];
}

const mergeableCache = new Map<string, string>();

/** Thrown when main moved during a dry run: the facts would be for a main that is gone. */
export class MainMoved extends Error {
  constructor() {
    super("main moved while computing branch facts");
    this.name = "MainMoved";
  }
}

/** "clean", "conflicts", "up_to_date" or "unknown", from a gitwrite dry run (cached per isolate by main and head). */
export async function mergeableOf(env: Env, r: RepoRecord, main: string, head: string, ahead: number | null): Promise<string> {
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
    // main moved while we looked: the answer is for nothing; a newer computation is coming.
    if (out.status === "ref_moved") throw new MainMoved();
    v = out.status === "mergeable" ? "clean" : out.status === "conflict" ? "conflicts" : out.status === "up_to_date" ? "up_to_date" : "unknown";
  } catch (err) {
    if (err instanceof MainMoved) throw err;
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
