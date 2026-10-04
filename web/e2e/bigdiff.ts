// A large branch for Files changed, made the same way every time (a seeded
// generator), as DiffsHub keeps reference pull requests: about 2,000 changed
// files and 150,000 changed lines, with one file whose diff is 20,000 lines,
// a 5 MB text file changed, renames, deletions, binaries and a lockfile's
// churn. `seedBigBranch` commits main and the branch through a Machine and
// pushes both through the real Worker.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Machine } from "./seed";

/** A small, seeded generator (mulberry32), so the fixture is the same in every run. */
function random(seed: number) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["branch", "commit", "merge", "tree", "blob", "patch", "hunk", "line", "file", "repo", "head", "base", "ref", "push", "fetch", "check", "build", "agent", "machine", "worktree"];

/** One TypeScript module of `n` lines: comments, imports, types and functions, as code reads. */
function module(rand: () => number, name: string, n: number): string[] {
  const word = () => WORDS[Math.floor(rand() * WORDS.length)] ?? "x";
  const lines = [`// ${name}: the ${word()} and its ${word()}s.`, `import { ${word()}Of, type ${word()[0]?.toUpperCase()}${word().slice(1)} } from "../${word()}";`, ""];

  for (let i = 0; lines.length < n; i++) {
    lines.push(`/** Reads the ${word()} for a ${word()}, or null when it is gone. */`);
    lines.push(`export async function ${word()}${i}(${word()}: string, count = ${Math.floor(rand() * 100)}): Promise<string | null> {`);
    lines.push(`  const ${word()}s = await ${word()}Of(${JSON.stringify(word())}, count);`);
    lines.push(`  if (!${word()}s.length) return null;`);
    lines.push(`  return \`\${${word()}s[0]}:\${count}\`;`);
    lines.push("}", "");
  }

  return lines.slice(0, n);
}

/** Changes `count` lines of `lines`, in a few places, so a file gets several hunks. */
function edit(rand: () => number, lines: string[], count: number): string[] {
  const out = [...lines];
  const spots = Math.max(1, Math.round(count / 6));

  for (let s = 0; s < spots; s++) {
    const at = Math.floor(rand() * Math.max(1, out.length - 8));

    for (let k = 0; k < Math.ceil(count / spots) && at + k < out.length; k++) out[at + k] = `${out[at + k]} // changed ${s}.${k}`;
  }

  return out;
}

const text = (lines: string[]) => lines.join("\n") + "\n";

/** A small binary file (a NUL in its first bytes), different for each seed. */
function binary(rand: () => number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);

  for (let i = 0; i < size; i++) bytes[i] = Math.floor(rand() * 256);
  bytes[0] = 0;

  return bytes;
}

/** A lockfile-like JSON file of `n` packages. */
function lockfile(rand: () => number, n: number, bump: number): string {
  const lines = ["{", '  "name": "big",', '  "lockfileVersion": 3,', '  "packages": {'];

  for (let i = 0; i < n; i++) {
    const v = `${1 + (i % 7)}.${(i * 13) % 40}.${(i + bump * ((i % 3) + 1)) % 50}`;

    lines.push(`    "node_modules/pkg-${i}": {`, `      "version": "${v}",`, `      "resolved": "https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-${v}.tgz",`, `      "integrity": "sha512-${Math.floor(rand() * 1e15).toString(36)}${bump}${i}"`, `    }${i === n - 1 ? "" : ","}`);
  }

  lines.push("  }", "}");

  return text(lines);
}

/** A file tree's order: at each level folders before files, each by name (as Files changed and its tree list them). */
function treeOrder(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  let i = 0;

  while (i < x.length - 1 && i < y.length - 1 && x[i] === y[i]) i += 1;
  const folderX = i < x.length - 1;
  const folderY = i < y.length - 1;

  if (folderX !== folderY) return folderX ? -1 : 1;

  return (x[i] ?? "").localeCompare(y[i] ?? "");
}

