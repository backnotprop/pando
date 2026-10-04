// The home (and an owner's page, the home narrowed to their monorepos): your
// monorepos on the left, then "Needs you" and the activity log across them.
// Merging happens on a branch's page only (owner ruling), so "Needs you" links.
import { Menu } from "@base-ui/react/menu";
import type { FullName } from "@pando/contract";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { MonorepoSummary } from "@pando/contract";
import { activityQuery, monoreposQuery, needsQuery } from "../../api/queries";
import { LARGE_REFETCH_MS, useLargeFeeds } from "../../live/feed";
import { ActivityList } from "../../ui/activity";
import { Avatar } from "../../ui/Avatar";
import { Empty, SectionHead } from "../../ui/controls";
import { Caret } from "../../ui/dropdown";
import { MenuLink, MenuPopup } from "../../ui/menu";
import { Page } from "../../ui/pages";
import { monoLink } from "../../ui/paths";
import { since, useNow } from "../../ui/time";
import { HomeFoot } from "./HomeFoot";
import { NeedsList } from "./NeedsList";

/** "2 projects, 5 open branches": shown once the summary carries both counts. */
function Line({ m }: { m: MonorepoSummary }) {
  const open = m.open_branches;

  if (open == null || m.repos == null) return null;
  const projects = m.kind === "repo" ? "" : `${m.repos} project${m.repos === 1 ? "" : "s"}, `;

  return open ? (
    <span>
      {projects}
      {open} open branch{open === 1 ? "" : "es"}
    </span>
  ) : (
    <span className="text-ash">{projects}no open branches</span>
  );
}

function MonorepoList({ lines }: { lines: readonly MonorepoSummary[] }) {
  const clock = useNow();

  if (!lines.length) return <Empty>No monorepos yet.</Empty>;

  return (
    <ul>
      {lines.map((m) => (
        <li key={m.id} className="border-t border-rule-faint first:border-t-0">
          <Link
            {...monoLink(m.full_name)}
            className="-mx-2.5 grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-[7px] px-2.5 py-2 hover:bg-air focus-visible:bg-air"
          >
            <Avatar name={m.name} org size={28} />
            <span className="flex min-w-0 flex-col gap-0.5 *:overflow-hidden *:text-ellipsis *:whitespace-nowrap">
              <span className="text-[14px] leading-[17px] text-bark">
                <span className="text-ash">{m.owner}/</span>
                {m.name}
              </span>
              <span className="text-[13px] text-bark-dim">
                <Line m={m} />
              </span>
            </span>
            <span className="text-[12.5px] whitespace-nowrap text-ash">{m.last_activity_at ? since(m.last_activity_at, clock) : ""}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The log's picker: all monorepos, or one (owner ruling: nothing finer). */
function Filter({ lines, current }: { lines: readonly MonorepoSummary[]; current: FullName | null }) {
  const shown = current ? lines.find((m) => m.full_name === current) : null;

  return (
    <Menu.Root>
      <Menu.Trigger className="inline-flex h-[30px] cursor-pointer items-center gap-2 rounded-[7px] border border-rootline pr-2 pl-3 text-[13px] text-bark-dim hover:border-rule-hi hover:text-bark data-popup-open:border-rule-hi data-popup-open:text-bark">
        {shown ? (
          <span className="text-[12.5px] text-bark">
            <span className="text-ash">{shown.owner}/</span>
            {shown.name}
          </span>
        ) : (
          <span>All monorepos</span>
        )}
        <Caret />
      </Menu.Trigger>
      <MenuPopup>
        <MenuLink link={{ to: "/" }} current={!current}>
          All monorepos
        </MenuLink>
        {lines.map((m) => (
          <MenuLink key={m.id} link={{ to: "/", search: { in: m.full_name } }} current={m.full_name === current}>
            <Avatar name={m.name} org size={16} />
            <span className="text-[13px]">
              <span className="text-ash">{m.owner}/</span>
              {m.name}
            </span>
          </MenuLink>
        ))}
      </MenuPopup>
    </Menu.Root>
  );
}

export function Home({ inMonorepo, owner }: { inMonorepo: FullName | null; owner: string | null }) {
  const all = useQuery(monoreposQuery).data ?? [];
  const mine = owner ? all.filter((m) => m.owner === owner) : all;
  const ownedHere = (full: string) => !owner || full.startsWith(`${owner}/`);
  const needs = (useQuery(needsQuery(inMonorepo)).data ?? []).filter((n) => ownedHere(n.monorepo));
  // Large monorepos' lines come by their own sockets; past 5 of them, the log is read again each minute.
  const beyond = useLargeFeeds(all);
  const activity = useInfiniteQuery({ ...activityQuery(inMonorepo), refetchInterval: beyond ? LARGE_REFETCH_MS : false });
  const events = (activity.data?.pages ?? []).flatMap((p) => p.events).filter((e) => ownedHere(e.monorepo));
  const older = { more: activity.hasNextPage, loading: activity.isFetchingNextPage, load: () => void activity.fetchNextPage() };

  return (
    <Page crumbs={owner ? [{ label: owner }] : []}>
      <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-16 narrow:grid-cols-[minmax(0,1fr)] narrow:gap-10">
        {/* On a phone the aside dissolves into the column, so What's new can follow the activity. */}
        <aside className="sticky top-7 flex min-h-[calc(100vh-140px)] flex-col narrow:static narrow:min-h-0 phone:contents">
          <div>
            {owner ? (
              <h1 className="mb-6 flex items-center gap-3.5 text-[24px] leading-[30px] tracking-[-.01em]">
                <Avatar name={owner} size={36} />
                {owner}
              </h1>
            ) : null}
            <SectionHead title="Monorepos" count={mine.length} />
            <MonorepoList lines={mine} />
          </div>
          <HomeFoot />
        </aside>
        <section aria-label="Needs you and activity">
          <SectionHead title="Needs you" count={needs.length} />
          {needs.length ? <NeedsList rows={needs} /> : <Empty>Nothing needs you{inMonorepo ? ` in ${inMonorepo}` : ""}.</Empty>}
          <div className="mt-10 mb-2 flex items-center gap-3">
            <h2 className="text-[14px] leading-5 font-semibold">Activity</h2>
            <Filter lines={mine} current={inMonorepo} />
          </div>
          {events.length ? <ActivityList events={events} withMonorepo={!inMonorepo} older={older} /> : <Empty>Nothing yet.</Empty>}
        </section>
      </div>
    </Page>
  );
}
