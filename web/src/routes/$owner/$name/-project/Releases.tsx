// A repo's releases (research/plans/releases-2026-10-04, mocks at
// research/design/pando-ui-2026-10-03/releases): the Releases tab, newest
// first with drafts (members see them), and a release's page: its files with
// size, SHA-256 and Download, its notes through Plannotator's viewer, its
// commit on main and that commit's checks. The web shows releases; making,
// publishing, uploading and deleting are `pando release` and the API.
import type { QueryClient } from "@tanstack/react-query";
import { useInfiniteQuery, useQuery, useQueryClient, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { Release, Repo } from "@pando/contract";
import { codeHistoryQuery } from "../../../../api/projects";
import { fileSize, releaseFileHref, releaseQuery, releasesKey, releasesQuery, repoQuery } from "../../../../api/releases";
import { openBranchesQuery } from "../../../../api/queries";
import type { MonorepoRef } from "../../../../api/names";
import { fallback, RELEASE_TOPICS, useRows } from "../../../../live/rows";
import { Avatar } from "../../../../ui/Avatar";
import { button, Cmd, Empty, SectionHead } from "../../../../ui/controls";
import { DownloadIcon, FileIcon, TagIcon } from "../../../../ui/Icons";
import { Older } from "../../../../ui/Older";
import { codeLink, releaseLink } from "../../../../ui/paths";
import { refClass } from "../../../../ui/Ref";
import { ago, useNow } from "../../../../ui/time";
import { Markdown } from "../-issues/Markdown";
import { RepoHead, useMonorepo } from "../-frame/heads";
import { CheckRows } from "./Branch";

export const loadReleases = (qc: QueryClient, m: MonorepoRef, repo: Repo) =>
  Promise.all([qc.ensureInfiniteQueryData(releasesQuery(m, repo.name)), qc.prefetchQuery(openBranchesQuery(m, repo.name))]);

/** The release, and the list (which says whether it is the latest), so its chip is there at once; the switch's word follows. */
export const loadRelease = (qc: QueryClient, m: MonorepoRef, repo: Repo, tag: string) => {
  void qc.prefetchQuery(repoQuery(m, repo.name));

  return Promise.all([qc.ensureQueryData(releaseQuery(m, repo.name, tag)), qc.prefetchInfiniteQuery(releasesQuery(m, repo.name))]);
};

/** The page's releases stay current from the repo's release rows; while the socket is down, they are read every 5 s. */
function useReleaseRows(repo: Repo) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();

  return useRows(monorepo, RELEASE_TOPICS, () => void qc.invalidateQueries({ queryKey: releasesKey(monorepo, repo.name) }));
}

const CHIPS = {
  latest: "text-bark shadow-[inset_0_0_0_1px_var(--ash-half)]",
  draft: "text-bark-dim shadow-[inset_0_0_0_1px_var(--rule-hi)]",
  forced: "text-rust shadow-[inset_0_0_0_1px_var(--rust-half)]",
};

/** Latest, Draft or Forced (published past red or missing checks). */
function Chip({ kind }: { kind: keyof typeof CHIPS }) {
  return (
    <span
      title={kind === "forced" ? "Published past red or missing checks" : undefined}
      className={`inline-flex h-5 flex-none items-center rounded-[5px] px-[7px] text-[12px] leading-5 font-normal tracking-normal ${CHIPS[kind]}`}
    >
      {kind === "latest" ? "Latest" : kind === "draft" ? "Draft" : "Forced"}
    </span>
  );
}

const chipsOf = (r: Release, latest: boolean) => (
  <>
    {latest ? <Chip kind="latest" /> : null}
    {r.draft ? <Chip kind="draft" /> : null}
    {r.forced ? <Chip kind="forced" /> : null}
  </>
);

/** "published 2 d ago", or a draft's "made 20 min ago". */
const when = (r: Release, clock: number) => (r.draft || !r.published_at ? `made ${ago(r.created_at, clock)}` : `published ${ago(r.published_at, clock)}`);

const who = (r: Release) => (r.draft ? r.created_by : (r.published_by ?? r.created_by));

