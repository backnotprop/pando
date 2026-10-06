// Times as the prototype writes them: "now", "12 s", "3 min", "2 h", "4 d",
// "3 w", then the date. One shared clock re-renders them every 10 seconds.
import { useEffect, useState, useSyncExternalStore } from "react";

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

const clockTime = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "15:27": a time of day, 24-hour, as Pando writes it everywhere. */
export const clock = (at: string | number) => clockTime.format(new Date(at));

/** "Today, 14:20", "Yesterday, 17:48", "Oct 2, 09:15": when something started, as a list of them says it ("today, 14:20" mid-sentence). */
export function dayAndTime(at: string | number, clock: number, midSentence = false): string {
  const ms = new Date(at).getTime();
  const days = Math.round((new Date(clock).setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days === 0 ? "Today" : days === 1 ? "Yesterday" : date.format(ms);
  const when = midSentence && days <= 1 ? day.toLowerCase() : day;

  return `${when}, ${clockTime.format(ms)}`;
}

/** "Oct 3, 2026", for history's day groups. */
export const day = (at: number) => dateYear.format(at);

/** "42 s", or "1 min 04 s": how long a check, job or build took. */
export const duration = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`);

/** The clock, ticking every second while `running` (a running check's elapsed time: a text change, no motion). */
export function useSeconds(running: boolean): number {
  const slow = useNow();
  const [fast, setFast] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => setFast(Date.now()), 1000);

    return () => clearInterval(tick);
  }, [running]);

  return running ? Math.max(fast, slow) : slow;
}

/** How long a run took, or has been running: "1 min 04 s"; "" before it starts. */
export function elapsed(run: { duration_s: number | null; started_at: string | null; finished_at: string | null }, clock: number): string {
  if (run.duration_s !== null) return duration(run.duration_s);

  if (run.started_at && !run.finished_at) return duration(Math.max(0, Math.round((clock - Date.parse(run.started_at)) / 1000)));

  return "";
}
