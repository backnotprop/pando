import { createFileRoute } from "@tanstack/react-router";
import { fullNameOf } from "../api/names";
import { activityQuery, monoreposQuery, needsQuery } from "../api/queries";
import { homeSearch } from "../api/search";
import { Home } from "./-home/Home";

export const Route = createFileRoute("/")({
  validateSearch: homeSearch,
  loaderDeps: ({ search }) => ({ in: fullNameOf(search.in) }),
  loader: ({ context: { queryClient }, deps }) =>
    Promise.all([
      queryClient.ensureQueryData(monoreposQuery),
      queryClient.ensureQueryData(needsQuery(deps.in)),
      queryClient.ensureInfiniteQueryData(activityQuery(deps.in)),
    ]),
  component: function HomeRoute() {
    const { in: inMonorepo } = Route.useLoaderDeps();

    return <Home inMonorepo={inMonorepo} owner={null} />;
  },
});
