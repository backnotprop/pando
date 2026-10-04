import { createFileRoute } from "@tanstack/react-router";
import { refSearch } from "../../../../../../api/search";
import { loadHistory, ProjectHistory } from "../../../-project/History";

export const Route = createFileRoute("/$owner/$name/projects/$project/history/$")({
  validateSearch: refSearch,
  loaderDeps: ({ search }) => ({ ref: search.ref ?? null }),
  loader: ({ context: { queryClient, monorepo, repo }, params, deps }) => loadHistory(queryClient, monorepo, repo, params._splat ?? "", deps.ref),
  component: function History() {
    const { repo } = Route.useRouteContext();

    return <ProjectHistory repo={repo} path={Route.useParams()._splat ?? ""} gitRef={Route.useLoaderDeps().ref} />;
  },
});
