// An organization's own pages, /orgs/{org}/people and /orgs/{org}/settings
// (`orgs` is a reserved name, so these can never be a monorepo's): it finds
// the org, where a person's name is not found, and draws the breadcrumb.
import { createFileRoute, notFound, Outlet, useLocation } from "@tanstack/react-router";
import { isMissing } from "../../../api/client";
import { loginRef } from "../../../api/names";
import { ownerQuery } from "../../../api/orgs";
import { Page } from "../../../ui/pages";
import { ownerLink } from "../../../ui/paths";

export const Route = createFileRoute("/orgs/$org")({
  beforeLoad: ({ params }) => {
    try {
      return { org: loginRef(params.org) };
    } catch {
      throw notFound();
    }
  },
  loader: async ({ context: { queryClient, org } }) => {
    const who = await queryClient.ensureQueryData(ownerQuery(org)).catch((error: Error) => {
      if (isMissing(error)) throw notFound();

      throw error;
    });

    if (who.type !== "org") throw notFound();
  },
  component: function OrgFrame() {
    const { org } = Route.useRouteContext();
    const page = useLocation().pathname.split("/")[3];

    return (
      <Page crumbs={[{ label: org, link: ownerLink(org) }, ...(page ? [{ label: page }] : [])]}>
        <Outlet />
      </Page>
    );
  },
});
