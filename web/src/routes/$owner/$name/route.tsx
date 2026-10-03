// A monorepo's frame: the breadcrumb (from the address), its name with its
// avatar, and its tabs. Every page under /{owner}/{name} renders inside.
import { createFileRoute, notFound, Outlet, useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { isMissing } from "../../../api/client";
import { monorepoRef } from "../../../api/names";
import { machinesQuery, membersQuery, monorepoQuery } from "../../../api/queries";
import { Avatar } from "../../../ui/Avatar";
import { Page } from "../../../ui/pages";
import { blobLink, monoLink, ownerLink, tabLink, treeLink } from "../../../ui/paths";
import { Tab, TabBar } from "../../../ui/TabBar";
import type { Crumb } from "../../../ui/TopBar";

export const Route = createFileRoute("/$owner/$name")({
  beforeLoad: ({ params }) => {
    try {
      return { monorepo: monorepoRef(params.owner, params.name) };
    } catch {
      throw notFound();
    }
  },
  loader: async ({ context: { queryClient, monorepo } }) => {
    try {
      return await queryClient.ensureQueryData(monorepoQuery(monorepo));
    } catch (error) {
      if (error instanceof Error && isMissing(error)) throw notFound();
      throw error;
    }
  },
  component: MonorepoFrame,
});

const TABS = ["activity", "machines", "ci", "members", "settings"] as const;

/** The breadcrumb after owner / name, read from the address. */
function pathCrumbs(full: string, rest: string[]): Crumb[] {
  const [kind = "", ...parts] = rest;
  const dirs = (upTo: number) => parts.slice(0, upTo).map((p, i) => ({ label: p, link: treeLink(full, parts.slice(0, i + 1).join("/")), wide: true }));

  if (kind === "tree") return [...dirs(parts.length - 1), { label: parts.at(-1) ?? "" }];

  if (kind === "blob") return [...dirs(parts.length - 1), { label: parts.at(-1) ?? "" }];

  if (kind === "history") return [...dirs(parts.length - 1), { label: parts.at(-1) ?? "", link: blobLink(full, parts.join("/")) }, { label: "history" }];

  if (kind === "projects") return [{ label: `projects/${parts[0] ?? ""}` }];

  return kind ? [{ label: kind }] : [];
}

function MonorepoFrame() {
  const { monorepo } = Route.useRouteContext();
  const info = Route.useLoaderData();
  const { pathname } = useLocation();

  const rest = pathname
    .split("/")
    .slice(3)
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));

  const full = monorepo.full;
  const tab = TABS.find((t) => rest[0] === t) ?? "code";
  const members = useQuery(membersQuery(monorepo)).data;
  const machines = useQuery({ ...machinesQuery(monorepo), enabled: info.kind === "monorepo" }).data;
  const crumbs: Crumb[] = [{ label: monorepo.owner, link: ownerLink(monorepo.owner), wide: true }, { label: monorepo.name, monorepo: full }, ...pathCrumbs(full, rest)];

  return (
    <Page crumbs={crumbs}>
      <div className="flex items-end justify-between gap-8 phone:flex-col phone:items-start phone:gap-4">
        <h1 className="flex items-center gap-3.5 font-mono text-[24px] leading-[30px] tracking-[-.01em]">
          <Avatar name={monorepo.name} org size={36} />
          <span>
            <span className="text-ash">{monorepo.owner}/</span>
            {monorepo.name}
          </span>
        </h1>
      </div>
      <TabBar label={full}>
        <Tab link={monoLink(full)} current={tab === "code"} label="Code" />
        <Tab link={tabLink(full, "activity")} current={tab === "activity"} label="Activity" />
        {info.kind === "monorepo" ? <Tab link={tabLink(full, "machines")} current={tab === "machines"} label="Machines" count={machines} /> : null}
        {info.kind === "monorepo" ? <Tab link={tabLink(full, "ci")} current={tab === "ci"} label="CI" /> : null}
        <Tab link={tabLink(full, "members")} current={tab === "members"} label="Members" count={members} />
        <Tab link={tabLink(full, "settings")} current={tab === "settings"} label="Settings" />
      </TabBar>
      <Outlet />
    </Page>
  );
}
