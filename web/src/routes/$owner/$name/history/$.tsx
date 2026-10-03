// A root file's history, its own page like GitHub's: every save grouped by
// day, newest first, each with View and Restore. A restore is a new version
// every machine receives; history is never rewritten.
import { useMutation, useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useState } from "react";
import { restore } from "../../../../api/actions";
import type { MetaVersion } from "@pando/contract";
import { historyQuery } from "../../../../api/queries";
import { refSearch } from "../../../../api/search";
import { Avatar } from "../../../../ui/Avatar";
import { Cmd, lnk } from "../../../../ui/controls";
import { CommitIcon } from "../../../../ui/Icons";
import { blobLink } from "../../../../ui/paths";
import { ago, day, useNow } from "../../../../ui/time";
import { Older } from "../../../../ui/Older";
import { saverOf } from "../-code/FileList";
import { MonorepoHead, usePlainRepo } from "../-frame/heads";
import { plainRepo } from "../-project/Branches";
import { loadHistory, ProjectHistory } from "../-project/History";

export const Route = createFileRoute("/$owner/$name/history/$")({
  validateSearch: refSearch,
  loaderDeps: ({ search }) => ({ ref: search.ref ?? null }),
  loader: async ({ context: { queryClient, monorepo }, params, deps }) => {
    const repo = await plainRepo(queryClient, monorepo);

    if (repo) return void (await loadHistory(queryClient, monorepo, repo, params._splat ?? "", deps.ref));

    const first = await queryClient.ensureInfiniteQueryData(historyQuery(monorepo, params._splat ?? ""));

    if (!first.pages[0]?.versions.length) throw notFound();
  },
  component: function HistoryPage() {
    const plain = usePlainRepo();

    return plain ? <ProjectHistory repo={plain} path={Route.useParams()._splat ?? ""} gitRef={Route.useLoaderDeps().ref} /> : <History />;
  },
});

const titleOf = (v: MetaVersion) =>
  v.restored_from ? `Restored from version ${v.restored_from}` : v.deleted ? `Deleted in version ${v.version}` : `Saved version ${v.version}`;

function VersionRow({ v, current, fresh, onRestore }: { v: MetaVersion; current: boolean; fresh: boolean; onRestore: (version: number) => void }) {
  const { monorepo } = Route.useRouteContext();
  const clock = useNow();
  const who = saverOf(v);

  return (
    <li className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t border-rule-faint px-4 py-2.5 first:border-t-0 ${fresh ? "arrived" : ""}`}>
      <div>
        <p className="fox-cool overflow-hidden text-[14px] text-ellipsis whitespace-nowrap text-bark">{titleOf(v)}</p>
        <p className="mt-[5px] flex items-center gap-[7px] text-[12.5px] text-ash">
          <Avatar name={who} size={16} />
          <b className="fox-cool font-normal text-bark-dim">{who}</b> saved on {v.machine}, {ago(v.at, clock)}
        </p>
      </div>
      <div className="flex items-center gap-4">
        <span className="font-mono text-[12.5px] leading-[15px] text-ash">v{v.version}</span>
        {current ? (
          <span className="text-[12px] text-ash">current</span>
        ) : (
          <>
            {v.deleted ? null : (
              <Link {...blobLink(monorepo.full, v.path, v.version)} className={lnk}>
                View
              </Link>
            )}
            <button type="button" className={`${lnk} text-[14px]`} onClick={() => onRestore(v.version)}>
              Restore
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function History() {
  const { monorepo } = Route.useRouteContext();
  const path = Route.useParams()._splat ?? "";
  const queryClient = useQueryClient();
  const log = useSuspenseInfiniteQuery(historyQuery(monorepo, path));
  const [fresh, setFresh] = useState<number | null>(null);

  const restoring = useMutation({
    mutationFn: (version: number) => restore(monorepo, path, version),
    onSuccess: async (out) => {
      setFresh(out.version);
      await queryClient.invalidateQueries({ queryKey: ["m", monorepo.owner, monorepo.name, "meta"] });
    },
  });

  const versions = log.data.pages.flatMap((p) => p.versions);
  const days: { day: string; versions: MetaVersion[] }[] = [];

  for (const v of versions) {
    const d = day(v.at);
    const last = days.at(-1);

    if (last?.day === d) last.versions.push(v);
    else days.push({ day: d, versions: [v] });
  }

  return (
    <>
      <MonorepoHead tab="code" />
      <div className="max-w-[1000px]">
      <div className="mb-[22px] flex items-center justify-between gap-8 phone:flex-col phone:items-start phone:gap-4">
        <h2 className="flex items-baseline gap-2.5 text-[17px] leading-6 font-semibold">
          History of <code className="text-[15px]">{path}</code>
        </h2>
        <Cmd text={`pando history ${path}`} />
      </div>
      {days.map((d, i) => (
        <section key={d.day} className={i ? "mt-7" : ""}>
          <h3 className="mb-2.5 flex items-center gap-2 text-[13px] leading-[15px] text-bark-dim">
            <CommitIcon className="size-3.5 text-ash" />
            Saves on {d.day}
          </h3>
          <ul className="overflow-hidden rounded-[10px] border border-rootline">
            {d.versions.map((v) => (
              <VersionRow key={v.version} v={v} current={v === versions[0]} fresh={v.version === fresh} onRestore={(n) => restoring.mutate(n)} />
            ))}
          </ul>
        </section>
      ))}
      {log.hasNextPage ? <Older more loading={log.isFetchingNextPage} load={() => void log.fetchNextPage()} none="" /> : null}
      </div>
    </>
  );
}
