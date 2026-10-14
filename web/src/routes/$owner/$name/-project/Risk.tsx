// Risk-based review on a branch (docs/risk-review/DESIGN.md): the meter under
// the title ("High · human review required"), its badge in the branch list,
// the Review box beside the Merge box (the reviewer agents, why the merge
// waits, Approve) and the Guided review panel, which opens Plannotator's
// guide in the Artifacts tab. Workers AI's clef scores each head.
import type { Branch, BranchReview, Repo } from "@pando/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { approve } from "../../../../api/review";
import { repoKey, reviewsQuery } from "../../../../api/projects";
import { button, Refusal, SectionHead } from "../../../../ui/controls";
import { agentLink, branchArtifactsLink } from "../../../../ui/paths";
import { useMonorepo } from "../-frame/heads";

const LEVEL = { low: "Low", medium: "Medium", high: "High", unknown: "Risk unknown" } as const;

/** The level's colour: low quiet, medium plain, high and unknown in Rust. */
const TONE = { low: "text-bark-dim", medium: "text-bark", high: "text-rust", unknown: "text-rust" } as const;

/** What the tier asks for, in words. */
function pathWords(r: BranchReview): string {
  if (r.state === "classifying") return "scoring";

  if (r.tier === "auto") return "auto";

  if (r.approved_by) return `approved by ${r.approved_by}`;

  return r.tier === "ai" ? "AI review" : "human review required";
}

/** The reasons, one a line, for a hover. */
const reasonsOf = (r: BranchReview) => [...r.reasons, ...(r.cost_usd !== null ? [`Scored by ${r.model ?? "clef"} for $${r.cost_usd.toFixed(5)}`] : [])].join("\n");

/** The meter's bar: three bands, the score's mark on it. */
function Bar({ r }: { r: BranchReview }) {
  const at = r.score === null ? null : Math.round(r.score * 100);

  return (
    <span aria-hidden className="relative inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-rule-faint">
      <span className="h-full w-[35%] bg-rule-soft" />
      <span className="h-full w-[35%] bg-ash-half" />
      <span className="h-full w-[30%] bg-rust-half" />
      {at === null ? null : <span className="absolute top-0 h-full w-[3px] -translate-x-1/2 rounded-full bg-bark" style={{ left: `${at}%` }} />}
    </span>
  );
}

/** Under the title: "High · human review required", the score, the reasons on hover. */
export function RiskMeter({ b }: { b: Branch }) {
  const r = b.review;

  if (!r) return null;

  // Decided by rule, with no model call: comments, docs and blank lines are never flagged.
  if (r.rule) {
    return (
      <p className="mt-2 flex items-center gap-2.5 text-[13.5px]" title={reasonsOf(r)} aria-label="Risk: comments and docs only, auto" data-risk="low">
        <Bar r={r} />
        <span className="font-semibold text-bark-dim">Comments and docs only</span>
        <span className="text-bark-dim">· auto, no review</span>
      </p>
    );
  }

  return (
    <p className="mt-2 flex items-center gap-2.5 text-[13.5px]" title={reasonsOf(r)} aria-label={`Risk: ${LEVEL[r.level]}, ${pathWords(r)}`} data-risk={r.level}>
      <Bar r={r} />
      <span className={`font-semibold ${TONE[r.level]}`}>{r.state === "classifying" ? "Scoring risk" : LEVEL[r.level]}</span>
      {r.state === "classifying" ? null : <span className="text-bark-dim">· {pathWords(r)}</span>}
      {r.score === null ? null : <span className="font-mono text-[12.5px] text-ash">{r.score.toFixed(2)}</span>}
    </p>
  );
}

/** The branch list's badge: the level word, the reasons on hover. */
export function RiskBadge({ b }: { b: Branch }) {
  const r = b.review;

  if (!r || r.state === "classifying") return null;

  return (
    <span title={`${LEVEL[r.level]} · ${pathWords(r)}\n${reasonsOf(r)}`} className={`ml-2 rounded-[5px] border border-rule-faint px-1.5 text-[11.5px] leading-[17px] ${TONE[r.level]}`}>
      {r.level === "unknown" ? "Unknown" : LEVEL[r.level]}
    </span>
  );
}

const SAID = { running: "reviewing", failed: "did not review" } as const;

const VERDICT = { comment: "commented", request_changes: "asked for changes", approve: "approved" } as const;

/** Beside the Merge box: the reviewer agents, why the merge waits, and Approve. */
export function ReviewBox({ repo, b }: { repo: Repo; b: Branch }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const r = b.review;

  const ok = useMutation({
    mutationFn: () => approve(monorepo, repo.name, b.name, b.head),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: repoKey(monorepo, repo.name) });
      await qc.invalidateQueries({ queryKey: reviewsQuery(monorepo, repo.name, b.name).queryKey });
    },
  });

  if (!r || b.state === "merged" || r.tier === null || r.tier === "auto") return null;

  return (
    <div className="mt-10" aria-label="Risk review">
      <SectionHead title="Risk review" />
      {r.reviewers.length ? (
        <ul className="grid gap-1.5 text-[13px]">
          {r.reviewers.map((x) => (
            <li key={x.profile} className="flex items-baseline gap-2">
              <span className="text-bark">{x.label}</span>
              {x.session ? (
                <Link {...agentLink(monorepo.full, x.session)} className="text-ash hover:text-link">
                  #{x.session}
                </Link>
              ) : null}
              <span className={`ml-auto ${x.verdict === "request_changes" ? "text-rust" : "text-bark-dim"}`}>{x.verdict ? VERDICT[x.verdict] : SAID[x.state === "posted" ? "running" : x.state]}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {r.why ? <p className="mt-2.5 text-[13px] leading-[19px] text-bark-dim">{r.why[0]?.toUpperCase() + r.why.slice(1)}.</p> : null}
      {r.approved_by ? (
        <p className="mt-2.5 text-[13px] text-bark-dim">Approved by {r.approved_by}</p>
      ) : (
        <div className="mt-3.5">
          <button type="button" className={button(r.tier === "human" ? "solid" : "quiet")} disabled={ok.isPending} onClick={() => ok.mutate()}>
            Approve
          </button>
          <Refusal error={ok.error} />
        </div>
      )}
    </div>
  );
}

/** Over the commits, on the human tier: Plannotator's guided review, read first. */
export function GuidedReview({ repo, b }: { repo: Repo; b: Branch }) {
  const { monorepo } = useMonorepo();
  const r = b.review;

  if (!r || r.guide_state === "none") return null;

  return (
    <section className="mb-10 rounded-[10px] bg-loam px-5 py-[18px]" aria-label="Guided review">
      <SectionHead title="Guided review" className="mb-1.5" />
      {r.guide ? (
        <>
          <p className="text-[14px] text-bark">{r.guide.title ?? "Guided review"}</p>
          <p className="mt-1 text-[13px] text-bark-dim">Written by Pando when this head was scored, for whoever approves it: the changes in the order to read them, the risky parts first.</p>
          <Link {...branchArtifactsLink(monorepo.full, repo.path, b.name, { artifact: "guided-review.html" })} className="mt-3 inline-block text-[13.5px] text-link hover:underline">
            Open the guided review
          </Link>
        </>
      ) : (
        <p className="text-[13px] text-bark-dim">{r.guide_state === "writing" ? "Pando is writing the guided review of this head." : "The guided review could not be written for this head."}</p>
      )}
    </section>
  );
}
