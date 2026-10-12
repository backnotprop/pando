// A repo's code at a ref, one folder at a time like GitHub (owner ruling): the
// branch picker, the latest-change bar, folders then files with each one's last
// commit, and the folder's README. On a branch, a line says how far ahead of
// main it is.
import { type QueryClient, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { MonorepoRef } from "../../../../api/names";
import type { CommitLine, Repo } from "@pando/contract";
import { branchesQuery, branchQuery, codeFileQuery, codeTreeQuery, lastCommitsQuery } from "../../../../api/projects";
import { openBranchesQuery, reposQuery } from "../../../../api/queries";
import { releasesQuery, summaryQuery } from "../../../../api/releases";
import { Empty, lnk } from "../../../../ui/controls";
import { useHeld, useLastAnswer } from "../../../../ui/held";
import { branchesLink, branchLink, codeBlobLink, codeLink, codeRawHref, commitLink } from "../../../../ui/paths";
import { Clone } from "../-code/Clone";
import { BarSpace, ChangeBar, FileList, Readme, type Row } from "../-code/FileList";
import { PathTrail } from "../-code/PathTrail";
import { RepoHead, useMonorepo } from "../-frame/heads";
import { BranchPicker } from "./Picker";
import { Strip } from "./Strip";

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** A full commit sha is a pinned ref, not a branch. */
export const isBranch = (ref: string | null): ref is string => !!ref && !/^[0-9a-f]{40}$/.test(ref);

/** The root folder of the default branch: where the strip shows. */
const onMainRoot = (repo: Repo, dir: string, ref: string | null) => !dir && (ref ?? repo.default_branch) === repo.default_branch;

const readmeIn = (names: readonly string[]) => names.find((n) => /^readme\.md$/i.test(n)) ?? null;

export async function loadCode(qc: QueryClient, m: MonorepoRef, repo: Repo, dir: string, ref: string | null) {
  // The Branches tab's count and "N open branches", read alongside the tree (quicker than it), so neither draws late.
  const open = qc.prefetchQuery(openBranchesQuery(m, repo.name));
  // The strip over main's root folder, read alongside the tree and waited for with the README, so the files never move
  // under it; and the Releases tab's count, never waited for.
  const strip = onMainRoot(repo, dir, ref) ? qc.prefetchQuery(summaryQuery(m, repo.name)) : null;
  void qc.prefetchInfiniteQuery(releasesQuery(m, repo.name));
  const tree = await qc.ensureQueryData(codeTreeQuery(m, repo.name, ref, dir));

  if (!tree) return open;

  const readme = readmeIn(tree.entries.map((e) => e.name));

  // The page waits for its files only; each row's last commit, the ahead line and the picker fill in as they arrive.
  void qc.prefetchQuery(lastCommitsQuery(m, repo.name, tree.commit, dir));
  void qc.prefetchInfiniteQuery(branchesQuery(m, repo.name, "open"));

  if (isBranch(ref)) void qc.prefetchQuery(branchQuery(m, repo.name, ref));

  await Promise.all([readme ? qc.ensureQueryData(codeFileQuery(m, repo, tree.commit, join(dir, readme))) : null, open, strip]);
}

/** "web-api is 2 commits ahead of main." with its page a click away. */
function AheadLine({ repo, gitRef }: { repo: Repo; gitRef: string }) {
  const { monorepo } = useMonorepo();
  const b = useQuery(branchQuery(monorepo, repo.name, gitRef)).data;

  if (!b || b.ahead === null) return null;

  return (
    <p className="mb-3.5 flex items-center gap-3.5 rounded-lg bg-loam px-3.5 py-2.5 text-[13.5px] text-bark-dim">
      <span>
        <code className="text-bark">{gitRef}</code> is {b.ahead} commit{b.ahead === 1 ? "" : "s"} ahead of main
        {b.behind ? ` and ${b.behind} behind` : ""}.
      </span>
      <Link {...branchLink(monorepo.full, repo.path, gitRef)} className={`${lnk} ml-auto`}>
        Open its page
      </Link>
    </p>
  );
}

/** The picker, the open branches, and Clone (or, in a folder, where you are). */
export function Toolbar({ repo, gitRef, at, here }: { repo: Repo; gitRef: string | null; at: Parameters<typeof BranchPicker>[0]["at"]; here?: ReactNode }) {
  const { monorepo, info } = useMonorepo();
  const open = useQuery(openBranchesQuery(monorepo, repo.name)).data;
  const repos = useSuspenseQuery(reposQuery(monorepo)).data;

  return (
    <div className="mb-3.5 flex items-center gap-4 phone:flex-wrap">
      <BranchPicker repo={repo} gitRef={gitRef} at={at} />
      {open === undefined ? null : (
        <Link {...branchesLink(monorepo.full, repo.path)} className={`${lnk} text-[13px]`}>
          {open} open branch{open === 1 ? "" : "es"}
        </Link>
      )}
      {here ? (
        here
      ) : (
        <span className="relative ml-auto">
          <Clone full={monorepo.full} repos={repos} plain={info.kind === "repo"} only={repo} />
        </span>
      )}
    </div>
  );
}

function CodeReadme({ repo, commit, path, gitRef }: { repo: Repo; commit: string; path: string; gitRef: string | null }) {
  const { monorepo } = useMonorepo();
  const text = useSuspenseQuery(codeFileQuery(monorepo, repo, commit, path)).data.text;
  const full = monorepo.full;

  return text === null ? null : (
    <Readme path={path} text={text} raw={codeRawHref(full, repo.path, path, commit)} fileLink={(p) => codeBlobLink(full, repo.path, p, gitRef)} />
  );
}

export function ProjectCode({ repo, dir, gitRef }: { repo: Repo; dir: string; gitRef: string | null }) {
  const { monorepo } = useMonorepo();
  const full = monorepo.full;
  // Held while a moved ref's new commit is read (its README), so the folder stays on screen (ui/held.ts).
  const at = `${repo.name}:${gitRef ?? ""}:${dir}`;
  const tree = useHeld(at, useSuspenseQuery(codeTreeQuery(monorepo, repo.name, gitRef, dir)).data);
  // The last answer for this ref and folder stays while a moved ref's is read (ui/held.ts).
  const last = useLastAnswer(at, useQuery({ ...lastCommitsQuery(monorepo, repo.name, tree?.commit ?? "", dir), enabled: !!tree }).data);
  // Where you are, each folder a link, as on a file's page (PathTrail).
  const here = dir ? <PathTrail inline root={repo.path === "." ? monorepo.name : repo.path} folder={(d) => codeLink(full, repo.path, d, gitRef)} path={dir} /> : undefined;
  const toolbar = <Toolbar repo={repo} gitRef={gitRef} at={(ref) => codeLink(full, repo.path, dir, ref)} here={here} />;

  if (!tree) {
    return (
      <>
        <RepoHead repo={repo} tab="code" />
        <div className="max-w-[1000px]">
          {toolbar}
          <Empty>No commits yet.</Empty>
        </div>
      </>
    );
  }

  const commitOf = (name: string) => last?.entries[name] ?? null;
  const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";

  const rows: Row[] = [
    ...(dir ? [{ kind: "up" as const, name: "..", link: codeLink(full, repo.path, parent, gitRef), change: "", at: null }] : []),
    ...tree.entries.map(
      (e): Row => ({
        kind: e.type === "dir" ? "dir" : "file",
        name: e.name,
        link: e.type === "dir" ? codeLink(full, repo.path, join(dir, e.name), gitRef) : codeBlobLink(full, repo.path, join(dir, e.name), gitRef),
        change: commitOf(e.name)?.title ?? "",
        at: commitOf(e.name) ? Date.parse(commitOf(e.name)?.at ?? "") : null,
      }),
    ),
  ];

  const newest = Object.values(last?.entries ?? {}).reduce<CommitLine | null>((a, c) => (c && (!a || c.at > a.at) ? c : a), null);
  // History: on main, what landed; on a branch, its own page.
  const history = isBranch(gitRef) ? branchLink(full, repo.path, gitRef) : branchesLink(full, repo.path, true);
  const readme = readmeIn(tree.entries.map((e) => e.name));

  return (
    <>
      <RepoHead repo={repo} tab="code" />
      <div className="max-w-[1000px]">
        {toolbar}
        {isBranch(gitRef) ? <AheadLine repo={repo} gitRef={gitRef} /> : null}
        {onMainRoot(repo, dir, gitRef) ? <Strip repo={repo} /> : null}
        <FileList
          bar={
            newest ? (
              <ChangeBar who={newest.author.name ?? ""} title={newest.title} id={newest.sha.slice(0, 7)} sha idLink={commitLink(full, repo.path, newest.sha)} at={Date.parse(newest.at)} history={history} />
            ) : last?.complete ? null : (
              <BarSpace />
            )
          }
          rows={rows}
        />
        {readme ? <CodeReadme repo={repo} commit={tree.commit} path={join(dir, readme)} gitRef={gitRef} /> : null}
      </div>
    </>
  );
}
