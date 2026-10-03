// A page's tabs: Code, Activity, Machines... On a phone the bar scrolls
// sideways; while more tabs are off to the right its right edge fades, and the
// current tab is scrolled into view.
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AppLink } from "./paths";

export function Tab({ link, current, label, count }: { link: AppLink; current: boolean; label: string; count?: number | undefined }) {
  return (
    <Link
      {...link}
      aria-current={current ? "page" : undefined}
      className="flex flex-none items-baseline gap-2 border-b-[1.5px] border-transparent pb-[11px] text-[14px] text-ash hover:text-bark aria-[current=page]:border-bark aria-[current=page]:text-bark"
    >
      {label}
      {count ? <span className="font-mono text-[12.5px] leading-[normal] text-ash">{count}</span> : null}
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

export function TabBar({ label, children, className = "mt-[22px] mb-7" }: { label: string; children: ReactNode; className?: string }) {
  const bar = useRef<HTMLElement>(null);
  const more = useMoreToTheRight(bar);

  return (
    <nav
      ref={bar}
      aria-label={label}
      // The rule is an inset shadow, not a border, so the scrolling bar does not clip the current tab's underline.
      className={`flex gap-7 overflow-x-auto shadow-[inset_0_-1px_0_var(--rootline)] [scrollbar-width:none] ${className} ${more ? "[mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)]" : ""}`}
    >
      {children}
    </nav>
  );
}
