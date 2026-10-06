// /{login}/sessions: a person's recorded agent sessions, in the repositories you both can open (from the name menu's
// Your sessions, and the profile's All N). A repository named "sessions" under a person is reached as /{login}/sessions too:
// this page takes the address, as GitHub keeps such names for itself.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { loginRef } from "../../api/names";
import { personSessionsSearch } from "../../api/search";
import { Page } from "../../ui/pages";
import { PersonSessions } from "./$name/-sessions/Person";

export const Route = createFileRoute("/$owner/sessions")({
  validateSearch: personSessionsSearch,
  beforeLoad: ({ params }) => {
    try {
      return { login: loginRef(params.owner) };
    } catch {
      throw notFound();
    }
  },
  component: function PersonSessionsRoute() {
    const { login } = Route.useRouteContext();
    const search = Route.useSearch();

    return (
      <Page crumbs={[{ label: login, link: { to: "/$owner", params: { owner: login } } }, { label: "sessions" }]}>
        <PersonSessions login={login} search={search} />
      </Page>
    );
  },
});
