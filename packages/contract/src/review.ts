// Risk-based review (docs/risk-review/DESIGN.md): each branch head's risk,
// from Workers AI's clef model, the review tier it calls for, the reviewer
// agents that ran, the guided review, and whether the merge gate passes.
import * as Schema from "effect/Schema";

import { ReviewVerdict } from "./feed.ts";
import { Count, Login, Sha, Timestamp } from "./ids.ts";

/** The score's band (`unknown`: clef failed or has not answered in time). */
export const RiskLevel = Schema.Literals(["low", "medium", "high", "unknown"]);

export type RiskLevel = typeof RiskLevel.Type;

/** auto: green checks merge. ai: reviewer agents first. human: a person's approval. */
export const ReviewTier = Schema.Literals(["auto", "ai", "human"]);

export type ReviewTier = typeof ReviewTier.Type;

/** A project's risk-based review settings (owners change them: PATCH .../repos/{repo} {review: {...}}). */
export const ReviewSettings = Schema.Struct({
  /** Off: no score, no reviewers, the merge gate is checks alone. */
  enabled: Schema.Boolean,
  /** A score below this merges on green checks (0 to 1). */
  auto_below: Schema.Number,
  /** A score at or above this needs a person's approval (0 to 1). Between the two: reviewer agents. */
  human_above: Schema.Number,
  /** A change under a sensitive path always needs a person. */
  human_for_sensitive: Schema.Boolean,
  /** The sensitive paths: `[review] sensitive` in .pando/pando.toml on main as the last scored push read it, else the defaults. Read only. */
  sensitive: Schema.Array(Schema.String),
});

export interface ReviewSettings extends Schema.Schema.Type<typeof ReviewSettings> {}

/** One reviewer agent launched for the head: a profile (correctness, security, ...) run as a review session. */
export const Reviewer = Schema.Struct({
  profile: Schema.String,
  /** What people read: "Correctness". */
  label: Schema.String,
  /** The agent session; null when it could not be launched. */
  session: Schema.NullOr(Count),
  /** running: no review yet. posted: its review is on this head. failed: it did not start, or ended without a review. */
  state: Schema.Literals(["running", "posted", "failed"]),
  verdict: Schema.NullOr(ReviewVerdict),
});

export interface Reviewer extends Schema.Schema.Type<typeof Reviewer> {}

/** The guided review written for a human-tier head: an artifact on the branch. */
export const GuideState = Schema.Literals(["none", "writing", "ready", "failed"]);

/** A branch head's risk and review state. */
export const BranchReview = Schema.Struct({
  head: Sha,
  /** classifying: clef has not answered yet (the merge answers 412 risk_pending). */
  state: Schema.Literals(["classifying", "done"]),
  /** 0 (low) to 1 (high): clef's probability-weighted level; null when unknown. */
  score: Schema.NullOr(Schema.Number),
  level: RiskLevel,
  /** comments_and_docs: only comments, docs and blank lines changed, so it is auto by rule, with no model call (never flagged). */
  rule: Schema.NullOr(Schema.Literals(["comments_and_docs"])),
  tier: Schema.NullOr(ReviewTier),
  /** Plain words, most telling first: sensitive paths, deletions, size, the model's answers. */
  reasons: Schema.Array(Schema.String),
  /** Changed files under a sensitive path (at most 20). */
  sensitive_paths: Schema.Array(Schema.String),
  /** The model that scored it, its input tokens and their cost in US dollars; null before or when it failed. */
  model: Schema.NullOr(Schema.String),
  tokens: Schema.NullOr(Count),
  cost_usd: Schema.NullOr(Schema.Number),
  /** Why the risk is unknown; null otherwise. */
  error: Schema.NullOr(Schema.String),
  reviewers: Schema.Array(Reviewer),
  guide_state: GuideState,
  /** The guided review's artifact (open it at its id); null until written. */
  guide: Schema.NullOr(Schema.Struct({ artifact: Schema.String, version: Count, title: Schema.NullOr(Schema.String) })),
  /** The person whose approval on this head lets it merge; null until one approves. */
  approved_by: Schema.NullOr(Login),
  /** Whether the merge gate's review part passes now (checks are separate). */
  passes: Schema.Boolean,
  /** When it does not pass: why, in plain words. */
  why: Schema.NullOr(Schema.String),
  classified_at: Schema.NullOr(Timestamp),
});

export interface BranchReview extends Schema.Schema.Type<typeof BranchReview> {}
