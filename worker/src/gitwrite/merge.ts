// mergeCommit: a two-parent merge commit of a branch head into a base branch,
// from a tree-level three-way merge against the merge base. No text merging.
import { buildPack } from "./pack";
import {
  commitObject,
  EMPTY_TREE,
  makeObject,
  TREE_MODE,
  treeObject,
  type GitObject,
  type Signature,
  type TreeEntry,
} from "./objects";
import { GitWriteError, isSha, OpenRepo, type GitRepo, type Stats } from "./repo";
import { checkBranchName, checkMessage, checkPresent, checkSignature } from "./validate";

export interface MergeOptions {
  base: string;
  head: string;
  baseSha?: string;
  message: string;
  author: Signature;
  committer?: Signature;
  dryRun?: boolean;
}

export type MergeResult =
  | { status: "merged"; sha: string; tree: string; old: string; mergeBase: string; stats: Stats }
  | { status: "mergeable"; tree: string; old: string; mergeBase: string; stats: Stats }
  | { status: "up_to_date"; sha: string; stats: Stats }
  | { status: "conflict"; paths: string[]; mergeBase: string; stats: Stats }
  | { status: "ref_moved"; expected: string; actual: string | null; stats: Stats };

export const MERGE_BASE_BUDGET = 5_000;

export async function mergeCommit(repo: GitRepo, opts: MergeOptions): Promise<MergeResult> {
  checkBranchName(opts?.base, "base");

  checkPresent(opts.head, "head");

  if (!isSha(opts.head)) checkBranchName(opts.head, "head");

  if (opts.baseSha !== undefined && !isSha(opts.baseSha)) {
    throw new GitWriteError("invalid_input", "baseSha must be a full lowercase sha");
  }

  checkMessage(opts.message);

  checkSignature(opts.author, "author");
  const committer = opts.committer ?? opts.author;
  checkSignature(committer, "committer");

  const r = await OpenRepo.open(repo);

  try {
    const old = await r.branchHead(opts.base);

    if (old === null) throw new GitWriteError("not_found", `branch ${opts.base} not found in ${r.name}`);

    if (opts.baseSha && opts.baseSha !== old) {
      return { status: "ref_moved", expected: opts.baseSha, actual: old, stats: r.stats };
    }

    let head: string;

    if (isSha(opts.head)) {
      head = (await r.commit(opts.head)).hash;
    } else {
      const h = await r.branchHead(opts.head);

      if (h === null) throw new GitWriteError("not_found", `branch ${opts.head} not found in ${r.name}`);
      head = h;
    }

    if (head === old) return { status: "up_to_date", sha: old, stats: r.stats };

    const bases = await mergeBases(r, old, head);

    if (bases.length === 0) {
      throw new GitWriteError("no_merge_base", `${opts.base} and ${opts.head} share no commit`);
    }

    const mergeBase = bases[0];

    if (mergeBase === head) return { status: "up_to_date", sha: old, stats: r.stats };

    const [baseC, oursC, theirsC] = await Promise.all([r.commit(mergeBase), r.commit(old), r.commit(head)]);
    const ctx: MergeCtx = { r, objects: new Map(), conflicts: [] };
    let tree: string;

    if (mergeBase === old) {
      tree = theirsC.treeHash; // base has not moved: the branch's tree is the result
    } else {
      tree = (await mergeTrees(ctx, baseC.treeHash, oursC.treeHash, theirsC.treeHash, "")) ?? EMPTY_TREE;
    }

    if (ctx.conflicts.length) {
      return { status: "conflict", paths: ctx.conflicts.sort(), mergeBase, stats: r.stats };
    }

    if (opts.dryRun) return { status: "mergeable", tree, old, mergeBase, stats: r.stats };

    if (tree === EMPTY_TREE) ctx.objects.set(EMPTY_TREE, await makeObject("tree", new Uint8Array()));

    const commit = await commitObject({
      tree,
      parents: [old, head],
      author: opts.author,
      committer,
      message: opts.message,
    });

    const objects = [...ctx.objects.values(), commit];
    r.stats.objectsWritten = objects.length;
    const refused = await r.push(`refs/heads/${opts.base}`, old, commit.sha, await buildPack(objects));

    if (refused !== null) {
      const now = await r.branchHead(opts.base);

      if (now !== old) return { status: "ref_moved", expected: old, actual: now, stats: r.stats };
      throw new GitWriteError("push_failed", `receive-pack refused ${opts.base}: ${refused}`);
    }

    return { status: "merged", sha: commit.sha, tree, old, mergeBase, stats: r.stats };
  } finally {
    r.close();
  }
}

// Merge bases of two commits, newest first, the way git paints them: walk
// back from both by commit time, marking which side reached each commit; a
// commit reached from both sides is a merge base, and its ancestors are not.
const ONE = 1;

