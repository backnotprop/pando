// /{owner}/{name}/issues: one issue list per repository (owner ruling), with its filters in the address.
import { createFileRoute } from "@tanstack/react-router";
import { issuesSearch } from "../../../../api/search";
import { OwnHead } from "../-frame/heads";
import { IssuesList } from "../-issues/List";

export const Route = createFileRoute("/$owner/$name/issues/")({
  validateSearch: issuesSearch,
  component: function Issues() {
    const search = Route.useSearch();

    return (
      <>
        <OwnHead tab="issues" />
        <IssuesList search={search} />
      </>
    );
  },
});
