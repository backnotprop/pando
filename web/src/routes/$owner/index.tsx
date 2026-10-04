// /{name}: a person's profile, or an organization's page. GET /v1/users/{name}
// says which; neither is not found. On a profile, `?day=` shows one day's
// activity under the graph.
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { isMissing } from "../../api/client";
import { loginRef } from "../../api/names";
import { orgMembersQuery, ownerActivityQuery, ownerQuery } from "../../api/orgs";
import { contributionsQuery, viewerTz } from "../../api/profile";
import { monoreposQuery } from "../../api/queries";
import { profileSearch } from "../../api/search";
import { OrgOverview } from "../-org/Overview";
import { ProfilePage } from "../-profile/Profile";

export const Route = createFileRoute("/$owner/")({
  validateSearch: profileSearch,
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

    await queryClient.ensureQueryData(contributionsQuery(name, viewerTz()));
  },
  component: function OwnerRoute() {
    const { name } = Route.useRouteContext();
    const { day } = Route.useSearch();
    const navigate = Route.useNavigate();
    const who = useSuspenseQuery(ownerQuery(name)).data;

    if (who.type === "org") return <OrgOverview org={who} />;

    return (
      <ProfilePage
        person={who}
        tz={viewerTz()}
        day={day ?? null}
        onPick={(d) => void navigate({ search: d ? { day: d } : {}, replace: true, resetScroll: false })}
      />
    );
  },
});
