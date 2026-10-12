// A plain repo's commit page.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { plainRepo } from "../-project/Branches";
import { CommitPage, loadCommit, NoCommit } from "../-project/Commit";

export const Route = createFileRoute("/$owner/$name/commit/$sha")({
  beforeLoad: async ({ context: { queryClient, monorepo } }) => {
    const repo = await plainRepo(queryClient, monorepo);

    if (!repo) throw notFound();

    return { repo };
  },
  loader: ({ context: { queryClient, monorepo, repo }, params }) => loadCommit(queryClient, monorepo, repo, params.sha),
  component: function Commit() {
    return <CommitPage repo={Route.useRouteContext().repo} sha={Route.useParams().sha} />;
  },
  notFoundComponent: function Missing() {
    return <NoCommit repo={Route.useRouteContext().repo} sha={Route.useParams().sha} />;
  },
});
