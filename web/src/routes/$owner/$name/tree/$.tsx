// One folder of the root files, as a list with `..` to go up, and its README.
// `projects/` lists the monorepo's code repos.
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { fileQuery, reposQuery, treeQuery } from "../../../../api/queries";
import { Empty } from "../../../../ui/controls";
import { tabLink, treeLink } from "../../../../ui/paths";
import { FileList, Readme, type Row, versionBar } from "../-code/FileList";
import { folderRows, newest, projectRows, readmeOf } from "../-code/rows";

export const Route = createFileRoute("/$owner/$name/tree/$")({
  loader: async ({ context: { queryClient, monorepo }, params }) => {
    const dir = params._splat ?? "";

    if (dir === "projects") return void (await queryClient.ensureQueryData(reposQuery(monorepo)));
    const tree = await queryClient.ensureQueryData(treeQuery(monorepo, dir));

    if (!tree.files.length && !tree.folders.length) throw notFound();
    const readme = readmeOf(dir, tree.files);

    if (readme) await queryClient.ensureQueryData(fileQuery(monorepo, readme, null));
  },
  component: Folder,
});

function Projects() {
  const { monorepo } = Route.useRouteContext();
  const repos = useSuspenseQuery(reposQuery(monorepo)).data;
  const up: Row = { kind: "up", name: "..", link: treeLink(monorepo.full, ""), change: "", at: null };

  return repos.length ? <FileList bar={null} rows={[up, ...projectRows(monorepo.full, repos)]} /> : <Empty>No projects yet.</Empty>;
}

function Files({ dir }: { dir: string }) {
  const { monorepo } = Route.useRouteContext();
  const tree = useSuspenseQuery(treeQuery(monorepo, dir)).data;
  const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  const up: Row = { kind: "up", name: "..", link: treeLink(monorepo.full, parent), change: "", at: null };
  const latest = newest(tree.files);
  const readme = readmeOf(dir, tree.files);

  return (
    <>
      <FileList
        bar={latest ? versionBar(latest, latest.path.slice(dir.length + 1), tabLink(monorepo.full, "activity")) : null}
        rows={[up, ...folderRows(monorepo.full, dir, tree.folders, tree.files, [])]}
      />
      {readme ? <FolderReadme path={readme} /> : null}
    </>
  );
}

function FolderReadme({ path }: { path: string }) {
  const { monorepo } = Route.useRouteContext();
  const text = useSuspenseQuery(fileQuery(monorepo, path, null)).data.text;

  return text === null ? null : <Readme name={path.slice(path.lastIndexOf("/") + 1)} text={text} />;
}

function Folder() {
  const dir = Route.useParams()._splat ?? "";

  return <div className="max-w-[1000px]">{dir === "projects" ? <Projects /> : <Files dir={dir} />}</div>;
}
