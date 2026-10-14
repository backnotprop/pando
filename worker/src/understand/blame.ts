// Which commit last changed each of a file's lines a to b, through Pando's own
// objects (the cached Objects entrypoint), as git blame does: the lines are
// carried back commit by commit; a line a commit added (against every parent)
// is that commit's; a line kept from a parent moves to the parent, at its line
// there. A merge passes each line to the first parent that has it unchanged,
// so a line a branch brought into main is blamed on the branch's commit, not
// the merge. Renames are not followed: a file that appears in a commit is that
// commit's. The walk stops after BLAME_CHANGES diffs or BLAME_VISITS commits
// (DESIGN.md, "Limits"), and says so.

import { diffLines } from "../monorepo/linediff";
import type { CommitMeta, Walker } from "../monorepo/files";
import type { ObjectsClient } from "../objects";

/** Diffs read at most (each reads two versions of the file). */
export const BLAME_CHANGES = 200;

/** Commits visited at most. */
const BLAME_VISITS = 3000;

/** A version of the file larger than this is not read. */
const BLOB_MAX = 2_000_000;

export interface BlamedLine {
  n: number;
  text: string;
  /** The commit that last changed it; null when the walk stopped first. */
  sha: string | null;
}

export interface Blame {
  lines: BlamedLine[];
  /** The commits named, by sha. */
  commits: Map<string, CommitMeta>;
  /** Why some lines have no commit; null when every line has one. */
  older: string | null;
}

/** A file's text at a version, or null (gone, binary or too large). */
export async function blobText(obj: ObjectsClient, artifacts: string, oid: string): Promise<string | null> {
  const r = await obj.raw(`/blob/${artifacts}/${oid}`);

  if (!r) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());

  if (bytes.byteLength > BLOB_MAX || bytes.subarray(0, 8000).includes(0)) return null;

  return new TextDecoder().decode(bytes);
}

/** For a line of `newText` (1-based), its line in `oldText`, or 0 when the change added it. */
export function lineMap(oldText: string, newText: string): (n: number) => number {
  const hunks = diffLines(oldText, newText);
  const added = new Set<number>();
  const kept = new Map<number, number>();
  const spans: { from: number; to: number; delta: number }[] = [];

  for (const h of hunks) {
    let o = h.old_lines === 0 ? h.old_start + 1 : h.old_start;
    let n = h.new_lines === 0 ? h.new_start + 1 : h.new_start;
    const from = n;

    for (const line of h.lines) {
      const mark = line[0];

      if (mark === " ") kept.set(n++, o++);
      else if (mark === "-") o++;
      else if (mark === "+") added.add(n++);
    }

    spans.push({ from, to: n, delta: h.new_lines - h.old_lines });
  }

  return (n) => {
    if (added.has(n)) return 0;
    const k = kept.get(n);

    if (k !== undefined) return k;
    let delta = 0;

    for (const s of spans) if (s.to <= n) delta += s.delta;

    return n - delta;
  };
}

const linesOf = (text: string) => text.replace(/\n$/, "").split("\n");

interface Pending {
  commit: CommitMeta;
  /** Line numbers in this commit's version, each with the asked line it carries (index into the result). */
  lines: { at: number; i: number }[];
}

export async function blame(w: Walker, obj: ObjectsClient, artifacts: string, start: CommitMeta, path: string, from: number, to: number): Promise<Blame | null> {
  const top = await w.entryAt(start.treeHash, path);

  if (!top || top.type === "tree") return null;
  const text = await blobText(obj, artifacts, top.oid);

  if (text === null) return null;
  const all = linesOf(text);
  const a = Math.max(1, from);
  const b = Math.min(all.length, to);
  const result: BlamedLine[] = [];

  for (let n = a; n <= b; n++) result.push({ n, text: all[n - 1] ?? "", sha: null });
  const commits = new Map<string, CommitMeta>();
  const texts = new Map<string, string | null>();

  const textOf = async (oid: string) => {
    if (!texts.has(oid)) texts.set(oid, await blobText(obj, artifacts, oid));

    return texts.get(oid) ?? null;
  };

  const queue: Pending[] = [{ commit: start, lines: result.map((r, i) => ({ at: r.n, i })) }];
  let changes = 0;
  let visits = 0;
  let stopped: string | null = null;

  const own = (c: CommitMeta, lines: { i: number }[]) => {
    commits.set(c.hash, c);

    for (const l of lines) result[l.i].sha = c.hash;
  };

  const push = (c: CommitMeta, lines: { at: number; i: number }[]) => {
    if (!lines.length) return;
    const had = queue.find((p) => p.commit.hash === c.hash);

    if (had) had.lines.push(...lines);
    else queue.push({ commit: c, lines });
  };

  while (queue.length) {
    // Newest first, so a commit reached by two paths is usually walked once with both sets of lines.
    queue.sort((x, y) => y.commit.authoredAt - x.commit.authoredAt);
    const p = queue.shift()!;

    if (++visits > BLAME_VISITS || changes >= BLAME_CHANGES) {
      stopped = `older than ${changes >= BLAME_CHANGES ? `${BLAME_CHANGES} changes to this file` : `${BLAME_VISITS} commits`}: Pando's blame stopped there`;
      break;
    }

    const here = await w.entryAt(p.commit.treeHash, path);

    if (!here) {
      own(p.commit, p.lines);
      continue;
    }

    let left = p.lines;

    for (const sha of p.commit.parents) {
      if (!left.length) break;
      const parent = await w.commit(sha);

      if (!parent) continue;
      const there = await w.entryAt(parent.treeHash, path);

      if (!there || there.type === "tree") continue;

      if (there.oid === here.oid) {
        push(parent, left);
        left = [];
        break;
      }

      const [now, then] = await Promise.all([textOf(here.oid), textOf(there.oid)]);

      if (now === null || then === null) continue;
      changes++;
      const map = lineMap(then, now);
      const moved: { at: number; i: number }[] = [];
      const stay: { at: number; i: number }[] = [];

      for (const l of left) {
        const at = map(l.at);

        if (at > 0) moved.push({ at, i: l.i });
        else stay.push(l);
      }

      push(parent, moved);
      left = stay;
    }

    own(p.commit, left);
  }

  return { lines: result, commits, older: result.some((r) => r.sha === null) ? (stopped ?? "not traced") : null };
}
