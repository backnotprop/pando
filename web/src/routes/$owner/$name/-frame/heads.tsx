// The heads pages carry under a monorepo: the monorepo's (its avatar, its
// name, its tabs), and a repo's (a project's path, or a plain repo's name,
// with Code and Branches). A branch's page has neither: its title is its head.
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { Machine, Repo } from "@pando/contract";
import { openCountQuery } from "../../../../api/issues";
import { machinesQuery, membersQuery, openBranchesQuery, reposQuery } from "../../../../api/queries";
import { Avatar } from "../../../../ui/Avatar";
import { branchesLink, issuesLink, monoLink, repoLink, tabLink } from "../../../../ui/paths";
import { Tab, TabBar } from "../../../../ui/TabBar";

const frame = getRouteApi("/$owner/$name");

/** The monorepo's own context (from the frame route): who, and what kind. */
export function useMonorepo() {
  const { monorepo } = frame.useRouteContext();

  return { monorepo, info: frame.useLoaderData() };
}

/** A plain repo's one repo (path `.`); null in a monorepo. */
export function usePlainRepo() {
  const { monorepo, info } = useMonorepo();
  const repos = useSuspenseQuery(reposQuery(monorepo)).data;

  return info.kind === "repo" ? (repos.find((r) => r.path === ".") ?? null) : null;
}

function Head({ title, right }: { title: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-8 phone:flex-col phone:items-start phone:gap-4">
      <h1 className="flex items-center gap-3.5 text-[24px] leading-[30px] tracking-[-.01em]">{title}</h1>
      {right}
    </div>
  );
}

function FullName() {
  const { monorepo } = useMonorepo();

  return (
    <>
      <Avatar name={monorepo.name} org size={36} />
      <span>
        <span className="text-ash">{monorepo.owner}/</span>
        {monorepo.name}
      </span>
    </>
  );
}

export type MonorepoTab = "code" | "issues" | "activity" | "machines" | "ci" | "members" | "settings";

export function MonorepoHead({ tab }: { tab: MonorepoTab }) {
  const { monorepo, info } = useMonorepo();
  const full = monorepo.full;
  const members = useQuery({ ...membersQuery(monorepo), select: (l) => l.length }).data;
  const machines = useQuery({ ...machinesQuery(monorepo), enabled: info.kind === "monorepo", select: connectedNow }).data;
  const issues = useQuery(openCountQuery(monorepo)).data;

  return (
    <>
      <Head title={<FullName />} />
      <TabBar label={full}>
        <Tab link={monoLink(full)} current={tab === "code"} label="Code" />
        <Tab link={issuesLink(full)} current={tab === "issues"} label="Issues" count={issues || undefined} />
        <Tab link={tabLink(full, "activity")} current={tab === "activity"} label="Activity" />
        {info.kind === "monorepo" ? <Tab link={tabLink(full, "machines")} current={tab === "machines"} label="Machines" count={machines || undefined} /> : null}
        {info.kind === "monorepo" ? <Tab link={tabLink(full, "ci")} current={tab === "ci"} label="CI" /> : null}
        <Tab link={tabLink(full, "members")} current={tab === "members"} label="Members" count={members} />
        {info.role === "owner" ? <Tab link={tabLink(full, "settings")} current={tab === "settings"} label="Settings" /> : null}
      </TabBar>
    </>
  );
}

/** Machines connected now: the Machines tab's count. */
const connectedNow = (machines: readonly Machine[]) => machines.filter((x) => x.connected).length;

/** A project's head (its path), or a plain repo's (its name), with the repo's tabs. */
export function RepoHead({ repo, tab, right }: { repo: Repo; tab: "code" | "issues" | "branches" | "members" | "settings"; right?: ReactNode }) {
  const { monorepo, info } = useMonorepo();
  const full = monorepo.full;
  const plain = repo.path === ".";
  const open = useQuery(openBranchesQuery(monorepo, repo.name)).data;
  const members = useQuery({ ...membersQuery(monorepo), enabled: plain, select: (l) => l.length }).data;
  const issues = useQuery({ ...openCountQuery(monorepo), enabled: plain }).data;

  return (
    <>
      <Head title={plain ? <FullName /> : repo.path} right={right} />
      <TabBar label={plain ? full : repo.path}>
        <Tab link={repoLink(full, repo.path)} current={tab === "code"} label="Code" />
        {plain ? <Tab link={issuesLink(full)} current={tab === "issues"} label="Issues" count={issues || undefined} /> : null}
        <Tab link={branchesLink(full, repo.path)} current={tab === "branches"} label="Branches" count={open} />
        {plain ? <Tab link={tabLink(full, "members")} current={tab === "members"} label="Members" count={members} /> : null}
        {plain && info.role === "owner" ? <Tab link={tabLink(full, "settings")} current={tab === "settings"} label="Settings" /> : null}
      </TabBar>
    </>
  );
}

/** The head of a page every monorepo and plain repo has (Issues, Members, Settings): a plain repo's carries its repo's tabs. */
export function OwnHead({ tab }: { tab: "issues" | "members" | "settings" }) {
  const repo = usePlainRepo();

  return repo ? <RepoHead repo={repo} tab={tab} /> : <MonorepoHead tab={tab} />;
}
