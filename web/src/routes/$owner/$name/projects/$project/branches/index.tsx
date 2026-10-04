import { createFileRoute } from "@tanstack/react-router";
import { branchesSearch } from "../../../../../../api/search";
import { BranchList, loadBranches } from "../../../-project/Branches";

export const Route = createFileRoute("/$owner/$name/projects/$project/branches/")({
  validateSearch: branchesSearch,
  loaderDeps: ({ search }) => ({ merged: search.tab === "merged" }),
  loader: ({ context: { queryClient, monorepo, repo } }) => loadBranches(queryClient, monorepo, repo),
  component: function Branches() {
    const { repo } = Route.useRouteContext();

    return <BranchList repo={repo} merged={Route.useLoaderDeps().merged} />;
  },
});
