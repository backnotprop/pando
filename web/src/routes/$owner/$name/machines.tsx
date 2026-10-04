// The Machines tab: one row per machine working in the monorepo, latest
// activity first. Each row: the person and the machine, its worktrees (each
// opens its branch), what it did last and when, and whether it is connected.
// Each machine's row comes live on the tab's socket (machine.updated).
import type { FeedEvent, Machine, MachineWorktree, Repo } from "@pando/contract";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { Fragment } from "react";
import type { MonorepoRef } from "../../../api/names";
import { machinesQuery, monorepoQuery, reposQuery } from "../../../api/queries";
import { describe } from "../../../ui/activity";
import { Avatar } from "../../../ui/Avatar";
import { Empty, row, thead } from "../../../ui/controls";
import { branchLink, isHomeProject, repoLink } from "../../../ui/paths";
import { fallback, useRows } from "../../../live/rows";
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

const cols = "grid-cols-[minmax(0,230px)_minmax(0,200px)_minmax(0,1fr)_64px_92px]";

// On a phone: the machine (its name whole, on one line, 10 px from its worktrees), its worktrees, when, and connected;
// what it did is left out. The table is one grid there, each row a subgrid, so the name column is the longest name's width in every row.
const phoneTable = "phone:grid phone:grid-cols-[auto_minmax(0,1fr)_52px_72px] phone:gap-x-2.5";

const phoneRow = "phone:col-span-full phone:grid phone:grid-cols-subgrid phone:gap-x-2.5";

/** A worktree as a link to its branch: `cli` in the monorepo's own project (or its only one), `artifact-fs/mac-mount` in another. */
function WorktreeLink({ w, full, home }: { w: MachineWorktree; full: string; home: string | null }) {
  if (!w.repo || !w.branch) return <span className="text-[13px] text-ash">{w.path ?? w.id}</span>;
  const label = `${w.repo === home ? "" : `${w.repo.split("/").pop()}/`}${w.branch}`;
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
          {s.object.path ? <span className="text-bark">{s.object.text}</span> : <code className="text-[12.5px] text-bark">{s.object.text}</code>}
        </>
      ) : null}
      {s.tail ? ` ${s.tail}` : null}
    </span>
  );
}

function Machines() {
  const { monorepo, info } = useMonorepo();
  const clock = useNow();
  const qc = useQueryClient();
  const live = useRows(monorepo, ["kind:machine.updated"], () => void qc.invalidateQueries({ queryKey: machinesQuery(monorepo).queryKey }));
  const machines = useSuspenseQuery({ ...machinesQuery(monorepo), refetchInterval: fallback(live) }).data;
  const repos: readonly Repo[] = useSuspenseQuery(reposQuery(monorepo)).data;
  // The project named after the monorepo (projects/pando in ramos/pando), or its only one, goes without its name.
  const home = repos.length === 1 ? (repos[0]?.path ?? null) : (repos.find((r) => isHomeProject(r.path, monorepo.name))?.path ?? null);

  return (
    <>
      <MonorepoHead tab="machines" />
      {machines.length ? (
        <div className={`max-w-[1100px] ${phoneTable}`}>
          <div className={`${thead} ${cols} ${phoneRow}`}>
            <span>Machine</span>
            <span>Worktrees</span>
            <span className="phone:hidden">Last</span>
            {/* The time's column: unlabelled beside Last, which it shows alone on a phone. */}
            <span>
              <span className="hidden phone:inline">Last</span>
            </span>
            <span className="text-right">Now</span>
          </div>
          <ul aria-label="Machines" className={phoneRow}>
            {machines.map((m) => (
              <li key={`${m.login}/${m.credential_id}`} className={`border-t border-rule-faint ${phoneRow}`}>
                <div className={`${row} ${cols} ${phoneRow}`}>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Avatar name={m.login} size={22} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="overflow-hidden text-[13px] text-ellipsis whitespace-nowrap text-bark phone:overflow-visible">
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
                          <WorktreeLink w={w} full={monorepo.full} home={home} />
                        </Fragment>
                      ))
                    ) : (
                      <span className="text-ash">none</span>
                    )}
                  </span>
                  <Last m={m} monorepo={monorepo} id={info.id} />
                  <span className="text-right text-[12.5px] whitespace-nowrap text-ash">{m.last_activity ? since(m.last_activity.at, clock) : ""}</span>
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
