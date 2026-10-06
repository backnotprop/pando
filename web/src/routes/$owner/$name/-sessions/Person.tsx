// A person's sessions (owner, 2026-10-05): the same one-line row, the repository in the person's column, in the
// repositories the viewer and the person can both open. The full list at /{login}/sessions, with Active and Inactive
// and its filters (Repository, Agent, Reached main); the profile shows the latest five, then "All N".
import type { Login } from "@pando/contract";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { personSessionsQuery } from "../../../../api/sessions";
import { AgentMark, PROGRAM_NAME, type Program } from "../../../../ui/AgentMark";
import { Avatar } from "../../../../ui/Avatar";
import { button, SectionHead } from "../../../../ui/controls";
import { Caret } from "../../../../ui/dropdown";
import { personSessionsLink } from "../../../../ui/paths";
import { useNow } from "../../../../ui/time";
import { Picker } from "../-issues/Picker";
import { byDay, GroupHead, SessionRow, sessionTable } from "./Row";

const PROGRAMS: Program[] = ["claude-code", "codex", "pi", "opencode"];

const filterButton =
  "inline-flex h-7 cursor-pointer items-center gap-[5px] rounded-md px-2 text-[13px] text-bark-dim hover:text-bark data-popup-open:bg-pop-hi data-popup-open:text-bark";

/** The page's filters in the address. */
export interface PersonSessionsSearch {
  state?: string;
  agent?: string;
  main?: string;
  repository?: string;
}

/** The rows, by day; each repository's row links within it. */
function Rows({ login, f, limit, more }: { login: Login; f: PersonSessionsSearch; limit: number; more: boolean }) {
  const clock = useNow();
  const list = useInfiniteQuery(personSessionsQuery(login, limit, f));
  const rows = list.data?.pages.flatMap((p) => p.sessions) ?? [];
  const shown = more ? rows : rows.slice(0, limit);

  if (list.isSuccess && !rows.length) return <p className="py-2.5 text-[13.5px] text-ash">No agent sessions here.</p>;

  return (
    <>
      <div className={sessionTable()}>
        {byDay(
          shown.map((r) => ({ ...r, last_at: r.session.last_at })),
          clock,
        ).map((g) => (
          <section key={g.day} className="col-span-full grid grid-cols-subgrid">
            <GroupHead title={g.day} count={`${g.rows.length} session${g.rows.length === 1 ? "" : "s"}`} />
            <ul aria-label={g.day} className="col-span-full grid grid-cols-subgrid">
              {g.rows.map((r) => (
                <SessionRow key={r.session.id} s={r.session} at={{ full: r.monorepo.full_name, paths: new Map() }} who={<span className="overflow-hidden text-ellipsis">{r.monorepo.full_name}</span>} whoText={r.monorepo.full_name} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {more && list.hasNextPage ? (
        <div className="flex justify-center pt-3.5">
          <button type="button" className={button("quiet")} disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            More
          </button>
        </div>
      ) : null}
    </>
  );
}

/** The profile's section: the latest five, and "All N" to the full list. */
export function ProfileSessions({ login }: { login: Login }) {
  const list = useInfiniteQuery(personSessionsQuery(login, 5, {}));
  const counts = list.data?.pages[0]?.counts;
  const total = counts ? counts.active + counts.inactive : null;

  if (list.isSuccess && total === 0) return null;

  return (
    <section aria-label="Sessions" className="mt-10">
      <SectionHead
        title="Sessions"
        right={
          total ? (
            <Link {...personSessionsLink(login)} className="text-[13px] text-bark-dim hover:text-bark">
              All {total.toLocaleString("en-US")}
            </Link>
          ) : null
        }
      />
      <Rows login={login} f={{}} limit={5} more={false} />
    </section>
  );
}

/** /{login}/sessions. */
export function PersonSessions({ login, search }: { login: Login; search: PersonSessionsSearch }) {
  const navigate = useNavigate();
  const head = useInfiniteQuery(personSessionsQuery(login, 30, search));
  const first = head.data?.pages[0];
  const go = (next: PersonSessionsSearch) => void navigate({ ...personSessionsLink(login), search: next });

  const set = (key: keyof PersonSessionsSearch, value: string | undefined) => {
    const next = { ...search };

    if (value === undefined || search[key] === value) delete next[key];
    else next[key] = value;
    go(next);
  };

  const caret = <Caret />;
  const picked = (on: boolean) => `${filterButton} ${on ? "bg-pop-hi text-bark" : ""}`;

  const state = (to: "active" | "inactive", count: number | undefined, dot: string) => (
    <button type="button" aria-pressed={search.state === to} onClick={() => set("state", to)} className={`inline-flex cursor-pointer items-center gap-[7px] ${search.state === to ? "font-semibold text-bark" : "text-bark-dim hover:text-bark"}`}>
      <span aria-hidden="true" className={`inline-block size-[9px] rounded-full border-2 ${dot}`} />
      {count === undefined ? null : <span className="tabular-nums">{count.toLocaleString("en-US")}</span>}
      {to === "active" ? "Active" : "Inactive"}
    </button>
  );

  return (
    <>
      <div className="mb-6 flex items-center gap-4">
        <Avatar name={login} size={48} />
        <h1 className="text-[26px] leading-8 tracking-[-.018em]">
          <span className="text-bark-dim">{login}/</span>sessions
        </h1>
      </div>
      <div className="flex min-h-12 flex-wrap items-center gap-x-[18px] gap-y-1.5 border-b border-rule-faint pb-3 text-[13.5px]">
        <nav aria-label="State" className="flex items-center gap-[18px]">
          {state("active", first?.counts.active, "border-bark-dim bg-bark")}
          {state("inactive", first?.counts.inactive, "border-ash")}
        </nav>
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <Picker label="Repository" heading="Repository" trigger={<>Repository{caret}</>} triggerClass={picked(Boolean(search.repository))} findAt={8} options={(first?.repositories ?? []).map((r) => ({ id: r, text: r }))} selected={search.repository ? [search.repository] : []} onDone={(v) => set("repository", v[0])} />
          <Picker label="Agent" heading="Agent" trigger={<>Agent{caret}</>} triggerClass={picked(Boolean(search.agent))} findAt={99} options={PROGRAMS.map((p) => ({ id: p, text: PROGRAM_NAME[p], node: (<><AgentMark program={p} /><span className="text-bark">{PROGRAM_NAME[p]}</span></>) }))} selected={search.agent ? [search.agent] : []} onDone={(v) => set("agent", v[0])} />
          <Picker label="Reached main" heading="Reached main" trigger={<>Reached main{caret}</>} triggerClass={picked(Boolean(search.main))} findAt={99} options={[{ id: "yes", text: "Reached main" }, { id: "no", text: "Not on main" }]} selected={search.main ? [search.main] : []} onDone={(v) => set("main", v[0])} />
          <span className="px-2 text-[13px] text-bark-dim">Latest activity</span>
        </span>
      </div>
      <Rows login={login} f={search} limit={30} more />
    </>
  );
}
