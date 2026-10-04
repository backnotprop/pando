// /{owner}/{name}/issues/new: a title, the description, and its assignees, labels and project.
import { createFileRoute } from "@tanstack/react-router";
import { newIssueSearch } from "../../../../api/search";
import { NewIssue } from "../-issues/NewIssue";

export const Route = createFileRoute("/$owner/$name/issues/new")({
  validateSearch: newIssueSearch,
  component: function New() {
    return <NewIssue project={Route.useSearch().project ?? null} />;
  },
});
