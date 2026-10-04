// A project of a monorepo (projects/<project>): finds its repo, for every page under it.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { reposQuery } from "../../../../../api/queries";

export const Route = createFileRoute("/$owner/$name/projects/$project")({
  beforeLoad: async ({ context: { queryClient, monorepo }, params }) => {
    const repo = (await queryClient.ensureQueryData(reposQuery(monorepo))).find((r) => r.path === `projects/${params.project}`);

    if (!repo) throw notFound();

    return { repo };
  },
});
