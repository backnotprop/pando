// The quiet top bar: the mark (home), the breadcrumb (owner / monorepo with
// its switcher / path), and your name, which opens a small menu.
import { Menu } from "@base-ui/react/menu";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { signOut } from "../api/actions";
import { monorepoRef } from "../api/names";
import { meQuery, monoreposQuery, openBranchesQuery, reposQuery } from "../api/queries";
import { Avatar } from "./Avatar";
import { Chevron, Mark } from "./Icons";
import { type AppLink, monoLink, repoLink } from "./paths";
import { MenuHeading, MenuLink, MenuPopup, MenuRule, menuItem } from "./menu";
import { ago, since, useNow } from "./time";

const lastSeen = (at: string, clock: number) => (since(at, clock) === "now" ? "now" : ago(at, clock));

export interface Crumb {
  label: string;
  /** Omitted on the page you are on. */
  link?: AppLink;
  /** The monorepo crumb: its avatar, and the chevron that switches monorepo. */
  monorepo?: string;
  /** A project crumb (its repo path): the chevron that switches project. */
  project?: string;
  /** Dropped on a phone, so the breadcrumb fits. */
  wide?: boolean;
}

const crumbLink = "rounded-md px-1.5 py-1 whitespace-nowrap text-bark-dim hover:bg-loam hover:text-bark";

function Switcher({ current }: { current: string }) {
  const lines = useQuery(monoreposQuery);
  const clock = useNow();

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Switch monorepo"
        className="flex h-7 w-[22px] items-center justify-center rounded-md text-ash hover:bg-loam hover:text-bark data-popup-open:bg-loam data-popup-open:text-bark"
      >
        {/* 10 by 14: the prototype's button kept the browser's 6px side padding, which narrows the chevron. */}
        <Chevron className="block h-3.5 w-2.5" />
      </Menu.Trigger>
      <MenuPopup offset={10}>
        <MenuHeading>Switch monorepo</MenuHeading>
        {(lines.data ?? []).map((m) => (
          <MenuLink key={m.id} link={monoLink(m.full_name)} current={m.full_name === current}>
            <Avatar name={m.name} org size={18} />
            <span className="font-mono text-[13px]">
              <span className="text-ash">{m.owner}/</span>
              {m.name}
            </span>
            <span className="ml-auto text-[12px] text-ash">
              {m.kind === "repo" ? "repo, " : ""}
              {m.last_activity_at ? lastSeen(m.last_activity_at, clock) : ""}
            </span>
          </MenuLink>
        ))}
        <MenuRule />
        <MenuLink link={{ to: "/" }}>All monorepos</MenuLink>
      </MenuPopup>
    </Menu.Root>
  );
}

function ProjectSwitcher({ full, current }: { full: string; current: string }) {
  const [owner = "", name = ""] = full.split("/");
  const monorepo = monorepoRef(owner, name);
  const repos = useQuery(reposQuery(monorepo)).data ?? [];
  const open = useQueries({ queries: repos.map((r) => openBranchesQuery(monorepo, r.name)) });

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Switch project"
        className="flex h-7 w-[22px] items-center justify-center rounded-md text-ash hover:bg-loam hover:text-bark data-popup-open:bg-loam data-popup-open:text-bark"
      >
        <Chevron className="block h-3.5 w-2.5" />
      </Menu.Trigger>
      <MenuPopup offset={10}>
        <MenuHeading>Projects in {name}</MenuHeading>
        {repos.map((r, i) => (
          <MenuLink key={r.path} link={repoLink(full, r.path)} current={r.path === current}>
            <span className="font-mono text-[13px]">{r.path}</span>
            <span className="ml-auto text-[12px] text-ash">{open[i]?.data === undefined ? "" : `${open[i]?.data} open`}</span>
          </MenuLink>
        ))}
        <MenuRule />
        <MenuLink link={monoLink(full)}>{name}, all files</MenuLink>
      </MenuPopup>
    </Menu.Root>
  );
}

function NameMenu() {
  const me = useQuery(meQuery).data;

  if (!me) return null;

  return (
    <Menu.Root>
      <Menu.Trigger className="ml-auto flex cursor-pointer items-center gap-2.5 rounded-md text-[13px] text-bark-dim hover:text-bark data-popup-open:text-bark">
        <Avatar name={me.login} size={22} />
        <span>{me.login}</span>
      </Menu.Trigger>
      <MenuPopup align="end" offset={10}>
        <MenuLink link={{ to: "/settings/machines" }}>Your machines</MenuLink>
        <MenuRule />
        <Menu.Item className={menuItem} onClick={() => void signOut()}>
          Sign out
        </Menu.Item>
      </MenuPopup>
    </Menu.Root>
  );
}

/** The monorepo the breadcrumb is in. */
const full = (crumbs: Crumb[]) => crumbs.find((c) => c.monorepo)?.monorepo ?? "";

export function TopBar({ crumbs = [] }: { crumbs?: Crumb[] }) {
  return (
    <header className="relative flex h-14 items-center gap-1.5 px-(--margin)">
      <Link to="/" aria-label="Home: your monorepos" className="-ml-1.5 flex size-8 items-center justify-center rounded-[7px] text-bark hover:bg-loam">
        <Mark className="block" />
      </Link>
      <nav aria-label="Where you are" className="flex min-w-0 items-center gap-0.5 font-mono text-[14px] leading-5">
        {crumbs.map((c, i) => (
          <span key={`${i}:${c.label}`} className={`inline-flex min-w-0 items-center ${c.wide ? "phone:hidden" : ""}`}>
            <span aria-hidden="true" className="px-1.5 font-sans text-[18px] text-rootline">
              /
            </span>
            {c.monorepo ? (
              <>
                <Link {...monoLink(c.monorepo)} className={`${crumbLink} inline-flex items-center gap-2`}>
                  <Avatar name={c.label} org size={18} />
                  {c.label}
                </Link>
                <Switcher current={c.monorepo} />
              </>
            ) : c.link ? (
              <>
                <Link {...c.link} className={crumbLink}>
                  {c.label}
                </Link>
                {c.project ? <ProjectSwitcher full={full(crumbs)} current={c.project} /> : null}
              </>
            ) : c.project ? (
              <>
                <span aria-current="page" className="px-1.5 py-1 whitespace-nowrap text-bark">
                  {c.label}
                </span>
                <ProjectSwitcher full={full(crumbs)} current={c.project} />
              </>
            ) : (
              <span aria-current="page" className="overflow-hidden px-1.5 py-1 text-ellipsis whitespace-nowrap text-bark">
                {c.label}
              </span>
            )}
          </span>
        ))}
      </nav>
      <NameMenu />
    </header>
  );
}
