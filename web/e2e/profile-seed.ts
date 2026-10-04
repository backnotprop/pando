// Seeding a profile: a repository's main with a dated history, made at once
// with git fast-import (no credentials: it only writes the local repository),
// then pushed by a machine. Its arrival is what fills a person's graph.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine } from "./seed";

export interface Author {
  name: string;
  email: string;
}

export interface Dated {
  /** When it was authored and committed (ms). */
  at: number;
  author: Author;
  /** A Co-authored-by line, if any. */
  coauthor?: Author;
}

const DAY_MS = 86_400_000;

/** A day in a time zone (minutes east of UTC), YYYY-MM-DD. */
export const dayIn = (ms: number, tz: number) => new Date(ms + tz * 60_000).toISOString().slice(0, 10);

/** Noon of the day `days` ago in that zone, as a time (ms): safe from either day's edge. */
export const noonAgo = (days: number, tz: number) => {
  const local = new Date(Date.now() + tz * 60_000);

  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - days, 12) - tz * 60_000;
};

/** A folder with a git repository whose main holds these commits, oldest first. */
export function history(commits: readonly Dated[]): string {
  const dir = join(mkdtempSync(join(tmpdir(), "pando-profile-")), "repo");
  const lines: string[] = [];
  const sorted = [...commits].sort((a, b) => a.at - b.at);

  mkdirSync(dir);

  for (const [i, c] of sorted.entries()) {
    const s = Math.floor(c.at / 1000);
    const message = c.coauthor ? `change ${i}\n\nCo-authored-by: ${c.coauthor.name} <${c.coauthor.email}>\n` : `change ${i}\n`;

    lines.push(
      "commit refs/heads/main", `mark :${i + 1}`, `author ${c.author.name} <${c.author.email}> ${s} +0000`, `committer ${c.author.name} <${c.author.email}> ${s} +0000`,
      `data ${Buffer.byteLength(message)}`, message, ...(i ? [`from :${i}`] : []), `M 644 inline file-${i % 40}.txt`, `data ${String(i).length}`, String(i), "",
    );
  }

  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir, GIT_TERMINAL_PROMPT: "0" };

  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  execFileSync("git", ["fast-import", "--quiet"], { cwd: dir, env, input: `${lines.join("\n")}\n` });
  execFileSync("git", ["checkout", "-q", "main"], { cwd: dir, env });

  return dir;
}

/** Pushes the folder's main as `m` (its first push: the history arrives). */
export function pushMain(m: Machine, dir: string, url: string): void {
  m.git(dir, "push", "-q", url, "main");
}

/** `n` commits on the day `days` ago, an hour apart from noon. */
export const onDay = (days: number, n: number, author: Author, tz: number): Dated[] =>
  Array.from({ length: n }, (_, i) => ({ at: noonAgo(days, tz) + (i - Math.floor(n / 2)) * 3_600_000, author }));

/** A year of work for a graph: busy weekdays, quiet weekends, a few empty weeks, by a fixed pattern (the same graph every run). */
export function year(author: Author, tz: number, days = 360): Dated[] {
  const out: Dated[] = [];

  for (let d = 1; d <= days; d++) {
    const dow = new Date(noonAgo(d, tz)).getUTCDay();
    const week = Math.floor(d / 7);
    const quiet = week % 9 === 4 || week % 13 === 7;
    const n = quiet ? 0 : dow === 0 || dow === 6 ? (d * 7) % 3 === 0 ? 1 : 0 : ((d * 37) % 11) % 7;

    out.push(...onDay(d, n, author, tz));
  }

  return out;
}

export { DAY_MS };