export interface BigBranch {
  /** main's files. */
  main: Record<string, string | Uint8Array>;
  /** The branch: files written, removed and renamed (unchanged, so git reports them as renames). */
  write: Record<string, string | Uint8Array>;
  remove: string[];
  rename: [string, string][];
  /** The file whose diff is 20,000 lines. */
  hugeDiff: string;
  /** The 5 MB text file. */
  fiveMb: string;
  /** The last changed file in the tree's order (folders before files at each level), as Files changed lists them. */
  last: string;
}

/** The fixture's files: 1,840 modules changed, 50 added, 50 removed, 30 renamed, 25 binaries, and the three big ones (1,998 in all). */
export function bigBranch(seed = 7): BigBranch {
  const rand = random(seed);
  const main: Record<string, string | Uint8Array> = {};
  const write: Record<string, string | Uint8Array> = {};
  const remove: string[] = [];
  const rename: [string, string][] = [];
  const pkg = (i: number) => `packages/p${String(Math.floor(i / 100)).padStart(2, "0")}/src/m${String(i % 100).padStart(2, "0")}.ts`;

  for (let i = 0; i < 1_970; i++) {
    const lines = module(rand, pkg(i), 110 + Math.floor(rand() * 40));

    main[pkg(i)] = text(lines);

    if (i < 1_840) write[pkg(i)] = text(edit(rand, lines, 16 + Math.floor(rand() * 6)));
    else if (i < 1_890) remove.push(pkg(i));
    else if (i < 1_920) rename.push([pkg(i), pkg(i).replace("/src/", "/lib/")]);
  }

  for (let i = 0; i < 50; i++) write[`packages/new/src/n${String(i).padStart(2, "0")}.ts`] = text(module(rand, `n${i}`, 300));

  for (let i = 0; i < 25; i++) {
    const path = `assets/a${String(i).padStart(2, "0")}.bin`;

    if (i < 20) main[path] = binary(rand, 2_000);
    write[path] = binary(rand, 2_000);
  }

  // One file whose diff is 20,000 lines: 10,000 lines, each changed.
  const huge = Array.from({ length: 10_000 }, (_, i) => `export const row${i} = ${i};`);

  main["gen/huge.ts"] = text(huge);
  write["gen/huge.ts"] = text(huge.map((l, i) => l.replace(`= ${i};`, `= ${i * 2 + 1};`)));

  // A lockfile's churn: 6,000 packages, versions bumped.
  main["package-lock.json"] = lockfile(rand, 6_000, 0);
  write["package-lock.json"] = lockfile(rand, 6_000, 1);

  // A 5 MB text file, 5,000 of its 100,000 lines changed.
  const rows = Array.from({ length: 100_000 }, (_, i) => `${i},${WORDS[i % WORDS.length]},${(i * 7919) % 100_000},${"x".repeat(28)}`);

  main["data/rows.csv"] = text(rows);
  write["data/rows.csv"] = text(rows.map((r, i) => (i % 20 === 0 ? r.replace("x", "y") : r)));

  const changed = [...Object.keys(write), ...remove, ...rename.map(([, to]) => to)].sort(treeOrder);

  return { main, write, remove, rename, hugeDiff: "gen/huge.ts", fiveMb: "data/rows.csv", last: changed.at(-1) ?? "" };
}

/** Pushes main, then the branch, of `repo` (its clone URL `url`) through the machine; returns the branch head. */
export function seedBigBranch(m: Machine, repo: string, url: string, branch: string, big: BigBranch): string {
  m.push(m.commit(repo, url, "main", big.main, "The big project"), url, "main");
  const dir = m.commit(repo, url, branch, big.write, "Change most of it");

  for (const [from, to] of big.rename) {
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    m.git(dir, "mv", from, to);
  }

  if (big.remove.length) m.git(dir, "rm", "-q", ...big.remove);
  m.git(dir, "-c", "user.name=Big Lane", "-c", `user.email=${m.name}@pando.invalid`, "commit", "-qm", "Rename and remove some");
  m.push(dir, url, branch);

  return m.git(dir, "rev-parse", "HEAD").trim();
}
