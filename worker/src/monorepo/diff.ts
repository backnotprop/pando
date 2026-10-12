// The branch diff (GitHub's three-dot diff): from the merge base's tree to the
// head's tree, read through the Artifacts binding with no clone. Equal
// subtrees are skipped; only changed blobs are read; text is diffed line by
// line (linediff.ts: patience, then bounded Myers), bounded by a byte budget.
// The files come out in path order as they are diffed (`fileDiffs`), so a
// route can stream them.

import { diffLines, type Hunk } from "./linediff";

export type { Hunk } from "./linediff";

export interface DiffOptions {
  hunks: boolean;
  maxBytes: number;
  paths: string[];
  /** List at most this many files (in path order); the rest are counted in `files_total` only. */
  maxFiles?: number;
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
  /** Every changed file, listed or not. */
  files_total: number;
  /** More files changed than `maxFiles`: only the first are listed. */
  too_many_files: boolean;
}

/** A side larger than this is listed without its diff (owner limit; it was 1 MiB). */
export const MAX_TEXT_BYTES = 8 << 20;

/** Blob reads in flight at once: Artifacts answers each in about 50 to 300 ms. */
const CONCURRENCY = 16;

/** Text read and diffed at once, in bytes: a few large files take turns, so a request never holds more than this. */
const BYTES_IN_FLIGHT = 24 << 20;

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
  const entries = await again((attempt) => within(repo.readTree(sha), `tree ${sha}`, READ_TIMEOUT_MS * attempt));

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
  blob: Blob;
}

/**
 * A blob's handle and size; its bytes are read once, later. A blob that comes
 * over RPC is a stream: read twice (a head, then the whole), the second read
 * waits until the session gives up (minutes); never read, it must be cancelled.
 */
async function readBlobFor(repo: ArtifactsRepo, e: Entry | null): Promise<BlobRead | null> {
  if (!e || e.type === "gitlink") return null;
  const blob = await again((attempt) => within(repo.readBlob(e.sha), `blob ${e.sha}`, READ_TIMEOUT_MS * attempt));

  if (!blob) throw new Error(`blob ${e.sha} not found`);

  return { size: blob.size, blob };
}

/**
 * Whether an Artifacts failure is the connection's, not the data's: its RPC
 * sometimes drops a call under load ("Network connection lost", retryable),
 * or the whole session, failing every stream on it ("... RPC stub was
 * disposed without calling close()").
 */
export function isDropped(err: Error): boolean {
  return ("retryable" in err && err.retryable === true) || /connection lost|disposed without calling close/i.test(err.message);
}

/**
 * Artifacts answers a tree or a blob in well under a second, and a blob's
 * bytes at 1 MiB in a second or two (the slowest seen: 1.4 MB in 2.4 s). Now
 * and then a read never answers (seen on wrangler dev: a stream held for
 * minutes; the 4.7 MB side of the fixture's csv, first read after its push,
 * every run): past these it counts as dropped, and is read again, with twice
 * and three times as long.
 */
const READ_TIMEOUT_MS = 10_000;

const BYTES_TIMEOUT_MS_PER_MIB = 2_000;

/** `read`, or a dropped-connection error once it has had no answer for `ms` (the hung call itself cannot be cancelled). */
function within<T>(read: Promise<T>, what: string, ms = READ_TIMEOUT_MS): Promise<T> {
  const timers: ReturnType<typeof setTimeout>[] = [];

  const hung = new Promise<never>((_, fail) => {
    timers.push(setTimeout(() => fail(new Error(`${what}: no answer in ${ms / 1000} s (connection lost)`)), ms));
  });

  return Promise.race([read, hung]).finally(() => timers.forEach(clearTimeout));
}

/** A read the connection dropped is tried again, up to three times in all; `read` is told which try it is (a slow read gets longer each time). */
async function again<T>(read: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read(attempt);
    } catch (err) {
      if (attempt === 3 || !(err instanceof Error) || !isDropped(err)) throw err;
      console.warn({ msg: "pando.artifacts-retry", attempt, error: err.message });
      await new Promise((go) => setTimeout(go, 200 * attempt));
    }
  }
}

/** git's test for binary: a NUL in the first 8,000 bytes. */
const BINARY_TEST = 8000;

