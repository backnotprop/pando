// Small pieces every issue screen shares: a label's chip, the filters as the
// address keeps them, the line that says how an issue was opened or closed,
// and a row of assignees.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import type { IssueRow, Label } from "@pando/contract";
import type { ListFilters } from "../../../../api/issues";
import { meQuery } from "../../../../api/queries";
import { Avatar } from "../../../../ui/Avatar";
import { type IssuesSearch, issuesLink } from "../../../../ui/paths";
import { ago } from "../../../../ui/time";

/** A label: its colour's dot on a quiet chip (SF Pro Text, as names are). `full` makes it a link to the list filtered by it. */
export function LabelChip({ label, full }: { label: Label; full?: string }) {
  // SAFETY: React passes custom properties through style; CSSProperties has no index for "--" names.
  const style = { "--dot": `var(--label-${label.color})` } as CSSProperties;
  const chip = "inline-flex h-5 flex-none items-center gap-1.5 rounded-[10px] bg-loam pr-2 pl-[7px] align-[1px] text-[12px] leading-5 whitespace-nowrap text-bark-dim shadow-[inset_0_0_0_1px_var(--rule-soft)]";

  const inner = (
    <>
      <i aria-hidden="true" className="size-2 rounded-full bg-(--dot)" />
      {label.name}
    </>
  );

  return full ? (
    <Link {...issuesLink(full, { label: label.name })} title={label.description ?? undefined} style={style} className={`${chip} relative z-10 hover:text-bark`}>
      {inner}
    </Link>
  ) : (
    <span title={label.description ?? undefined} style={style} className={chip}>
      {inner}
    </span>
  );
}

/** The signed-in person's login (`@me` in filters, "you" in pickers). */
export const useMe = () => useQuery(meQuery).data?.login ?? null;

/** The Sort menu's four orders and how the address writes each (Newest is the default, so it writes nothing). */
export const SORTS = [
  { id: "", label: "Newest", sort: "created", order: "desc" },
  { id: "oldest", label: "Oldest", sort: "created", order: "asc" },
  { id: "updated", label: "Recently updated", sort: "updated", order: "desc" },
  { id: "comments", label: "Most commented", sort: "comments", order: "desc" },
] as const;

const list = (v: string | undefined) => (v ? v.split(",").filter(Boolean) : []);

/** The filters the address asks for. Several labels are one comma-separated `label`. */
export function filtersOf(s: IssuesSearch): ListFilters {
  const sort = SORTS.find((x) => x.id === (s.sort ?? "")) ?? SORTS[0];

  return {
    state: s.state === "closed" ? "closed" : "open",
    labels: list(s.label),
    assignee: s.assignee || null,
    author: s.author || null,
    project: s.project || null,
    q: s.q ?? "",
    sort: sort.sort,
    order: sort.order,
  };
}

/** The address for filters: only the keys that are set. */
export function searchOf(f: ListFilters): IssuesSearch {
  const out: IssuesSearch = {};
  const sort = SORTS.find((x) => x.sort === f.sort && x.order === f.order)?.id;

  if (f.state === "closed") out.state = "closed";

  if (f.labels.length) out.label = f.labels.join(",");

  if (f.assignee) out.assignee = f.assignee;

  if (f.author) out.author = f.author;

  if (f.project) out.project = f.project;

  if (f.q.trim()) out.q = f.q.trim();

  if (sort) out.sort = sort;

  return out;
}

/** "opened 12 min ago by ana", or how it was closed: "closed 14 min ago by merging fix-login", "closed as not planned 2 d ago". */
export function StateLine({ row, clock }: { row: IssueRow; clock: number }) {
  if (row.state === "open") return <>{`#${row.number} opened ${ago(row.created_at, clock)} by ${row.author}`}</>;

  const when = row.closed_at ? ago(row.closed_at, clock) : "";

  if (row.state_reason === "not_planned") return <>{`#${row.number} by ${row.author}, closed as not planned ${when}`}</>;

  if (row.closed_by_merge) {
    return (
      <>
        {`#${row.number} by ${row.author}, closed ${when} by merging `}
        <code className="text-[12px] text-bark-dim">{row.closed_by_merge.branch}</code>
      </>
    );
  }

  return <>{`#${row.number} by ${row.author}, closed ${when}${row.closed_by ? ` by ${row.closed_by}` : ""}`}</>;
}

/** Assignees as a small stack of avatars, each named on hover. */
export function Assignees({ logins, size = 18 }: { logins: readonly string[]; size?: 16 | 18 | 20 }) {
  if (!logins.length) return null;

  return (
    <span className="inline-flex" title={logins.join(", ")}>
      {logins.slice(0, 3).map((l, i) => (
        <span key={l} className={i ? "-ml-1 rounded-full shadow-[0_0_0_2px_var(--soil)]" : ""}>
          <Avatar name={l} size={size} />
        </span>
      ))}
    </span>
  );
}
