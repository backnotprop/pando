import { createFileRoute } from "@tanstack/react-router";
import { branchSearch } from "../../../../../../api/search";
import { BranchPage, loadBranch } from "../../../-project/Branch";

export const Route = createFileRoute("/$owner/$name/projects/$project/branches/$")({
  validateSearch: branchSearch,
  loaderDeps: ({ search }) => ({ files: search.tab === "files" }),
  loader: ({ context: { queryClient, monorepo, repo }, params, deps }) => loadBranch(queryClient, monorepo, repo, params._splat ?? "", deps.files),
  component: function Branch() {
    const { repo } = Route.useRouteContext();

    return <BranchPage repo={repo} branch={Route.useParams()._splat ?? ""} files={Route.useLoaderDeps().files} />;
  },
});