/** The first BINARY_TEST bytes of a blob not read whole; its stream is cancelled after. */
async function headOf(blob: Blob): Promise<Uint8Array> {
  const reader = blob.stream().getReader();
  const head = new Uint8Array(BINARY_TEST);
  let n = 0;

  try {
    while (n < BINARY_TEST) {
      const { value, done } = await within(reader.read(), "a blob's first bytes");

      if (done) break;
      head.set(value.subarray(0, BINARY_TEST - n), n);
      n += Math.min(value.byteLength, BINARY_TEST - n);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return head.subarray(0, n);
}

const isBinary = (bytes: Uint8Array) => bytes.subarray(0, BINARY_TEST).includes(0);

/** A side's bytes, read once (none for a missing side). */
const bytesOf = async (x: BlobRead | null) =>
  x ? new Uint8Array(await within(x.blob.arrayBuffer(), "a blob's bytes", READ_TIMEOUT_MS + (x.size / (1 << 20)) * BYTES_TIMEOUT_MS_PER_MIB)) : new Uint8Array(0);

const decoder = new TextDecoder();

export function hunkBytes(hunks: Hunk[]): number {
  let n = 0;

  for (const h of hunks) for (const l of h.lines) n += l.length + 1;

  return n;
}

/** What a diff will cover: every changed file in path order (renames paired), before any blob is read. */
export interface DiffPlan {
  pairs: { old: Entry | null; new: Entry | null; status: DiffFile["status"] }[];
  /** Every changed file, listed or not. */
  files_total: number;
  too_many_files: boolean;
}

/** A file tree's order: at each level folders before files, each by name (as the web's tree and Plannotator's draw it). */
export function treeOrder(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  let i = 0;

  while (i < x.length - 1 && i < y.length - 1 && x[i] === y[i]) i += 1;
  const folderX = i < x.length - 1;
  const folderY = i < y.length - 1;

  if (folderX !== folderY) return folderX ? -1 : 1;

  return (x[i] ?? "").localeCompare(y[i] ?? "");
}

/** `order`: git's path order (the default), or a file tree's (treeOrder), which the streamed Files changed uses. */
export async function planDiff(repo: ArtifactsRepo, fromTree: string | null, toTree: string, opts: Pick<DiffOptions, "paths" | "maxFiles"> & { order?: "path" | "tree" }): Promise<DiffPlan> {
  const removed: Entry[] = [];
  const added: Entry[] = [];
  const changed: [Entry, Entry][] = [];
  await walk(repo, fromTree, toTree, "", opts.paths, removed, added, changed);

  // Exact renames: a removed blob that reappears, unchanged, at a new path.
  const pairs: DiffPlan["pairs"] = [];
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
  const pathOf = (p: DiffPlan["pairs"][number]) => (p.new ?? p.old)!.path;

  pairs.sort(opts.order === "tree" ? (x, y) => treeOrder(pathOf(x), pathOf(y)) : (x, y) => (pathOf(x) < pathOf(y) ? -1 : 1));

  const filesTotal = pairs.length;
  const tooMany = opts.maxFiles !== undefined && pairs.length > opts.maxFiles;

  if (tooMany) pairs.length = opts.maxFiles!;

  return { pairs, files_total: filesTotal, too_many_files: tooMany };
}

/** A gate on bytes held at once: a read waits until its size fits under the limit (one oversize read goes alone). */
function byteGate(limit: number) {
  let held = 0;
  const waiting: (() => void)[] = [];

  return async <T>(bytes: number, fn: () => Promise<T>): Promise<T> => {
    while (held > 0 && held + bytes > limit) await new Promise<void>((go) => waiting.push(go));
    held += bytes;

    try {
      return await fn();
    } finally {
      held -= bytes;

      for (const go of waiting.splice(0)) go();
    }
  };
}

/** What diffing two blobs found: binary, too large, or the hunks and their counts. Two blobs always give the same. */
export interface PairDiff {
  omitted?: "binary" | "too_large";
  additions: number | null;
  deletions: number | null;
  hunks: Hunk[] | null;
}

/** Where pairs already diffed are kept (R2, by repo and the two blobs), so a branch's next head reads only what changed. */
export interface PairCache {
  get(oldSha: string | null, newSha: string | null): Promise<PairDiff | null>;
  put(oldSha: string | null, newSha: string | null, diff: PairDiff): void;
}

async function diffPair(repo: ArtifactsRepo, p: DiffPlan["pairs"][number], gate: ReturnType<typeof byteGate>): Promise<PairDiff> {
  const [a, b] = await Promise.all([readBlobFor(repo, p.old), readBlobFor(repo, p.new)]);
  const large = (x: BlobRead | null) => (x?.size ?? 0) > MAX_TEXT_BYTES;

  // A side too large to diff: binary if a large side's head says so, else too large; nothing else is read.
  if (large(a) || large(b)) {
    const heads = await Promise.all([a, b].map((x) => (x && large(x) ? headOf(x.blob) : x?.blob.stream().cancel().then(() => null))));

    return { omitted: heads.some((h) => h && isBinary(h)) ? "binary" : "too_large", additions: null, deletions: null, hunks: null };
  }

  return gate((a?.size ?? 0) + (b?.size ?? 0), async () => {
    const [ba, bb] = await Promise.all([bytesOf(a), bytesOf(b)]);

    if (isBinary(ba) || isBinary(bb)) return { omitted: "binary", additions: null, deletions: null, hunks: null };
    const hunks = diffLines(decoder.decode(ba), decoder.decode(bb));
    let additions = 0;
    let deletions = 0;

    for (const h of hunks) {
      for (const l of h.lines) {
        if (l[0] === "+") additions++;
        else if (l[0] === "-") deletions++;
      }
    }

    return { additions, deletions, hunks };
  });
}

/** One file's row and hunks: binary, too large, or its diff (from the cache when the two blobs were diffed before). */
async function diffOne(repo: ArtifactsRepo, p: DiffPlan["pairs"][number], gate: ReturnType<typeof byteGate>, cache: PairCache | undefined): Promise<{ file: DiffFile; hunks: Hunk[] | null }> {
  const file: DiffFile = {
    path: (p.new ?? p.old)!.path,
    old_path: p.status === "renamed" ? p.old!.path : undefined, // left out of the JSON unless renamed
    status: p.status,
    old_sha: p.old?.sha ?? null,
    new_sha: p.new?.sha ?? null,
    old_mode: p.old?.mode ?? null,
    new_mode: p.new?.mode ?? null,
    binary: false,
    additions: 0,
    deletions: 0,
  };

  // Renames with the same blob need no read.
  if (p.status === "renamed") return { file, hunks: [] };

  if (p.old?.type === "gitlink" || p.new?.type === "gitlink") {
    file.additions = file.deletions = null;

    return { file, hunks: null };
  }

  let d = await cache?.get(file.old_sha, file.new_sha).catch(() => null);

  if (!d) {
    // A blob's bytes are a stream read once: a dropped read starts the pair over.
    d = await again(() => diffPair(repo, p, gate));
    cache?.put(file.old_sha, file.new_sha, d);
  }

  file.additions = d.additions;
  file.deletions = d.deletions;

  if (d.omitted) {
    file.patch_omitted = d.omitted;
    file.binary = d.omitted === "binary";
  }

  return { file, hunks: d.hunks };
}

/**
 * Each planned file, diffed, in path order, as soon as it and those before it
 * are done (up to CONCURRENCY files ahead are read at once). The byte budget is
 * spent in path order: a file past it keeps its counts and is listed with
 * patch_omitted "budget".
 */
export async function* fileDiffs(repo: ArtifactsRepo, plan: DiffPlan, opts: Pick<DiffOptions, "hunks" | "maxBytes">, cache?: PairCache): AsyncGenerator<DiffFile> {
  const gate = byteGate(BYTES_IN_FLIGHT);
  const started: Promise<{ file: DiffFile; hunks: Hunk[] | null }>[] = [];
  let next = 0;

  const fill = () => {
    while (next < plan.pairs.length && started.length < CONCURRENCY) {
      const job = diffOne(repo, plan.pairs[next++]!, gate, cache);

      // A failure is raised in order, when its file's turn comes; until then it must not count as unhandled.
      job.catch(() => {});
      started.push(job);
    }
  };

  let used = 0;

  fill();

  while (started.length) {
    const { file, hunks } = await started.shift()!;

    fill();

    if (hunks && file.patch_omitted === undefined) {
      const size = hunkBytes(hunks);

      if (used + size > opts.maxBytes) file.patch_omitted = "budget";
      else {
        used += size;

        if (opts.hunks) file.hunks = hunks;
      }
    }

    yield file;
  }
}

export async function treeDiff(repo: ArtifactsRepo, fromTree: string, toTree: string, opts: DiffOptions): Promise<DiffResult> {
  const plan = await planDiff(repo, fromTree, toTree, opts);
  const files: DiffFile[] = [];

  for await (const f of fileDiffs(repo, plan, opts)) files.push(f);

  return { files, truncated: files.some((f) => f.patch_omitted === "budget"), stats: statsOf(files), files_total: plan.files_total, too_many_files: plan.too_many_files };
}

/** Files and lines changed, over the files listed. */
export function statsOf(files: readonly Pick<DiffFile, "additions" | "deletions">[]): DiffResult["stats"] {
  const stats = { files: files.length, additions: 0, deletions: 0 };

  for (const f of files) {
    stats.additions += f.additions ?? 0;
    stats.deletions += f.deletions ?? 0;
  }

  return stats;
}

/** Every file that differs between two trees: its path and new blob (null when deleted). */
export async function changedFiles(repo: ArtifactsRepo, fromTree: string, toTree: string): Promise<{ path: string; sha: string | null; mode: string | null }[]> {
  const removed: Entry[] = [];
  const added: Entry[] = [];
  const changed: [Entry, Entry][] = [];
  await walk(repo, fromTree, toTree, "", [], removed, added, changed);
  const out = new Map<string, { path: string; sha: string | null; mode: string | null }>();

  for (const e of removed) out.set(e.path, { path: e.path, sha: null, mode: null });

  for (const e of added) out.set(e.path, { path: e.path, sha: e.sha, mode: e.mode });

  for (const [, b] of changed) out.set(b.path, { path: b.path, sha: b.sha, mode: b.mode });

  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** A changed file in Files changed: its row, and its own unified patch (null when left out: binary, too large, past the budget). */
export type ShownFile = Omit<DiffFile, "hunks"> & { patch: string | null };

/** GET .../branches/{branch}/diff?patches=1: a branch's Files changed, by (main, head); it never changes for those two. */
export interface BranchDiff {
  base_branch: string;
  /** Main's head the diff was taken against, and the branch's head. */
  base: string;
  head: string;
  merge_base: string;
  /** Some patches were left out for the byte budget. */
  truncated: boolean;
  too_many_files: boolean;
  files_total: number;
  stats: DiffResult["stats"];
  files: ShownFile[];
}

/** A unified diff with git's headers, for `git apply` and Plannotator. */
/** A diff as git's patch text, and how many files were left out of it. */
export interface Patch {
  text: string;
  omitted: number;
}

export function toPatch(result: DiffResult, hunksOf: (f: DiffFile) => Hunk[] | undefined): Patch {
  const out: string[] = [];
  let omitted = 0;

  for (const f of result.files) {
    const lines = fileLines(f, hunksOf(f) ?? []);

    if (lines === null) omitted++;
    else out.push(...lines);
  }

  return { text: out.length ? out.join("\n") + "\n" : "", omitted };
}

/** One file's part of the patch (git's headers and its hunks), or null when its patch was left out (too large, past the budget). */
export function filePatch(f: DiffFile, hunks: Hunk[]): string | null {
  const lines = fileLines(f, hunks);

  return lines === null ? null : lines.join("\n") + "\n";
}

function fileLines(f: DiffFile, hunks: Hunk[]): string[] | null {
  if (f.patch_omitted === "budget" || f.patch_omitted === "too_large") return null;
  const out: string[] = [];
  const oldPath = f.old_path ?? f.path;
  out.push(`diff --git a/${oldPath} b/${f.path}`);

  if (f.status === "added") out.push(`new file mode ${f.new_mode}`);
  else if (f.status === "deleted") out.push(`deleted file mode ${f.old_mode}`);
  else {
    if (f.old_mode !== f.new_mode) out.push(`old mode ${f.old_mode}`, `new mode ${f.new_mode}`);

    if (f.status === "renamed") out.push("similarity index 100%", `rename from ${oldPath}`, `rename to ${f.path}`);
  }

  if (f.old_sha !== f.new_sha) {
    const sameMode = f.status === "modified" && f.old_mode === f.new_mode;
    out.push(`index ${f.old_sha ?? "0".repeat(40)}..${f.new_sha ?? "0".repeat(40)}${sameMode ? " " + f.new_mode : ""}`);
  }

  if (f.binary) {
    out.push(`Binary files ${f.old_sha ? "a/" + oldPath : "/dev/null"} and ${f.new_sha ? "b/" + f.path : "/dev/null"} differ`);

    return out;
  }

  if (!hunks.length) return out;
  out.push(f.status === "added" ? "--- /dev/null" : `--- a/${oldPath}`);
  out.push(f.status === "deleted" ? "+++ /dev/null" : `+++ b/${f.path}`);

  for (const h of hunks) {
    const o = h.old_lines === 1 ? `${h.old_start}` : `${h.old_start},${h.old_lines}`;
    const n = h.new_lines === 1 ? `${h.new_start}` : `${h.new_start},${h.new_lines}`;
    out.push(`@@ -${o} +${n} @@`);
    out.push(...h.lines);
  }

  return out;
}
