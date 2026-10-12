import { createFileRoute } from "@tanstack/react-router";
import { loadReleases, ReleaseList } from "../../../-project/Releases";

export const Route = createFileRoute("/$owner/$name/projects/$project/releases/")({
  loader: ({ context: { queryClient, monorepo, repo } }) => loadReleases(queryClient, monorepo, repo),
  component: function Releases() {
    const { repo } = Route.useRouteContext();

    return <ReleaseList repo={repo} />;
  },
});
