// An organization's head (mock `org`): its square avatar, display name and
// login; on the overview also its description and facts (website, people,
// repositories). Then its tabs: Overview, People (its people only) and
// Settings (owners only).
import type { OrgProfile } from "@pando/contract";
import type { ReactNode } from "react";
import { Avatar } from "../../ui/Avatar";
import { LinkIcon, PersonIcon, RepoBookIcon } from "../../ui/Icons";
import { orgLink, ownerLink } from "../../ui/paths";
import { Ref } from "../../ui/Ref";
import { Tab, TabBar } from "../../ui/TabBar";

export type OrgTab = "overview" | "people" | "settings";

/** "plannotator.ai" for https://plannotator.ai/; the text as written when it is not a URL. */
function host(website: string): string {
  try {
    const url = new URL(website);

    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return website;
  }
}

const Fact = ({ icon, children }: { icon: ReactNode; children: ReactNode }) => (
  <span className="inline-flex items-center gap-[7px] *:[svg]:size-4 *:[svg]:flex-none *:[svg]:text-ash">
    {icon}
    {children}
  </span>
);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** `repositories`: the org's repositories this person can open (the overview's facts). */
export function OrgHead({ org, tab, repositories }: { org: OrgProfile; tab: OrgTab; repositories?: number }) {
  const full = tab === "overview";

  return (
    <>
      <div className="flex items-center gap-[18px] phone:items-start phone:gap-4">
        <span className="phone:hidden">
          <Avatar name={org.login} org size={56} />
        </span>
        <span className="hidden phone:block">
          <Avatar name={org.login} org size={48} />
        </span>
        <div className="min-w-0">
          <h1 className="text-[26px] leading-8 tracking-[-.018em] phone:text-[22px] phone:leading-7">
            {org.name ?? org.login}
            {org.name ? <span className="ml-2.5 text-[17px] tracking-normal text-ash phone:ml-0 phone:block phone:text-[15px] phone:leading-6">{org.login}</span> : null}
          </h1>
          {full && org.description ? <p className="mt-1.5 text-[14.5px] leading-[21px] text-bark-dim">{org.description}</p> : null}
          {full ? (
            <p className="mt-2 flex flex-wrap gap-x-[18px] gap-y-1.5 text-[13.5px] text-bark-dim phone:gap-x-3.5">
              {org.website ? (
                <Fact icon={<LinkIcon />}>
                  <Ref kind="object" href={org.website}>
                    {host(org.website)}
                  </Ref>
                </Fact>
              ) : null}
              {org.members === null ? null : <Fact icon={<PersonIcon />}>{plural(org.members, "person", "people")}</Fact>}
              {repositories === undefined ? null : <Fact icon={<RepoBookIcon />}>{plural(repositories, "repository", "repositories")}</Fact>}
            </p>
          ) : null}
        </div>
      </div>
      <TabBar label={`Organization ${org.login}`}>
        <Tab link={ownerLink(org.login)} current={tab === "overview"} label="Overview" />
        {org.role ? <Tab link={orgLink(org.login, "people")} current={tab === "people"} label="People" count={org.members ?? undefined} /> : null}
        {org.role === "owner" ? <Tab link={orgLink(org.login, "settings")} current={tab === "settings"} label="Settings" /> : null}
      </TabBar>
    </>
  );
}
