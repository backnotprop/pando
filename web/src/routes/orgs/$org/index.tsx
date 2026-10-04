// /orgs/{org} on its own is the org's page, /{org}.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/orgs/$org/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/$owner", params: { owner: params.org }, replace: true });
  },
});
