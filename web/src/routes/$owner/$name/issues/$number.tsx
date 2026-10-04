// /{owner}/{name}/issues/{n}: the issue, its timeline and its sidebar.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { isMissing } from "../../../../api/client";
import { issueQuery, timelineQuery } from "../../../../api/issues";
import { IssuePage } from "../-issues/Issue";

const numberOf = (n: string) => (/^[1-9]\d{0,9}$/.test(n) ? Number(n) : null);

export const Route = createFileRoute("/$owner/$name/issues/$number")({
  loader: async ({ context: { queryClient, monorepo }, params }) => {
    const n = numberOf(params.number);

    if (n === null) throw notFound();

    await Promise.all([queryClient.ensureQueryData(issueQuery(monorepo, n)), queryClient.ensureQueryData(timelineQuery(monorepo, n))]).catch((error: Error) => {
      if (isMissing(error)) throw notFound();

      throw error;
    });

    return n;
  },
  component: function Issue() {
    return <IssuePage n={Route.useLoaderData()} />;
  },
});