const filesWord = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/** The command that makes the first release. */
const FIRST = "pando release create v0.1.0 --generate";

export function ReleaseList({ repo }: { repo: Repo }) {
  const { monorepo } = useMonorepo();
  const clock = useNow();
  const live = useReleaseRows(repo);
  const list = useSuspenseInfiniteQuery({ ...releasesQuery(monorepo, repo.name), refetchInterval: fallback(live) });
  const releases = list.data.pages.flatMap((p) => p.releases);
  // Newest first: the first published one is the latest.
  const latest = releases.find((r) => !r.draft)?.tag ?? null;

  return (
    <>
      <RepoHead repo={repo} tab="releases" />
      <div className="max-w-[1000px]">
        {!releases.length ? (
          <>
            <Empty>No releases yet.</Empty>
            <div className="mt-1.5">
              <Cmd text={FIRST} />
            </div>
          </>
        ) : (
          <ul aria-label="Releases" className="rounded-[10px] border border-rootline">
            {releases.map((r) => (
              <li key={r.tag} className="border-t border-rule-faint first:border-t-0">
                <Link
                  {...releaseLink(monorepo.full, repo.path, r.tag)}
                  className="group grid grid-cols-[150px_minmax(0,1fr)_auto] items-baseline gap-x-[18px] gap-y-1 px-4 py-3.5 first:rounded-t-[10px] hover:bg-air focus-visible:bg-air phone:grid-cols-[minmax(0,1fr)_auto] phone:gap-x-3"
                >
                  <span className="inline-flex min-w-0 items-center gap-[7px]">
                    <TagIcon className="size-3.5 flex-none text-ash" />
                    <span className={`${refClass("object", { mono: true })} overflow-hidden text-[13.5px] text-ellipsis whitespace-nowrap`}>{r.tag}</span>
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[14px] text-bark phone:col-span-2 phone:row-start-2">
                    <span className="min-w-0">{r.title}</span>
                    {chipsOf(r, r.tag === latest)}
                  </span>
                  <span className="col-start-3 row-span-2 row-start-1 flex items-center gap-1.5 self-center text-[13px] whitespace-nowrap text-ash phone:col-start-2 phone:row-span-1 phone:self-baseline">
                    {r.files.length ? (
                      <>
                        <DownloadIcon className="size-3.5" />
                        {filesWord(r.files.length)}
                      </>
                    ) : r.draft ? null : (
                      "no files"
                    )}
                  </span>
                  <span className="col-start-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-ash phone:col-span-2 phone:col-start-1 phone:row-start-3">
                    <Avatar name={who(r)} size={16} />
                    <span className="font-semibold text-bark">{who(r)}</span>
                    <span>{when(r, clock)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono text-[12.5px]">{r.sha.slice(0, 7)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage ? <Older more loading={list.isFetchingNextPage} load={() => void list.fetchNextPage()} none="" /> : null}
      </div>
    </>
  );
}

/** Its files: name, size, SHA-256 (the first 12, all of it on hover) and Download. A phone keeps the name and Download. */
function Files({ repo, r }: { repo: Repo; r: Release }) {
  const { monorepo } = useMonorepo();
  const open = useQuery(repoQuery(monorepo, repo.name)).data?.releases_public;
  const right = open === undefined ? undefined : <span className="text-ash">{open ? "Anyone can download" : "Members only"}</span>;

  return (
    <section aria-label="Files" className="mt-[34px]">
      <SectionHead title="Files" count={r.files.length} right={right} />
      {r.files.length ? (
        <ul className="rounded-[10px] border border-rootline">
          {r.files.map((f) => (
            <li
              key={f.name}
              className="grid min-h-[42px] grid-cols-[16px_minmax(0,1fr)_72px_120px_auto] items-center gap-3.5 border-t border-rule-faint py-1 pr-2 pl-4 first:border-t-0 phone:grid-cols-[16px_minmax(0,1fr)_auto] phone:pl-3"
            >
              <FileIcon className="size-4 text-ash" />
              <span className="overflow-hidden font-mono text-[13px] text-ellipsis whitespace-nowrap text-bark">{f.name}</span>
              <span className="text-right text-[12.5px] whitespace-nowrap text-ash phone:hidden">{fileSize(f.size)}</span>
              <span title={`SHA-256 ${f.sha256}`} className="font-mono text-[12px] text-ash phone:hidden">
                {f.sha256.slice(0, 12)}
              </span>
              <a href={releaseFileHref(monorepo, repo.name, r.tag, f.name)} download={f.name} aria-label={`Download ${f.name}`} className={`${button("quiet", 28)} gap-1.5 px-3`}>
                <DownloadIcon className="size-3.5" />
                <span className="phone:hidden">Download</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <Empty>None yet.</Empty>
          <div className="mt-1">
            <Cmd text={`pando release upload ${r.tag} dist/*`} />
          </div>
        </>
      )}
    </section>
  );
}

/** Its commit on main, with the commit's title once read. */
function CommitBlock({ repo, r }: { repo: Repo; r: Release }) {
  const { monorepo } = useMonorepo();
  const commit = useInfiniteQuery(codeHistoryQuery(monorepo, repo.name, r.sha, "")).data?.pages[0]?.commits[0];

  return (
    <div className="mb-[30px]">
      <SectionHead title="Commit" className="mb-3" />
      <div className="grid gap-2 text-[13.5px] text-bark-dim">
        <span>
          <Link {...codeLink(monorepo.full, repo.path, "", r.sha)} className={refClass("object", { mono: true })}>
            {r.sha.slice(0, 7)}
          </Link>{" "}
          on <span className="font-mono text-[13px] text-bark">{repo.default_branch}</span>
        </span>
        {commit?.sha === r.sha ? <span>{commit.title}</span> : null}
      </div>
    </div>
  );
}

function Side({ repo, r, live }: { repo: Repo; r: Release; live: boolean }) {
  return (
    <aside aria-label="Commit and checks">
      <CommitBlock repo={repo} r={r} />
      {r.checks ? (
        <div>
          <SectionHead title="Checks" className="mb-3" />
          <CheckRows repo={repo} branch={repo.default_branch} sha={r.sha} checks={r.checks} live={live} />
        </div>
      ) : null}
    </aside>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return <p className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[14px] text-bark-dim">{children}</p>;
}

export function ReleasePage({ repo, tag }: { repo: Repo; tag: string }) {
  const { monorepo } = useMonorepo();
  const clock = useNow();
  const live = useReleaseRows(repo);
  const r = useSuspenseQuery({ ...releaseQuery(monorepo, repo.name, tag), refetchInterval: fallback(live) }).data;
  // Latest: the newest published release, as the list says it.
  const latest = useInfiniteQuery(releasesQuery(monorepo, repo.name)).data?.pages[0]?.releases.find((x) => !x.draft)?.tag === r.tag;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-12 narrow:grid-cols-[minmax(0,1fr)_260px] narrow:gap-10 phone:grid-cols-[minmax(0,1fr)] phone:gap-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
          <h1 className="text-[26px] leading-8 tracking-[-.018em] text-balance phone:text-[22px] phone:leading-7">{r.title}</h1>
          {chipsOf(r, latest)}
        </div>
        <Sub>
          <span className="inline-flex items-center gap-1.5 font-mono text-[13.5px] text-bark">
            <TagIcon className="size-3.5 text-ash" />
            {r.tag}
          </span>
          <span aria-hidden="true" className="text-ash">
            ·
          </span>
          <Avatar name={who(r)} size={18} />
          <span className="font-semibold text-bark">{who(r)}</span>
          <span>{when(r, clock)}</span>
          {r.draft ? (
            <>
              <span aria-hidden="true" className="text-ash">
                ·
              </span>
              <span>no tag until published</span>
            </>
          ) : null}
        </Sub>
        <Files repo={repo} r={r} />
        <section aria-label="Notes" className="mt-[34px] max-w-[760px]">
          <SectionHead title="Notes" />
          {r.notes.trim() ? <Markdown text={r.notes} full={monorepo.full} /> : <Empty>No notes.</Empty>}
        </section>
      </div>
      <div className="phone:mt-8">
        <Side repo={repo} r={r} live={live} />
      </div>
    </div>
  );
}
