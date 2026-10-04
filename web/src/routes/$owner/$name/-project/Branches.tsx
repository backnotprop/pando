// A repo's branches: the open ones (who pushed from which machine, their
// state, when) and, under Merged, what landed on main and who merged it.
import type { QueryClient } from "@tanstack/react-query";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { MonorepoRef } from "../../../../api/names";
import type { Branch, Repo } from "@pando/contract";
import { branchesQuery } from "../../../../api/projects";
import { reposQuery } from "../../../../api/queries";
import { CheckMark } from "../../../../ui/activity";
import { Avatar } from "../../../../ui/Avatar";
import { Cmd, Empty } from "../../../../ui/controls";
import { branchesLink, branchLink } from "../../../../ui/paths";
import { Tab, TabBar } from "../../../../ui/TabBar";
import { since, useNow } from "../../../../ui/time";
import { Older } from "../../../../ui/Older";
import { useArrivals } from "../../../../ui/arrival";
import { RepoHead, useMonorepo } from "../-frame/heads";
import { stateOf, toneClass } from "./state";

/** A plain repo's one repo (path `.`), for its pages at /{owner}/{name}. */
export const plainRepo = async (qc: QueryClient, m: MonorepoRef) => (await qc.ensureQueryData(reposQuery(m))).find((r) => r.path === ".") ?? null;

/** Both lists: each tab carries its count. */
export const loadBranches = (qc: QueryClient, m: MonorepoRef, repo: Repo) =>
  Promise.all([qc.ensureInfiniteQueryData(branchesQuery(m, repo.name, "open")), qc.ensureInfiniteQueryData(branchesQuery(m, repo.name, "merged"))]);

const thead = "-mx-2.5 grid gap-4 px-2.5 pb-2 text-[12px] text-ash";

const rowLine = "-mx-2.5 grid min-h-11 items-center gap-4 rounded-[7px] px-2.5 py-2";

/** "ramos on sandbox-1", with the person's avatar. */
export function Who({ person, machine }: { person: string | null; machine: string | null | undefined }) {
  if (!person) return <span />;

  return (
    <span className="flex min-w-0 items-center gap-2 overflow-hidden text-[13px] whitespace-nowrap text-bark-dim phone:whitespace-normal">
      <Avatar name={person} size={18} />
      <span className="min-w-0 overflow-hidden text-ellipsis phone:overflow-visible">
        {person}
        {machine ? <span className="text-ash"> on {machine}</span> : null}
      </span>
    </span>
  );
}

export function StateWord({ b, mark = true, className = "" }: { b: Branch; mark?: boolean; className?: string }) {
  const s = stateOf(b);

  return (
    <span className={`text-[13px] whitespace-nowrap ${toneClass[s.tone]} ${className}`}>
      {mark && s.app === "buildkite" ? <CheckMark /> : null}
      {s.text}
    </span>
  );
}

function Open({ repo }: { repo: Repo }) {
  const { monorepo } = useMonorepo();
  const clock = useNow();
  const list = useSuspenseInfiniteQuery(branchesQuery(monorepo, repo.name, "open"));
  const branches = list.data.pages.flatMap((p) => p.branches);
  // A branch pushed while the list is open plays the arrival.
  const arrived = useArrivals(branches.map((b) => ({ key: b.name, state: "" })));
  // On a phone: the branch and its title, then a second line with who pushed it (in full) and when.
  const cols = "grid-cols-[minmax(0,1fr)_230px_150px_64px] narrow:grid-cols-[minmax(0,1fr)_150px_64px] phone:grid-cols-[minmax(0,1fr)_auto]";

  if (!branches.length) return <Empty>No open branches.</Empty>;

  return (
    <div>
      <div className={`${thead} ${cols}`}>
        <span>Branch</span>
        <span className="narrow:hidden">Who</span>
        <span className="phone:hidden">State</span>
        <span className="text-right">Pushed</span>
      </div>
      <ul aria-label="Open branches">
        {branches.map((b) => (
          <li key={b.name} className={`border-t border-rule-faint ${arrived(b.name) ? "arrived" : ""}`}>
            <Link {...branchLink(monorepo.full, repo.path, b.name)} className={`${rowLine} ${cols} hover:bg-air focus-visible:bg-air`}>
              <span className="flex min-w-0 flex-col gap-0.5 *:overflow-hidden *:text-ellipsis *:whitespace-nowrap phone:col-span-2">
                <span className="fox-cool font-mono text-[13.5px] leading-[16px] text-bark">{b.name}</span>
                {b.title ? <span className="text-[13px] text-ash">{b.title}</span> : null}
              </span>
              <span className="min-w-0 narrow:hidden phone:block">
                <Who person={b.author} machine={b.pushed_machine} />
              </span>
              <StateWord b={b} mark={false} className="phone:hidden" />
              <span className="text-right font-mono text-[12.5px] whitespace-nowrap text-ash">{b.updated_at ? since(b.updated_at, clock) : ""}</span>
            </Link>
          </li>
        ))}
      </ul>
      {list.hasNextPage ? <Older more loading={list.isFetchingNextPage} load={() => void list.fetchNextPage()} none="" /> : null}
    </div>
  );
}

