// The profile's counts in words, and its links to a repository: one place, so
// the shared link component (links ruling R) replaces this class alone.

/** "1,206 contributions", "1 contribution". */
export const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "Oct 2". */
export const shortDay = (iso: string, tz: number) =>
  new Date(Date.parse(iso) + tz * 60_000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A repository's name where a line is about it: the owner dim, the name in the text colour. */
export const repoLink = "text-bark hover:underline hover:decoration-ash hover:underline-offset-3";
