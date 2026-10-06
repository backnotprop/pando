// /{owner}/{name}/agents/{n}: one agent session, live.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { AgentSessionPage } from "../-agents/Session";

export const Route = createFileRoute("/$owner/$name/agents/$n")({
  beforeLoad: ({ params }) => {
    if (!/^[1-9]\d*$/.test(params.n)) throw notFound();
  },
  component: function AgentSession() {
    const { n } = Route.useParams();

    return <AgentSessionPage n={Number(n)} />;
  },
});
