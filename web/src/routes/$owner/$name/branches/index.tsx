// A plain repo's branches (a monorepo's projects have theirs under projects/<project>/branches).
import { createFileRoute, notFound } from "@tanstack/react-router";
import { branchesSearch } from "../../../../api/search";
import { BranchList, loadBranches, plainRepo } from "../-project/Branches";

export const Route = createFileRoute("/$owner/$name/branches/")({
  validateSearch: branchesSearch,
  loaderDeps: ({ search }) => ({ merged: search.tab === "merged" }),
  beforeLoad: async ({ context: { queryClient, monorepo } }) => {
    const repo = await plainRepo(queryClient, monorepo);

    if (!repo) throw notFound();

    return { repo };
  },
  loader: ({ context: { queryClient, monorepo, repo } }) => loadBranches(queryClient, monorepo, repo),
  component: function Branches() {
    const { repo } = Route.useRouteContext();

    return <BranchList repo={repo} merged={Route.useLoaderDeps().merged} />;
  },
});
