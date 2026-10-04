// The commit graph, read through the Artifacts binding: the merge base of two
// commits and how many commits each side has that the other lacks.
// Commits are immutable, so their metadata is cached per isolate. A cache
// miss reads up to 64 first-parent ancestors in one `log` call.

import type { Env } from "../env";
import { HttpError } from "../http";
import { withRepo } from "./artifacts";
import { coAuthorEmails } from "./trailers";

export interface CommitInfo {
  parents: string[];
  time: number;
  tree: string;
  /** Present when read from Artifacts; tests may leave them out. */
  message?: string;
  author?: { name: string; email: string };
  committer?: { name: string; email: string };
  authoredAt?: number;
  /** The emails its Co-authored-by trailers name (read from the whole message, before it is cut). */
  coauthors?: string[];
}

function info(c: ArtifactsCommitMetadata): CommitInfo {
  return {
    parents: c.parents, time: c.committedAt, tree: c.treeHash,
    message: c.message.length > 4096 ? c.message.slice(0, 4096) : c.message,
    author: c.author, committer: c.committer, authoredAt: c.authoredAt,
    coauthors: coAuthorEmails(c.message),
  };
}

const MAX_CACHE = 20_000;

const BATCH = 64;

const BUDGET = 5_000;

const cache = new Map<string, CommitInfo>();

export type CommitReader = (sha: string) => Promise<CommitInfo>;

export function commitReader(repo: ArtifactsRepo): CommitReader {
  return async (sha) => {
    const hit = cache.get(sha);

    if (hit) return hit;

    if (cache.size > MAX_CACHE) cache.clear();
    const list = await repo.log({ ref: sha, limit: BATCH });

    for (const c of list) cache.set(c.hash, info(c));
    let got = cache.get(sha);

    if (!got) {
      const c = await repo.readCommit(sha);

      if (!c) throw new HttpError(404, "not_found", `commit ${sha} not found`);
      got = info(c);
      cache.set(sha, got);
    }

    return got;
  };
}

export interface Comparison {
  mergeBase: string | null;
  /** Commits reachable from `head` and not from `base`. */
  ahead: number;
  /** Commits reachable from `base` and not from `head`. */
  behind: number;
  /** The commits counted in `ahead`, newest first. */
  aheadCommits: string[];
}

const FROM_BASE = 1;

const FROM_HEAD = 2;

const STALE = 4;

/**
 * Git's paint-down-to-common walk, newest commit first. Stops when every
 * commit left in the queue is known to be below a common ancestor.
 */
export async function compareWith(read: CommitReader, base: string, head: string): Promise<Comparison> {
  if (base === head) return { mergeBase: base, ahead: 0, behind: 0, aheadCommits: [] };
  const flags = new Map<string, number>([[base, FROM_BASE], [head, FROM_HEAD]]);
  const queue = new Heap();
  queue.push(base, (await read(base)).time);
  queue.push(head, (await read(head)).time);
  const bases: string[] = [];
  let visited = 0;

  while (queue.size && queue.anyLive(flags)) {
    const sha = queue.pop()!;

    if (++visited > BUDGET) throw new HttpError(422, "too_large", `the merge base search passed ${BUDGET} commits`);
    let f = flags.get(sha)!;

    if ((f & (FROM_BASE | FROM_HEAD)) === (FROM_BASE | FROM_HEAD) && !(f & STALE)) {
      bases.push(sha);
      f |= STALE;
      flags.set(sha, f);
    }

    const c = await read(sha);

    for (const p of c.parents) {
      const pf = flags.get(p) ?? 0;
      const nf = pf | f;

      if (nf !== pf) {
        flags.set(p, nf);
        queue.push(p, (await read(p)).time);
      }
    }
  }

  let behind = 0;
  const aheadCommits: string[] = [];

  for (const [sha, f] of flags) {
    const side = f & (FROM_BASE | FROM_HEAD);

    if (side === FROM_HEAD) aheadCommits.push(sha);
    else if (side === FROM_BASE) behind++;
  }

  return { mergeBase: bases[0] ?? null, ahead: aheadCommits.length, behind, aheadCommits: await newestFirst(read, head, aheadCommits) };
}

export async function compare(env: Env, artifactsName: string, base: string, head: string): Promise<Comparison> {
  return withRepo(env, artifactsName, (repo) => compareWith(commitReader(repo), base, head));
}

