// A plain repo's branch page.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { branchSearch } from "../../../../api/search";
import { artifactsAt, BranchPage, loadBranch } from "../-project/Branch";
import { plainRepo } from "../-project/Branches";

export const Route = createFileRoute("/$owner/$name/branches/$")({
  beforeLoad: async ({ context: { queryClient, monorepo } }) => {
    const repo = await plainRepo(queryClient, monorepo);

    if (!repo) throw notFound();

    return { repo };
  },
  validateSearch: branchSearch,
  loaderDeps: ({ search }) => ({ files: search.tab === "files", sessions: search.tab === "sessions", guide: search.tab === "review" }),
  loader: ({ context: { queryClient, monorepo, repo }, params, deps }) => loadBranch(queryClient, monorepo, repo, params._splat ?? "", deps.files, deps.guide),
  component: function Branch() {
    const { repo } = Route.useRouteContext();

    return <BranchPage repo={repo} branch={Route.useParams()._splat ?? ""} files={Route.useLoaderDeps().files} sessions={Route.useLoaderDeps().sessions} guide={Route.useLoaderDeps().guide} artifacts={artifactsAt(Route.useSearch())} />;
  },
});
