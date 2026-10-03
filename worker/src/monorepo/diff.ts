// The branch diff (GitHub's three-dot diff): from the merge base's tree to the
// head's tree, read through the Artifacts binding with no clone. Equal
// subtrees are skipped; only changed blobs are read; text is diffed with
// Myers (jsdiff), bounded by a byte budget.

import { structuredPatch } from "diff";

export interface DiffOptions {
  hunks: boolean;
  maxBytes: number;
  paths: string[];
}

export interface Hunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: string[];
}

export interface DiffFile {
  path: string;
  old_path?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  old_sha: string | null;
  new_sha: string | null;
  old_mode: string | null;
  new_mode: string | null;
  binary: boolean;
  additions: number | null;
  deletions: number | null;
  hunks?: Hunk[];
  patch_omitted?: "binary" | "too_large" | "budget";
}

export interface DiffResult {
  files: DiffFile[];
  truncated: boolean;
  stats: { files: number; additions: number; deletions: number };
}

const MAX_TEXT_BYTES = 1 << 20; // per side
const MAX_EDIT_LENGTH = 20_000;
const CONCURRENCY = 6;

interface Entry {
  path: string;
  mode: string;
  sha: string;
  type: ArtifactsTreeEntryType;
}

/** Does `path` (a file or a folder) fall under a `paths` filter, or lead to one? */
function wanted(path: string, isDir: boolean, filters: string[]): boolean {
  if (!filters.length) return true;
  return filters.some((f) => {
    if (path === f || path.startsWith(f.endsWith("/") ? f : f + "/")) return true;
    if (f.endsWith("/") ? path.startsWith(f) : false) return true;
    return isDir && f.startsWith(path + "/");
  });
}

async function readTree(repo: ArtifactsRepo, sha: string): Promise<Map<string, ArtifactsTreeEntry>> {
  const entries = await repo.readTree(sha);
  if (!entries) throw new Error(`tree ${sha} not found`);
  return new Map(entries.map((e) => [e.name, e]));
}

async function allFiles(repo: ArtifactsRepo, sha: string, prefix: string, filters: string[], out: Entry[]): Promise<void> {
  const tree = await readTree(repo, sha);
  await Promise.all(
    [...tree.values()].map(async (e) => {
      const path = prefix + e.name;
      if (e.type === "tree") {
        if (wanted(path, true, filters)) await allFiles(repo, e.hash, path + "/", filters, out);
      } else if (wanted(path, false, filters)) out.push({ path, mode: e.mode, sha: e.hash, type: e.type });
    }),
  );
}

/** Walk two trees; collect files that differ. */
async function walk(
  repo: ArtifactsRepo,
  a: string | null,
  b: string | null,
  prefix: string,
  filters: string[],
  removed: Entry[],
  added: Entry[],
  changed: [Entry, Entry][],
): Promise<void> {
  if (a === b) return;
  if (a === null) return allFiles(repo, b!, prefix, filters, added);
  if (b === null) return allFiles(repo, a, prefix, filters, removed);
  const [ta, tb] = await Promise.all([readTree(repo, a), readTree(repo, b)]);
  const names = new Set([...ta.keys(), ...tb.keys()]);
  const jobs: Promise<void>[] = [];
  for (const name of names) {
    const ea = ta.get(name);
    const eb = tb.get(name);
    const path = prefix + name;
    if (ea && eb && ea.hash === eb.hash && ea.mode === eb.mode) continue;
    const aDir = ea?.type === "tree";
    const bDir = eb?.type === "tree";
    if (aDir || bDir) {
      if (!wanted(path, true, filters)) {
        // Only a file on the other side might still be wanted.
      } else if (aDir && bDir) {
        jobs.push(walk(repo, ea!.hash, eb!.hash, path + "/", filters, removed, added, changed));
        continue;
      } else {
        jobs.push(walk(repo, aDir ? ea!.hash : null, bDir ? eb!.hash : null, path + "/", filters, removed, added, changed));
      }
    }
    const fa = ea && !aDir ? { path, mode: ea.mode, sha: ea.hash, type: ea.type } : null;
    const fb = eb && !bDir ? { path, mode: eb.mode, sha: eb.hash, type: eb.type } : null;
    if (!wanted(path, false, filters)) continue;
    if (fa && fb) changed.push([fa, fb]);
    else if (fa) removed.push(fa);
    else if (fb) added.push(fb);
  }
  await Promise.all(jobs);
}

