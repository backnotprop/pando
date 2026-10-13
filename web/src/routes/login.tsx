// The sign-in page a signed-out visitor sees (owner ask, 2026-10-13: "a cooler,
// well thought out, login page"; direction A of research/design/
// pando-ui-2026-10-03/login/INDEX.html). The landing page's ground line runs
// across it, the mark stands on it, and under it the landing's root system
// grows once (./-login/Roots.tsx). One headline, one line, one button. Sign-in
// runs through the Worker (WorkOS AuthKit), which sets the session cookie and
// sends the person back to where they were.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "../api/queries";
import { loginSearch } from "../api/search";
import { Mark } from "../ui/Icons";
import { DOCS } from "../ui/paths";
import { Roots } from "./-login/Roots";

/** A path on this host, else "/" (the Worker checks it too). */
const local = (to: string | undefined) => (to && to.startsWith("/") && !to.startsWith("//") && !to.startsWith("/login") ? to : "/");

export const Route = createFileRoute("/login")({
  validateSearch: loginSearch,
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.fetchQuery(meQuery).catch(() => null);

    if (me) throw redirect({ href: local(search.return_to) });
  },
  component: SignIn,
});

const quiet = "text-[13px] leading-5 text-bark-dim hover:text-bark";

function SignIn() {
  const { return_to } = Route.useSearch();

  return (
    <div className="flex min-h-svh flex-col">
      {/* Above the ground: the air, with the words and the mark standing on the line. */}
      <div className="flex flex-1 flex-col bg-air">
        <header className="flex h-14 items-center gap-2.5 px-(--margin)">
          <Mark className="block text-bark" />
          <span className="text-[15px] leading-5 font-semibold">Pando</span>
          <nav aria-label="Pando" className="ml-auto flex gap-5">
            <a href={DOCS} className={quiet}>
              Docs
            </a>
            <a href="https://gitpando.com" className={quiet}>
              gitpando.com
            </a>
          </nav>
        </header>
        <main className="flex flex-1 flex-col items-center px-(--margin) text-center">
          <div className="my-auto flex flex-col items-center pt-6 pb-12">
            <h1 className="text-[40px] leading-[46px] tracking-[-.022em] text-balance phone:text-[28px] phone:leading-[33px] phone:tracking-[-.018em]">
              Everything everywhere all at once
            </h1>
            <p className="mt-3 max-w-[480px] text-[15px] leading-[22px] text-balance text-bark-dim phone:text-[14px] phone:leading-5">
              A git platform for monorepos, built on Cloudflare, where many agents work at once.
            </p>
            <a
              href={`/v1/login/browser?return_to=${encodeURIComponent(local(return_to))}`}
              className="mt-7 inline-flex h-9 items-center justify-center rounded-[8px] bg-bark px-[18px] text-[14px] leading-4 font-semibold whitespace-nowrap text-soil hover:bg-bark-hi"
            >
              Sign in
            </a>
          </div>
          {/* The mark's floor sits on the ground line (its path's base is 9.5 of its 64 units above the box's bottom). */}
          <Mark width={52} height={52} className="-mb-[7.7px] block text-bark phone:size-11 phone:-mb-[6.5px]" />
        </main>
      </div>
      <div className="h-px bg-[color-mix(in_srgb,var(--bark)_55%,transparent)]" />
      <Roots />
    </div>
  );
}
