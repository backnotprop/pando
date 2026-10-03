// The quiet sign-in page a signed-out visitor sees: the mark and one button.
// Sign-in runs through the Worker (WorkOS AuthKit), which sets the session
// cookie and sends the person back to where they were.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "../api/queries";
import { loginSearch } from "../api/search";
import { Mark } from "../ui/Icons";

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

function SignIn() {
  const { return_to } = Route.useSearch();

  return (
    <>
      <header className="flex h-14 items-center px-(--margin)">
        <span className="-ml-1.5 flex size-8 items-center justify-center text-bark">
          <Mark className="block" />
        </span>
      </header>
      <main className="mx-auto flex max-w-[1296px] flex-col items-center px-(--margin) pt-[22vh] pb-28">
        <Mark width={40} height={40} className="block text-bark" />
        <h1 className="mt-5 text-[26px] leading-8 tracking-[-.018em]">Pando</h1>
        <a
          href={`/v1/login/browser?return_to=${encodeURIComponent(local(return_to))}`}
          className="mt-7 inline-flex h-8 items-center justify-center rounded-[7px] bg-bark px-3.5 text-[13.5px] leading-[normal] font-semibold whitespace-nowrap text-soil hover:bg-bark-hi"
        >
          Sign in
        </a>
      </main>
    </>
  );
}
