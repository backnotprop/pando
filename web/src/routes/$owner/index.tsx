// An owner's page: for now, the home narrowed to that owner's monorepos.
import { createFileRoute } from "@tanstack/react-router";
import { activityQuery, monoreposQuery, needsQuery } from "../../api/queries";
import { Home } from "../-home/Home";

export const Route = createFileRoute("/$owner/")({
  loader: ({ context: { queryClient } }) =>
    Promise.all([queryClient.ensureQueryData(monoreposQuery), queryClient.ensureQueryData(needsQuery(null)), queryClient.ensureInfiniteQueryData(activityQuery(null))]),
  component: function OwnerRoute() {
    const { owner } = Route.useParams();

    return <Home inMonorepo={null} owner={owner.toLowerCase()} />;
  },
});
