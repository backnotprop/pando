// /{owner}/{name}/understand: the repository's Understand pages and the ask box.
import { createFileRoute } from "@tanstack/react-router";
import { UnderstandList } from "../-understand/List";

export const Route = createFileRoute("/$owner/$name/understand/")({
  component: UnderstandList,
});
