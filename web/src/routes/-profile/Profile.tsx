// A person's profile, /{login} (profile SPEC 4.1 and 4.2, mocks `profile`,
// `profile@390` and `ana`): at the side their picture or initials, name,
// login, bio, Edit profile (your own), location, links, join date and the
// organizations you share; then the repositories with their work this year,
// the graph, and the activity by month (or the day picked on the graph). A
// viewer sees only work in repositories they can open.
import type { ContributionMonorepo, Contributions, Login, Profile as Person } from "@pando/contract";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useRef, useState } from "react";
import { contributionDayQuery, contributionsQuery } from "../../api/profile";
import { meQuery } from "../../api/queries";
import { useLanded } from "../../live/contributed";
import { Avatar } from "../../ui/Avatar";
import { button, Empty, lnk, SectionHead } from "../../ui/controls";
import { CalendarIcon, LinkIcon, PinIcon } from "../../ui/Icons";
import { Page } from "../../ui/pages";
import { ownerLink } from "../../ui/paths";
import { Ref } from "../../ui/Ref";
import { Months, PeriodItems, RepoName } from "./Activity";
import { Graph, longDay } from "./Graph";
import { count } from "./words";

/** The repositories shown before "All N". */
const FIRST_REPOS = 6;

/** "plannotator.ai" for https://plannotator.ai/; the text as written when it is not a URL. */
function host(link: string): string {
  try {
    const url = new URL(link);

    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return link;
  }
}

const Fact = ({ icon, children }: { icon: ReactNode; children: ReactNode }) => (
  <li className="flex min-w-0 items-center gap-[9px] *:[svg]:size-4 *:[svg]:flex-none *:[svg]:text-ash">
    {icon}
    {children}
  </li>
);

