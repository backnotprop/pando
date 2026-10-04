// The quiet top bar: the mark (home), the breadcrumb (owner / monorepo with
// its switcher / path), and your name, which opens a small menu (Your
// machines, the theme and its mode, Sign out).
import { Menu } from "@base-ui/react/menu";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { signOut } from "../api/actions";
import { monorepoRef } from "../api/names";
import { meQuery, monoreposQuery, openBranchesQuery, reposQuery } from "../api/queries";
import { Avatar } from "./Avatar";
import { Caret } from "./dropdown";
import { CheckIcon, Mark } from "./Icons";
import { type AppLink, monoLink, repoLink } from "./paths";
import { MenuHeading, menuHeading, MenuLink, MenuPopup, MenuRule, menuItem } from "./menu";
import { EXACT } from "./TabBar";
import { MODES, type Mode, setTheme, type Theme, THEMES, useThemeChoice } from "./theme";
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

// A crumb that has no room ends in an ellipsis rather than running into the next one.
const crumbLink = "min-w-0 overflow-hidden rounded-md px-1.5 py-1 text-ellipsis whitespace-nowrap text-bark-dim hover:bg-loam hover:text-bark";

function Switcher({ current }: { current: string }) {
  const lines = useQuery(monoreposQuery);
  const clock = useNow();

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Switch repository"
        className="flex h-7 w-[22px] flex-none items-center justify-center rounded-md text-ash hover:bg-loam hover:text-bark data-popup-open:bg-loam data-popup-open:text-bark"
      >
        <Caret kind="switch" />
      </Menu.Trigger>
      <MenuPopup offset={10}>
        <MenuHeading>Switch repository</MenuHeading>
        {(lines.data ?? []).map((m) => (
          <MenuLink key={m.id} link={monoLink(m.full_name)} current={m.full_name === current}>
            <Avatar name={m.name} org size={18} />
            <span className="text-[13px]">
              <span className="text-ash">{m.owner}/</span>
              {m.name}
            </span>
            <span className="ml-auto text-[12px] text-ash">{m.last_activity_at ? lastSeen(m.last_activity_at, clock) : ""}</span>
          </MenuLink>
        ))}
        <MenuRule />
        <MenuLink link={{ to: "/" }}>All repositories</MenuLink>
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
        className="flex h-7 w-[22px] flex-none items-center justify-center rounded-md text-ash hover:bg-loam hover:text-bark data-popup-open:bg-loam data-popup-open:text-bark"
      >
        <Caret kind="switch" />
      </Menu.Trigger>
      <MenuPopup offset={10}>
        <MenuHeading>Projects in {name}</MenuHeading>
        {repos.map((r, i) => (
          <MenuLink key={r.path} link={repoLink(full, r.path)} current={r.path === current}>
            <span className="text-[13px]">{r.path}</span>
            <span className="ml-auto text-[12px] text-ash">{open[i]?.data === undefined ? "" : `${open[i]?.data} open`}</span>
          </MenuLink>
        ))}
        <MenuRule />
        <MenuLink link={monoLink(full)}>{name}, all files</MenuLink>
      </MenuPopup>
    </Menu.Root>
  );
}

/** The mode's three choices sit in one row, as a segmented control; under a dark-only theme they show Dark, and none can be picked. */
const modeItem =
  "flex h-7 flex-1 cursor-pointer items-center justify-center rounded-[5px] text-[13px] text-bark-dim outline-none data-checked:bg-pop-hi data-checked:text-bark data-highlighted:text-bark data-highlighted:shadow-[inset_0_0_0_1px_var(--rule-hi)] data-disabled:cursor-default data-disabled:text-ash data-disabled:data-checked:text-bark-dim";

/**
 * The theme and its mode, kept in this browser (public/theme.js). A choice
 * keeps the menu open, so the page changes under it. A dark-only theme (Black
 * Rainbow) shows Mode as Dark, not to be picked, and says so; the mode kept
 * for the other themes is left as it was.
 */
function ThemeSetting() {
  const { theme, mode } = useThemeChoice();
  const darkOnly = THEMES.some((t) => t.id === theme && t.darkOnly);

  return (
    <>
      <Menu.Group>
        <Menu.GroupLabel className={menuHeading}>Theme</Menu.GroupLabel>
        <Menu.RadioGroup value={theme} onValueChange={(id: Theme) => setTheme({ theme: id })}>
          {THEMES.map((t) => (
            <Menu.RadioItem key={t.id} value={t.id} className={menuItem}>
              {t.label}
              <Menu.RadioItemIndicator className="ml-auto text-bark">
                <CheckIcon className="block size-3.5" />
              </Menu.RadioItemIndicator>
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Group>
      <Menu.Group>
        <Menu.GroupLabel className={`${menuHeading} flex`}>
          Mode
          {darkOnly ? <span className="ml-auto">dark only</span> : null}
        </Menu.GroupLabel>
        <Menu.RadioGroup
          value={darkOnly ? "dark" : mode}
          onValueChange={(id: Mode) => setTheme({ mode: id })}
          disabled={darkOnly}
          className="mx-1 mb-1 flex gap-0.5 rounded-[7px] border border-rootline p-0.5"
        >
          {MODES.map((m) => (
            <Menu.RadioItem key={m.id} value={m.id} className={modeItem}>
              {m.label}
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Group>
    </>
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
        <ThemeSetting />
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
      <Link to="/" aria-label="Home: your repositories" className="-ml-1.5 flex size-8 items-center justify-center rounded-[7px] text-bark hover:bg-loam">
        <Mark className="block" />
      </Link>
      <nav aria-label="Where you are" className="flex min-w-0 items-center gap-0.5 text-[14px] leading-5">
        {crumbs.map((c, i) => (
          // On a phone only the monorepo and the page you are on stay (the heading names the rest), so crumbs never collide.
          <span
            key={`${i}:${c.label}`}
            className={`inline-flex min-w-0 items-center ${c.monorepo ? "shrink-0" : ""} ${c.wide || (!c.monorepo && i !== crumbs.length - 1) ? "phone:hidden" : ""}`}
          >
            <span aria-hidden="true" className="flex-none px-1.5 font-sans text-[18px] text-rootline">
              /
            </span>
            {c.monorepo ? (
              <>
                <Link {...monoLink(c.monorepo)} activeOptions={EXACT} className={`${crumbLink} inline-flex items-center gap-2`}>
                  <Avatar name={c.label} org size={18} />
                  <span className="min-w-0 overflow-hidden text-ellipsis">{c.label}</span>
                </Link>
                <Switcher current={c.monorepo} />
              </>
            ) : c.link ? (
              <>
                <Link {...c.link} activeOptions={EXACT} className={crumbLink}>
                  {c.label}
                </Link>
                {c.project ? <ProjectSwitcher full={full(crumbs)} current={c.project} /> : null}
              </>
            ) : c.project ? (
              <>
                <span aria-current="page" className="min-w-0 overflow-hidden px-1.5 py-1 text-ellipsis whitespace-nowrap text-bark">
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
