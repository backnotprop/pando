// An issue's Agents block (the mocks accepted 2026-10-05): each agent that
// addressed it, newest first, with its leaf and state as the Agents tab says
// them, then who started it, the machine it acts as, and when. Live on the
// `agents` topic. Hidden while none has.
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { agentListQuery, agentsKey } from "../../../../api/agents";
import { fallback, useRows } from "../../../../live/rows";
import { Leaf } from "../../../../ui/Leaf";
import { ago, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { Link } from "@tanstack/react-router";
import { agentLink } from "../../../../ui/paths";
import { useMe } from "../-issues/parts";
import { Section } from "../-issues/Sidebar";
import { leafOf, StateWords } from "./parts";

export function IssueAgents({ issue }: { issue: number }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const clock = useNow();
  const me = useMe();
  const live = useRows(monorepo, ["agents"], () => void qc.invalidateQueries({ queryKey: agentsKey(monorepo) }));
  const list = useInfiniteQuery({ ...agentListQuery(monorepo, { issue }), refetchInterval: fallback(live) });
  const rows = list.data?.pages[0]?.sessions ?? [];

  if (!rows.length) return null;

  return (
    <Section title="Agents">
      {rows.map((s) => {
        const l = leafOf(s);

        return (
          <div key={s.number} data-agent={s.number} className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-x-2">
            <Leaf state={l.state} tone={l.tone} size={16} label={s.status} />
            <span className="flex flex-wrap items-baseline gap-x-1.5">
              <Link {...agentLink(monorepo.full, s.number)} className="font-semibold hover:underline">
              Agent #{s.number}
            </Link>
              <StateWords s={s} me={me} />
            </span>
            <span className="col-start-2 text-[12.5px] text-ash">
              {s.launched_by} on {s.machine} · started {ago(s.created_at, clock)}
            </span>
          </div>
        );
      })}
    </Section>
  );
}
