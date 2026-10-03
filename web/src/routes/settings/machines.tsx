import { createFileRoute } from "@tanstack/react-router";
import { Empty } from "../../ui/controls";
import { Page, Title } from "../../ui/pages";

export const Route = createFileRoute("/settings/machines")({
  component: () => (
    <Page crumbs={[{ label: "settings" }, { label: "machines" }]}>
      <Title>Your machines</Title>
      <Empty>Not built yet.</Empty>
    </Page>
  ),
});
