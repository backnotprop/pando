// What an agent's row shows wherever it appears (the Agents tab, an issue's
// Agents block): its leaf and its state in words.
import type { AgentSession } from "@pando/contract";
import type { LeafState } from "../../../../ui/Leaf";

/** How a row's leaf looks. */
interface LeafLook {
  state: LeafState;
  tone?: "quiet" | "rust";
}

/** The leaf for a row: its state, and its tone when it ended without merging. */
export function leafOf(s: AgentSession): LeafLook {
  if (s.status === "working") return { state: "working" };

  if (s.status === "failed") return { state: "idle", tone: "rust" };

  if (s.status === "stopped") return { state: "idle", tone: "quiet" };

  if (s.branch_facts?.state === "merged") return { state: "done" };

  return s.awaiting_checks ? { state: "idle" } : { state: "needs" };
}

/** The state in words: only what Pando knows (its status, its merge, the checks it waits for). */
export function StateWords({ s, me }: { s: AgentSession; me: string | null }) {
  if (s.status === "working") return <span className="text-bark">Working</span>;

  if (s.status === "failed") return <span className="text-rust" title={s.reason ?? undefined}>Failed</span>;

  if (s.status === "stopped") return <span className="text-bark-dim">{s.reason ? `${s.reason.charAt(0).toUpperCase()}${s.reason.slice(1)}` : "Stopped"}</span>;

  if (s.branch_facts?.state === "merged") return <span className="text-bark">Merged into main</span>;

  if (s.awaiting_checks) return <span className="text-bark">Waiting for checks</span>;

  return <span className="text-bark">Waiting for {s.launched_by === me ? "you" : s.launched_by}</span>;
}
