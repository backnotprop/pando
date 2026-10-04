// A line diff fast enough for any text a branch can hold, in git's unified
// format with three lines of context. jsdiff's Myers took 6 s on a file of
// 10,000 changed lines and gave up after 16 s on a lockfile; this one is
// patience diff (lines that occur once on each side anchor the match, as git
// diff --patience) with plain Myers between anchors, bounded: a stretch with no
// anchor too large for Myers is shown as removed and added, never wrong, only
// less minimal. Lines are compared as numbers (each distinct line is
// numbered once), and a line's newline is part of it, so "x" at the end of a
// file without a newline differs from "x\n".

/** A hunk with git's numbering (a hunk with no lines on a side starts one line earlier). */
export interface Hunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: string[];
}

const CONTEXT = 3;

/** Myers runs on a stretch between anchors only up to this many lines in all, and this many edits. */
const MYERS_MAX_LINES = 20_000;

const MYERS_MAX_EDITS = 2_000;

const NO_NEWLINE = "\\ No newline at end of file";

/** A text's lines, each with its newline; the last without one when the text has none. */
function linesOf(text: string): string[] {
  const out: string[] = [];
  let from = 0;

  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", from)) {
    out.push(text.slice(from, at + 1));
    from = at + 1;
  }

  if (from < text.length) out.push(text.slice(from));

  return out;
}

/** The pairs of lines (old index, new index) the two sides keep, in order. */
class Matcher {
  /** matchA[i] is the new index old line i is kept as, or -1. */
  readonly matchA: Int32Array;

  private readonly a: Int32Array;

  private readonly b: Int32Array;

  constructor(a: Int32Array, b: Int32Array) {
    this.a = a;
    this.b = b;
    this.matchA = new Int32Array(a.length).fill(-1);
  }

  run(): void {
    // A stack of stretches to diff, rather than recursion, so a long file never runs out of stack.
    const work: [number, number, number, number][] = [[0, this.a.length, 0, this.b.length]];

    while (work.length) {
      const [a0, a1, b0, b1] = work.pop()!;

      this.stretch(a0, a1, b0, b1, work);
    }
  }

  private stretch(a0: number, a1: number, b0: number, b1: number, work: [number, number, number, number][]): void {
    const { a, b } = this;

    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) this.matchA[a0++] = b0++;

    while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) this.matchA[--a1] = --b1;

    if (a0 === a1 || b0 === b1) return;
    const anchors = this.anchors(a0, a1, b0, b1);

    if (anchors.length) {
      let pa = a0;
      let pb = b0;

      for (const [ia, ib] of anchors) {
        this.matchA[ia] = ib;

        if (ia > pa || ib > pb) work.push([pa, ia, pb, ib]);
        pa = ia + 1;
        pb = ib + 1;
      }

      if (a1 > pa || b1 > pb) work.push([pa, a1, pb, b1]);

      return;
    }

    if (a1 - a0 + (b1 - b0) <= MYERS_MAX_LINES) this.myers(a0, a1, b0, b1);
  }

  /** Lines that occur once in each side of the stretch, in an order both sides keep (the longest such run). */
  private anchors(a0: number, a1: number, b0: number, b1: number): [number, number][] {
    // count: 1 once in a, 2 more than once in a; position in a when once.
    const inA = new Map<number, number>();

    for (let i = a0; i < a1; i++) {
      const id = this.a[i]!;

      inA.set(id, inA.has(id) ? -1 : i);
    }

    const inB = new Map<number, number>();

    for (let j = b0; j < b1; j++) {
      const id = this.b[j]!;

      if ((inA.get(id) ?? -1) >= 0) inB.set(id, inB.has(id) ? -1 : j);
    }

    const pairs: [number, number][] = [];

    for (let i = a0; i < a1; i++) {
      const j = inB.get(this.a[i]!);

      if (j !== undefined && j >= 0 && inA.get(this.a[i]!) === i) pairs.push([i, j]);
    }

    return longestRun(pairs);
  }

  /** Myers's greedy diff on a stretch with no anchor; left unmatched past the bounds. */
  private myers(a0: number, a1: number, b0: number, b1: number): void {
    const { a, b } = this;
    const n = a1 - a0;
    const m = b1 - b0;
    const max = Math.min(n + m, MYERS_MAX_EDITS);
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace: Int32Array[] = [];

    for (let d = 0; d <= max; d++) {
      trace.push(v.slice(offset - d - 1, offset + d + 2));

      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
        let y = x - k;

        while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
          x++;
          y++;
        }

        v[offset + k] = x;

        if (x >= n && y >= m) return this.backtrack(trace, d, a0, b0, n, m);
      }
    }
  }

  private backtrack(trace: Int32Array[], dEnd: number, a0: number, b0: number, n: number, m: number): void {
    let x = n;
    let y = m;

    for (let d = dEnd; d > 0; d--) {
      const v = trace[d]!;
      // v holds k in [-d - 1, d + 1] at indices 0 .. 2d + 2.
      const at = (k: number) => v[k + d + 1]!;
      const k = x - y;
      const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      const prevX = at(prevK);
      const prevY = prevX - prevK;

      while (x > prevX && y > prevY) this.matchA[a0 + --x] = b0 + --y;
      x = prevX;
      y = prevY;
    }

    while (x > 0 && y > 0) this.matchA[a0 + --x] = b0 + --y;
  }
}

