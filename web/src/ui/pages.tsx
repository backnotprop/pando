// Whole-page states: not found, something failed, and the frame every page shares.
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { isOutdated } from "../api/client";
import { Lnk } from "./controls";
import { type Crumb, TopBar } from "./TopBar";

/** The page frame: the top bar, then the content column (1296 wide, the prototype's margins). */
export function Page({ crumbs, children }: { crumbs?: Crumb[]; children: ReactNode }) {
  return (
    <>
      <TopBar crumbs={crumbs} />
      <main className="mx-auto max-w-[1296px] px-(--margin) pt-7 pb-28">{children}</main>
    </>
  );
}

export const Title = ({ children }: { children: ReactNode }) => (
  <h1 className="max-w-[28em] text-[26px] leading-8 tracking-[-.018em] text-balance">{children}</h1>
);

export function NotFoundPage() {
  return (
    <Page crumbs={[{ label: "not found" }]}>
      <Title>Nothing at this path.</Title>
      <p className="mt-2 text-[14px] text-bark-dim">
        <Lnk to="/">Back to your repositories</Lnk>
      </p>
    </Page>
  );
}

export function Failed({ error }: ErrorComponentProps) {
  const router = useRouter();
  const outdated = error instanceof Error && isOutdated(error);
  const action = "cursor-pointer border-b border-ash-half pb-px hover:border-bark hover:text-bark";

  return (
    <Page>
      <Title>{outdated ? "Pando was updated." : "Something went wrong."}</Title>
      <p className="mt-2 flex gap-4 text-[14px] text-bark-dim">
        {outdated ? (
          <button type="button" className={action} onClick={() => location.reload()}>
            Reload
          </button>
        ) : (
          <>
            <span>{error instanceof Error ? error.message : "The page could not load."}</span>
            <button type="button" className={action} onClick={() => void router.invalidate()}>
              Try again
            </button>
          </>
        )}
      </p>
    </Page>
  );
}
