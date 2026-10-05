// The Agents tab (owner, 2026-10-04: "a new agents tab ... like github actions
// but focused on cloudflare agent"; the mocks accepted 2026-10-05): one box
// whose bar holds All, Working and Waiting with their counts, Started by and
// New agent; then a table, one row shape for every agent (owner, 2026-10-05):
// the agent, its branch (named for the change), its issue's number (its title
// and state on hover), who started it, its state in words and its last
// activity, newest first, and More. Rows come live on the `agents` topic.
import { type AgentSession, Login } from "@pando/contract";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { agentListQuery, agentsKey, type AgentFilters } from "../../../../api/agents";
import { membersQuery, reposQuery } from "../../../../api/queries";
import { fallback, useRows } from "../../../../live/rows";
import { Avatar } from "../../../../ui/Avatar";
import { button } from "../../../../ui/controls";
import { Caret } from "../../../../ui/dropdown";
import { Leaf } from "../../../../ui/Leaf";
import { type AgentsSearch, agentsLink, branchLink, issueLink } from "../../../../ui/paths";
import { Ref } from "../../../../ui/Ref";
import { ago, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { useMe } from "../-issues/parts";
import { Picker } from "../-issues/Picker";
import { NewAgent } from "./NewAgent";
import { leafOf, StateWords } from "./parts";

const filterButton =
  "inline-flex h-7 cursor-pointer items-center gap-[5px] rounded-md px-2 text-[13px] text-bark-dim hover:text-bark data-popup-open:bg-pop-hi data-popup-open:text-bark";

/** The address's filters, checked. */
export function filtersOf(s: AgentsSearch): AgentFilters {
  const f: AgentFilters = {};

  if (s.status === "working" || s.status === "waiting") f.status = s.status;

  const person = Option.getOrUndefined(Schema.decodeUnknownOption(Login)(s.person));

  if (person) f.person = person;

  if (s.kind === "task" || s.kind === "issue" || s.kind === "review") f.kind = s.kind;

  return f;
}

/**
 * The table's columns (owner, 2026-10-05): the leaf, the agent, its branch,
 * its issue's number, who started it, its state, its last activity. Each takes
 * its content's width (the branch at most 300 px), as the Sessions list does,
 * so no column leaves a wide blank; the last activity sits at the right.
 */
const TABLE = "grid grid-cols-[20px_auto_fit-content(300px)_auto_auto_auto_minmax(80px,1fr)] phone:grid-cols-[20px_minmax(0,1fr)_auto]";

/** A row: the table's columns, through subgrid. */
const ROW = "col-span-full grid grid-cols-subgrid items-center gap-x-6 px-4";

function Row({ s, full, repoPath, me }: { s: AgentSession; full: string; repoPath: string; me: string | null }) {
  const clock = useNow();
  const l = leafOf(s);

  return (
    <li data-agent={s.number} className={`${ROW} min-h-[46px] border-t border-rule-faint text-[13.5px] text-bark-dim phone:gap-x-3 phone:gap-y-0.5 phone:px-3 phone:py-2.5`}>
      <Leaf state={l.state} tone={l.tone} label={s.status} />
      <span className="font-semibold whitespace-nowrap text-bark">Agent #{s.number}</span>
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap phone:col-span-2 phone:col-start-2 phone:row-start-2">
        {s.branch ? (
          <Ref kind="object" link={branchLink(full, repoPath, s.branch)} mono className="font-mono text-[12.5px]">
            {s.branch}
          </Ref>
        ) : null}
      </span>
      <span className="phone:hidden" title={s.issue !== null && s.issue_title ? `#${s.issue} ${s.issue_title}${s.issue_state ? ` (${s.issue_state})` : ""}` : undefined}>
        {s.issue !== null ? (
          <Link {...issueLink(full, s.issue)} className="text-ash hover:text-bark">
            #{s.issue}
          </Link>
        ) : null}
      </span>
      <span className="flex min-w-0 items-center gap-[7px] text-bark phone:hidden">
        <Avatar name={s.launched_by} size={18} />
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{s.launched_by}</span>
      </span>
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap phone:col-start-2 phone:row-start-3">
        <StateWords s={s} me={me} />
      </span>
      <span className="text-right text-[12.5px] whitespace-nowrap text-ash phone:col-start-3 phone:row-start-1">{ago(s.updated_at, clock)}</span>
    </li>
  );
}

function StateTab({ on, search, count, children }: { on: boolean; search: AgentsSearch; count: number | undefined; children: ReactNode }) {
  const { monorepo } = useMonorepo();

  return (
    <Link {...agentsLink(monorepo.full, search)} aria-current={on ? "page" : undefined} className={`inline-flex items-baseline gap-[7px] ${on ? "font-semibold text-bark" : "text-ash hover:text-bark"}`}>
      {children}
      {count === undefined ? null : <span className="text-[12.5px] font-normal text-ash">{count}</span>}
    </Link>
  );
}

export function AgentsList({ search }: { search: AgentsSearch }) {
  const { monorepo } = useMonorepo();
  const full = monorepo.full;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const f = filtersOf(search);
  const [launching, setLaunching] = useState(false);
  const members = useQuery(membersQuery(monorepo)).data ?? [];
  const repos = useQuery(reposQuery(monorepo)).data ?? [];
  const paths = new Map<string, string>(repos.map((r) => [r.name, r.path]));
  const me = useMe();
  const live = useRows(monorepo, ["agents"], () => void qc.invalidateQueries({ queryKey: agentsKey(monorepo) }));
  const list = useInfiniteQuery({ ...agentListQuery(monorepo, f), refetchInterval: fallback(live) });
  const rows = list.data?.pages.flatMap((p) => p.sessions) ?? [];
  const counts = list.data?.pages[0]?.counts;
  // The other filters, kept when the state changes.
  const rest: AgentsSearch = {};

  if (search.person) rest.person = search.person;

  if (search.kind) rest.kind = search.kind;
  const go = (next: AgentsSearch) => void navigate(agentsLink(full, next));
  const people = members.map((p) => ({ id: p.login, text: p.login, node: (<><Avatar name={p.login} size={18} /><span className="text-bark">{p.login}</span></>) }));
  const filtered = Boolean(f.person || f.kind);

  return (
    <>
      <div className="rounded-[10px] border border-rootline">
        <div className="flex min-h-12 flex-wrap items-center gap-[18px] rounded-t-[10px] bg-loam py-2 pr-2 pl-4 text-[13.5px] phone:gap-3 phone:pl-3">
          <nav aria-label="State" className="flex items-center gap-[18px] phone:gap-3.5">
            <StateTab on={!f.status} search={rest} count={counts?.all}>
              All
            </StateTab>
            <StateTab on={f.status === "working"} search={{ ...rest, status: "working" }} count={counts?.working}>
              Working
            </StateTab>
            <StateTab on={f.status === "waiting"} search={{ ...rest, status: "waiting" }} count={counts?.waiting}>
              Waiting
            </StateTab>
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <span className="flex gap-1 phone:hidden">
              <Picker label="Started by" heading="Started by" trigger={<>Started by<Caret /></>} triggerClass={`${filterButton} ${f.person ? "bg-pop-hi text-bark" : ""}`} findAt={8} options={people} selected={f.person ? [f.person] : []} onDone={(v) => go({ ...search, person: v[0] === f.person ? undefined : v[0] })} />
            </span>
            <button type="button" className={`${button("solid", 30)} ml-2`} onClick={() => setLaunching(true)}>
              New agent
            </button>
          </div>
        </div>
        {rows.length ? (
          <div className={TABLE}>
            <div aria-hidden="true" className={`${ROW} h-[34px] border-t border-rule-faint text-[12px] text-ash phone:hidden`}>
              <span />
              <span>Agent</span>
              <span>Branch</span>
              <span>Issue</span>
              <span>Started by</span>
              <span>State</span>
              <span className="text-right">Last activity</span>
            </div>
            <ul aria-label="Agents" className="col-span-full grid grid-cols-subgrid">
              {rows.map((s) => (
                <Row key={s.number} s={s} full={full} repoPath={paths.get(s.repo) ?? "."} me={me} />
              ))}
            </ul>
          </div>
        ) : list.isSuccess ? (
          <div className="grid justify-items-center gap-3.5 border-t border-rule-faint px-4 pt-14 pb-[60px] text-center text-[14px] text-bark-dim">
            <Leaf state="idle" size={32} />
            <p>{filtered || f.status ? "No agents match." : "No agents have run in this repository."}</p>
          </div>
        ) : null}
      </div>
      {list.hasNextPage ? (
        <div className="flex justify-center pt-3.5">
          <button type="button" className={button("quiet")} disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            More
          </button>
        </div>
      ) : null}
      <NewAgent open={launching} onClose={() => setLaunching(false)} />
    </>
  );
}
