// "Risk-based review", owners only (docs/risk-review/DESIGN.md): per project,
// the switch, the two thresholds (below the first a branch merges on green
// checks; between them reviewer agents review it; at the second or above a
// person approves), whether a sensitive path always asks a person, and the
// sensitive paths as pando.toml names them.
import type { Repo } from "@pando/contract";
import { useMutation, useQueries, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { repoQuery } from "../../../../api/releases";
import { reposQuery } from "../../../../api/queries";
import { setRepoReview } from "../../../../api/review";
import type { JsonBody } from "../../../../api/json";
import { button, field, Refusal } from "../../../../ui/controls";
import { useMonorepo } from "../-frame/heads";
import { Toggle } from "./mirror-parts";

const TITLE = "Risk-based review";

const WHAT = "Workers AI scores each branch head. Low risk merges on green checks, medium gets reviewer agents, high needs a person's approval and comes with a guided review.";

function Project({ repo, review }: { repo: Repo; review: NonNullable<Repo["review"]> }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const [auto, setAuto] = useState(String(review.auto_below));
  const [human, setHuman] = useState(String(review.human_above));

  const save = useMutation({
    mutationFn: (patch: JsonBody) => setRepoReview(monorepo, repo.name, patch),
    onSuccess: (saved) => qc.setQueryData(repoQuery(monorepo, repo.name).queryKey, saved),
  });

  const changed = Number(auto) !== review.auto_below || Number(human) !== review.human_above;
  const id = `risk-${repo.name}`;

  return (
    <li className="border-b border-rule-faint py-3" aria-label={`${TITLE} for ${repo.path}`}>
      <div className="flex min-h-[30px] items-center gap-3.5 text-[14px]">
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-bark">{repo.path === "." ? monorepo.full : repo.path}</span>
        <span className="ml-auto text-[13px] whitespace-nowrap text-ash">{review.enabled ? "On" : "Off"}</span>
        <Toggle label={`${TITLE} for ${repo.path}`} checked={save.isPending && save.variables?.enabled !== undefined ? save.variables.enabled === true : review.enabled} disabled={save.isPending} onChange={(v) => save.mutate({ enabled: v })} />
      </div>
      {review.enabled ? (
        <div className="mt-2.5 grid gap-2.5 text-[13px] text-bark-dim">
          <span className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${id}-auto`}>Merges on green checks below</label>
            <input id={`${id}-auto`} className={`${field} w-[72px]`} inputMode="decimal" value={auto} onChange={(e) => setAuto(e.target.value)} />
            <label htmlFor={`${id}-human`}>; a person approves at</label>
            <input id={`${id}-human`} className={`${field} w-[72px]`} inputMode="decimal" value={human} onChange={(e) => setHuman(e.target.value)} />
            <span>or above. Between: reviewer agents.</span>
            {changed ? (
              <button type="button" className={button("quiet", 28)} disabled={save.isPending} onClick={() => save.mutate({ auto_below: Number(auto), human_above: Number(human) })}>
                Save
              </button>
            ) : null}
          </span>
          <span className="flex items-center gap-2.5">
            <Toggle size="sm" label="A sensitive path always asks a person" checked={review.human_for_sensitive} disabled={save.isPending} onChange={(v) => save.mutate({ human_for_sensitive: v })} />
            A change under a sensitive path always asks a person
          </span>
          <span className="text-ash">
            Sensitive paths: <code className="text-[12.5px]">{review.sensitive.join(", ")}</code>. Set them with <code className="text-[12.5px]">[review] sensitive = [...]</code> in .pando/pando.toml on main.
          </span>
        </div>
      ) : null}
      <Refusal error={save.error} />
    </li>
  );
}

export function RiskReviewSettings() {
  const { monorepo } = useMonorepo();
  const repos = useSuspenseQuery(reposQuery(monorepo)).data;
  const read = useQueries({ queries: repos.map((r) => repoQuery(monorepo, r.name)) }).map((q) => q.data);

  if (!repos.length) return null;

  return (
    <section className="mt-11">
      <h2 className="mb-1.5 text-[14px] leading-5 font-semibold">{TITLE}</h2>
      <p className="text-[13.5px] text-bark-dim">{WHAT}</p>
      <ul aria-label={TITLE} className="mt-3.5 border-t border-rule-faint">
        {repos.map((r, i) => {
          const review = read[i]?.review;

          return review ? <Project key={`${r.name}:${review.auto_below}:${review.human_above}`} repo={r} review={review} /> : null;
        })}
      </ul>
    </section>
  );
}