/** The longest run of pairs increasing on both sides (patience sorting); `pairs` are in old order. */
function longestRun(pairs: [number, number][]): [number, number][] {
  if (pairs.length <= 1) return pairs;
  const tails: number[] = [];
  const back = new Int32Array(pairs.length).fill(-1);

  for (let p = 0; p < pairs.length; p++) {
    const j = pairs[p]![1];
    let lo = 0;
    let hi = tails.length;

    while (lo < hi) {
      const mid = (lo + hi) >> 1;

      if (pairs[tails[mid]!]![1] < j) lo = mid + 1;
      else hi = mid;
    }

    if (lo > 0) back[p] = tails[lo - 1]!;
    tails[lo] = p;
  }

  const out: [number, number][] = [];

  for (let p = tails[tails.length - 1] ?? -1; p !== -1; p = back[p]!) out.push(pairs[p]!);

  return out.reverse();
}

/** One line of a hunk: its mark and text, and the marker after it when it ends a file with no newline. */
function push(lines: string[], mark: string, line: string): void {
  if (line.endsWith("\n")) {
    lines.push(mark + line.slice(0, -1));
  } else {
    lines.push(mark + line, NO_NEWLINE);
  }
}

/** The hunks between two texts, in git's unified format with three lines of context; none when they are equal. */
export function diffLines(oldText: string, newText: string): Hunk[] {
  const oldLines = linesOf(oldText);
  const newLines = linesOf(newText);
  const ids = new Map<string, number>();

  const id = (line: string) => {
    let n = ids.get(line);

    if (n === undefined) ids.set(line, (n = ids.size));

    return n;
  };

  const a = Int32Array.from(oldLines, id);
  const b = Int32Array.from(newLines, id);
  const matcher = new Matcher(a, b);

  matcher.run();

  // The edit script, in order: each kept line, and between two of them the old lines removed, then the new lines added (as git writes them).
  type Op = 0 | 1 | 2; // kept, removed, added

  const ops: Op[] = [];
  const at: [number, number][] = [];
  let j = 0;

  for (let i = 0; i <= a.length; i++) {
    const to = i < a.length ? matcher.matchA[i]! : b.length;

    if (to === -1) {
      ops.push(1);
      at.push([i, j]);
      continue;
    }

    while (j < to) {
      ops.push(2);
      at.push([i, j++]);
    }

    if (i < a.length) {
      ops.push(0);
      at.push([i, j++]);
    }
  }

  const hunks: Hunk[] = [];
  let k = 0;

  while (k < ops.length) {
    while (k < ops.length && ops[k] === 0) k++;

    if (k === ops.length) break;
    // A hunk: from CONTEXT kept lines before the change, to CONTEXT after the last change no more than 2 * CONTEXT kept lines apart.
    const start = Math.max(0, k - CONTEXT);
    let end = k;

    for (;;) {
      while (end < ops.length && ops[end] !== 0) end++;
      let gap = end;

      while (gap < ops.length && ops[gap] === 0 && gap - end < 2 * CONTEXT + 1) gap++;

      if (gap < ops.length && ops[gap] !== 0 && gap - end <= 2 * CONTEXT) {
        end = gap;
        continue;
      }

      end = Math.min(ops.length, end + CONTEXT);
      break;
    }

    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;

    for (let p = start; p < end; p++) {
      const [ia, ib] = at[p]!;

      if (ops[p] === 0) {
        push(lines, " ", oldLines[ia]!);
        oldCount++;
        newCount++;
      } else if (ops[p] === 1) {
        push(lines, "-", oldLines[ia]!);
        oldCount++;
      } else {
        push(lines, "+", newLines[ib]!);
        newCount++;
      }
    }

    hunks.push({ ...numbering(at[start]!, oldCount, newCount), lines });
    k = end;
  }

  return hunks;
}

function numbering([ia, ib]: [number, number], oldCount: number, newCount: number) {
  return { old_start: oldCount === 0 ? ia : ia + 1, old_lines: oldCount, new_start: newCount === 0 ? ib : ib + 1, new_lines: newCount };
}
