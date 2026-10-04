// A file in a repo at a ref: the branch picker and where it sits, its last
// commit with History, the tools, then the file (FileView): a document's
// Preview through Plannotator's viewer (`?plain=1` for its code), other text
// plain at once and coloured when the highlighter answers.
import { type QueryClient, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";
import type { MonorepoRef } from "../../../../api/names";
import type { Repo } from "@pando/contract";
import { branchesQuery, codeFileQuery, codeTreeQuery, lastCommitsQuery } from "../../../../api/projects";
import { openBranchesQuery } from "../../../../api/queries";
import { isDoc } from "../../../../ui/doc/Doc";
import { useHeld, useLastAnswer } from "../../../../ui/held";
import { codeBlobLink, codeHistoryLink, codeLink, codeRawHref } from "../../../../ui/paths";
import { loadColourViews } from "../-code/coloured";
import { BarSpace, ChangeBar } from "../-code/FileList";
import { FileShown, FileTools } from "../-code/FileView";
import { PathTrail } from "../-code/PathTrail";
import { RepoHead, useMonorepo } from "../-frame/heads";
import { BranchPicker } from "./Picker";

const split = (path: string) => ({ dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", name: path.slice(path.lastIndexOf("/") + 1) });

export async function loadFile(qc: QueryClient, m: MonorepoRef, repo: Repo, path: string, ref: string | null) {
  const { dir, name } = split(path);
  // The Branches tab's count, read alongside the tree (quicker than it), so the tab never draws without it.
  const open = qc.prefetchQuery(openBranchesQuery(m, repo.name));

  // The coloured view and its worker load alongside the reads, so a file opened first, or by its address, is not left plain.
  void loadColourViews();
  const tree = await qc.ensureQueryData(codeTreeQuery(m, repo.name, ref, dir));

  if (!tree?.entries.some((e) => e.name === name && e.type !== "dir")) throw notFound();

  // The page waits for the bytes only; the last commit and the picker fill in as they arrive.
  void qc.prefetchQuery(lastCommitsQuery(m, repo.name, tree.commit, dir));
  void qc.prefetchInfiniteQuery(branchesQuery(m, repo.name, "open"));
  await Promise.all([qc.ensureQueryData(codeFileQuery(m, repo, tree.commit, path)), open]);
}

export function ProjectFile({ repo, path, gitRef, plain }: { repo: Repo; path: string; gitRef: string | null; plain: boolean }) {
  const { monorepo } = useMonorepo();
  const full = monorepo.full;
  const { dir, name } = split(path);
  // Held while a moved ref's new commit is read, so the file stays on screen (ui/held.ts); the blob's oid comes from the same tree.
  const at = `${repo.name}:${gitRef ?? ""}:${dir}`;
  const tree = useHeld(at, useSuspenseQuery(codeTreeQuery(monorepo, repo.name, gitRef, dir)).data);
  const commit = tree?.commit ?? "";
  // The bytes and the last commit are read at the commit the ref resolved to, so they agree.
  const { text, size } = useSuspenseQuery(codeFileQuery(monorepo, repo, commit, path)).data;
  const oid = tree?.entries.find((e) => e.name === name)?.oid ?? null;
  // The last answer for this ref and folder stays while a moved ref's is read (ui/held.ts).
  const lastCommits = useLastAnswer(at, useQuery(lastCommitsQuery(monorepo, repo.name, commit, dir)).data);
  const last = lastCommits?.entries[name] ?? null;
  const views = { preview: codeBlobLink(full, repo.path, path, gitRef), code: codeBlobLink(full, repo.path, path, gitRef, true), plain };

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
            <ChangeBar who={last.author.name ?? ""} title={last.title} id={last.sha.slice(0, 7)} sha at={Date.parse(last.at)} history={codeHistoryLink(full, repo.path, path, gitRef)} />
          ) : lastCommits?.complete ? null : (
            <BarSpace />
          )}
          <FileTools name={name} text={text} raw={codeRawHref(full, repo.path, path, gitRef)} views={isDoc(name) && text !== null ? views : undefined} />
          <FileShown
            path={path}
            text={text}
            size={size}
            id={oid}
            raw={codeRawHref(full, repo.path, path, commit)}
            views={views}
            fileLink={(p) => codeBlobLink(full, repo.path, p, gitRef)}
          />
        </div>
      </div>
    </>
  );
}
