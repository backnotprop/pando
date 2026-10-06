// A repository's Sessions tab (owner, 2026-10-05): one box whose quiet bar holds Active and Inactive with their
// counts, the filters (Person, Agent, Branch, Reached main), Group (Day or Branch) and "Latest activity"; then one line
// per session under day headers, latest activity first, or grouped by branch. No search box, no titles. Every member
// sees every session; rows come live on the `sessions` topic.
import type { RepoName, Routes, Session } from "@pando/contract";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { branchQuery } from "../../../../api/projects";
import { membersQuery, reposQuery } from "../../../../api/queries";
import { sessionListQuery, sessionsKey } from "../../../../api/sessions";
import { fallback, useRows } from "../../../../live/rows";
import { AgentMark, PROGRAM_NAME, type Program } from "../../../../ui/AgentMark";
import { Avatar } from "../../../../ui/Avatar";
import { button } from "../../../../ui/controls";
import { Caret } from "../../../../ui/dropdown";
import { type SessionsSearch, sessionsLink } from "../../../../ui/paths";
import { useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { Picker } from "../-issues/Picker";
import { byDay, GroupHead, Person, type RowWhere, SessionRow, sessionTable } from "./Row";

const filterButton =
  "inline-flex h-7 cursor-pointer items-center gap-[5px] rounded-md px-2 text-[13px] text-bark-dim hover:text-bark data-popup-open:bg-pop-hi data-popup-open:text-bark";

const PROGRAMS: Program[] = ["claude-code", "codex", "pi", "opencode"];

/** Rows a branch group shows before "N more". */
const GROUP_ROWS = 3;

/** The address's filters, as the list route takes them. */
export function filtersOf(s: SessionsSearch): Routes.SessionFilters {
  const f: Routes.SessionFilters = {};

  if (s.state === "active" || s.state === "inactive") f.state = s.state;

  if (s.person) f.person = s.person;

  if (s.agent && PROGRAMS.some((p) => p === s.agent)) f.agent = s.agent;

  const colon = s.branch?.indexOf(":") ?? -1;

  if (s.branch && colon > 0) {
    f.repo = s.branch.slice(0, colon);
    f.branch = s.branch.slice(colon + 1);
  }

  if (s.main === "yes" || s.main === "no") f.main = s.main;

  return f;
}

function StateLink({ on, search, count, dot, children }: { on: boolean; search: SessionsSearch; count: number | undefined; dot: "on" | "off"; children: ReactNode }) {
  const { monorepo } = useMonorepo();

  return (
    <Link {...sessionsLink(monorepo.full, search)} aria-current={on ? "page" : undefined} className={`inline-flex items-center gap-[7px] ${on ? "font-semibold text-bark" : "text-bark-dim hover:text-bark"}`}>
      <span aria-hidden="true" className={`inline-block size-[9px] rounded-full border-2 ${dot === "on" ? "border-bark-dim bg-bark" : "border-ash"}`} />
      {count === undefined ? null : <span className="tabular-nums">{count.toLocaleString("en-US")}</span>}
      {children}
    </Link>
  );
}

/** A branch's state in one word, from its page. */
function BranchWord({ repo, branch }: { repo: RepoName; branch: string }) {
  const { monorepo } = useMonorepo();
  const b = useQuery(branchQuery(monorepo, repo, branch)).data;

  return b ? <span className="text-ash">{b.state === "merged" ? "merged" : "open"}</span> : null;
}

/** A branch group's head: the branch, its state in one word, and its sessions here. */
function BranchHead({ s, count }: { s: Session; count: number }) {
  const { repo, branch } = s.lead;

  return (
    <GroupHead title={branch ? <span className="font-mono text-[13px] font-normal text-link">{branch}</span> : "repository folder"} count={`${count} session${count === 1 ? "" : "s"}`}>
      {repo && branch ? <BranchWord repo={repo} branch={branch} /> : null}
    </GroupHead>
  );
}

export function SessionsList({ search }: { search: SessionsSearch }) {
  const { monorepo } = useMonorepo();
  const full = monorepo.full;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const clock = useNow();
  const f = filtersOf(search);
  const members = useQuery(membersQuery(monorepo)).data ?? [];
  const repos = useQuery(reposQuery(monorepo)).data ?? [];
  const at: RowWhere = { full, paths: new Map(repos.map((r) => [r.name, r.path])) };
  const live = useRows(monorepo, ["sessions"], () => void qc.invalidateQueries({ queryKey: sessionsKey(monorepo) }));
  const list = useInfiniteQuery({ ...sessionListQuery(monorepo, f), refetchInterval: fallback(live) });
  const rows = list.data?.pages.flatMap((p) => p.sessions) ?? [];
  const counts = list.data?.pages[0]?.counts;
  const go = (next: SessionsSearch) => void navigate(sessionsLink(full, next));

  const set = (key: keyof SessionsSearch, value: string | undefined) => {
    const next: SessionsSearch = { ...search };

    if (value === undefined || search[key] === value) delete next[key];
    else next[key] = value;
    go(next);
  };

  const rest: SessionsSearch = { ...search };

  delete rest.state;
  const people = members.map((p) => ({ id: p.login, text: p.login, node: (<><Avatar name={p.login} size={18} /><span className="text-bark">{p.login}</span></>) }));
  const agents = PROGRAMS.map((p) => ({ id: p, text: PROGRAM_NAME[p], node: (<><AgentMark program={p} /><span className="text-bark">{PROGRAM_NAME[p]}</span></>) }));
  // Branches from the sessions on screen, and the one chosen: `<repo>:<branch>`.
  const leads = new Map<string, string>();

  for (const s of rows) if (s.lead.repo && s.lead.branch) leads.set(`${s.lead.repo}:${s.lead.branch}`, s.lead.branch);

  if (search.branch) leads.set(search.branch, search.branch.slice(search.branch.indexOf(":") + 1));
  const branches = [...leads].map(([id, name]) => ({ id, text: name, node: <span className="font-mono text-[13px] text-bark">{name}</span> }));

  const mains = [
    { id: "yes", text: "Reached main" },
    { id: "no", text: "Not on main" },
  ];

  const groups = [
    { id: "day", text: "Day" },
    { id: "branch", text: "Branch" },
  ];

  const byBranch = search.group === "branch";
  const filtered = Boolean(f.person || f.agent || f.branch || f.main);
  const caret = <Caret />;
  const picked = (on: boolean) => `${filterButton} ${on ? "bg-pop-hi text-bark" : ""}`;

  const grouped = byBranch
    ? [...rows.reduce((m, s) => m.set(`${s.lead.repo ?? ""}:${s.lead.branch ?? ""}`, [...(m.get(`${s.lead.repo ?? ""}:${s.lead.branch ?? ""}`) ?? []), s]), new Map<string, Session[]>())]
    : [];

  return (
    <>
      <div className="flex min-h-12 flex-wrap items-center gap-x-[18px] gap-y-1.5 border-b border-rule-faint pb-3 text-[13.5px]">
        <nav aria-label="State" className="flex items-center gap-[18px]">
          <StateLink on={f.state === "active"} search={f.state === "active" ? rest : { ...rest, state: "active" }} count={counts?.active} dot="on">
            Active
          </StateLink>
          <StateLink on={f.state === "inactive"} search={f.state === "inactive" ? rest : { ...rest, state: "inactive" }} count={counts?.inactive} dot="off">
            Inactive
          </StateLink>
        </nav>
        <span className="flex flex-wrap items-center gap-1">
          <Picker label="Person" heading="Person" trigger={<>Person{caret}</>} triggerClass={picked(Boolean(f.person))} findAt={8} options={people} selected={f.person ? [f.person] : []} onDone={(v) => set("person", v[0])} />
          <Picker label="Agent" heading="Agent" trigger={<>Agent{caret}</>} triggerClass={picked(Boolean(f.agent))} findAt={99} options={agents} selected={f.agent ? [f.agent] : []} onDone={(v) => set("agent", v[0])} />
          <Picker label="Branch" heading="Branch" trigger={<>Branch{caret}</>} triggerClass={picked(Boolean(f.branch))} findAt={8} options={branches} selected={search.branch ? [search.branch] : []} onDone={(v) => set("branch", v[0])} />
          <Picker label="Reached main" heading="Reached main" trigger={<>Reached main{caret}</>} triggerClass={picked(Boolean(f.main))} findAt={99} options={mains} selected={f.main ? [f.main] : []} onDone={(v) => set("main", v[0])} />
          <Picker label="Group" heading="Group" trigger={<>Group: {byBranch ? "Branch" : "Day"}{caret}</>} triggerClass={picked(false)} findAt={99} options={groups} selected={[byBranch ? "branch" : "day"]} onDone={(v) => set("group", v[0] === "branch" ? "branch" : undefined)} />
          <span className="px-2 text-[13px] text-bark-dim">Latest activity</span>
        </span>
      </div>
      {rows.length ? (
        <div className={sessionTable()}>
          {byBranch
            ? grouped.map(([key, list]) => (
                <section key={key} className="col-span-full grid grid-cols-subgrid">
                  <BranchHead s={list[0]!} count={list.length} />
                  <ul aria-label={list[0]!.lead.branch ?? "repository folder"} className="col-span-full grid grid-cols-subgrid">
                    {list.slice(0, GROUP_ROWS).map((s) => (
                      <SessionRow key={s.id} s={s} at={at} who={<Person login={s.person} />} />
                    ))}
                  </ul>
                  {list.length > GROUP_ROWS && list[0]!.lead.repo && list[0]!.lead.branch ? (
                    <Link {...sessionsLink(full, { ...search, group: undefined, branch: `${list[0]!.lead.repo}:${list[0]!.lead.branch}` })} className="col-span-full px-1 py-2.5 text-[13px] text-ash hover:text-bark">
                      {list.length - GROUP_ROWS} more
                    </Link>
                  ) : null}
                </section>
              ))
            : byDay(rows, clock).map((g) => (
                <section key={g.day} className="col-span-full grid grid-cols-subgrid">
                  <GroupHead title={g.day} count={`${g.rows.length} session${g.rows.length === 1 ? "" : "s"}`} />
                  <ul aria-label={g.day} className="col-span-full grid grid-cols-subgrid">
                    {g.rows.map((s) => (
                      <SessionRow key={s.id} s={s} at={at} who={<Person login={s.person} />} />
                    ))}
                  </ul>
                </section>
              ))}
        </div>
      ) : list.isSuccess ? (
        <div className="grid justify-items-center gap-3 px-4 pt-14 pb-[60px] text-center text-[14px] text-bark-dim">
          <p>{filtered || f.state ? "No sessions match." : "No agent sessions have been recorded in this repository."}</p>
        </div>
      ) : null}
      {list.hasNextPage ? (
        <div className="flex justify-center pt-3.5">
          <button type="button" className={button("quiet")} disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            More
          </button>
        </div>
      ) : null}
    </>
  );
}
