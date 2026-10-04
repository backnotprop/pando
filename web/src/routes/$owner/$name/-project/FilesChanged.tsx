// A branch's Files changed tab, read only (comments stay in Plannotator):
// Plannotator's file tree beside the files, as its review lays them out, and
// each changed file in its own box, as the code view draws a file. A header
// row (the path, what happened to it, its added and removed lines) opens and
// closes its unified diff, coloured by Diff.tsx (loaded on first use). A large
// diff starts closed; a file with no patch says why, with a link to the file.
// Choosing a file in the tree scrolls to its box; scrolling the files moves
// the tree to the file at the top. Narrow screens fold the tree behind Files.
import type { BranchDiff, ChangedFile, Repo } from "@pando/contract";
import { Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Empty, lnk } from "../../../../ui/controls";
import { FileTree, type TreeFile } from "../../../../ui/doc/Tree";
import { Chevron } from "../../../../ui/Icons";
import { codeBlobLink } from "../../../../ui/paths";
import { tool } from "../-code/FileView";
import { useMonorepo } from "../-frame/heads";

const Diff = lazy(() => import("../-code/Diff"));

/** Owner board: a file with more changed lines than this starts closed. */
const START_CLOSED = 400;

const WHY = {
  binary: "Binary file",
  too_large: "Too large to show (over 1 MiB, or over 20,000 changed lines)",
  budget: "Not shown: this branch's changes are over 2 MiB",
} as const;

const note = "border-t border-rule-faint px-4 py-3 text-[13px] leading-5 text-ash";

const changed = (f: ChangedFile) => (f.additions ?? 0) + (f.deletions ?? 0);

/** The file whose box has reached this far down the window is the one at the top. */
const TOP = 80;

/** The tree's order (Plannotator's): at each level folders before files, each by name. */
function treeOrder(a: ChangedFile, b: ChangedFile): number {
  const x = a.path.split("/");
  const y = b.path.split("/");
  let i = 0;

  while (i < x.length - 1 && i < y.length - 1 && x[i] === y[i]) i += 1;
  const folderX = i < x.length - 1;
  const folderY = i < y.length - 1;

  if (folderX !== folderY) return folderX ? -1 : 1;

  return (x[i] ?? "").localeCompare(y[i] ?? "");
}

function treeFile(f: ChangedFile): TreeFile {
  const file: TreeFile = { path: f.path, status: f.binary ? "binary" : f.status, additions: f.additions ?? 0, deletions: f.deletions ?? 0 };

  if (f.old_path) file.oldPath = f.old_path;

  return file;
}

/** The patch's lines after its header, for the space the diff takes while it loads. */
const bodyLines = (patch: string) => patch.slice(Math.max(0, patch.indexOf("\n@@"))).split("\n").length - 1;

function Counts({ f }: { f: ChangedFile }) {
  if (f.additions === null || f.deletions === null || f.additions + f.deletions === 0) return null;

  return (
    <span className="flex flex-none gap-2 text-[12.5px] leading-[15px]">
      <span className="text-[var(--diffs-token-inserted)]">+{f.additions.toLocaleString("en-US")}</span>
      <span className="text-[var(--diffs-token-deleted)]">−{f.deletions.toLocaleString("en-US")}</span>
    </span>
  );
}

/** A path that may break after any `/`. */
const breakable = (path: string) => path.split("/").map((part, i, all) => (i < all.length - 1 ? [part, "/", <wbr key={i} />] : part));

function Path({ f }: { f: ChangedFile }) {
  return (
    // On a phone a long path wraps after a folder, so its file name is never cut off.
    <span className="min-w-0 flex-1 overflow-hidden text-[12.5px] leading-[15px] text-ellipsis whitespace-nowrap text-bark phone:whitespace-normal phone:[overflow-wrap:anywhere]">
      {f.old_path ? <span className="text-ash">{breakable(f.old_path)} → </span> : null}
      {breakable(f.path)}
    </span>
  );
}

/** No patch: why, and the file itself (at the branch's head, or before the branch for a deleted one). */
function Omitted({ repo, diff, f }: { repo: Repo; diff: BranchDiff; f: ChangedFile }) {
  const { monorepo } = useMonorepo();
  const at = f.status === "deleted" ? diff.merge_base : diff.head;

  return (
    <p className={`${note} flex items-baseline gap-4`}>
      {WHY[f.patch_omitted ?? "too_large"]}
      <Link {...codeBlobLink(monorepo.full, repo.path, f.path, at)} className={`${lnk} ml-auto flex-none`}>
        View file
      </Link>
    </p>
  );
}

interface BoxProps {
  repo: Repo;
  diff: BranchDiff;
  f: ChangedFile;
  open: boolean;
  toggle: () => void;
  /** The file chosen in the tree, or at the top of the list. */
  current: boolean;
  place: (el: HTMLLIElement | null) => void;
}