const TWO = 2;

const STALE = 4;

const RESULT = 8;

export async function mergeBases(r: OpenRepo, a: string, b: string): Promise<string[]> {
  if (a === b) return [a];
  const flags = new Map<string, number>();
  const queue: { sha: string; time: number }[] = [];

  const push = async (sha: string) => {
    const c = await r.commit(sha);
    let i = queue.length;

    while (i > 0 && queue[i - 1].time < c.committedAt) i--;
    queue.splice(i, 0, { sha, time: c.committedAt }); // newest first
  };

  flags.set(a, ONE);
  flags.set(b, TWO);
  await push(a);
  await push(b);
  const results: string[] = [];
  let walked = 0;

  while (queue.some((q) => !((flags.get(q.sha) ?? 0) & STALE))) {
    if (++walked > MERGE_BASE_BUDGET) {
      throw new GitWriteError("too_large", `merge base search passed ${MERGE_BASE_BUDGET} commits`);
    }

    const { sha } = queue.shift()!;
    let f = (flags.get(sha) ?? 0) & (ONE | TWO | STALE);

    if (f === (ONE | TWO)) {
      if (!((flags.get(sha) ?? 0) & RESULT)) {
        flags.set(sha, (flags.get(sha) ?? 0) | RESULT);
        results.push(sha);
      }

      f |= STALE;
    }

    for (const p of (await r.commit(sha)).parents) {
      const pf = flags.get(p) ?? 0;

      if ((pf & f) === f) continue;
      flags.set(p, pf | f);
      await push(p);
    }
  }

  // A base that is an ancestor of another base was marked stale later on.
  const best = results.filter((s) => !((flags.get(s) ?? 0) & STALE));

  return best.length ? best : results;
}

interface MergeCtx {
  r: OpenRepo;
  objects: Map<string, GitObject>;
  conflicts: string[];
}

type Entry = { mode: string; hash: string } | undefined;

const same = (x: Entry, y: Entry) => x?.mode === y?.mode && x?.hash === y?.hash;

const isTree = (e: Entry) => e?.mode === TREE_MODE;

const isFile = (e: Entry) => e?.mode === "100644" || e?.mode === "100755";

// Three-way merge of trees. Only trees that differ on both sides are read,
// so the work follows the changed paths, not the size of the repo.
async function mergeTrees(
  ctx: MergeCtx,
  base: string | null,
  ours: string | null,
  theirs: string | null,
  path: string,
): Promise<string | null> {
  if (ours === theirs) return ours;

  if (base === theirs) return ours;

  if (base === ours) return theirs;
  const [b, o, t] = await Promise.all([ctx.r.tree(base), ctx.r.tree(ours), ctx.r.tree(theirs)]);
  const byName = (list: TreeEntry[]) => new Map(list.map((e) => [e.name, e]));
  const bm = byName(b);
  const om = byName(o);
  const tm = byName(t);
  const names = new Set([...bm.keys(), ...om.keys(), ...tm.keys()]);
  const out: TreeEntry[] = [];

  for (const name of names) {
    const p = path ? `${path}/${name}` : name;
    const r = await mergeEntry(ctx, bm.get(name), om.get(name), tm.get(name), p);

    if (r) out.push({ name, mode: r.mode, hash: r.hash });
  }

  if (out.length === 0) return null;
  const obj = await treeObject(out);

  if (obj.sha !== ours && obj.sha !== theirs) ctx.objects.set(obj.sha, obj);

  return obj.sha;
}

async function mergeEntry(ctx: MergeCtx, be: Entry, oe: Entry, te: Entry, path: string): Promise<Entry> {
  if (same(oe, te)) return oe; // unchanged, or changed identically

  if (same(be, te)) return oe; // only ours changed

  if (same(be, oe)) return te; // only theirs changed

  // Both sides changed it, differently.
  if ((oe === undefined || isTree(oe)) && (te === undefined || isTree(te))) {
    const sub = await mergeTrees(ctx, isTree(be) ? be!.hash : null, oe?.hash ?? null, te?.hash ?? null, path);

    return sub === null ? undefined : { mode: TREE_MODE, hash: sub };
  }

  if (isFile(oe) && isFile(te) && (be === undefined || isFile(be))) {
    // Content and mode merge separately: one side's chmod and the other's edit both land.
    const hash = pick3(be?.hash, oe!.hash, te!.hash);
    const mode = pick3(be?.mode, oe!.mode, te!.mode);

    if (hash !== null && mode !== null) return { mode, hash };
  }

  ctx.conflicts.push(path);

  return oe;
}

function pick3(b: string | undefined, o: string, t: string): string | null {
  if (o === t) return o;

  if (b === t) return o;

  if (b === o) return t;

  return null;
}
