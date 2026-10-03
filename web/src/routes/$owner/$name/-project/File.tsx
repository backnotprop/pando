// A file in a repo at a ref: the branch picker and where it sits, its last
// commit with History, the tools, then the file (plain text with line numbers;
// colour comes with @pierre/diffs in slice 3).
import { type QueryClient, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";
import type { MonorepoRef } from "../../../../api/names";
import type { Repo } from "@pando/contract";
import { branchesQuery, codeFileQuery, codeTreeQuery, lastCommitsQuery } from "../../../../api/projects";
import { codeBlobLink, codeHistoryLink, codeLink, codeRawHref } from "../../../../ui/paths";
import { ChangeBar } from "../-code/FileList";
import { FileBody, FileTools } from "../-code/FileView";
import { PathTrail } from "../-code/PathTrail";
import { RepoHead, useMonorepo } from "../-frame/heads";
import { BranchPicker } from "./Picker";

const split = (path: string) => ({ dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", name: path.slice(path.lastIndexOf("/") + 1) });

export async function loadFile(qc: QueryClient, m: MonorepoRef, repo: Repo, path: string, ref: string | null) {
  const { dir, name } = split(path);
  const tree = await qc.ensureQueryData(codeTreeQuery(m, repo.name, ref, dir));

  if (!tree?.entries.some((e) => e.name === name && e.type !== "dir")) throw notFound();

  // The page waits for the bytes only; the last commit and the picker fill in as they arrive.
  void qc.prefetchQuery(lastCommitsQuery(m, repo.name, tree.commit, dir));
  void qc.prefetchInfiniteQuery(branchesQuery(m, repo.name, "open"));
  await qc.ensureQueryData(codeFileQuery(m, repo.name, tree.commit, path));
}

export function ProjectFile({ repo, path, gitRef }: { repo: Repo; path: string; gitRef: string | null }) {
  const { monorepo } = useMonorepo();
  const full = monorepo.full;
  const { dir, name } = split(path);
  const tree = useSuspenseQuery(codeTreeQuery(monorepo, repo.name, gitRef, dir)).data;
  const commit = tree?.commit ?? "";
  // The bytes and the last commit are read at the commit the ref resolved to, so they agree.
  const { text } = useSuspenseQuery(codeFileQuery(monorepo, repo.name, commit, path)).data;
  const last = useQuery(lastCommitsQuery(monorepo, repo.name, commit, dir)).data?.entries[name] ?? null;

  return (
    <>
      <RepoHead repo={repo} tab="code" />
      <div className="max-w-[1000px]">
        <div className="mb-3.5 flex items-center gap-4 phone:flex-wrap">
          <BranchPicker repo={repo} gitRef={gitRef} at={(ref) => codeBlobLink(full, repo.path, path, ref)} />
          <PathTrail inline root={repo.path === "." ? monorepo.name : repo.path} folder={(d) => codeLink(full, repo.path, d, gitRef)} path={path} />
        </div>
        <div className="overflow-hidden rounded-[10px] border border-rootline">
          {last ? (
            <ChangeBar who={last.author.name ?? ""} title={last.title} id={last.sha.slice(0, 7)} at={Date.parse(last.at)} history={codeHistoryLink(full, repo.path, path, gitRef)} />
          ) : null}
          <FileTools name={name} text={text} raw={codeRawHref(full, repo.path, path, gitRef)} />
          <FileBody name={name} text={text} />
        </div>
      </div>
    </>
  );
}
