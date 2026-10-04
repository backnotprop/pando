import { createFileRoute } from "@tanstack/react-router";
import { BranchPage, loadBranch } from "../../../-project/Branch";

export const Route = createFileRoute("/$owner/$name/projects/$project/branches/$")({
  loader: ({ context: { queryClient, monorepo, repo }, params }) => loadBranch(queryClient, monorepo, repo, params._splat ?? ""),
  component: function Branch() {
    const { repo } = Route.useRouteContext();

    return <BranchPage repo={repo} branch={Route.useParams()._splat ?? ""} />;
  },
});