function Merged({ repo }: { repo: Repo }) {
  const { monorepo } = useMonorepo();
  const clock = useNow();
  const list = useSuspenseInfiniteQuery(branchesQuery(monorepo, repo.name, "merged"));
  const branches = list.data.pages.flatMap((p) => p.branches);
  const cols = "grid-cols-[84px_minmax(0,1fr)_200px_64px] phone:grid-cols-[64px_minmax(0,1fr)]";

  if (!branches.length) return <Empty>Nothing merged yet.</Empty>;

  return (
    <div>
      <div className={`${thead} ${cols}`}>
        <span>Commit</span>
        <span>Message</span>
        <span className="phone:hidden">Merged by</span>
        <span className="text-right phone:hidden">When</span>
      </div>
      <ul aria-label="Merged branches">
        {branches.map((b) => (
          <li key={`${b.name}:${b.merge_commit ?? ""}`} className="border-t border-rule-faint">
            <Link {...branchLink(monorepo.full, repo.path, b.name)} className={`${rowLine} ${cols} hover:bg-air focus-visible:bg-air`}>
              <span className="font-mono text-[13.5px] leading-[16px] text-bark-dim">{b.merge_commit?.slice(0, 7) ?? ""}</span>
              <span className="overflow-hidden text-[13.5px] text-ellipsis whitespace-nowrap text-bark-dim">{b.title ?? `Merge branch '${b.name}'`}</span>
              <span className="overflow-hidden text-[13px] text-ellipsis whitespace-nowrap text-bark-dim phone:hidden">{b.merged_by ?? ""}</span>
              <span className="text-right font-mono text-[12.5px] whitespace-nowrap text-ash phone:hidden">{b.merged_at ? since(b.merged_at, clock) : ""}</span>
            </Link>
          </li>
        ))}
      </ul>
      {list.hasNextPage ? <Older more loading={list.isFetchingNextPage} load={() => void list.fetchNextPage()} none="" /> : null}
    </div>
  );
}

/** A list's count: "41", or "100+" while older pages wait. */
function useCount(m: MonorepoRef, repo: Repo, state: "open" | "merged") {
  const list = useSuspenseInfiniteQuery(branchesQuery(m, repo.name, state));
  const n = list.data.pages.reduce((a, p) => a + p.branches.length, 0);

  return list.hasNextPage ? `${n}+` : n;
}

export function BranchList({ repo, merged }: { repo: Repo; merged: boolean }) {
  const { monorepo } = useMonorepo();
  const open = useCount(monorepo, repo, "open");
  const done = useCount(monorepo, repo, "merged");
  const add = `pando worktree add ${repo.path === "." ? monorepo.full : repo.path} <branch>`;

  return (
    <>
      <RepoHead repo={repo} tab="branches" right={<Cmd text={add} />} />
      {/* The prototype's second row of tabs: no rule, 20 px apart, 1 px shorter (its tabs' -1 px margin over no border). */}
      <TabBar label="Branches" className="-mt-2 mb-[27px] gap-5">
        <Tab link={branchesLink(monorepo.full, repo.path)} current={!merged} label="Open" count={open} />
        <Tab link={branchesLink(monorepo.full, repo.path, true)} current={merged} label="Merged" count={done} />
      </TabBar>
      {merged ? <Merged repo={repo} /> : <Open repo={repo} />}
    </>
  );
}
