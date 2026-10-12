import { createFileRoute } from "@tanstack/react-router";
import { CommitPage, loadCommit, NoCommit } from "../../../-project/Commit";

export const Route = createFileRoute("/$owner/$name/projects/$project/commit/$sha")({
  loader: ({ context: { queryClient, monorepo, repo }, params }) => loadCommit(queryClient, monorepo, repo, params.sha),
  component: function Commit() {
    return <CommitPage repo={Route.useRouteContext().repo} sha={Route.useParams().sha} />;
  },
  notFoundComponent: function Missing() {
    return <NoCommit repo={Route.useRouteContext().repo} sha={Route.useParams().sha} />;
  },
});