/** Where a paged walk goes on: each queued commit and its paint (FROM_BASE, FROM_HEAD or both). */
export type Frontier = { sha: string; paint: number }[];

/**
 * The commits reachable from `head` and not from `base` (with `base` null:
 * all of them), newest first by commit time, down to `since` (Unix seconds):
 * a merge's new commits, or a repository's history, a page at a time. Git's
 * paint-down walk as compareWith does it, with no budget: at most `max`
 * commits are read for one page and `next` says where the walk goes on (empty
 * when it is done). A commit is taken when it leaves the queue with only
 * head's paint (by then every child has painted it). Commits older than
 * `since` end their line. Clock skew can count a commit a page apart twice.
 */
export async function walkAhead(read: CommitReader, start: Frontier, since: number, max: number): Promise<{ commits: string[]; next: Frontier }> {
  const queue = new Heap();
  const paint = new Map<string, number>();
  const commits: string[] = [];
  let walked = 0;

  for (const s of start) {
    paint.set(s.sha, (paint.get(s.sha) ?? 0) | s.paint);
    queue.push(s.sha, (await read(s.sha)).time);
  }

  const live = () => queue.rest().some((sha) => !((paint.get(sha) ?? 0) & FROM_BASE));

  while (queue.size && live() && walked < max) {
    const sha = queue.pop()!;
    const f = paint.get(sha) ?? 0;
    const c = await read(sha);
    walked++;

    if (c.time < since) continue;

    if (f === FROM_HEAD) commits.push(sha);

    for (const p of c.parents) {
      const pf = paint.get(p) ?? 0;

      if ((pf | f) !== pf) {
        paint.set(p, pf | f);
        queue.push(p, (await read(p)).time);
      }
    }
  }

  return { commits, next: live() ? queue.rest().map((sha) => ({ sha, paint: paint.get(sha) ?? 0 })) : [] };
}

/** The first page of a walk: `head` against `base` (null: a whole history). */
export const walkStart = (base: string | null, head: string): Frontier => [
  ...(base ? [{ sha: base, paint: FROM_BASE }] : []),
  { sha: head, paint: FROM_HEAD },
];

/** A max-heap of commits by commit time. */
class Heap {
  private items: { sha: string; time: number }[] = [];
  private inQueue = new Set<string>();

  get size() {
    return this.items.length;
  }

  push(sha: string, time: number) {
    if (this.inQueue.has(sha)) return;
    this.inQueue.add(sha);
    const a = this.items;
    a.push({ sha, time });
    let i = a.length - 1;

    while (i > 0) {
      const p = (i - 1) >> 1;

      if (a[p].time >= a[i].time) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop(): string | undefined {
    const a = this.items;

    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;

    if (a.length) {
      a[0] = last;
      let i = 0;

      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;

        if (l < a.length && a[l].time > a[m].time) m = l;

        if (r < a.length && a[r].time > a[m].time) m = r;

        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }

    this.inQueue.delete(top.sha);

    return top.sha;
  }

  /** The commits still queued, in no order. */
  rest(): string[] {
    return this.items.map((it) => it.sha);
  }

  anyLive(flags: Map<string, number>): boolean {
    return this.items.some((it) => !((flags.get(it.sha) ?? 0) & STALE));
  }
}

/**
 * `commits` in git log's order: every commit before its parents (a reverse
 * post-order walk from `head`), so commits made in the same second still list
 * the newer one first. Commits the walk does not reach go last, newest first.
 */
async function newestFirst(read: CommitReader, head: string, commits: string[]): Promise<string[]> {
  const set = new Set(commits);
  const done = new Set<string>();
  const post: string[] = [];
  const stack: { sha: string; next: number }[] = set.has(head) ? [{ sha: head, next: 0 }] : [];

  if (set.has(head)) done.add(head);

  while (stack.length) {
    const top = stack[stack.length - 1];
    const parents = (await read(top.sha)).parents;

    if (top.next < parents.length) {
      const p = parents[top.next++];

      if (set.has(p) && !done.has(p)) {
        done.add(p);
        stack.push({ sha: p, next: 0 });
      }

      continue;
    }

    post.push(top.sha);
    stack.pop();
  }

  const ordered = post.reverse();
  const rest = commits.filter((c) => !done.has(c));

  if (rest.length) {
    const times = new Map<string, number>();

    for (const sha of rest) times.set(sha, (await read(sha)).time);
    rest.sort((a, b) => times.get(b)! - times.get(a)!);
  }

  return [...ordered, ...rest];
}
