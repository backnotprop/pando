// A plain repo's branch page.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { BranchPage, loadBranch } from "../-project/Branch";
import { plainRepo } from "../-project/Branches";

export const Route = createFileRoute("/$owner/$name/branches/$")({
  beforeLoad: async ({ context: { queryClient, monorepo } }) => {
    const repo = await plainRepo(queryClient, monorepo);

    if (!repo) throw notFound();

    return { repo };
  },
  loader: ({ context: { queryClient, monorepo, repo }, params }) => loadBranch(queryClient, monorepo, repo, params._splat ?? ""),
  component: function Branch() {
    const { repo } = Route.useRouteContext();

    return <BranchPage repo={repo} branch={Route.useParams()._splat ?? ""} />;
  },
});
