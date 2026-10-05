// /{owner}/{name}/sessions: the repository's recorded agent sessions, beside Issues, with its filters in the address.
import { createFileRoute } from "@tanstack/react-router";
import { sessionsSearch } from "../../../../api/search";
import { OwnHead } from "../-frame/heads";
import { SessionsList } from "../-sessions/List";

export const Route = createFileRoute("/$owner/$name/sessions/")({
  validateSearch: sessionsSearch,
  component: function Sessions() {
    const search = Route.useSearch();

    return (
      <>
        <OwnHead tab="sessions" />
        <SessionsList search={search} />
      </>
    );
  },
});
