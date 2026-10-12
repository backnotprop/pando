import { createFileRoute } from "@tanstack/react-router";
import { loadRelease, ReleasePage } from "../../../-project/Releases";

export const Route = createFileRoute("/$owner/$name/projects/$project/releases/$tag")({
  loader: ({ context: { queryClient, monorepo, repo }, params }) => loadRelease(queryClient, monorepo, repo, params.tag),
  component: function Release() {
    const { repo } = Route.useRouteContext();

    return <ReleasePage repo={repo} tag={Route.useParams().tag} />;
  },
});
