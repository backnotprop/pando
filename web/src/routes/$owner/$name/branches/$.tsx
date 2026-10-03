import { createFileRoute } from "@tanstack/react-router";
import { Empty } from "../../../../ui/controls";

/** Project code and branch pages come in slices 2 and 3; links to them already land here. */
export const Route = createFileRoute("/$owner/$name/branches/$")({
  component: () => <Empty>Not built yet.</Empty>,
});
