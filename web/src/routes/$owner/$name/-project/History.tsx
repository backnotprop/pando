// A code file's history: the commits on the ref that changed it (first
// parents, like the branch's own log), grouped by day, newest first.
import { type QueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { MonorepoRef } from "../../../../api/names";
import type { Repo } from "@pando/contract";
import { codeHistoryQuery } from "../../../../api/projects";
import { Avatar } from "../../../../ui/Avatar";
import { lnk } from "../../../../ui/controls";
import { CommitIcon } from "../../../../ui/Icons";
import { Older } from "../../../../ui/Older";
import { codeBlobLink } from "../../../../ui/paths";
import { ago, day, useNow } from "../../../../ui/time";
import { RepoHead, useMonorepo } from "../-frame/heads";

export const loadHistory = (qc: QueryClient, m: MonorepoRef, repo: Repo, path: string, ref: string | null) =>
  qc.ensureInfiniteQueryData(codeHistoryQuery(m, repo.name, ref, path));

export function ProjectHistory({ repo, path, gitRef }: { repo: Repo; path: string; gitRef: string | null }) {
  const { monorepo } = useMonorepo();
  const clock = useNow();
  const log = useSuspenseInfiniteQuery(codeHistoryQuery(monorepo, repo.name, gitRef, path));
  const commits = log.data.pages.flatMap((p) => p.commits);
  const days: { day: string; commits: typeof commits }[] = [];

  for (const c of commits) {
    const d = day(Date.parse(c.at));
    const last = days.at(-1);

    if (last?.day === d) last.commits.push(c);
    else days.push({ day: d, commits: [c] });
  }

  return (
    <>
      <RepoHead repo={repo} tab="code" />
      <div className="max-w-[1000px]">
        <div className="mb-[22px] flex items-center justify-between gap-8 phone:flex-col phone:items-start phone:gap-4">
          <h2 className="flex items-baseline gap-2.5 text-[17px] leading-6 font-semibold">
            History of <code className="-mb-px text-[15px] leading-6">{path}</code>
          </h2>
          <Link {...codeBlobLink(monorepo.full, repo.path, path, gitRef)} className={lnk}>
            Back to the file
          </Link>
        </div>
        {days.length ? null : <p className="py-2.5 text-[13.5px] text-ash">No history.</p>}
        {days.map((d, i) => (
          <section key={d.day} className={i ? "mt-7" : ""}>
            <h3 className="mb-2.5 flex items-center gap-2 text-[13px] leading-[15px] text-bark-dim">
              <CommitIcon className="size-3.5 text-ash" />
              Commits on {d.day}
            </h3>
            <ul className="overflow-hidden rounded-[10px] border border-rootline">
              {d.commits.map((c) => (
                <li key={c.sha} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t border-rule-faint px-4 py-2.5 first:border-t-0">
                  <div>
                    <p className="overflow-hidden text-[14px] text-ellipsis whitespace-nowrap text-bark">{c.title}</p>
                    <p className="mt-[5px] flex items-center gap-[7px] text-[12.5px] text-ash">
                      {c.author.name ? <Avatar name={c.author.name} size={16} /> : null}
                      <b className="font-normal text-bark-dim">{c.author.name ?? ""}</b> committed, {ago(c.at, clock)}
                    </p>
                  </div>
                  <span className="font-mono text-[12.5px] leading-[15px] text-ash">{c.sha.slice(0, 7)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {log.hasNextPage ? <Older more loading={log.isFetchingNextPage} load={() => void log.fetchNextPage()} none="" /> : null}
      </div>
    </>
  );
}
