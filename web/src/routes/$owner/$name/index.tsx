// A monorepo opens on its code: the root folder with Clone, its README (or
// AGENTS.md), and a quiet side column (what needs you here, the projects, the
// latest activity). A plain repo opens on its code at a ref, as a project does.
import type { NeedRow } from "@pando/contract";
import { useQueries, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { refSearch } from "../../../api/search";
import type { MonorepoRef } from "../../../api/names";
import type { Repo } from "@pando/contract";
import { activityQuery, fileQuery, headsQuery, latestQuery, monorepoQuery, needsQuery, openBranchesQuery, reposQuery, treeQuery } from "../../../api/queries";
import { MiniActivity } from "../../../ui/activity";
import { Empty, Lnk, SectionHead } from "../../../ui/controls";
import { RepoIcon } from "../../../ui/Icons";
import { branchLink, repoLink, tabLink, treeLink } from "../../../ui/paths";
import { NeedState } from "../../-home/NeedsList";
import { Clone } from "./-code/Clone";
import { FileList, Readme, versionBar } from "./-code/FileList";
import { folderRows, readmeOf } from "./-code/rows";
import { MonorepoHead, usePlainRepo } from "./-frame/heads";
import { loadCode, ProjectCode } from "./-project/Code";

export const Route = createFileRoute("/$owner/$name/")({
  validateSearch: refSearch,
  loaderDeps: ({ search }) => ({ ref: search.ref ?? null }),
  loader: async ({ context: { queryClient, monorepo }, deps }) => {
    const [info, repos] = await Promise.all([queryClient.ensureQueryData(monorepoQuery(monorepo)), queryClient.ensureQueryData(reposQuery(monorepo))]);
    const plain = repos.find((r) => r.path === ".");

    if (info.kind === "repo") return plain ? loadCode(queryClient, monorepo, plain, "", deps.ref) : undefined;
    const tree = await queryClient.ensureQueryData(treeQuery(monorepo, ""));
    const readme = readmeOf("", tree.files);
    await Promise.all([
      tree.head ? queryClient.ensureQueryData(latestQuery(monorepo, tree.head)) : null,
      readme ? queryClient.ensureQueryData(fileQuery(monorepo, readme, null)) : null,
      queryClient.ensureQueryData(needsQuery(monorepo.full)),
      queryClient.ensureQueryData(headsQuery(monorepo)),
      queryClient.ensureInfiniteQueryData(activityQuery(monorepo.full)),
    ]);
  },
  component: CodeRoot,
});

/** Open branches per repo, for "5 open branches" and the side column's "4 open". */
function useOpenCounts(monorepo: MonorepoRef, repos: readonly Repo[]) {
  return useQueries({ queries: repos.map((r) => openBranchesQuery(monorepo, r.name)) }).map((q) => q.data);
}

function ReadmeFor({ monorepo, path }: { monorepo: MonorepoRef; path: string }) {
  const text = useSuspenseQuery(fileQuery(monorepo, path, null)).data.text;

  return text === null ? null : <Readme name={path} text={text} />;
}

function Side({ monorepo, repos, open }: { monorepo: MonorepoRef; repos: readonly Repo[]; open: (number | undefined)[] }) {
  const needs = useSuspenseQuery(needsQuery(monorepo.full)).data;
  const events = useSuspenseInfiniteQuery(activityQuery(monorepo.full)).data.pages[0]?.events.slice(0, 6) ?? [];

  return (
    <aside className="flex flex-col gap-10">
      <div>
        <SectionHead title="Needs you" count={needs.length} />
        {needs.length ? <MiniNeeds rows={needs} /> : <Empty>Nothing.</Empty>}
      </div>
      {repos.length ? (
        <div>
          <SectionHead title="Projects" count={repos.length} />
          <ul>
            {repos.map((r, i) => (
              <li key={r.path} className="border-t border-rule-faint first:border-t-0">
                <Link
                  {...repoLink(monorepo.full, r.path)}
                  className="-mx-2.5 grid min-h-10 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[7px] px-2.5 py-2 hover:bg-air focus-visible:bg-air"
                >
                  <RepoIcon className="block size-4 text-bark-dim" />
                  <span className="font-mono text-[13px] leading-[16px] text-bark">{r.path}</span>
                  <span className="font-mono text-[12.5px] whitespace-nowrap text-ash">{open[i] === undefined ? "" : `${open[i]} open`}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <SectionHead title="Activity" right={<Lnk {...tabLink(monorepo.full, "activity")}>All</Lnk>} />
        {events.length ? <MiniActivity events={events} /> : <Empty>Nothing yet.</Empty>}
      </div>
    </aside>
  );
}

function MiniNeeds({ rows }: { rows: readonly NeedRow[] }) {
  return (
    <ul>
      {rows.map((n) => (
        <li key={`${n.repo}:${n.branch}`} className="border-t border-rule-faint first:border-t-0">
          <Link
            {...branchLink(n.monorepo, n.repo_path, n.branch)}
            className="-mx-2.5 grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-[7px] px-2.5 py-[5px] hover:bg-air focus-visible:bg-air"
          >
            <span className="flex min-w-0 items-baseline gap-1.5 overflow-hidden text-[13px] whitespace-nowrap">
              <span className="font-mono text-[12.5px] leading-[15px] text-bark">{n.branch}</span>
              <NeedState row={n} />
            </span>
            <span className="font-mono text-[12.5px] whitespace-nowrap text-ash">{n.repo_path.split("/").pop()}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function CodeRoot() {
  const { monorepo } = Route.useRouteContext();
  const plain = usePlainRepo();
  const repos = useSuspenseQuery(reposQuery(monorepo)).data;
  const open = useOpenCounts(monorepo, repos);

  if (plain) return <ProjectCode repo={plain} dir="" gitRef={Route.useLoaderDeps().ref} />;

  return (
    <>
      <MonorepoHead tab="code" />
      <Root monorepo={monorepo} repos={repos} open={open} />
    </>
  );
}

function Root({ monorepo, repos, open }: { monorepo: MonorepoRef; repos: readonly Repo[]; open: (number | undefined)[] }) {
  const tree = useSuspenseQuery(treeQuery(monorepo, "")).data;
  const latest = useSuspenseQuery(latestQuery(monorepo, tree.head)).data;
  const readme = readmeOf("", tree.files);
  const full = monorepo.full;
  const total = open.every((n) => n !== undefined) ? open.reduce<number>((a, n) => a + (n ?? 0), 0) : null;
  const heads = useSuspenseQuery(headsQuery(monorepo)).data;
  const rows = folderRows(full, "", tree.folders, tree.files, heads);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-14 narrow:grid-cols-[minmax(0,1fr)] narrow:gap-10">
      <section aria-label="Files">
        <div className="mb-3.5 flex items-center gap-4 phone:flex-wrap">
          {repos.length ? (
            <Lnk {...treeLink(full, "projects")} className="text-[13px]">
              {repos.length} project{repos.length === 1 ? "" : "s"}
            </Lnk>
          ) : null}
          {total === null ? null : (
            <span className="font-mono text-[13px] leading-[16px] text-ash">
              {total} open branch{total === 1 ? "" : "es"}
            </span>
          )}
          <span className="relative ml-auto">
            <Clone full={full} repos={repos} plain={false} />
          </span>
        </div>
        {rows.length ? (
          <FileList bar={latest ? versionBar(latest, latest.path, tabLink(full, "activity")) : null} rows={rows} />
        ) : (
          <Empty>No files yet.</Empty>
        )}
        {readme ? <ReadmeFor monorepo={monorepo} path={readme} /> : null}
      </section>
      <Side monorepo={monorepo} repos={repos} open={open} />
    </div>
  );
}
