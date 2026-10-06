// Release notes written from Pando's own records: the merges between two
// releases. Main moves only by merges, and each merges row holds where main
// was before (base_before) and the commit it moved to (merge_commit), so the
// merges behind a release are a walk back over rows, with no git reads.

/** Merges listed in generated notes; more are counted as "and N more" (lane limit, approved 2026-10-06). */
export const NOTES_MERGES_MAX = 500;

/** A release's notes, in characters (lane limit, approved 2026-10-06). */
export const NOTES_MAX = 100_000;

/** Rows a walk reads at most, so a broken chain can never loop or run long. */
const SCAN_MAX = 100_000;

/** A branch title in generated notes, in characters. */
const TITLE_MAX = 150;

/** What the walk needs of a merges row. */
export interface MergeLink {
  base_before: string;
}

export interface Walk<T> {
  /** Newest first, at most `max`. */
  merges: T[];
  /** Merges past `max`, counted. */
  more: number;
  /** The earlier release the walk stopped at, or null when it reached main's first commit. */
  since: string | null;
}

/**
 * The merges that brought main from an earlier release to `from`, newest
 * first. `mergeAt(sha)` is the merge whose merge_commit is sha (null for a
 * commit no merge made: main's first push, or a commit before Pando).
 * `stops` maps the commits of the other published releases to their tags:
 * the walk ends at the first one it reaches.
 */
export function walkMerges<T extends MergeLink>(from: string, mergeAt: (sha: string) => T | null, stops: ReadonlyMap<string, string>, max = NOTES_MERGES_MAX): Walk<T> {
  const merges: T[] = [];
  const seen = new Set<string>();
  let more = 0;
  let cur = from;

  for (let i = 0; i < SCAN_MAX && !seen.has(cur); i++) {
    const tag = stops.get(cur);

    if (tag !== undefined) return { merges, more, since: tag };
    seen.add(cur);
    const row = mergeAt(cur);

    if (!row) break;

    if (merges.length < max) merges.push(row);
    else more++;
    cur = row.base_before;
  }

  return { merges, more, since: null };
}

/** One merge as the notes show it. */
export interface NotesLine {
  branch: string;
  title: string | null;
  merged_by: string;
  /** The issues it closed, by number. */
  closes: number[];
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();

  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** "#12", "#12 and #14", "#12, #14 and #20". */
function issueList(ns: number[]): string {
  const refs = ns.map((n) => `#${n}`);

  return refs.length > 1 ? `${refs.slice(0, -1).join(", ")} and ${refs.at(-1)}` : (refs[0] ?? "");
}

/**
 * The notes as Markdown: a heading, one line per merge (its branch's title,
 * the branch, who merged it, the issues it closed), then "and N more". Kept
 * under NOTES_MAX by moving lines into the count.
 */
export function notesMarkdown(lines: NotesLine[], more: number, since: string | null): string {
  const head = since ? `## Changes since ${since}` : "## Changes";

  if (!lines.length && !more) return `${head}\n\nNo branches were merged${since ? ` since ${since}` : ""}.\n`;

  const items = lines.map((l) => {
    const title = l.title ? oneLine(l.title) : null;
    const what = title ? `${title} (\`${l.branch}\`)` : `\`${l.branch}\``;

    return `- ${what} by ${l.merged_by}${l.closes.length ? `, closes ${issueList(l.closes)}` : ""}`;
  });

  let extra = more;
  const render = () => `${head}\n\n${items.join("\n")}\n${extra ? `- and ${extra} more\n` : ""}`;
  let text = render();

  while (text.length > NOTES_MAX && items.length) {
    items.pop();
    extra++;
    text = render();
  }

  return text;
}
