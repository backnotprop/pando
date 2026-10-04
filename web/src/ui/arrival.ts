// The prototype's one motion (theme.css .arrived: a short slide in, then
// Foxfire for about 2 s), for rows that change while the page is open: a
// check that moves (queued, running, passed), a build or a branch that comes
// in. What the page showed first never plays it. A row keyed by its id and
// state remounts on each change, so the arrival plays once per change.
import { useRef } from "react";

export interface Seen {
  key: string;
  state: string;
}

/** Whether a row came in, or changed state, after the page first showed the list (`rows` undefined: not loaded yet). */
export function useArrivals(rows: readonly Seen[] | undefined): (key: string) => boolean {
  const first = useRef<Map<string, string> | null>(null);

  if (rows && !first.current) first.current = new Map(rows.map((r) => [r.key, r.state]));
  const shown = first.current;
  const now = new Map((rows ?? []).map((r) => [r.key, r.state]));

  return (key) => shown !== null && shown.get(key) !== now.get(key);
}
