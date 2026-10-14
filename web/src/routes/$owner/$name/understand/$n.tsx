// /{owner}/{name}/understand/{n}: one Understand page, live.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { understandQuery } from "../../../../api/understand";
import { isMissing } from "../../../../api/client";
import { UnderstandPage } from "../-understand/Page";

export const Route = createFileRoute("/$owner/$name/understand/$n")({
  beforeLoad: ({ params }) => {
    if (!/^[1-9]\d*$/.test(params.n)) throw notFound();
  },
  loader: async ({ context: { queryClient, monorepo }, params }) => {
    await queryClient.ensureQueryData(understandQuery(monorepo, Number(params.n))).catch((error: Error) => {
      if (isMissing(error)) throw notFound();

      throw error;
    });
  },
  component: function Understand() {
    const { n } = Route.useParams();

    return <UnderstandPage n={Number(n)} />;
  },
});
