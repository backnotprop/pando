// Every page: signed in (the person's live socket runs), or sent to /login.
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { isSignedOut } from "../api/client";
import { meQuery } from "../api/queries";
import { startFeed } from "../live/feed";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  beforeLoad: async ({ context, location }) => {
    if (location.pathname === "/login") return;

    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (error) {
      if (error instanceof Error && isSignedOut(error)) throw redirect({ to: "/login", search: { return_to: location.href } });
      throw error;
    }
  },
  component: Root,
});

/** The person's socket, while they are signed in. */
function Live() {
  const queryClient = useQueryClient();
  useEffect(() => startFeed(queryClient), [queryClient]);

  return null;
}

function Root() {
  const me = useQuery({ ...meQuery, retry: false }).data;

  return (
    <>
      <Outlet />
      {me ? <Live /> : null}
    </>
  );
}
