// A folder's rows from the root files' tree: folders first, then files, each
// alphabetical; at the root, `projects` for the monorepo's code repos.
import type { MetaFolder, MetaVersion } from "@pando/contract";
import type { RepoHead } from "@pando/contract";
import { blobLink, repoLink, treeLink } from "../../../../ui/paths";
import type { Row } from "./FileList";

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** When main last moved, in ms; the newest of several heads. */
const movedAt = (heads: readonly RepoHead[]) => heads.reduce<number | null>((a, h) => (h.updated_at && (a === null || Date.parse(h.updated_at) > a) ? Date.parse(h.updated_at) : a), null);

/** What main last took in the project whose main moved last (the `projects` row's change). */
const newestTitle = (heads: readonly RepoHead[]) =>
  [...heads].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0]?.head_title ?? "";

export function folderRows(full: string, dir: string, folders: readonly MetaFolder[], files: readonly MetaVersion[], heads: readonly RepoHead[]): Row[] {
  const dirs: Row[] = folders.map((f) => ({
    kind: "dir",
    name: f.name,
    link: treeLink(full, join(dir, f.name)),
    change: f.last ? `saved ${f.last.path.slice(join(dir, f.name).length + 1)}` : "",
    at: f.last?.at ?? null,
  }));

  if (!dir && heads.length) dirs.push({ kind: "dir", name: "projects", link: treeLink(full, "projects"), change: newestTitle(heads), at: movedAt(heads) });

  const rows: Row[] = files.map((v) => ({
    kind: "file",
    name: base(v.path),
    link: blobLink(full, v.path),
    change: v.machine ? `saved from ${v.machine}` : "saved",
    at: v.at,
  }));

  return [...dirs.sort(byName), ...rows.sort(byName)];
}

/** `projects/`: one row per code repo, each opening its project page. */
export const projectRows = (full: string, heads: readonly RepoHead[]): Row[] =>
  heads.map((h): Row => ({ kind: "project", name: base(h.path), link: repoLink(full, h.path), change: h.head_title ?? "", at: movedAt([h]) })).sort(byName);

/** The newest file in a folder: the folder page's latest-change bar. */
export const newest = (files: readonly MetaVersion[]) => files.reduce<MetaVersion | null>((a, v) => (!a || v.at > a.at ? v : a), null);

/** A folder's README, else (at the root) AGENTS.md: the file shown under the list. */
export function readmeOf(dir: string, files: readonly MetaVersion[]): string | null {
  const names = new Set(files.map((v) => base(v.path)));
  const pick = ["README.md", "readme.md", "Readme.md", ...(dir ? [] : ["AGENTS.md"])].find((n) => names.has(n));

  return pick ? join(dir, pick) : null;
}
