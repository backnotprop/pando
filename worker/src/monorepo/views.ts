// The Branch row's shape (api-v1.yaml, Branch), the merge dry run behind
// `mergeable`, and small helpers. Rows are assembled by the monorepo object
// from stored facts (facts.ts).

import type { Env } from "../env";
import { isOneOf } from "../parse";
import { gitwrite } from "./merge-port";
import { timedArtifacts } from "../timing";
import type { Checks, RepoRecord } from "./types";

/** The merge dry run's answer, as the contract's Mergeable has it; `pending` while not computed for the current main and head. */
export const MERGEABLE = ["clean", "conflicts", "up_to_date", "unknown", "pending"] as const;

export type Mergeable = (typeof MERGEABLE)[number];

/** A stored mergeable answer (branches.mergeable), checked as it is read back. */
export function isMergeable(v: string | null | undefined): v is Mergeable {
  return isOneOf(MERGEABLE, v);
}

export interface BranchView {
  name: string;
  head: string;
  base: string | null;
  author: string | null;
  title: string | null;
  description: string | null;
  ahead: number | null;
  behind: number | null;
  mergeable: Mergeable;
  checks: Checks;
  state: "open" | "merged";
  merge_commit: string | null;
  merged_by: string | null;
  merged_at: string | null;
  merged_machine: string | null;
  merged_agent: string | null;
  forced: boolean | null;
  /** The credential (machine) that last pushed the branch. */
  pushed_machine: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** True when ahead, behind, base and mergeable are not yet for the current main and head. */
  stale: boolean;
  /** When stale: the last known mergeable answer (mergeable says "pending"). */
  last_mergeable: Mergeable | null;
  /** The paths changed differently on both sides, from the dry run behind mergeable (or last_mergeable while stale); null unless that answer is "conflicts". */
  conflict_paths: string[] | null;
  facts_at: string | null;
}

export interface BranchList {
  default_branch: string;
  default_head: string | null;
  branches: BranchView[];
  next_cursor: string | null;
  /** Stale branches past the grace period, for the caller to compute (facts.ts). */
  due: string[];
  /** A push Artifacts accepted was not recorded: the caller reads Artifacts' refs and calls reconcile (C2). */
  reconcile: boolean;
}

/** A dry run's answer: mergeable, and the paths that conflict when it is "conflicts" (else null). */
export interface DryRun {
  mergeable: Mergeable;
  conflict_paths: string[] | null;
}

const mergeableCache = new Map<string, DryRun>();

/** Thrown when main moved during a dry run: the facts would be for a main that is gone. */
export class MainMoved extends Error {
  constructor() {
    super("main moved while computing branch facts");
    this.name = "MainMoved";
  }
}

/**
 * "clean", "conflicts", "up_to_date" or "unknown", from a gitwrite dry run
 * (cached per isolate by main and head). The dry run walks the whole merge,
 * so on "conflicts" it has every conflicting path at no extra read.
 */
export async function mergeableOf(env: Env, r: RepoRecord, main: string, head: string, ahead: number | null): Promise<DryRun> {
  if (ahead === 0) return { mergeable: "up_to_date", conflict_paths: null };

  if (!gitwrite) return { mergeable: "unknown", conflict_paths: null };
  const key = `${r.artifacts_name}:${main}:${head}`;
  const hit = mergeableCache.get(key);

  if (hit) return hit;
  let v: DryRun = { mergeable: "unknown", conflict_paths: null };

  try {
    const out = await gitwrite.mergeCommit(
      { artifacts: timedArtifacts(env.ARTIFACTS), name: r.artifacts_name },
      { base: r.default_branch, head, baseSha: main, message: "dry run\n", author: { name: "Pando", email: "pando@pando.invalid" }, dryRun: true },
    );

    // main moved while we looked: the answer is for nothing; a newer computation is coming.
    if (out.status === "ref_moved") throw new MainMoved();

    if (out.status === "conflict") v = { mergeable: "conflicts", conflict_paths: out.paths };
    else v = { mergeable: out.status === "mergeable" ? "clean" : out.status === "up_to_date" ? "up_to_date" : "unknown", conflict_paths: null };
  } catch (err) {
    if (err instanceof MainMoved) throw err;
    v = { mergeable: "unknown", conflict_paths: null };
  }

  if (mergeableCache.size > 5000) mergeableCache.clear();

  if (v.mergeable !== "unknown") mergeableCache.set(key, v);

  return v;
}

export async function pool<T, U>(items: T[], n: number, fn: (t: T) => Promise<U>): Promise<U[]> {
  const out: U[] = [];
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

/** Pando's who-made-it trailers on a commit (formats.md, section 6); null when absent. */
export interface PandoTrailers {
  agent: string | null;
  worktree: string | null;
  machine: string | null;
}

/** Pando's who-made-it trailers (formats.md, section 6), from a commit message's last paragraph. */
export function pandoTrailers(message: string): PandoTrailers {
  const out: PandoTrailers = { agent: null, worktree: null, machine: null };
  const paragraphs = message.replace(/\r\n/g, "\n").trimEnd().split(/\n\s*\n/);
  const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1] : "";

  for (const line of last.split("\n")) {
    const m = line.match(/^Pando-(Agent|Worktree|Machine):\s*(.*?)\s*$/i);

    if (!m || !m[2]) continue;
    const k = m[1].toLowerCase();

    if (k === "agent" || k === "worktree" || k === "machine") out[k] = m[2];
  }

  return out;
}

/** `Co-authored-by: Name <email>` lines from a commit message's trailers (its last paragraph), as git and GitHub read them. */
export function coAuthors(message: string): { name: string; email: string | null }[] {
  const paragraphs = message.replace(/\r\n/g, "\n").trimEnd().split(/\n\s*\n/);

  if (paragraphs.length < 2) return [];
  const out: { name: string; email: string | null }[] = [];
  const seen = new Set<string>();

  for (const line of paragraphs[paragraphs.length - 1].split("\n")) {
    const m = line.match(/^co-authored-by:\s*(.*?)\s*(?:<([^<>]*)>)?\s*$/i);

    if (!m || !m[1]) continue;
    const key = (m[2] || m[1]).toLowerCase();

    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: m[1], email: m[2]?.trim() || null });
  }

  return out;
}

/** The most commits one call to a branch's commits returns. */
export const COMMITS_MAX = 250;
