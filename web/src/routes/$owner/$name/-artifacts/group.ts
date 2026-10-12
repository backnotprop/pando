// What a drop or a pick makes, before anything is uploaded (SPEC.md 1,
// "Grouping an upload"): a document with the images it uses is one artifact;
// several documents are one artifact each, each taking the images its text
// names; images no document takes are one artifact each. A dropped folder is
// one artifact: its one document, or its index.html, with the folder's images
// kept by their paths from that document. Files of other kinds are left out
// and named. Pando's limits (SPEC.md 9) are checked here too, so a row says
// what is wrong before the upload is tried.
import type { ArtifactKind } from "@pando/contract";

/** A file as it was dropped or picked: `path` is from the dropped folder (`plans/img/a.png`), else its name. */
export interface Picked<F = File> {
  path: string;
  file: F;
  size: number;
  /** The dropped folder it came from (the path's first part), or null for a loose file. */
  folder: string | null;
}

/** One artifact to add: its main file and the images uploaded with it, each by its path from the main file. */
export interface Group<F = File> {
  name: string;
  kind: ArtifactKind;
  main: Picked<F>;
  images: readonly { path: string; picked: Picked<F> }[];
  size: number;
  /** Why it cannot be added, in words; null when it can. */
  problem: string | null;
}

export interface Grouping<F = File> {
  groups: readonly Group<F>[];
  /** Files left out (not a document or an image), by path. */
  skipped: readonly string[];
}

const MIB = 1024 * 1024;

/** SPEC.md 9. */
export const LIMITS = { artifact: 10 * MIB, document: 1.5 * MIB, files: 20, name: 200 };

const NAME = /^[A-Za-z0-9._+-]+$/;

export function kindOf(path: string): ArtifactKind | null {
  if (/\.(md|markdown)$/i.test(path)) return "markdown";

  if (/\.html?$/i.test(path)) return "html";

  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) return "image";

  return null;
}

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const dir = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");

const mb = (bytes: number) => `${(bytes / MIB).toFixed(1).replace(/\.0$/, "")} MiB`;

/** What is wrong with a group, against the limits; null when nothing. */
function problemOf<F>(name: string, kind: ArtifactKind, main: Picked<F>, images: readonly { path: string }[], size: number): string | null {
  if (name.length > LIMITS.name || !NAME.test(name)) return "Its name may have only letters, digits, . _ + and -";

  if (images.some((i) => i.path.split("/").some((part) => !NAME.test(part)))) return "An image's path may have only letters, digits, . _ + - and /";

  if (images.length + 1 > LIMITS.files) return `${images.length + 1} files: at most ${LIMITS.files}`;

  if (kind !== "image" && main.size > LIMITS.document) return `The document is ${mb(main.size)}: at most ${mb(LIMITS.document)}`;

  if (size > LIMITS.artifact) return `${mb(size)} in all: at most ${mb(LIMITS.artifact)}`;

  return null;
}

function make<F>(main: Picked<F>, kind: ArtifactKind, images: readonly { path: string; picked: Picked<F> }[]): Group<F> {
  const name = base(main.path);
  const size = main.size + images.reduce((n, i) => n + i.picked.size, 0);

  return { name, kind, main, images, size, problem: problemOf(name, kind, main, images, size) };
}

/** Whether a document's text names an image, by its path from the document or by its name. */
const names = (text: string, path: string) => text.includes(path) || text.includes(base(path));

/** A dropped folder: its one document (or its index.html) with the folder's images under that document's folder. */
function fromFolder<F>(files: readonly Picked<F>[], skipped: string[]): Group<F> | null {
  const docs = files.filter((f) => kindOf(f.path) === "markdown" || kindOf(f.path) === "html");
  const main = docs.length === 1 ? docs[0] : docs.find((d) => /^[^/]+\/index\.html?$/i.test(d.path));

  if (!main) {
    // No document, or several and no index.html: its images are added one each, the documents are left out.
    skipped.push(...docs.map((d) => d.path));

    return null;
  }

  for (const d of docs) if (d !== main) skipped.push(d.path);
  const from = dir(main.path);
  const images = files.filter((f) => kindOf(f.path) === "image");
  const under = images.filter((i) => i.path.startsWith(from));

  for (const i of images) if (!i.path.startsWith(from)) skipped.push(i.path);

  return make(
    main,
    kindOf(main.path) ?? "markdown",
    under.map((picked) => ({ path: picked.path.slice(from.length), picked })),
  );
}

/**
 * Groups what was dropped or picked. `texts` holds each document's text by
 * its path (read before), so loose images go to the documents that name them.
 */
export function group<F>(picked: readonly Picked<F>[], texts: ReadonlyMap<string, string>): Grouping<F> {
  const skipped: string[] = [];
  const groups: Group<F>[] = [];
  const loose: Picked<F>[] = [];
  const folders = new Map<string, Picked<F>[]>();

  for (const p of picked) {
    if (!kindOf(p.path)) {
      skipped.push(p.path);
      continue;
    }

    if (p.folder === null) loose.push(p);
    else folders.set(p.folder, [...(folders.get(p.folder) ?? []), p]);
  }

  for (const files of folders.values()) {
    const g = fromFolder(files, skipped);

    if (g) groups.push(g);
    else loose.push(...files.filter((f) => kindOf(f.path) === "image"));
  }

  const docs = loose.filter((f) => kindOf(f.path) !== "image");
  const images = loose.filter((f) => kindOf(f.path) === "image");
  const taken = new Set<Picked<F>>();

  for (const d of docs) {
    // One document takes every loose image; several take the images their text names.
    const mine = docs.length === 1 ? images : images.filter((i) => names(texts.get(d.path) ?? "", i.folder === null ? i.path : base(i.path)));

    for (const i of mine) taken.add(i);
    groups.push(
      make(
        d,
        kindOf(d.path) ?? "markdown",
        mine.map((picked) => ({ path: picked.folder === null ? picked.path : base(picked.path), picked })),
      ),
    );
  }

  for (const i of images) if (!taken.has(i)) groups.push(make(i, "image", []));

  // Two artifacts of one drop with one name: the second would only be the first's next version.
  const seen = new Set<string>();

  return {
    groups: groups.map((g) => {
      const twice = seen.has(g.name);

      seen.add(g.name);

      return twice && !g.problem ? { ...g, problem: "Another file in this drop has the same name" } : g;
    }),
    skipped,
  };
}
