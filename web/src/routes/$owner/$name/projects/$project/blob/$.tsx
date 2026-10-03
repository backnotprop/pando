import { createFileRoute } from "@tanstack/react-router";
import { fileSearch } from "../../../../../../api/search";
import { loadFile, ProjectFile } from "../../../-project/File";

export const Route = createFileRoute("/$owner/$name/projects/$project/blob/$")({
  validateSearch: fileSearch,
  loaderDeps: ({ search }) => ({ ref: search.ref ?? null }),
  loader: ({ context: { queryClient, monorepo, repo }, params, deps }) => loadFile(queryClient, monorepo, repo, params._splat ?? "", deps.ref),
  component: function File() {
    const { repo } = Route.useRouteContext();

    return <ProjectFile repo={repo} path={Route.useParams()._splat ?? ""} gitRef={Route.useLoaderDeps().ref} />;
  },
});
