// The activity under the graph (profile SPEC 4.1, mock `profile`): the year
// by month, newest first, two months at first and the rest on "Show more
// activity"; or one day, when a square was picked. Each month says what kind
// of work it held ("Created 339 commits in 4 repositories"), with a row and a
// bar per repository, the repositories made, and the organizations made or
// joined.
import type { ContributionPeriod, MonorepoCount } from "@pando/contract";
import { type ReactNode, useState } from "react";
import { BranchIcon, CommitIcon, OrgIcon, RepoBookIcon, ReviewIcon } from "../../ui/Icons";
import { button } from "../../ui/controls";
import { monoLink, ownerLink } from "../../ui/paths";
import { Ref } from "../../ui/Ref";
import { count, shortDay } from "./words";

/** The months shown before "Show more activity". */
const FIRST_MONTHS = 2;

/** "October 2026". */
const monthName = (period: string) => new Date(`${period}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** `owner/name`, the line's object (links R): in Link, the owner in its regular weight. */
export function RepoName({ full, kind = "object" }: { full: string; kind?: "object" | "name" }) {
  const [owner, name] = full.split("/");

  return (
    <Ref kind={kind} link={monoLink(full)}>
      <span className="font-normal">{owner}/</span>
      {name}
    </Ref>
  );
}

/** One kind of work in the period: its badge on the timeline, its line, and its rows. */
function Item({ icon, head, right, children }: { icon: ReactNode; head: ReactNode; right?: ReactNode; children?: ReactNode }) {
  return (
    <li className="relative pt-3 pb-1.5 pl-11 phone:pl-10">
      <span className="absolute top-2 left-0 flex size-7 items-center justify-center rounded-full bg-loam text-bark-dim shadow-[0_0_0_4px_var(--soil)] *:[svg]:size-[15px]">{icon}</span>
      <p className="flex items-baseline gap-2.5 text-[14.5px] leading-[21px] text-bark">
        <span className="min-w-0">{head}</span>
        {right ? <span className="ml-auto text-[12.5px] whitespace-nowrap text-ash">{right}</span> : null}
      </p>
      {children}
    </li>
  );
}

const rowsGrid = "mt-[9px] grid grid-cols-[minmax(0,240px)_100px_minmax(0,1fr)] items-center gap-x-4 gap-y-[7px] text-[13.5px] phone:grid-cols-[minmax(0,1fr)_84px]";

/** One row per repository, with its count and a bar against the busiest. */
function Counts({ list, one, many }: { list: readonly MonorepoCount[]; one: string; many: string }) {
  const most = Math.max(1, ...list.map((m) => m.n));

  return (
    <div className={rowsGrid}>
      {list.map((m) => (
        <div key={m.full_name} className="contents">
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">
            <RepoName full={m.full_name} />
          </span>
          <span className="text-right text-[12.5px] text-ash">{count(m.n, one, many)}</span>
          <span className="h-1.5 rounded-[3px] bg-(--graph-3) phone:hidden" style={{ width: `${Math.max(2, (m.n / most) * 100)}%` }} />
        </div>
      ))}
    </div>
  );
}

const inRepos = (list: readonly MonorepoCount[]) => `in ${count(list.length, "repository", "repositories")}`;

const sum = (list: readonly MonorepoCount[]) => list.reduce((a, m) => a + m.n, 0);

/** What one month or day holds, as timeline items. */
export function PeriodItems({ p, tz }: { p: ContributionPeriod; tz: number }) {
  return (
    <ul className="relative before:absolute before:top-[18px] before:bottom-[18px] before:left-[13.5px] before:border-l before:border-rootline">
      {p.commit.length ? (
        <Item icon={<CommitIcon />} head={`Created ${count(sum(p.commit), "commit", "commits")} ${inRepos(p.commit)}`}>
          <Counts list={p.commit} one="commit" many="commits" />
        </Item>
      ) : null}
      {p.branch.length ? (
        <Item icon={<BranchIcon />} head={`Opened ${count(sum(p.branch), "branch", "branches")} ${inRepos(p.branch)}`}>
          <Counts list={p.branch} one="branch" many="branches" />
        </Item>
      ) : null}
      {p.review.length ? (
        <Item icon={<ReviewIcon />} head={`Wrote ${count(sum(p.review), "review", "reviews")} ${inRepos(p.review)}`}>
          <Counts list={p.review} one="review" many="reviews" />
        </Item>
      ) : null}
      {p.created.length ? (
        <Item icon={<RepoBookIcon />} head={`Created ${count(p.created.length, "repository", "repositories")}`}>
          <div className={rowsGrid}>
            {p.created.map((m) => (
              <div key={m.full_name} className="contents">
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  <RepoName full={m.full_name} />
                </span>
                <span className="text-right text-[12.5px] text-ash">{shortDay(m.at, tz)}</span>
                <span className="phone:hidden" />
              </div>
            ))}
          </div>
        </Item>
      ) : null}
      {p.joined.map((o) => (
        <Item
          key={o.org}
          icon={<OrgIcon />}
          right={shortDay(o.at, tz)}
          head={
            <>
              {o.created ? "Created the organization " : "Joined "}
              <Ref kind="object" link={ownerLink(o.org)}>
                {o.org}
              </Ref>
            </>
          }
        />
      ))}
    </ul>
  );
}

/** The year, by month, newest first. */
export function Months({ months, tz }: { months: readonly ContributionPeriod[]; tz: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? months : months.slice(0, FIRST_MONTHS);

  if (!months.length) return <p className="py-2.5 text-[13.5px] text-ash">No activity in the last year that you can see.</p>;

  return (
    <>
      {shown.map((m) => (
        <section key={m.period} aria-label={monthName(m.period)} className="mt-[26px] first:mt-0">
          <h3 className="mb-1.5 flex items-center gap-3.5 text-[13px] leading-[18px] font-semibold text-bark-dim after:flex-1 after:border-t after:border-rule-faint after:content-['']">
            {monthName(m.period)}
          </h3>
          <PeriodItems p={m} tz={tz} />
        </section>
      ))}
      {months.length > shown.length ? (
        <p className="mt-[22px] flex justify-center">
          <button type="button" className={button("quiet")} onClick={() => setAll(true)}>
            Show more activity
          </button>
        </p>
      ) : null}
    </>
  );
}
