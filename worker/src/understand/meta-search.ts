// Understand's lookup in the shared files (the meta layer object's own current
// files): the files that hold any of the question's words, or the files a
// commit or a prompt names by path. Bounded for one page's question, not a
// repository search (DESIGN.md, "Limits"; files ruling 2026-10-12): at most
// SHARED_FILES_MAX files are read, each at most SHARED_FILE_BYTES, and the
// best SHARED_HITS are answered, each with up to EXCERPT_LINES lines.

export const SHARED_FILES_MAX = 2000;

export const SHARED_FILE_BYTES = 256 * 1024;

export const SHARED_HITS = 20;

const EXCERPT_LINES = 16;

/** A current shared file, as the meta layer object reads it. */
export interface SharedRow extends Record<string, SqlStorageValue> {
  path: string;
  version: number;
  sha: string;
  size: number | null;
  author: string;
  login: string | null;
  machine: string;
  agent: string | null;
  at: number;
  lfs_oid: string | null;
}

/** A file found, its version and who saved it, and the lines found. */
export interface SharedHit {
  path: string;
  version: number;
  saved_by: string;
  login: string | null;
  machine: string;
  agent: string | null;
  saved_at: string;
  excerpt: { from: number; text: string } | null;
  /** How many of the words it holds (0 for a named path). */
  score: number;
  named: boolean;
}

/** Words worth matching: three characters or more, lower case, at most 8. */
export function wordsOf(words: string[]): string[] {
  return [...new Set(words.flatMap((w) => (w.trim().length >= 3 ? [w.trim().toLowerCase()] : [])))].slice(0, 8);
}

function excerptAt(lines: string[], at: number): SharedHit["excerpt"] {
  const from = Math.max(0, Math.min(at - 3, lines.length - EXCERPT_LINES));

  return { from: from + 1, text: lines.slice(from, from + EXCERPT_LINES).join("\n") };
}

/** The files found, and how many were read. */
export interface SharedFound {
  hits: SharedHit[];
  read: number;
}

export function searchShared(rows: SharedRow[], read: (sha: string) => ArrayBuffer, words: string[], paths: string[]): SharedFound {
  const want = wordsOf(words);
  const named = new Set(paths);
  const hits: SharedHit[] = [];
  let count = 0;

  for (const r of rows) {
    const isNamed = named.has(r.path);

    if (r.lfs_oid || (r.size ?? 0) > SHARED_FILE_BYTES) continue;

    if (!isNamed && !want.length) continue;
    const bytes = new Uint8Array(read(r.sha));

    count++;

    if (bytes.subarray(0, 8000).includes(0)) continue;
    const text = new TextDecoder().decode(bytes);
    const lower = text.toLowerCase();
    const matched = want.filter((w) => lower.includes(w));

    if (!isNamed && !matched.length) continue;
    const lines = text.replace(/\n$/, "").split("\n");
    const first = matched.length ? lines.findIndex((l) => matched.some((w) => l.toLowerCase().includes(w))) : 0;

    hits.push({
      path: r.path, version: r.version, saved_by: r.author, login: r.login, machine: r.machine, agent: r.agent, saved_at: new Date(r.at).toISOString(),
      excerpt: lines.length ? excerptAt(lines, Math.max(0, first)) : null, score: matched.length, named: isNamed,
    });
  }

  hits.sort((a, b) => Number(b.named) - Number(a.named) || b.score - a.score || a.path.localeCompare(b.path));

  return { hits: hits.slice(0, SHARED_HITS), read: count };
}
