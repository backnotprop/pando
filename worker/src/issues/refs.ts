// Closing keywords, as GitHub reads them (research/plans/issues-2026-10-04/SPEC.md 3.2): close, closes,
// closed, fix, fixes, fixed, resolve, resolves, resolved, any case, an optional colon, then `#12` or
// `owner/name#12`. One keyword per number ("Fixes #12, #14" names #12 only). A `git revert` never closes:
// its message quotes the original title, keywords and all.

const KEYWORD = /(?<![\w-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:[ \t]*:[ \t]*|[ \t]+)(?:([A-Za-z0-9][\w.-]*\/[\w.-]+))?#(\d{1,9})(?![\w-])/gi;

/** Fenced blocks and backtick spans: code, never a reference. */
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/** A first line `Revert "..."`: git revert's message (or a branch titled after one). */
function isRevert(text: string): boolean {
  return text.trimStart().startsWith('Revert "');
}

/**
 * The issue numbers a text closes in this monorepo, in order, each once. `names`: this monorepo's
 * `owner/name` (any case); a reference to another monorepo is ignored. Code is skipped.
 */
export function closingRefs(text: string | null | undefined, names: readonly string[]): number[] {
  if (!text || isRevert(text)) return [];
  const mine = new Set(names.map((n) => n.toLowerCase()));
  const out: number[] = [];

  for (const m of text.replace(CODE, " ").matchAll(KEYWORD)) {
    const full = m[1];
    const n = Number(m[2]);

    if (full !== undefined && !mine.has(full.toLowerCase())) continue;

    if (n > 0 && !out.includes(n)) out.push(n);
  }

  return out;
}
