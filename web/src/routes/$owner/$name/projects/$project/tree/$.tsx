import { createFileRoute } from "@tanstack/react-router";
import { refSearch } from "../../../../../../api/search";
import { loadCode, ProjectCode } from "../../../-project/Code";

export const Route = createFileRoute("/$owner/$name/projects/$project/tree/$")({
  validateSearch: refSearch,
  loaderDeps: ({ search }) => ({ ref: search.ref ?? null }),
  loader: ({ context: { queryClient, monorepo, repo }, params, deps }) => loadCode(queryClient, monorepo, repo, params._splat ?? "", deps.ref),
  component: function Folder() {
    const { repo } = Route.useRouteContext();

    return <ProjectCode repo={repo} dir={Route.useParams()._splat ?? ""} gitRef={Route.useLoaderDeps().ref} />;
  },
});
