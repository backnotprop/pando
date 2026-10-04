// The issues list, GitHub's (SPEC.md 7.2): a search box and New issue; one
// box whose bar holds Open and Closed with their counts for the filters, and
// the filter menus (Author, Label, Project, Assignee, Sort; one Filters menu
// on a phone); then the rows, and More for older ones. The filters live in
// the address. Rows come live on the `issues` topic (live/issues.ts).
import { Popover } from "@base-ui/react/popover";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { issueListQuery, labelsQuery, type ListFilters, listKey, openCountQuery } from "../../../../api/issues";
import type { IssueRow } from "@pando/contract";
import { membersQuery, reposQuery } from "../../../../api/queries";
import { issueArrival } from "../../../../live/issues";
import { takeArrived } from "../../../../live/arrivals";
import { fallback, useRows } from "../../../../live/rows";
import { Avatar } from "../../../../ui/Avatar";
import { button } from "../../../../ui/controls";
import { Caret } from "../../../../ui/dropdown";
import { BranchIcon, ChatIcon, CheckIcon } from "../../../../ui/Icons";
import { DoneIcon, OpenIcon, SearchIcon, StateGlyph } from "../../../../ui/IssueIcons";
import { type IssuesSearch, issueLink, issuesLink, newIssueLink } from "../../../../ui/paths";
import { useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { Assignees, filtersOf, LabelChip, SORTS, searchOf, StateLine, useMe } from "./parts";
import { type PickOption, Picker } from "./Picker";

const filterButton =
  "inline-flex h-7 cursor-pointer items-center gap-[5px] rounded-md px-2 text-[13px] text-bark-dim hover:text-bark data-popup-open:bg-pop-hi data-popup-open:text-bark aria-[current=true]:bg-pop-hi aria-[current=true]:text-bark";

/** The options every filter menu offers, from the monorepo's members, labels and projects. */
function useOptions(f: ListFilters) {
  const { monorepo, info } = useMonorepo();
  const me = useMe();
  const members = useQuery(membersQuery(monorepo)).data ?? [];
  const labels = useQuery(labelsQuery(monorepo)).data ?? [];
  const repos = useQuery({ ...reposQuery(monorepo), enabled: info.kind === "monorepo" }).data ?? [];
  const people = [...members].sort((a, b) => Number(b.login === me) - Number(a.login === me) || a.login.localeCompare(b.login));

  const person = (login: string): PickOption => ({
    id: login,
    text: login,
    node: (
      <>
        <Avatar name={login} size={18} />
        <span className="text-bark">{login}</span>
      </>
    ),
  });

  return {
    author: people.map((p) => person(p.login)),
    assignee: [{ id: "@me", text: "Assigned to you" }, { id: "none", text: "No one" }, ...people.map((p) => person(p.login))],
    // Labels the filter names that are gone (deleted) still show, so they can be taken off.
    label: [...labels, ...f.labels.filter((l) => !labels.some((x) => x.name === l)).map((name) => ({ name, color: "gray" as const, description: null }))].map((l) => ({
      id: l.name,
      text: l.name,
      node: <LabelChip label={l} />,
      hint: l.description ?? undefined,
    })),
    project: info.kind === "monorepo" ? [{ id: "none", text: "No project" }, ...repos.filter((r) => r.path !== ".").map((r) => ({ id: r.name, text: r.path }))] : [],
    sort: SORTS.map((s) => ({ id: s.id || "newest", text: s.label })),
  };
}

/** The filters, as menus on the bar. */
function FilterMenus({ f, go }: { f: ListFilters; go: (next: ListFilters) => void }) {
  const o = useOptions(f);
  const sort = SORTS.find((s) => s.sort === f.sort && s.order === f.order) ?? SORTS[0];
  const one = (v: readonly string[]) => v[0] ?? null;
  const caret = <Caret />;

  return (
    <div className="ml-auto flex gap-1 phone:hidden">
      <Picker label="Author" heading="Author" trigger={<>Author{caret}</>} triggerClass={filterButton} options={o.author} selected={f.author ? [f.author] : []} onDone={(v) => go({ ...f, author: one(v) === f.author ? null : one(v) })} />
      <Picker
        label="Label"
        heading="Labels"
        trigger={
          <>
            Label{f.labels.length ? <span className="text-[12px] text-ash">{f.labels.length}</span> : null}
            {caret}
          </>
        }
        triggerClass={`${filterButton} ${f.labels.length ? "bg-pop-hi text-bark" : ""}`}
        options={o.label}
        selected={f.labels}
        multi
        onDone={(labels) => go({ ...f, labels })}
      />
      {o.project.length ? (
        <Picker label="Project" heading="Project" trigger={<>Project{caret}</>} triggerClass={`${filterButton} ${f.project ? "bg-pop-hi text-bark" : ""}`} options={o.project} selected={f.project ? [f.project] : []} onDone={(v) => go({ ...f, project: one(v) === f.project ? null : one(v) })} />
      ) : null}
      <Picker label="Assignee" heading="Assignee" trigger={<>Assignee{caret}</>} triggerClass={`${filterButton} ${f.assignee ? "bg-pop-hi text-bark" : ""}`} options={o.assignee} selected={f.assignee ? [f.assignee] : []} onDone={(v) => go({ ...f, assignee: one(v) === f.assignee ? null : one(v) })} />
      <Picker
        label="Sort"
        heading="Sort"
        trigger={
          <>
            {sort.label}
            {caret}
          </>
        }
        triggerClass={filterButton}
        options={o.sort}
        selected={[sort.id || "newest"]}
        onDone={(v) => {
          const next = SORTS.find((s) => (s.id || "newest") === one(v)) ?? SORTS[0];

          go({ ...f, sort: next.sort, order: next.order });
        }}
      />
    </div>
  );
}

/** On a phone, one Filters menu with each filter's rows under its heading. */
function PhoneFilters({ f, go }: { f: ListFilters; go: (next: ListFilters) => void }) {
  const o = useOptions(f);
  const [open, setOpen] = useState(false);
  const sort = SORTS.find((s) => s.sort === f.sort && s.order === f.order) ?? SORTS[0];

  const pick = (next: ListFilters) => {
    setOpen(false);
    go(next);
  };

  const sections: { heading: string; options: readonly PickOption[]; on: (id: string) => boolean; choose: (id: string) => ListFilters }[] = [
    { heading: "Author", options: o.author, on: (id) => f.author === id, choose: (id) => ({ ...f, author: f.author === id ? null : id }) },
    { heading: "Labels", options: o.label, on: (id) => f.labels.includes(id), choose: (id) => ({ ...f, labels: f.labels.includes(id) ? f.labels.filter((l) => l !== id) : [...f.labels, id] }) },
    { heading: "Project", options: o.project, on: (id) => f.project === id, choose: (id) => ({ ...f, project: f.project === id ? null : id }) },
    { heading: "Assignee", options: o.assignee, on: (id) => f.assignee === id, choose: (id) => ({ ...f, assignee: f.assignee === id ? null : id }) },
    {
      heading: "Sort",
      options: o.sort,
      on: (id) => id === (sort.id || "newest"),
      choose: (id) => {
        const s = SORTS.find((x) => (x.id || "newest") === id) ?? SORTS[0];

        return { ...f, sort: s.sort, order: s.order };
      },
    },
  ];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={`${filterButton} ml-auto hidden phone:inline-flex`}>
        Filters
        <Caret />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-10">
          <Popover.Popup className="max-h-[min(520px,var(--available-height))] w-[290px] overflow-y-auto rounded-[10px] border border-rootline bg-pop p-1.5 shadow-pop outline-none">
            {sections.flatMap((s) =>
              s.options.length ? [
                <div key={s.heading} role="group" aria-label={s.heading}>
                  <div className="px-2.5 pt-2 pb-1.5 text-[12px] text-ash">{s.heading}</div>
                  {s.options.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      aria-pressed={s.on(opt.id)}
                      className="flex min-h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13.5px] text-bark-dim hover:bg-pop-hi aria-pressed:text-bark"
                      onClick={() => pick(s.choose(opt.id))}
                    >
                      <span className="w-3.5 flex-none">{s.on(opt.id) ? <CheckIcon className="size-3.5" /> : null}</span>
                      {opt.node ?? opt.text}
                    </button>
                  ))}
                </div>,
              ] : [],
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Row({ row, full }: { row: IssueRow; full: string }) {
  const clock = useNow();
  const { monorepo } = useMonorepo();
  // Only a row that arrived live (a new issue on this list) plays the arrival; a changed row never does.
  const [fresh] = useState(() => takeArrived(issueArrival(monorepo, `row:${row.number}`)));

  return (
    <li className={`border-t border-rule-faint first:border-t-0 ${fresh ? "arrived" : ""}`}>
      <div className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-3.5 px-4 py-3 phone:grid-cols-[16px_minmax(0,1fr)] phone:px-3">
        <span className="mt-0.5">
          <StateGlyph state={row.state} reason={row.state_reason} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[14.5px] leading-[21px]">
            <Link {...issueLink(full, row.number)} className="fox-cool mr-0.5 text-bark hover:underline hover:decoration-ash hover:underline-offset-3">
              {row.title}
            </Link>
            {row.labels.map((l) => (
              <LabelChip key={l.name} label={l} full={full} />
            ))}
          </div>
          <p className="mt-1 text-[12.5px] text-ash">
            <StateLine row={row} clock={clock} />
            {row.project_path ? <span className="phone:hidden"> · <span className="text-bark-dim">{row.project_path}</span></span> : null}
            {row.tasks && row.tasks.total ? <span className="phone:hidden">{` · ${row.tasks.done} of ${row.tasks.total} tasks`}</span> : null}
          </p>
        </div>
        <div className="mt-0.5 grid grid-cols-[36px_44px_40px] items-center gap-1.5 text-[12.5px] text-ash phone:hidden">
          <span className="flex items-center justify-end gap-[5px]" title={row.linked_branches ? `${row.linked_branches} linked branch${row.linked_branches === 1 ? "" : "es"}` : undefined}>
            {row.linked_branches ? (
              <>
                <BranchIcon className="size-3.5" />
                {row.linked_branches}
              </>
            ) : null}
          </span>
          <span className="flex justify-end">
            <Assignees logins={row.assignees} />
          </span>
          <span className="flex items-center justify-end gap-[5px]">
            {row.comments ? (
              <>
                <ChatIcon className="size-3.5" />
                {row.comments}
              </>
            ) : null}
          </span>
        </div>
      </div>
    </li>
  );
}

function StateTab({ on, link, icon, children }: { on: boolean; link: ReturnType<typeof issuesLink>; icon: ReactNode; children: ReactNode }) {
  return (
    <Link {...link} aria-current={on ? "page" : undefined} className={`inline-flex items-center gap-[7px] ${on ? "font-semibold text-bark" : "text-ash hover:text-bark"}`}>
      {icon}
      {children}
    </Link>
  );
}

export function IssuesList({ search }: { search: IssuesSearch }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const f = filtersOf(search);
  const [q, setQ] = useState(f.q);
  const full = monorepo.full;

  const live = useRows(monorepo, ["issues"], () => {
    void qc.invalidateQueries({ queryKey: listKey(monorepo) });
    void qc.invalidateQueries({ queryKey: openCountQuery(monorepo).queryKey });
  });

  const list = useInfiniteQuery({ ...issueListQuery(monorepo, f), refetchInterval: fallback(live) });
  const rows = list.data?.pages.flatMap((p) => p.issues) ?? [];
  const counts = list.data?.pages[0]?.counts;
  const go = (next: ListFilters) => void navigate({ ...issuesLink(full, searchOf(next)), replace: false });
  const filtered = f.labels.length || f.assignee || f.author || f.project || f.q;

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <form
          role="search"
          className="flex h-[34px] min-w-0 flex-1 items-center gap-2.5 rounded-[7px] border border-rootline bg-air px-3 focus-within:border-ash"
          onSubmit={(e) => {
            e.preventDefault();
            go({ ...f, q });
          }}
        >
          <SearchIcon className="size-4 flex-none text-ash" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search issues" aria-label="Search issues" className="min-w-0 flex-1 bg-transparent text-[14px] text-bark placeholder:text-ash focus:outline-none" />
        </form>
        <Link {...newIssueLink(full)} className={`${button("solid")} h-[34px]`}>
          New issue
        </Link>
      </div>
      <div className="rounded-[10px] border border-rootline">
        <div className="flex min-h-12 items-center gap-[18px] rounded-t-[10px] bg-loam px-4 text-[13.5px] phone:gap-3.5 phone:px-3">
          <nav aria-label="State" className="flex items-center gap-[18px] phone:gap-3.5">
            <StateTab on={f.state === "open"} link={issuesLink(full, searchOf({ ...f, state: "open" }))} icon={<OpenIcon className="size-4" />}>
              {counts ? `${counts.open} Open` : "Open"}
            </StateTab>
            <StateTab on={f.state === "closed"} link={issuesLink(full, searchOf({ ...f, state: "closed" }))} icon={<DoneIcon className="size-4" />}>
              {counts ? `${counts.closed} Closed` : "Closed"}
            </StateTab>
          </nav>
          <FilterMenus f={f} go={go} />
          <PhoneFilters f={f} go={go} />
        </div>
        {rows.length ? (
          <ul aria-label="Issues">
            {rows.map((r) => (
              <Row key={r.number} row={r} full={full} />
            ))}
          </ul>
        ) : list.isSuccess ? (
          <p className="border-t border-rule-faint px-4 py-5 text-[13.5px] text-ash">
            {filtered ? `No ${f.state} issues match.` : `No ${f.state} issues.`}
          </p>
        ) : null}
      </div>
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
