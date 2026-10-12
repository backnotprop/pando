// A plain repo's releases (a monorepo's projects have theirs under projects/<project>/releases): finds its one repo.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { plainRepo } from "../-project/Branches";

export const Route = createFileRoute("/$owner/$name/releases")({
  beforeLoad: async ({ context: { queryClient, monorepo } }) => {
    const repo = await plainRepo(queryClient, monorepo);

    if (!repo) throw notFound();

    return { repo };
  },
});
