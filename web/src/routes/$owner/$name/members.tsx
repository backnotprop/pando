import { createFileRoute } from "@tanstack/react-router";
import { Empty } from "../../../ui/controls";

/** Slice 1 builds Code; this tab's page comes in a later slice. */
export const Route = createFileRoute("/$owner/$name/members")({
  component: () => <Empty>Not built yet.</Empty>,
});