function FileBox({ repo, diff, f, open, toggle, current, place }: BoxProps) {
  const row = "flex min-h-11 w-full items-center gap-2.5 py-1.5 pr-4 pl-4 text-left";
  const status = <span className="flex-none text-[12.5px] leading-[15px] text-ash">{f.status}</span>;
  const box = `scroll-mt-4 overflow-hidden rounded-[10px] border ${current ? "border-ash" : "border-rootline"}`;

  // No patch: the header and why, nothing to open (the chevron's room kept, so paths line up).
  if (f.patch === null) {
    return (
      <li ref={place} aria-current={current || undefined} className={box}>
        <div className={row}>
          <span className="-ml-1 size-3.5 flex-none" />
          <Path f={f} />
          {status}
          <Counts f={f} />
        </div>
        <Omitted repo={repo} diff={diff} f={f} />
      </li>
    );
  }

  const hunks = f.patch.includes("\n@@");

  return (
    <li ref={place} aria-current={current || undefined} className={box}>
      <button type="button" aria-expanded={open} className={`${row} cursor-pointer hover:bg-loam`} onClick={toggle}>
        <Chevron className={`-ml-1 size-3.5 flex-none text-ash ${open ? "" : "-rotate-90"}`} />
        <Path f={f} />
        {status}
        <Counts f={f} />
      </button>
      {!open ? null : hunks ? (
        <div className="border-t border-rule-faint">
          <Suspense fallback={<div style={{ height: bodyLines(f.patch) * 20 + 24 }} />}>
            <Diff patch={f.patch} id={`${f.old_sha ?? "none"}..${f.new_sha ?? "none"}:${f.path}`} />
          </Suspense>
        </div>
      ) : (
        <p className={note}>{f.status === "renamed" ? "Renamed, no line changes" : "No line changes"}</p>
      )}
    </li>
  );
}

/**
 * The file at the top follows the scroll, except just after a file was chosen
 * in the tree: its box may not reach the top (the page ends first), so the
 * choice holds until the person scrolls, presses a key or clicks outside it.
 */
function useFileAtTop(files: readonly ChangedFile[], boxes: Map<string, HTMLLIElement>, pinned: { current: boolean }, set: (path: string) => void) {
  useEffect(() => {
    let frame = 0;

    const follow = () => {
      frame = 0;

      if (pinned.current) return;
      let top = files[0]?.path;

      for (const f of files) {
        const el = boxes.get(f.path);

        if (!el || el.getBoundingClientRect().top > TOP) break;
        top = f.path;
      }

      if (top) set(top);
    };

    const scrolled = () => {
      frame ||= requestAnimationFrame(follow);
    };

    const release = (e: Event) => {
      if (!(e.target instanceof Element && e.target.closest("[role=tree]"))) pinned.current = false;
    };

    const inputs = ["wheel", "touchmove", "keydown", "pointerdown"];

    window.addEventListener("scroll", scrolled, { passive: true });

    for (const name of inputs) window.addEventListener(name, release, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scrolled);

      for (const name of inputs) window.removeEventListener(name, release);
    };
  }, [files, boxes, pinned, set]);
}

export function FilesChanged({ repo, diff }: { repo: Repo; diff: BranchDiff }) {
  // Open or closed by the person, per path; otherwise a large diff starts closed.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [current, setCurrent] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const boxes = useRef(new Map<string, HTMLLIElement>()).current;
  const pinned = useRef(false);
  // The boxes in the tree's order, so scrolling walks down the tree.
  const ordered = useMemo(() => diff.files.toSorted(treeOrder), [diff.files]);
  const files = useMemo(() => ordered.map(treeFile), [ordered]);
  const at = current ?? ordered[0]?.path ?? null;

  useFileAtTop(ordered, boxes, pinned, setCurrent);

  if (!ordered.length) return <Empty>No files changed.</Empty>;

  const choose = (path: string) => {
    setCurrent(path);
    pinned.current = true;
    boxes.get(path)?.scrollIntoView({ block: "start" });
  };

  const tree = <FileTree files={files} selected={at} onSelect={choose} />;

  return (
    <div className="grid grid-cols-[260px_minmax(0,1fr)] items-start gap-6 narrow:grid-cols-[minmax(0,1fr)]">
      <div className="sticky top-4 flex max-h-[calc(100vh-32px)] flex-col narrow:hidden">{tree}</div>
      <div>
        <div className="mb-3.5 hidden narrow:block">
          <button type="button" aria-expanded={treeOpen} className={`${tool} gap-1.5`} onClick={() => setTreeOpen(!treeOpen)}>
            <Chevron className={`-ml-0.5 size-3 ${treeOpen ? "" : "-rotate-90"}`} />
            Files
          </button>
          {treeOpen ? <div className="mt-2 flex max-h-[60vh] flex-col overflow-hidden rounded-[10px] border border-rootline">{tree}</div> : null}
        </div>
        {diff.too_many_files ? (
          <p className="mb-3.5 rounded-lg bg-loam px-3.5 py-2.5 text-[13.5px] text-bark-dim">
            The first {diff.files.length.toLocaleString("en-US")} of {diff.files_total.toLocaleString("en-US")} files
          </p>
        ) : null}
        <ul aria-label="Files changed" className="grid gap-4">
          {ordered.map((f) => {
            const open = chosen[f.path] ?? changed(f) <= START_CLOSED;

            return (
              <FileBox
                key={f.path}
                repo={repo}
                diff={diff}
                f={f}
                open={open}
                toggle={() => setChosen((c) => ({ ...c, [f.path]: !open }))}
                current={f.path === at}
                place={(el) => {
                  if (el) boxes.set(f.path, el);
                  else boxes.delete(f.path);
                }}
              />
            );
          })}
        </ul>
      </div>
    </div>
  );
}
