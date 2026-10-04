import { createFileRoute } from "@tanstack/react-router";
import { refSearch } from "../../../../../api/search";
import { loadCode, ProjectCode } from "../../-project/Code";

export const Route = createFileRoute("/$owner/$name/projects/$project/")({
  validateSearch: refSearch,
  loaderDeps: ({ search }) => ({ ref: search.ref ?? null }),
  loader: ({ context: { queryClient, monorepo, repo }, deps }) => loadCode(queryClient, monorepo, repo, "", deps.ref),
  component: function Code() {
    const { repo } = Route.useRouteContext();

    return <ProjectCode repo={repo} dir="" gitRef={Route.useLoaderDeps().ref} />;
  },
});