interface BlobRead {
  size: number;
  /** The whole blob, only when it is at most MAX_TEXT_BYTES. */
  bytes: Uint8Array | null;
  binary: boolean;
}

/** Read a blob, but never more than its first 8,000 bytes when it is large. */
async function readBlobFor(repo: ArtifactsRepo, e: Entry | null): Promise<BlobRead | null> {
  if (!e || e.type === "gitlink") return null;
  const blob = await repo.readBlob(e.sha);
  if (!blob) throw new Error(`blob ${e.sha} not found`);
  const head = new Uint8Array(await blob.slice(0, 8000).arrayBuffer());
  const binary = head.includes(0);
  const bytes = !binary && blob.size <= MAX_TEXT_BYTES ? new Uint8Array(await blob.arrayBuffer()) : null;
  return { size: blob.size, bytes, binary };
}

const decoder = new TextDecoder();

/** Hunks with git's numbering (a hunk with no lines on a side starts one line earlier). */
function lineDiff(oldText: string, newText: string): Hunk[] | null {
  const p = structuredPatch("a", "b", oldText, newText, undefined, undefined, { context: 3, maxEditLength: MAX_EDIT_LENGTH });
  if (!p) return null;
  return p.hunks.map((h) => ({
    old_start: h.oldLines === 0 ? h.oldStart - 1 : h.oldStart,
    old_lines: h.oldLines,
    new_start: h.newLines === 0 ? h.newStart - 1 : h.newStart,
    new_lines: h.newLines,
    lines: h.lines,
  }));
}

