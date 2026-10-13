// Risk-based review's rules, pure (docs/risk-review/DESIGN.md): which changed
// files are sensitive, a score's level and tier under a project's settings,
// and whether the merge gate's review part passes for a head.

import type * as Contract from "@pando/contract";
import { isNumber, isRecord, type Json } from "../parse";

type Tier = Contract.ReviewTier;

type Level = Contract.RiskLevel;

/**
 * A project's settings. `enabled` null: the server's default (RISK_REVIEW).
 * Defaults: below 0.35 the model put most of its weight on "low" (docs, tests,
 * small isolated changes); at 0.70 and above, most of it on "high" (auth,
 * payments, infra, deletions, large cross-cutting changes).
 */
export interface Settings {
  enabled: boolean | null;
  auto_below: number;
  human_above: number;
  human_for_sensitive: boolean;
}

export const DEFAULT_SETTINGS: Settings = { enabled: null, auto_below: 0.35, human_above: 0.7, human_for_sensitive: true };

/** Used when .pando/pando.toml names none (`[review] sensitive = [...]` replaces them). */
export const DEFAULT_SENSITIVE: readonly string[] = ["auth/", "payments/", "billing/", "infra/", ".github/", "migrations/", ".pando/", ".env", "secrets"];

/** Sensitive files named on a head (the rest are counted only). */
export const SENSITIVE_SHOWN = 20;

/**
 * Whether a path is under a pattern. A pattern ending in `/` is a folder
 * anywhere in the path (`auth/` matches `auth/x.ts` and `src/auth/x.ts`);
 * any other is a file name or the start of one (`.env` matches
 * `config/.env.local`). Case-sensitive, as git paths are.
 */
export function isSensitive(path: string, pattern: string): boolean {
  const p = pattern.replace(/^\/+/, "");

  if (!p) return false;

  if (p.endsWith("/")) return path.startsWith(p) || path.includes(`/${p}`);
  const name = path.slice(path.lastIndexOf("/") + 1);

  return p.includes("/") ? path === p || path.startsWith(`${p}/`) || path.includes(`/${p}`) : name.startsWith(p);
}

export function sensitiveOf(paths: readonly string[], patterns: readonly string[]): string[] {
  return paths.filter((f) => patterns.some((p) => isSensitive(f, p)));
}

/** The level a score's band names: below auto_below low, at human_above or more high, else medium. */
export function levelOf(score: number | null, s: Settings): Level {
  if (score === null) return "unknown";

  return score < s.auto_below ? "low" : score >= s.human_above ? "high" : "medium";
}

/** The tier: unknown and sensitive (when set) are human; else the score's band. Never auto on unknown. */
export function tierOf(score: number | null, sensitive: number, s: Settings): Tier {
  if (score === null) return "human";

  if (sensitive > 0 && s.human_for_sensitive) return "human";

  return score < s.auto_below ? "auto" : score >= s.human_above ? "human" : "ai";
}

/** A settings change as sent (PATCH .../repos/{repo} {review}): the new settings, or what is wrong. */
export function settingsPatch(v: Json | undefined, now: Settings): { ok: true; settings: Settings } | { ok: false; why: string } {
  if (!isRecord(v)) return { ok: false, why: "review: an object {enabled, auto_below, human_above, human_for_sensitive}" };
  const out = { ...now };
  const flag = (x: Json | undefined): x is boolean => x === true || x === false;

  for (const k of Object.keys(v)) {
    if (!["enabled", "auto_below", "human_above", "human_for_sensitive"].includes(k)) return { ok: false, why: `review.${k}: not a setting` };
  }

  if (v.enabled !== undefined) {
    if (!flag(v.enabled)) return { ok: false, why: "review.enabled: true or false" };
    out.enabled = v.enabled;
  }

  for (const k of ["auto_below", "human_above"] as const) {
    const n = v[k];

    if (n === undefined) continue;

    if (!isNumber(n) || n < 0 || n > 1) return { ok: false, why: `review.${k}: a number from 0 to 1` };
    out[k] = Math.round(n * 100) / 100;
  }

  if (v.human_for_sensitive !== undefined) {
    if (!flag(v.human_for_sensitive)) return { ok: false, why: "review.human_for_sensitive: true or false" };
    out.human_for_sensitive = v.human_for_sensitive;
  }

  if (out.auto_below > out.human_above) return { ok: false, why: "review.auto_below must not be above review.human_above" };

  return { ok: true, settings: out };
}

/** A launched reviewer as the gate sees it. */
export interface ReviewerState {
  label: string;
  state: Contract.Reviewer["state"];
  verdict: Contract.Reviewer["verdict"];
}

/** What the gate reads for a head. */
export interface GateInput {
  /** null: not classified yet. */
  tier: Tier | null;
  reviewers: readonly ReviewerState[];
  /** A person's approval on this head (not an agent session's). */
  approvedBy: string | null;
}

/** The review part of the merge gate: whether it passes, and why not in plain words. */
export interface GateAnswer {
  passes: boolean;
  why: string | null;
}

export function gateOf(g: GateInput): GateAnswer {
  if (g.approvedBy) return { passes: true, why: null };

  if (g.tier === null) return { passes: false, why: "the risk score is still being worked out" };

  if (g.tier === "auto") return { passes: true, why: null };

  if (g.tier === "human") return { passes: false, why: "a person's approval is needed on this head" };

  const asked = g.reviewers.filter((r) => r.verdict === "request_changes");

  if (asked.length) return { passes: false, why: `${asked.map((r) => r.label).join(" and ")} asked for changes; push a fix, or a person approves` };
  const failed = g.reviewers.filter((r) => r.state === "failed");

  if (failed.length || !g.reviewers.length) return { passes: false, why: `${failed.length ? failed.map((r) => r.label).join(" and ") : "the reviewer agents"} did not review; a person approves instead` };
  const waiting = g.reviewers.filter((r) => r.state === "running");

  if (waiting.length) return { passes: false, why: `waiting for the ${waiting.map((r) => r.label).join(" and ")} review${waiting.length > 1 ? "s" : ""}` };

  return { passes: true, why: null };
}
