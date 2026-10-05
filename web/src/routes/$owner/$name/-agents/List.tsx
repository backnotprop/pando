// The Agents tab (owner, 2026-10-04: "a new agents tab ... like github actions
// but focused on cloudflare agent"; the mocks accepted 2026-10-05): one box
// whose bar holds All, Working and Waiting with their counts, the Person and
// Started-from menus and New agent; then a row per agent, newest first, and
// More. Each row is only what is recorded: its number, what started it (an
// issue by its own title, or a task), its branch, who started it and the
// machine it acts as, its state in words, and its branch's facts now. Rows
// come live on the `agents` topic.
import { type AgentSession, Login } from "@pando/contract";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { agentListQuery, agentsKey, type AgentFilters, checksWords } from "../../../../api/agents";
import { membersQuery } from "../../../../api/queries";
import { fallback, useRows } from "../../../../live/rows";
import { Avatar } from "../../../../ui/Avatar";
import { button } from "../../../../ui/controls";
import { Caret } from "../../../../ui/dropdown";
import { Leaf, type LeafState } from "../../../../ui/Leaf";
import { type AgentsSearch, agentsLink, issueLink } from "../../../../ui/paths";
import { Ref } from "../../../../ui/Ref";
import { ago, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { type PickOption, Picker } from "../-issues/Picker";
import { NewAgent } from "./NewAgent";

const filterButton =
  "inline-flex h-7 cursor-pointer items-center gap-[5px] rounded-md px-2 text-[13px] text-bark-dim hover:text-bark data-popup-open:bg-pop-hi data-popup-open:text-bark";

const KINDS: readonly PickOption[] = [
  { id: "issue", text: "An issue" },
  { id: "task", text: "A task" },
  { id: "review", text: "A branch to review" },
];

/** The address's filters, checked. */
export function filtersOf(s: AgentsSearch): AgentFilters {
  const f: AgentFilters = {};

  if (s.status === "working" || s.status === "waiting") f.status = s.status;

  const person = Option.getOrUndefined(Schema.decodeUnknownOption(Login)(s.person));

  if (person) f.person = person;

  if (s.kind === "task" || s.kind === "issue" || s.kind === "review") f.kind = s.kind;

  return f;
}

/** How a row's leaf looks. */
interface LeafLook {
  state: LeafState;
  tone?: "quiet" | "rust";
}

/** The leaf for a row: its state, and its tone when it ended without merging. */
function leafOf(s: AgentSession): LeafLook {
  if (s.status === "working") return { state: "working" };

  if (s.status === "failed") return { state: "idle", tone: "rust" };

  if (s.status === "stopped") return { state: "idle", tone: "quiet" };

  if (s.branch_facts?.state === "merged") return { state: "done" };

  return s.awaiting_checks ? { state: "idle" } : { state: "needs" };
}

/** The second line: the state in words, then the branch as Pando knows it now. */
function StateLine({ s, clock }: { s: AgentSession; clock: number }) {
  const parts: ReactNode[] = [];
  const f = s.branch_facts;

  if (s.status === "working") parts.push(<span key="s" className="text-bark">Working</span>);
  else if (s.status === "failed") parts.push(<span key="s" className="text-rust">Failed{s.reason ? `: ${s.reason}` : ""}</span>);
  else if (s.status === "stopped") parts.push(<span key="s" className="text-bark">{s.reason ? `${s.reason.charAt(0).toUpperCase()}${s.reason.slice(1)}` : "Stopped"}</span>);
  else if (f?.state === "merged") parts.push(<span key="s" className="text-bark">Merged into main</span>);
  else if (s.awaiting_checks) parts.push(<span key="s" className="text-bark">Waiting for checks</span>, "merges when they pass");
  else parts.push(<span key="s" className="text-bark">Waiting for {s.launched_by}</span>);

  if (!f) parts.push("No branch yet");
  else if (f.state === "merged") parts.push(f.merged_at ? ago(f.merged_at, clock) : "merged");
  else {
    if (!f.stale && f.ahead !== null) parts.push(`${f.ahead} commit${f.ahead === 1 ? "" : "s"} ahead of main`);

    if (checksWords(f.checks)) parts.push(checksWords(f.checks));
  }

  return (
    <p className="mt-1 min-w-0 overflow-hidden text-[13px] text-ellipsis whitespace-nowrap text-ash phone:whitespace-normal">
      {parts.flatMap((p, i) => (i ? [" · ", p] : [p]))}
    </p>
  );
}

function Row({ s, full }: { s: AgentSession; full: string }) {
  const clock = useNow();
  const l = leafOf(s);

  return (
    <li data-agent={s.number} className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-baseline gap-x-3 border-t border-rule-faint px-4 py-3 first:border-t-0 phone:grid-cols-[22px_minmax(0,1fr)] phone:px-3">
      <span className="self-start pt-0.5">
        <Leaf state={l.state} tone={l.tone} label={s.status} />
      </span>
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[14px] leading-[21px] text-bark-dim">
        <span className="text-ash">#{s.number}</span>
        {s.kind === "issue" && s.issue !== null ? (
          <>
            <span className="font-semibold text-bark">
              Issue{" "}
              <Ref kind="object" link={issueLink(full, s.issue)}>
                #{s.issue}
              </Ref>
            </span>
            {s.issue_title ? <span>{s.issue_title}</span> : null}
          </>
        ) : (
          <span className="font-semibold text-bark">{s.kind === "review" ? "Review" : "Task"}</span>
        )}
        <span aria-hidden="true">·</span>
        <code className="font-mono text-[13px] break-all text-link">{s.branch}</code>
        <span aria-hidden="true">·</span>
        <Avatar name={s.launched_by} size={16} />
        <span className="font-semibold text-bark">{s.launched_by}</span>
        <span className="text-[12.5px]">on {s.machine}</span>
      </p>
      <span className="text-right text-[12.5px] whitespace-nowrap text-ash phone:col-start-2 phone:text-left">{s.status === "working" ? `started ${ago(s.created_at, clock)}` : ago(s.updated_at, clock)}</span>
      <div className="col-start-2 col-end-4 min-w-0 phone:col-end-3">
        <StateLine s={s} clock={clock} />
      </div>
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
              <Picker label="Person" heading="Started by" trigger={<>Person<Caret /></>} triggerClass={`${filterButton} ${f.person ? "bg-pop-hi text-bark" : ""}`} findAt={8} options={people} selected={f.person ? [f.person] : []} onDone={(v) => go({ ...search, person: v[0] === f.person ? undefined : v[0] })} />
              <Picker label="Started from" heading="Started from" trigger={<>Started from<Caret /></>} triggerClass={`${filterButton} ${f.kind ? "bg-pop-hi text-bark" : ""}`} options={KINDS} selected={f.kind ? [f.kind] : []} onDone={(v) => go({ ...search, kind: v[0] === f.kind ? undefined : v[0] })} />
            </span>
            <button type="button" className={`${button("solid", 30)} ml-2`} onClick={() => setLaunching(true)}>
              New agent
            </button>
          </div>
        </div>
        {rows.length ? (
          <ul aria-label="Agents">
            {rows.map((s) => (
              <Row key={s.number} s={s} full={full} />
            ))}
          </ul>
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