function hunkBytes(hunks: Hunk[]): number {
  let n = 0;
  for (const h of hunks) for (const l of h.lines) n += l.length + 1;
  return n;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

export async function treeDiff(repo: ArtifactsRepo, fromTree: string, toTree: string, opts: DiffOptions): Promise<DiffResult> {
  const removed: Entry[] = [];
  const added: Entry[] = [];
  const changed: [Entry, Entry][] = [];
  await walk(repo, fromTree, toTree, "", opts.paths, removed, added, changed);

  // Exact renames: a removed blob that reappears, unchanged, at a new path.
  const pairs: { old: Entry | null; new: Entry | null; status: DiffFile["status"] }[] = [];
  const addedBySha = new Map<string, Entry[]>();
  for (const e of added) addedBySha.set(e.sha, [...(addedBySha.get(e.sha) ?? []), e]);
  const renamedTo = new Set<Entry>();
  for (const r of removed) {
    const target = addedBySha.get(r.sha)?.find((e) => !renamedTo.has(e));
    if (target) {
      renamedTo.add(target);
      pairs.push({ old: r, new: target, status: "renamed" });
    } else pairs.push({ old: r, new: null, status: "deleted" });
  }
  for (const e of added) if (!renamedTo.has(e)) pairs.push({ old: null, new: e, status: "added" });
  for (const [a, b] of changed) pairs.push({ old: a, new: b, status: "modified" });
  pairs.sort((x, y) => ((x.new ?? x.old)!.path < (y.new ?? y.old)!.path ? -1 : 1));

  const files: DiffFile[] = pairs.map((p) => ({
    path: (p.new ?? p.old)!.path,
    ...(p.status === "renamed" ? { old_path: p.old!.path } : {}),
    status: p.status,
    old_sha: p.old?.sha ?? null,
    new_sha: p.new?.sha ?? null,
    old_mode: p.old?.mode ?? null,
    new_mode: p.new?.mode ?? null,
    binary: false,
    additions: 0,
    deletions: 0,
  }));

  // Read and diff the changed blobs. Renames with the same blob need no read.
  const computed = new Map<DiffFile, Hunk[]>();
  await pool(
    files.map((f, i) => [f, pairs[i]] as const),
    CONCURRENCY,
    async ([f, p]) => {
      if (f.status === "renamed") return;
      if (p.old?.type === "gitlink" || p.new?.type === "gitlink") {
        f.additions = f.deletions = null;
        return;
      }
      const [a, b] = await Promise.all([readBlobFor(repo, p.old), readBlobFor(repo, p.new)]);
      if (a?.binary || b?.binary) {
        f.binary = true;
        f.additions = f.deletions = null;
        f.patch_omitted = "binary";
        return;
      }
      if ((a?.size ?? 0) > MAX_TEXT_BYTES || (b?.size ?? 0) > MAX_TEXT_BYTES) {
        f.additions = f.deletions = null;
        f.patch_omitted = "too_large";
        return;
      }
      const hunks = lineDiff(a?.bytes ? decoder.decode(a.bytes) : "", b?.bytes ? decoder.decode(b.bytes) : "");
      if (!hunks) {
        f.additions = f.deletions = null;
        f.patch_omitted = "too_large";
        return;
      }
      let add = 0;
      let del = 0;
      for (const h of hunks) for (const l of h.lines) l[0] === "+" ? add++ : l[0] === "-" ? del++ : 0;
      f.additions = add;
      f.deletions = del;
      computed.set(f, hunks);
    },
  );

  // Spend the byte budget in path order.
  let used = 0;
  let truncated = false;
  for (const f of files) {
    const hunks = computed.get(f);
    if (!hunks) continue;
    const size = hunkBytes(hunks);
    if (used + size > opts.maxBytes) {
      f.patch_omitted = "budget";
      truncated = true;
      continue;
    }
    used += size;
    if (opts.hunks) f.hunks = hunks;
  }

  const stats = { files: files.length, additions: 0, deletions: 0 };
  for (const f of files) {
    stats.additions += f.additions ?? 0;
    stats.deletions += f.deletions ?? 0;
  }
  return { files, truncated, stats };
}

/** A unified diff with git's headers, for `git apply` and Plannotator. */
export function toPatch(result: DiffResult, hunksOf: (f: DiffFile) => Hunk[] | undefined): { text: string; omitted: number } {
  const out: string[] = [];
  let omitted = 0;
  for (const f of result.files) {
    if (f.patch_omitted === "budget" || f.patch_omitted === "too_large") {
      omitted++;
      continue;
    }
    const oldPath = f.old_path ?? f.path;
    out.push(`diff --git a/${oldPath} b/${f.path}`);
    if (f.status === "added") out.push(`new file mode ${f.new_mode}`);
    else if (f.status === "deleted") out.push(`deleted file mode ${f.old_mode}`);
    else {
      if (f.old_mode !== f.new_mode) out.push(`old mode ${f.old_mode}`, `new mode ${f.new_mode}`);
      if (f.status === "renamed") out.push("similarity index 100%", `rename from ${oldPath}`, `rename to ${f.path}`);
    }
    const hunks = hunksOf(f) ?? [];
    if (f.old_sha !== f.new_sha) {
      const sameMode = f.status === "modified" && f.old_mode === f.new_mode;
      out.push(`index ${f.old_sha ?? "0".repeat(40)}..${f.new_sha ?? "0".repeat(40)}${sameMode ? " " + f.new_mode : ""}`);
    }
    if (f.binary) {
      out.push(`Binary files ${f.old_sha ? "a/" + oldPath : "/dev/null"} and ${f.new_sha ? "b/" + f.path : "/dev/null"} differ`);
      continue;
    }
    if (!hunks.length) continue;
    out.push(f.status === "added" ? "--- /dev/null" : `--- a/${oldPath}`);
    out.push(f.status === "deleted" ? "+++ /dev/null" : `+++ b/${f.path}`);
    for (const h of hunks) {
      const o = h.old_lines === 1 ? `${h.old_start}` : `${h.old_start},${h.old_lines}`;
      const n = h.new_lines === 1 ? `${h.new_start}` : `${h.new_start},${h.new_lines}`;
      out.push(`@@ -${o} +${n} @@`);
      out.push(...h.lines);
    }
  }
  return { text: out.length ? out.join("\n") + "\n" : "", omitted };
}
