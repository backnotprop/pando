// Review with agent on a branch (REPORT.md c): the button by the branch's
// Reviews, its dialog (words to add, optional, and the model), and the review
// agents at work on the branch. The agent reads the branch and its diff, may
// run its tests in a sandbox, and posts one review through Pando's route as
// the person (comment or request changes, never approve), which lands in the
// Reviews list below like any other; the list is read again when a run ends.
import type { Repo } from "@pando/contract";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { agentListQuery, agentsKey, reviewBranch } from "../../../../api/agents";
import { reviewsQuery } from "../../../../api/projects";
import { fallback, useRows } from "../../../../live/rows";
import { button } from "../../../../ui/controls";
import { Leaf } from "../../../../ui/Leaf";
import { ago, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { Link } from "@tanstack/react-router";
import { agentLink } from "../../../../ui/paths";
import { useMe } from "../-issues/parts";
import { AgentDialog, fieldLabel, ModelField, useModel } from "./Dialog";
import { leafOf, StateWords } from "./parts";

export function ReviewWithAgent({ repo, branch }: { repo: Repo; branch: string }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const pick = useModel(open);
  const [prompt, setPrompt] = useState("");

  const start = useMutation({
    mutationFn: () => reviewBranch(monorepo, { branch, repo: repo.name, model: pick.model ?? "", prompt: prompt.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentsKey(monorepo) });
      setPrompt("");
      setOpen(false);
    },
  });

  return (
    <>
      <button type="button" className={`${button("quiet", 28)} gap-2`} onClick={() => setOpen(true)}>
        <Leaf state="idle" size={14} />
        Review with agent
      </button>
      <AgentDialog
        open={open}
        onClose={() => setOpen(false)}
        title={
          <>
            Review with agent <code className="font-mono text-[14px] font-normal text-ash">{branch}</code>
          </>
        }
        ready={Boolean(pick.model && !start.isPending)}
        error={start.error}
        onStart={() => start.mutate()}
      >
        <p className="text-[13px] text-bark-dim">It reads the branch and its diff, may run its tests, and posts one review as you: a comment or changes requested, never an approval.</p>
        <label className={fieldLabel}>
          <span className="font-semibold text-bark">
            Add <i className="font-normal text-ash">optional</i>
          </span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What to look at closely"
            rows={3}
            className="resize-y rounded-lg border border-rootline bg-air px-3 py-2.5 text-[14px] leading-[21px] text-bark placeholder:text-ash focus:border-ash focus:outline-none"
          />
        </label>
        <ModelField pick={pick} />
      </AgentDialog>
    </>
  );
}

/** The review agents on the branch still at work, live; when one finishes, its review is read. */
export function ReviewAgents({ repo, branch }: { repo: Repo; branch: string }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const clock = useNow();
  const me = useMe();
  const live = useRows(monorepo, ["agents"], () => void qc.invalidateQueries({ queryKey: agentsKey(monorepo) }));
  const list = useInfiniteQuery({ ...agentListQuery(monorepo, { repo: repo.name, branch, kind: "review", status: "working" }), refetchInterval: fallback(live) });
  const rows = list.data?.pages[0]?.sessions ?? [];
  const working = rows.length;
  const before = useRef(working);

  useEffect(() => {
    if (working < before.current) void qc.invalidateQueries({ queryKey: reviewsQuery(monorepo, repo.name, branch).queryKey });
    before.current = working;
  }, [working, qc, monorepo, repo.name, branch]);

  if (!rows.length) return null;

  return (
    <ul aria-label="Review agents" className="mb-2">
      {rows.map((s) => {
        const l = leafOf(s);

        return (
          <li key={s.number} data-agent={s.number} className="flex min-h-10 items-center gap-2 border-b border-rule-faint text-[13.5px]">
            <Leaf state={l.state} tone={l.tone} size={16} label={s.status} />
            <Link {...agentLink(monorepo.full, s.number)} className="font-semibold hover:underline">
              Agent #{s.number}
            </Link>
            <StateWords s={s} me={me} />
            <span className="ml-auto text-[12.5px] text-ash">
              {s.launched_by} on {s.machine} · started {ago(s.created_at, clock)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
