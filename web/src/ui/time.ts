// Times as the prototype writes them: "now", "12 s", "3 min", "2 h", "4 d",
// "3 w", then the date. One shared clock re-renders them every 10 seconds.
import { useSyncExternalStore } from "react";

let now = Date.now();

const listeners = new Set<() => void>();

let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => {
    now = Date.now();

    for (const l of listeners) l();
  }, 10_000);

  return () => {
    listeners.delete(listener);

    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export const useNow = () => useSyncExternalStore(subscribe, () => now);

const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

const dateYear = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

/** "12 s", "3 min", or the date for anything older than four weeks. */
export function since(at: string | number, clock: number): string {
  const ms = new Date(at).getTime();
  const s = Math.max(0, Math.round((clock - ms) / 1000));

  if (s < 10) return "now";

  if (s < 60) return `${s} s`;

  if (s < 3600) return `${Math.floor(s / 60)} min`;

  if (s < 86_400) return `${Math.floor(s / 3600)} h`;

  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} d`;

  if (s < 28 * 86_400) return `${Math.floor(s / (7 * 86_400))} w`;

  return new Date(ms).getFullYear() === new Date(clock).getFullYear() ? date.format(ms) : dateYear.format(ms);
}

/** "2 min ago", "just now", or the date. */
export function ago(at: string | number, clock: number): string {
  const t = since(at, clock);

  if (t === "now") return "just now";

  return /\d (s|min|h|d|w)$/.test(t) ? `${t} ago` : t;
}

/** "Oct 3, 2026", for history's day groups. */
export const day = (at: number) => dateYear.format(at);
