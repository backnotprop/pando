// A branch's one state, in words first (the prototype's order): merged,
// conflicts with main, a check failed, a check running, the required checks
// unknown, no check reported, then ready to merge.
import type { Branch } from "@pando/contract";

export type Tone = "ready" | "bad" | "wait" | "merged";

export interface BranchState {
  tone: Tone;
  text: string;
  /** The CI service that reported the check the state names (its mark), if one did. */
  app: string | null;
}

/** The mergeable answer to show: while facts are computed, the last known one. */
export const mergeableOf = (b: Branch) => (b.mergeable === "pending" ? (b.last_mergeable ?? "pending") : b.mergeable);

export function stateOf(b: Branch): BranchState {
  if (b.state === "merged") return { tone: "merged", text: "merged", app: null };

  const mergeable = mergeableOf(b);

  if (mergeable === "conflicts") return { tone: "bad", text: "conflicts with main", app: null };

  const failed = b.checks.statuses.find((s) => s.state === "failure" || s.state === "error");

  if (failed) return { tone: "bad", text: `${failed.context} failed`, app: failed.app };

  const running = b.checks.statuses.find((s) => s.state === "pending");

  if (running) return { tone: "wait", text: `${running.context} running`, app: running.app };

  // pando.toml unreadable or broken: only a forced merge goes through.
  if (b.checks.state === "unknown") return { tone: "wait", text: "checks unknown", app: null };

  if (b.checks.state === "missing") return { tone: "wait", text: "no ci yet", app: null };

  if (mergeable === "up_to_date") return { tone: "merged", text: "up to date", app: null };

  if (mergeable !== "clean") return { tone: "wait", text: "checking", app: null };

  return { tone: "ready", text: "ready to merge", app: null };
}

/** The state's colour in a list: ready in Bark, failures in Rust, waiting in Ash. */
export const toneClass: Record<Tone, string> = {
  ready: "font-semibold text-bark",
  bad: "font-semibold text-rust",
  wait: "text-ash",
  merged: "text-bark-dim",
};