function Side({ person, own }: { person: Person; own: boolean }) {
  const joined = new Date(person.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return (
    <aside aria-label={`About ${person.login}`}>
      <div className="phone:flex phone:items-center phone:gap-3.5">
        <span className="phone:hidden">
          <Avatar name={person.login} picture={person.picture_url} size={120} />
        </span>
        <span className="hidden phone:block">
          <Avatar name={person.login} picture={person.picture_url} size={64} />
        </span>
        <div className="min-w-0">
          <h1 className="mt-5 text-[24px] leading-[30px] font-semibold tracking-[-.012em] [overflow-wrap:anywhere] phone:mt-0 phone:text-[20px] phone:leading-[26px]">
            {person.name ?? person.login}
          </h1>
          {person.name ? <p className="mt-0.5 text-[17px] leading-6 text-ash phone:text-[15px]">{person.login}</p> : null}
        </div>
      </div>
      {person.bio ? <p className="mt-3.5 text-[14.5px] leading-[22px] [overflow-wrap:anywhere] text-bark">{person.bio}</p> : null}
      {own ? (
        <Link to="/settings/profile" className={`${button("quiet")} mt-4 w-full`}>
          Edit profile
        </Link>
      ) : null}
      <ul className="mt-4 flex flex-col gap-2 text-[13.5px] text-bark-dim">
        {person.location ? <Fact icon={<PinIcon />}>{person.location}</Fact> : null}
        {person.links.map((l) => (
          <Fact key={l} icon={<LinkIcon />}>
            <Ref kind="object" href={l} className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {host(l)}
            </Ref>
          </Fact>
        ))}
        <Fact icon={<CalendarIcon />}>Joined {joined}</Fact>
      </ul>
      {person.orgs.length ? (
        <section aria-label="Organizations" className="mt-[22px] border-t border-rule-faint pt-[18px]">
          <h2 className="mb-2.5 text-[13px] leading-[18px] font-semibold text-bark-dim">Organizations</h2>
          <ul className="phone:flex phone:flex-wrap phone:gap-x-3.5 phone:gap-y-1">
            {person.orgs.map((o) => (
              <li key={o.login} className="flex min-h-8 items-center">
                <span className="flex min-w-0 items-center gap-2.5 text-[14px]">
                  <Avatar name={o.login} org size={28} />
                  <Ref kind="name" link={ownerLink(o.login)} className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                    {o.name ?? o.login}
                  </Ref>
                  {o.name ? <span className="text-[12.5px] text-ash">{o.login}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}

/** A repository with the person's work this year: its owner's avatar, its name, the count and a bar a month. */
function Card({ m }: { m: ContributionMonorepo }) {
  const [owner = ""] = m.full_name.split("/");
  const most = Math.max(1, ...m.months);

  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-rootline px-4 py-3.5">
      <p className="flex min-w-0 items-center gap-2.5 text-[14.5px]">
        <Avatar name={owner} org={m.owner_type === "org"} size={20} />
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          <RepoName full={m.full_name} kind="name" />
        </span>
        {m.kind === "repo" ? (
          <span className="ml-auto h-5 flex-none rounded-[5px] px-[7px] text-[11.5px] leading-5 text-bark-dim shadow-[inset_0_0_0_1px_var(--rule-hi)]">repo</span>
        ) : null}
      </p>
      <p className="flex items-center gap-2.5 text-[12.5px] text-ash">
        {count(m.n, "contribution", "contributions")} in the last year
        <span aria-hidden="true" className="ml-auto flex h-3.5 items-end gap-0.5">
          {m.months.map((n, i) => (
            <i key={i} className="block w-[3px] rounded-[1px] bg-(--graph-3)" style={{ height: `${n ? Math.max(2, Math.round((n / most) * 14)) : 1}px`, opacity: n ? 1 : 0.5 }} />
          ))}
        </span>
      </p>
    </li>
  );
}

function Repos({ c }: { c: Contributions }) {
  const [all, setAll] = useState(false);
  const shown = all ? c.monorepos : c.monorepos.slice(0, FIRST_REPOS);
  const more = c.monorepos.length > shown.length;

  return (
    <section aria-label="Repositories">
      <SectionHead
        title="Repositories"
        count={c.monorepos.length}
        className="mb-3"
        right={more ? <button type="button" className={lnk} onClick={() => setAll(true)}>{`All ${c.monorepos.length}`}</button> : undefined}
      />
      {c.monorepos.length ? (
        <ul className="grid grid-cols-2 gap-3 phone:grid-cols-1">
          {shown.map((m) => (
            <Card key={m.full_name} m={m} />
          ))}
        </ul>
      ) : (
        <Empty>No work this year in a repository you can open.</Empty>
      )}
    </section>
  );
}

function Day({ login, tz, day, onBack }: { login: Login; tz: number; day: string; onBack: () => void }) {
  const p = useQuery(contributionDayQuery(login, tz, day)).data;
  const empty = p && !p.commit.length && !p.branch.length && !p.review.length && !p.created.length && !p.joined.length;

  return (
    <section aria-label={longDay(day)}>
      <div className="mb-1.5 flex items-center gap-3">
        <h3 className="text-[13px] leading-[18px] font-semibold text-bark-dim">{longDay(day)}</h3>
        <button type="button" className={`${lnk} text-[13px]`} onClick={onBack}>
          Back to the year
        </button>
      </div>
      {p ? empty ? <Empty>No contributions on this day.</Empty> : <PeriodItems p={p} tz={tz} /> : null}
    </section>
  );
}

export function ProfilePage({ person, tz, day, onPick }: { person: Person; tz: number; day: string | null; onPick: (day: string | null) => void }) {
  const me = useQuery(meQuery).data;
  const own = me?.login === person.login;
  const c = useSuspenseQuery(contributionsQuery(person.login, tz)).data;
  // Your own work landing while the page is open: its day glows once (frames from before the page showed do not).
  const landed = useLanded();
  const seen = useRef(landed.n);

  return (
    <Page crumbs={[{ label: person.login }]}>
      <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-14 narrow:grid-cols-[240px_minmax(0,1fr)] narrow:gap-10 phone:grid-cols-[minmax(0,1fr)] phone:gap-7">
        <Side person={person} own={own} />
        <div className="min-w-0">
          <Repos c={c} />
          <section aria-label="Contributions" className="mt-10">
            <h2 className="mb-3 text-[14px] leading-5 font-semibold">{count(c.total, "contribution", "contributions")} in the last year</h2>
            <Graph c={c} picked={day} onPick={onPick} glow={own && landed.n > seen.current ? landed : null} />
          </section>
          <section aria-label="Activity" className="mt-10">
            <SectionHead title="Activity" />
            {day ? <Day login={person.login} tz={tz} day={day} onBack={() => onPick(null)} /> : <Months months={c.months} tz={tz} />}
          </section>
        </div>
      </div>
    </Page>
  );
}
