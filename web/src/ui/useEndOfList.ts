import { useEffect, useRef } from "react";

/** Calls `more` when the element (placed after a list) scrolls into view: older pages load as you read. */
export function useEndOfList<T extends HTMLElement>(more: (() => void) | null) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;

    if (!el || !more) return;

    const io = new IntersectionObserver((seen) => {
      if (seen.some((x) => x.isIntersecting)) more();
    });

    io.observe(el);

    return () => io.disconnect();
  }, [more]);

  return ref;
}
