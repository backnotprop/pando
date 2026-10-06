// The profile graph's agent marks (DETERMINISM.md rows 46 to 48): for each day, and each week from Sunday, the agent
// behind most of the person's commits on main that name their own sessions, in the viewer's zone. Ties go to more
// distinct sessions, then the latest commit, then the agent's name A to Z. A week sums its commits, not its days' winners.

export interface MarkCommit<P extends string> {
  at: string;
  program: P;
  session: string;
}

export interface Mark<P extends string> {
  /** The day (YYYY-MM-DD), or the week's Sunday. */
  date: string;
  program: P;
  commits: number;
}

const DAY_MS = 86_400_000;

/** A time's day in a zone (minutes east of UTC). */
export function dayIn(iso: string, tz: number): string {
  return new Date(Date.parse(iso) + tz * 60_000).toISOString().slice(0, 10);
}

/** The Sunday of a day's week. */
export function sundayOf(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);

  return new Date(ms - new Date(ms).getUTCDay() * DAY_MS).toISOString().slice(0, 10);
}

/** The winner of each bucket, in date order. */
export function winners<P extends string>(commits: readonly MarkCommit<P>[], bucketOf: (c: MarkCommit<P>) => string): Mark<P>[] {
  const tally = new Map<string, Map<P, { commits: number; sessions: Set<string>; latest: string }>>();

  for (const c of commits) {
    const bucket = bucketOf(c);
    const byProgram = tally.get(bucket) ?? tally.set(bucket, new Map()).get(bucket)!;
    const t = byProgram.get(c.program) ?? byProgram.set(c.program, { commits: 0, sessions: new Set(), latest: "" }).get(c.program)!;
    t.commits++;
    t.sessions.add(c.session);

    if (c.at > t.latest) t.latest = c.at;
  }

  return [...tally]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, byProgram]) => {
      const [program, t] = [...byProgram].sort(
        ([pa, a], [pb, b]) => b.commits - a.commits || b.sessions.size - a.sessions.size || b.latest.localeCompare(a.latest) || pa.localeCompare(pb),
      )[0];

      return { date, program, commits: t.commits };
    });
}
