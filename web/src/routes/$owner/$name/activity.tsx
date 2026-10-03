// A monorepo's own log: the home's activity, narrowed to it.
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { activityQuery } from "../../../api/queries";
import { ActivityList } from "../../../ui/activity";
import { Empty } from "../../../ui/controls";

export const Route = createFileRoute("/$owner/$name/activity")({
  loader: ({ context: { queryClient, monorepo } }) => queryClient.ensureInfiniteQueryData(activityQuery(monorepo.full)),
  component: function Activity() {
    const { monorepo } = Route.useRouteContext();
    const log = useSuspenseInfiniteQuery(activityQuery(monorepo.full));
    const events = log.data.pages.flatMap((p) => p.events);
    const more = log.hasNextPage && !log.isFetchingNextPage ? () => void log.fetchNextPage() : null;

    return <div className="max-w-[960px]">{events.length ? <ActivityList events={events} withMonorepo={false} more={more} /> : <Empty>Nothing yet.</Empty>}</div>;
  },
});
