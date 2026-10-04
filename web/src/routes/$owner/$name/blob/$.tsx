// A file's page is the file, full width (owner note): its latest change with
// History, then Raw, Copy, Copy link and Copy raw link, then the file. In a
// monorepo these are its root files (`?v=` for an older version); in a plain
// repo, its code (`?ref=` for a branch). The free width on the right is kept
// for Plannotator's comment dock later. A document (Markdown, HTML) opens on
// its Preview, through Plannotator's viewer; `?plain=1` shows its code.
import { Routes } from "@pando/contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { entryQuery, fileQuery } from "../../../../api/queries";
import { fileSearch, versionOf } from "../../../../api/search";
import { lnk } from "../../../../ui/controls";
import { isDoc } from "../../../../ui/doc/Doc";
import { blobLink, historyLink, treeLink } from "../../../../ui/paths";
import { ChangeBar, saverOf } from "../-code/FileList";
import { FileShown, FileTools } from "../-code/FileView";
import { PathTrail } from "../-code/PathTrail";
import { MonorepoHead, usePlainRepo } from "../-frame/heads";
import { plainRepo } from "../-project/Branches";
import { loadFile, ProjectFile } from "../-project/File";

export const Route = createFileRoute("/$owner/$name/blob/$")({
  validateSearch: fileSearch,
  loaderDeps: ({ search }) => ({ v: versionOf(search.v), ref: search.ref ?? null }),
  loader: async ({ context: { queryClient, monorepo }, params, deps }) => {
    const path = params._splat ?? "";
    const repo = await plainRepo(queryClient, monorepo);

    if (repo) return loadFile(queryClient, monorepo, repo, path, deps.ref);

    const [entry, file] = await Promise.allSettled([
      queryClient.ensureQueryData(entryQuery(monorepo, path, deps.v)),
      queryClient.ensureQueryData(fileQuery(monorepo, path, deps.v)),
    ]);

    if (entry.status === "rejected") throw entry.reason;

    if (!entry.value || entry.value.deleted) throw notFound();

    if (file.status === "rejected") throw file.reason;
  },
  component: function File() {
    const repo = usePlainRepo();
    const path = Route.useParams()._splat ?? "";
    const plain = Route.useSearch().plain === "1";

    return repo ? <ProjectFile repo={repo} path={path} gitRef={Route.useLoaderDeps().ref} plain={plain} /> : <RootFile path={path} plain={plain} />;
  },
});

function RootFile({ path, plain }: { path: string; plain: boolean }) {
  const { monorepo } = Route.useRouteContext();
  const { v } = Route.useLoaderDeps();
  const entry = useSuspenseQuery(entryQuery(monorepo, path, v)).data;
  const { text } = useSuspenseQuery(fileQuery(monorepo, path, v)).data;

  if (!entry) return null;

  const full = monorepo.full;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const raw = Routes.metaRawPath(monorepo.owner, monorepo.name, path, v);
  const views = { preview: blobLink(full, path, v), code: blobLink(full, path, v, true), plain };
  const what = entry.restored_from ? `Restored from version ${entry.restored_from}, as version ${entry.version}` : `Saved version ${entry.version}`;

  return (
    <>
      <MonorepoHead tab="code" />
      <div className="max-w-[1000px]">
        <PathTrail root={monorepo.name} folder={(dir) => treeLink(full, dir)} path={path} />
        {v ? (
          <p className="mb-3.5 flex items-center gap-3.5 rounded-lg bg-loam px-3.5 py-2.5 text-[13.5px] text-bark-dim">
            <span>Version {entry.version}</span>
            <Link {...blobLink(full, path)} className={`${lnk} ml-auto`}>
              Back to now
            </Link>
          </p>
        ) : null}
        <div className="overflow-hidden rounded-[10px] border border-rootline">
          <ChangeBar who={saverOf(entry)} title={what} id={`on ${entry.machine}`} at={entry.at} history={historyLink(full, path)} />
          <FileTools name={name} text={text} raw={raw} views={isDoc(name) && !entry.large ? views : undefined} />
          <FileShown path={path} text={entry.large ? null : text} raw={raw} views={views} fileLink={(p) => blobLink(full, p)} />
        </div>
      </div>
    </>
  );
}
