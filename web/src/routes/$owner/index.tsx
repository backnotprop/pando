// /{name}: an organization's page, or for a person, the home narrowed to
// their monorepos. GET /v1/users/{name} says which; neither is not found.
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { isMissing } from "../../api/client";
import { loginRef } from "../../api/names";
import { orgMembersQuery, ownerActivityQuery, ownerQuery } from "../../api/orgs";
import { activityQuery, monoreposQuery, needsQuery } from "../../api/queries";
import { Home } from "../-home/Home";
import { OrgOverview } from "../-org/Overview";

export const Route = createFileRoute("/$owner/")({
  beforeLoad: ({ params }) => {
    try {
      return { name: loginRef(params.owner) };
    } catch {
      throw notFound();
    }
  },
  loader: async ({ context: { queryClient, name } }) => {
    const who = await queryClient.ensureQueryData(ownerQuery(name)).catch((error: Error) => {
      if (isMissing(error)) throw notFound();

      throw error;
    });

    if (who.type === "org") {
      await Promise.all([
        queryClient.ensureQueryData(monoreposQuery),
        queryClient.ensureInfiniteQueryData(ownerActivityQuery(name)),
        who.role ? queryClient.ensureQueryData(orgMembersQuery(name)) : null,
      ]);

      return;
    }

    await Promise.all([queryClient.ensureQueryData(monoreposQuery), queryClient.ensureQueryData(needsQuery(null)), queryClient.ensureInfiniteQueryData(activityQuery(null))]);
  },
  component: function OwnerRoute() {
    const { name } = Route.useRouteContext();
    const who = useSuspenseQuery(ownerQuery(name)).data;

    return who.type === "org" ? <OrgOverview org={who} /> : <Home inMonorepo={null} owner={name} />;
  },
});
