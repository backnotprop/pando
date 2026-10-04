// The Machines tab: one row per machine working in the monorepo, latest
// activity first. Each row: the person and the machine, its worktrees (each
// opens its branch), what it did last and when, and whether it is connected.
// A connect makes no activity line, so the open tab asks again every 5 s.
import type { FeedEvent, Machine, MachineWorktree, Repo } from "@pando/contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { Fragment } from "react";
import type { MonorepoRef } from "../../../api/names";
import { machinesQuery, monorepoQuery, reposQuery } from "../../../api/queries";
import { describe } from "../../../ui/activity";
import { Avatar } from "../../../ui/Avatar";
import { Empty, row, thead } from "../../../ui/controls";
import { branchLink, repoLink } from "../../../ui/paths";
import { since, useNow } from "../../../ui/time";
import { MonorepoHead, useMonorepo } from "./-frame/heads";

export const Route = createFileRoute("/$owner/$name/machines")({
  loader: async ({ context: { queryClient, monorepo } }) => {
    const [info] = await Promise.all([queryClient.ensureQueryData(monorepoQuery(monorepo)), queryClient.ensureQueryData(reposQuery(monorepo))]);

    // A plain repo has no Machines tab.
    if (info.kind === "repo") throw notFound();

    await queryClient.ensureQueryData(machinesQuery(monorepo));
  },
  component: Machines,
});

// On a phone: the machine (its name whole, wrapping), its worktrees, when, and connected; what it did is left out.
const cols = "grid-cols-[minmax(0,230px)_minmax(0,200px)_minmax(0,1fr)_64px_92px] phone:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] phone:gap-3";

/** A worktree as a link to its branch: `cli`, or `artifact-fs/mac-mount` outside the first project. */
function WorktreeLink({ w, full, first }: { w: MachineWorktree; full: string; first: string | undefined }) {
  if (!w.repo || !w.branch) return <span className="font-mono text-[13px] text-ash">{w.path ?? w.id}</span>;
  const label = `${w.repo === first ? "" : `${w.repo.split("/").pop()}/`}${w.branch}`;
  const link = w.branch === "main" ? repoLink(full, w.repo) : branchLink(full, w.repo, w.branch);

  return (
    <Link {...link} className="font-mono text-[13px] text-bark hover:underline hover:decoration-ash hover:underline-offset-3">
      {label}
    </Link>
  );
}

/** What the machine did last, as the log says it without the person: "pushed 1 commit to live". */
function Last({ m, monorepo, id }: { m: Machine; monorepo: MonorepoRef; id: FeedEvent["monorepo_id"] }) {
  if (!m.last_activity) return <span />;
  const s = describe({ ...m.last_activity, monorepo: monorepo.full, monorepo_id: id, actor: m.login, machine: m.name });

  return (
    <span className="overflow-hidden text-[13.5px] text-ellipsis whitespace-nowrap text-bark-dim phone:hidden">
      <span className={s.bad ? "text-rust" : ""}>{s.verb}</span>
      {s.object ? (
        <>
          {" "}
          <code className="text-[12.5px] text-bark">{s.object.text}</code>
        </>
      ) : null}
      {s.tail ? ` ${s.tail}` : null}
    </span>
  );
}

function Machines() {
  const { monorepo, info } = useMonorepo();
  const clock = useNow();
  const machines = useSuspenseQuery({ ...machinesQuery(monorepo), refetchInterval: 5000 }).data;
  const repos: readonly Repo[] = useSuspenseQuery(reposQuery(monorepo)).data;
  const first = repos[0]?.path;

  return (
    <>
      <MonorepoHead tab="machines" />
      {machines.length ? (
        <div className="max-w-[1100px]">
          <div className={`${thead} ${cols}`}>
            <span>Machine</span>
            <span>Worktrees</span>
            <span className="phone:hidden">Last</span>
            <span className="hidden phone:block">Last</span>
            <span className="text-right">Now</span>
          </div>
          <ul aria-label="Machines">
            {machines.map((m) => (
              <li key={`${m.login}/${m.credential_id}`} className="border-t border-rule-faint">
                <div className={`${row} ${cols}`}>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Avatar name={m.login} size={22} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="overflow-hidden font-mono text-[13px] text-ellipsis whitespace-nowrap text-bark phone:whitespace-normal phone:[overflow-wrap:anywhere]">
                        {m.name}
                      </span>
                      <span className="overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-ash">{m.login}</span>
                    </span>
                  </span>
                  <span className="min-w-0 phone:[overflow-wrap:anywhere]">
                    {m.worktrees.length ? (
                      m.worktrees.map((w, i) => (
                        <Fragment key={w.id}>
                          {i ? <span className="text-ash">, </span> : null}
                          <WorktreeLink w={w} full={monorepo.full} first={first} />
                        </Fragment>
                      ))
                    ) : (
                      <span className="text-ash">none</span>
                    )}
                  </span>
                  <Last m={m} monorepo={monorepo} id={info.id} />
                  <span className="text-right font-mono text-[12.5px] whitespace-nowrap text-ash">{m.last_activity ? since(m.last_activity.at, clock) : ""}</span>
                  <span className={`text-right text-[13px] ${m.connected ? "text-bark" : "text-ash"}`}>{m.connected ? "connected" : "offline"}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Empty>No machine has worked here yet.</Empty>
      )}
    </>
  );
}
