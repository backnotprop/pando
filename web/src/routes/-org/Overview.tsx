// An organization's page, /{org} (mock `org`): its repositories you can open,
// most recently active first, as GitHub lists them (links R); your activity in them;
// and at the side its people, the command that makes a repository in it, and
// your role. Someone outside the org sees its head and the repositories they
// were added to, nothing more.
import type { OrgMember, OrgProfile } from "@pando/contract";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { orgMembersQuery, ownerActivityQuery } from "../../api/orgs";
import { monoreposQuery } from "../../api/queries";
import { ActivityList } from "../../ui/activity";
import { Avatar } from "../../ui/Avatar";
import { Cmd, Empty, lnk, SectionHead } from "../../ui/controls";
import { Page } from "../../ui/pages";
import { orgLink, ownerLink } from "../../ui/paths";
import { Ref } from "../../ui/Ref";
import { RepoRows } from "../-home/RepoRows";
import { OrgHead } from "./OrgHead";

/** The most people the side lists; People has them all. */
const SIDE_PEOPLE = 8;

const byRole = (a: OrgMember, b: OrgMember) => Number(b.role === "owner") - Number(a.role === "owner") || a.login.localeCompare(b.login);

function Side({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="mb-5 border-b border-rule-faint pb-5 last:mb-0 last:border-b-0">
      <h2 className="mb-3 flex items-baseline gap-2.5 text-[13px] leading-[18px] font-semibold text-bark-dim">
        {title}
        {count === undefined ? null : <span className="text-[12.5px] font-normal text-ash">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function People({ org }: { org: OrgProfile }) {
  const people = [...(useQuery(orgMembersQuery(org.login)).data ?? [])].sort(byRole);

  return (
    <Side title="People" count={people.length}>
      <ul aria-label={`People in ${org.login}`}>
        {people.slice(0, SIDE_PEOPLE).map((p) => (
          <li key={p.login} className="flex min-h-[34px] items-center gap-2.5 text-[14px]">
            <Avatar name={p.login} picture={p.picture_url} size={22} />
            <Ref kind="person" link={ownerLink(p.login)} className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {p.name ?? p.login}
            </Ref>
            <span className="ml-auto text-[12.5px] text-ash">{p.role}</span>
          </li>
        ))}
      </ul>
      {people.length > SIDE_PEOPLE ? (
        <p className="mt-2 text-[13px]">
          <Link {...orgLink(org.login, "people")} className={lnk}>
            All {people.length}
          </Link>
        </p>
      ) : null}
    </Side>
  );
}

export function OrgOverview({ org }: { org: OrgProfile }) {
  const lines = (useQuery(monoreposQuery).data ?? []).filter((m) => m.owner === org.login);
  const activity = useInfiniteQuery(ownerActivityQuery(org.login));
  const events = (activity.data?.pages ?? []).flatMap((p) => p.events);
  const older = { more: activity.hasNextPage, loading: activity.isFetchingNextPage, load: () => void activity.fetchNextPage() };

  return (
    <Page crumbs={[{ label: org.login }]}>
      <OrgHead org={org} tab="overview" repositories={lines.length} />
      <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-14 narrow:grid-cols-[minmax(0,1fr)] narrow:gap-10">
        <div>
          <section aria-label="Repositories">
            <SectionHead title="Repositories" count={lines.length} className="mb-3" />
            <RepoRows lines={lines} />
          </section>
          <section aria-label="Activity" className="mt-10">
            <SectionHead title="Activity" />
            {events.length ? <ActivityList events={events} withMonorepo owner={org.login} older={older} /> : <Empty>Nothing yet.</Empty>}
          </section>
        </div>
        {org.role ? (
          <aside aria-label={`About ${org.login}`}>
            <People org={org} />
            <Side title="New repository">
              <Cmd text={`pando init --owner ${org.login}`} wide bare />
            </Side>
            <Side title="You">
              <p className="text-[13.5px] text-bark-dim">{org.role === "owner" ? "Owner" : "Member"}</p>
            </Side>
          </aside>
        ) : null}
      </div>
    </Page>
  );
}
