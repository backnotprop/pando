// A page's tabs: Code, Activity, Machines... On a phone the bar scrolls
// sideways; while more tabs are off to the right its right edge fades, and the
// current tab is scrolled into view.
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AppLink } from "./paths";

export const EXACT = { exact: true, includeSearch: true };

export function Tab({ link, current, label, count }: { link: AppLink; current: boolean; label: string; count?: number | string | undefined }) {
  return (
    <Link
      {...link}
      // The router marks a link current on a prefix match unless told otherwise; a tab is current only when it says so.
      activeOptions={EXACT}
      aria-current={current ? "page" : undefined}
      className="flex flex-none items-baseline gap-2 border-b-[1.5px] border-transparent pb-[11px] text-[14px] text-ash hover:text-bark aria-[current=page]:border-bark aria-[current=page]:text-bark"
    >
      {label}
      {count === undefined ? null : <span className="font-mono text-[12.5px] leading-[15px] text-ash">{count}</span>}
    </Link>
  );
}

/** True while the bar has tabs hidden past its right edge. */
function useMoreToTheRight(bar: React.RefObject<HTMLElement | null>) {
  const [more, setMore] = useState(false);

  useEffect(() => {
    const el = bar.current;

    if (!el) return;

    const check = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    const sizes = new ResizeObserver(check);

    sizes.observe(el);
    el.addEventListener("scroll", check, { passive: true });
    el.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    check();

    return () => {
      sizes.disconnect();
      el.removeEventListener("scroll", check);
    };
  }, [bar]);

  return more;
}

export function TabBar({ label, children, className = "mt-[22px] mb-7 gap-7 shadow-[inset_0_-1px_0_var(--rootline)]" }: { label: string; children: ReactNode; className?: string }) {
  const bar = useRef<HTMLElement>(null);
  const more = useMoreToTheRight(bar);

  return (
    <nav
      ref={bar}
      aria-label={label}
      // The rule is an inset shadow, not a border, so the scrolling bar does not clip the current tab's underline.
      className={`flex overflow-x-auto [scrollbar-width:none] ${className} ${more ? "[mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)]" : ""}`}
    >
      {children}
    </nav>
  );
}
