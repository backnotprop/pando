// /{owner}/{name}/sessions/{id}: one recorded session.
import { createFileRoute } from "@tanstack/react-router";
import { SessionPage } from "../-sessions/Session";

export const Route = createFileRoute("/$owner/$name/sessions/$id")({
  component: function OneSession() {
    const { id } = Route.useParams();

    return <SessionPage id={id} />;
  },
});
