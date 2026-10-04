import { createFileRoute } from "@tanstack/react-router";
import { Empty } from "../../../ui/controls";
import { MonorepoHead } from "./-frame/heads";

/** Slice 1 builds Code; this tab's page comes in a later slice. */
export const Route = createFileRoute("/$owner/$name/machines")({
  component: () => (
    <>
      <MonorepoHead tab="machines" />
      <Empty>Not built yet.</Empty>
    </>
  ),
});
