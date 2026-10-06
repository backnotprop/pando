// /{owner}/{name}/agents: the repository's Cloudflare-run agents, with their filters in the address.
import { createFileRoute } from "@tanstack/react-router";
import { agentsSearch } from "../../../../api/search";
import { OwnHead } from "../-frame/heads";
import { AgentsList } from "../-agents/List";

export const Route = createFileRoute("/$owner/$name/agents/")({
  validateSearch: agentsSearch,
  component: function Agents() {
    const search = Route.useSearch();

    return (
      <>
        <OwnHead tab="agents" />
        <AgentsList search={search} />
      </>
    );
  },
});
