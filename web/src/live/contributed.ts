// Your own work, counted while a page is open (the socket's `contributed`
// frame): the day it landed on, in this browser's time zone, so your profile's
// square for it glows once. Each frame bumps `n`; a graph glows for the
// frames that came after it first showed.
import { useSyncExternalStore } from "react";
import { viewerTz } from "../api/profile";

export interface Landed {
  day: string;
  n: number;
}

let last: Landed = { day: "", n: 0 };

const listeners = new Set<() => void>();

/** A `contributed` frame's UTC hour ("2026-10-03T17"), on this browser's calendar. */
export function noteContributed(hour: string): void {
  const day = new Date(Date.parse(`${hour}:00:00Z`) + viewerTz() * 60_000).toISOString().slice(0, 10);

  last = { day, n: last.n + 1 };

  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);

  return () => listeners.delete(l);
};

export const useLanded = (): Landed => useSyncExternalStore(subscribe, () => last);
