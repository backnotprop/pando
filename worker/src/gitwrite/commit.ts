// commitChanges: one commit on a branch from a list of file writes and
// deletes. Only the directories on the changed paths are read and rebuilt.
import { buildPack } from "./pack";
import {
  blobObject,
  commitObject,
  EMPTY_TREE,
  makeObject,
  TREE_MODE,
  treeObject,
  type GitObject,
  type Signature,
} from "./objects";
import { GitWriteError, isSha, OpenRepo, type GitRepo, type Stats } from "./repo";
import { checkBranchName, checkSignature, splitPath } from "./validate";

export type Change =
  | { path: string; content: string | Uint8Array; mode?: "100644" | "100755" | "120000" }
  | { path: string; delete: true };

export interface CommitOptions {
  parent: string | null;
  changes: Change[];
  message: string;
  author: Signature;
  committer?: Signature;
}

export type CommitResult =
  | { status: "committed"; sha: string; tree: string; stats: Stats }
  | { status: "unchanged"; sha: string; stats: Stats }
  | { status: "ref_moved"; expected: string | null; actual: string | null; stats: Stats };

const MAX_BLOB = 32 * 1024 * 1024; // Artifacts' per-file limit

const MODES = new Set(["100644", "100755", "120000"]);

// The changes as a tree of directories, so each directory is visited once.
interface Dir {
  files: Map<string, Change>;
  dirs: Map<string, Dir>;
}

const newDir = (): Dir => ({ files: new Map(), dirs: new Map() });

function planChanges(changes: Change[]): Dir {
  const root = newDir();
  const seen = new Set<string>();

  for (const ch of changes) {
    const parts = splitPath(ch?.path);

    if (seen.has(ch.path)) throw new GitWriteError("invalid_input", `${ch.path} appears twice`);
    seen.add(ch.path);

    if ("delete" in ch) {
      if (ch.delete !== true) throw new GitWriteError("invalid_input", `${ch.path}: delete must be true`);
    } else {
      if (typeof ch.content !== "string" && !(ch.content instanceof Uint8Array)) {
        throw new GitWriteError("invalid_input", `${ch.path}: content must be a string or Uint8Array`);
      }

      if (ch.mode !== undefined && !MODES.has(ch.mode)) {
        throw new GitWriteError("invalid_input", `${ch.path}: mode must be 100644, 100755 or 120000`);
      }
    }

    let d = root;

    for (const seg of parts.slice(0, -1)) {
      if (d.files.has(seg)) throw new GitWriteError("invalid_input", `${ch.path}: a parent is also written as a file`);
      let next = d.dirs.get(seg);

      if (!next) d.dirs.set(seg, (next = newDir()));
      d = next;
    }

    const name = parts[parts.length - 1];

    if (d.dirs.has(name)) throw new GitWriteError("invalid_input", `${ch.path}: also used as a directory`);
    d.files.set(name, ch);
  }

  return root;
}

export async function commitChanges(repo: GitRepo, branch: string, opts: CommitOptions): Promise<CommitResult> {
  checkBranchName(branch, "branch");

  if (!opts || (opts.parent !== null && !isSha(opts.parent))) {
    throw new GitWriteError("invalid_input", "parent must be a full lowercase sha or null");
  }

  if (!Array.isArray(opts.changes) || opts.changes.length === 0) {
    throw new GitWriteError("invalid_input", "changes must be a non-empty list");
  }

  if (typeof opts.message !== "string" || !opts.message.trim()) {
    throw new GitWriteError("invalid_input", "message is required");
  }

  checkSignature(opts.author, "author");
  const committer = opts.committer ?? opts.author;
  checkSignature(committer, "committer");
  const plan = planChanges(opts.changes);

  const r = await OpenRepo.open(repo);

  try {
    const current = await r.branchHead(branch);

    if (current !== null && current !== opts.parent) {
      return { status: "ref_moved", expected: opts.parent, actual: current, stats: r.stats };
    }

    const baseTree = opts.parent ? (await r.commit(opts.parent)).treeHash : null;
    const objects = new Map<string, GitObject>();
    const tree = (await applyDir(r, objects, baseTree, plan, "")) ?? EMPTY_TREE;

    if (opts.parent && tree === baseTree) return { status: "unchanged", sha: opts.parent, stats: r.stats };

    if (tree === EMPTY_TREE) {
      if (!opts.parent) throw new GitWriteError("invalid_input", "nothing to commit on a new branch");
      objects.set(EMPTY_TREE, await makeObject("tree", new Uint8Array()));
    }

    const commit = await commitObject({
      tree,
      parents: opts.parent ? [opts.parent] : [],
      author: opts.author,
      committer,
      message: opts.message,
    });

    const all = [...objects.values(), commit];
    r.stats.objectsWritten = all.length;
    const refused = await r.push(`refs/heads/${branch}`, current, commit.sha, await buildPack(all));

    if (refused !== null) {
      const now = await r.branchHead(branch);

      if (now !== current) return { status: "ref_moved", expected: opts.parent, actual: now, stats: r.stats };
      throw new GitWriteError("push_failed", `receive-pack refused ${branch}: ${refused}`);
    }

    return { status: "committed", sha: commit.sha, tree, stats: r.stats };
  } finally {
    r.close();
  }
}

// Apply one directory's changes to the tree at treeSha (null: no tree yet).
// Returns the new tree's sha, or null when the directory ends up empty.
async function applyDir(
  r: OpenRepo,
  objects: Map<string, GitObject>,
  treeSha: string | null,
  dir: Dir,
  path: string,
): Promise<string | null> {
  const entries = new Map((await r.tree(treeSha)).map((e) => [e.name, e]));

  for (const [name, ch] of dir.files) {
    const existing = entries.get(name);

    if ("delete" in ch) {
      entries.delete(name);
      continue;
    }

    if (existing?.mode === TREE_MODE) {
      throw new GitWriteError("invalid_input", `${ch.path} is a directory`);
    }

    const blob = await blobObject(ch.content);

    if (blob.data.length > MAX_BLOB) throw new GitWriteError("invalid_input", `${ch.path} is over 32 MB`);
    const keep = existing && (existing.mode === "100644" || existing.mode === "100755") ? existing.mode : "100644";
    const mode = ch.mode ?? keep;

    if (blob.sha !== existing?.hash) objects.set(blob.sha, blob);
    entries.set(name, { name, mode, hash: blob.sha });
  }

  for (const [name, sub] of dir.dirs) {
    const existing = entries.get(name);
    const p = path ? `${path}/${name}` : name;

    if (existing && existing.mode !== TREE_MODE) {
      if (onlyDeletes(sub)) continue; // nothing under a file to delete
      throw new GitWriteError("invalid_input", `${p} is a file, not a directory`);
    }

    const sha = await applyDir(r, objects, existing?.hash ?? null, sub, p);

    if (sha === null) entries.delete(name);
    else entries.set(name, { name, mode: TREE_MODE, hash: sha });
  }

  if (entries.size === 0) return null;
  const obj = await treeObject([...entries.values()]);

  if (obj.sha !== treeSha) objects.set(obj.sha, obj);

  return obj.sha;
}

function onlyDeletes(d: Dir): boolean {
  for (const ch of d.files.values()) if (!("delete" in ch)) return false;

  for (const sub of d.dirs.values()) if (!onlyDeletes(sub)) return false;

  return true;
}
