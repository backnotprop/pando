// A branch's Files changed tab, read only (comments stay in Plannotator):
// Plannotator's file tree beside one virtualized list of every changed file
// (-code/DiffList.tsx, Pierre's CodeView, as DiffsHub draws large diffs), so
// a branch of thousands of files, or a file of 20,000 changed lines, scrolls
// as smoothly as a small one. The files stream in (api/projects.ts); each has
// a header (its path, what happened to it, its added and removed lines) that
// opens and closes its diff; a file with no patch says why, with a link to
// the file. Choosing a file in the tree brings it to the top; scrolling the
// list moves the tree to the file at the top. The tab fills the window below
// the page's head, the tree and the list each scrolling on their own; narrow
// screens fold the tree behind Files.
import type { ChangedFile, Repo } from "@pando/contract";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FilesSoFar } from "../../../../api/projects";
import { askUnderstand, linesQuestion } from "../../../../api/understand";
import { button, Empty, lnk, Refusal } from "../../../../ui/controls";
import { FileTree, type TreeFile } from "../../../../ui/doc/Tree";
import { Chevron } from "../../../../ui/Icons";
import { codeBlobLink, understandLink } from "../../../../ui/paths";
import { Ref } from "../../../../ui/Ref";
import { useColourViews } from "../-code/coloured";
import type { ChosenLines } from "../-code/DiffList";
import { tool } from "../-code/FileView";
import { useMonorepo } from "../-frame/heads";

/** What the list needs from a diff's start: the commit each file links to, the one before (a deleted file's), how many files changed. */
export interface DiffEnds {
  after: string;
  /** Null for a first commit: nothing came before. */
  before: string | null;
  files_total: number;
  too_many_files: boolean;
}

/** A file's commit for its link: before the change for a deleted one. */
const atOf = (ends: DiffEnds, f: ChangedFile) => (f.status === "deleted" ? (ends.before ?? ends.after) : ends.after);

const why = (what: "branch" | "commit") =>
  ({
    binary: "Binary file",
    too_large: "Too large to show (over 8 MiB)",
    budget: `Not shown: this ${what}'s changes are over 32 MiB`,
  }) as const;

/** The tree's order (Plannotator's): at each level folders before files, each by name. The server streams in the same order. */
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

function Counts({ f }: { f: ChangedFile }) {
  if (f.additions === null || f.deletions === null || f.additions + f.deletions === 0) return null;

  return (
    <span className="flex flex-none gap-2 text-[12.5px] leading-[15px]">
      <span className="text-[var(--diffs-token-inserted)]">+{f.additions.toLocaleString("en-US")}</span>
      <span className="text-[var(--diffs-token-deleted)]">−{f.deletions.toLocaleString("en-US")}</span>
    </span>
  );
}

/** The file's path, a link to the file (after the change, or before it for a deleted one): what the line is about. */
function Path({ repo, ends, f }: { repo: Repo; ends: DiffEnds; f: ChangedFile }) {
  const { monorepo } = useMonorepo();
  const at = atOf(ends, f);

  return (
    <span className="min-w-0 flex-1 overflow-hidden text-[12.5px] leading-[15px] text-ellipsis whitespace-nowrap">
      {f.old_path ? <span className="text-ash">{f.old_path} → </span> : null}
      <Ref kind="object" link={codeBlobLink(monorepo.full, repo.path, f.path, at)}>
        {f.path}
      </Ref>
    </span>
  );
}

/** Why a file has no lines here, and the file itself (after the change, or before it for a deleted one). */
function Why({ repo, what, ends, f }: { repo: Repo; what: "branch" | "commit"; ends: DiffEnds; f: ChangedFile }) {
  const { monorepo } = useMonorepo();
  const at = atOf(ends, f);

  if (f.patch !== null) return <span className="flex-none text-[12.5px] leading-[15px] text-ash">{f.status === "renamed" ? "Renamed, no line changes" : "No line changes"}</span>;

  return (
    <span className="flex flex-none items-baseline gap-4 text-[12.5px] leading-[15px] text-ash">
      {why(what)[f.patch_omitted ?? "too_large"]}
      <Link {...codeBlobLink(monorepo.full, repo.path, f.path, at)} className={lnk}>
        View file
      </Link>
    </span>
  );
}

const hasLines = (f: ChangedFile) => f.patch !== null && f.patch.includes("\n@@");

/** One file's header in the list: exactly the list's header height (DiffList HEADER_HEIGHT, 44 px), opaque, as it sticks while its lines scroll by. */
function Header({ repo, what, ends, f, open, current, toggle }: { repo: Repo; what: "branch" | "commit"; ends: DiffEnds; f: ChangedFile; open: boolean; current: boolean; toggle: () => void }) {
  return (
    <div
      data-file-path={f.path}
      aria-current={current || undefined}
      className={`flex h-11 w-full items-center gap-2.5 pr-4 pl-4 shadow-[inset_0_-1px_0_var(--rule-faint)] ${current ? "bg-loam" : "bg-soil"}`}
    >
      {hasLines(f) ? (
        <button type="button" aria-expanded={open} aria-label={`${open ? "Close" : "Open"} ${f.path}`} className="-ml-1 flex-none cursor-pointer rounded text-ash hover:text-bark" onClick={toggle}>
          <Chevron className={`size-3.5 ${open ? "" : "-rotate-90"}`} />
        </button>
      ) : (
        <span className="-ml-1 size-3.5 flex-none" />
      )}
      <Path repo={repo} ends={ends} f={f} />
      <span className="flex-none text-[12.5px] leading-[15px] text-ash">{f.status}</span>
      <Counts f={f} />
      {hasLines(f) ? null : <Why repo={repo} what={what} ends={ends} f={f} />}
    </div>
  );
}

/**
 * Lines chosen in a file, with Why?: it asks an Understand page about them, at the side's commit (the head for the
 * changed file, the commit before for removed lines), and opens it.
 */
function WhyBar({ repo, ends, chosen, branch, what }: { repo: Repo; ends: DiffEnds; chosen: ChosenLines; branch: string | null; what: "branch" | "commit" }) {
  const { monorepo } = useMonorepo();
  const navigate = useNavigate();
  const [error, setError] = useState<Error | null>(null);
  const [asking, setAsking] = useState(false);
  const old = chosen.side === "old";
  const path = old ? (chosen.file.old_path ?? chosen.file.path) : chosen.file.path;
  const ref = old ? (ends.before ?? ends.after) : ends.after;
  const lines = chosen.start === chosen.end ? `Line ${chosen.start}` : `Lines ${chosen.start} to ${chosen.end}`;

  const ask = async () => {
    if (asking) return;
    setAsking(true);
    setError(null);

    try {
      const page = await askUnderstand(monorepo, linesQuestion(path, chosen.start, chosen.end), { kind: "lines", repo: repo.name, path, ref, start: chosen.start, end: chosen.end }, branch ? { kind: what === "branch" ? "files_changed" : "commit", branch } : { kind: what === "branch" ? "files_changed" : "commit" });

      await navigate(understandLink(monorepo.full, page.number));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setAsking(false);
    }
  };

  return (
    <div className="mb-3.5 flex-none rounded-lg bg-loam px-3.5 py-2 text-[13.5px] text-bark-dim">
      <div className="flex items-center gap-4">
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {lines} of <code className="text-[13px] text-bark">{path}</code>
          {old ? ", before the change" : ""}
        </span>
        <button type="button" className={button("solid", 28)} onClick={() => void ask()}>
          Why?
        </button>
      </div>
      <Refusal error={error} />
    </div>
  );
}

/** The pane's least height: below it, a page whose head is tall (a commit's long message on a phone) scrolls instead. */
const PANE_MIN = 360;

/**
 * The tab's height: the window below where it starts, with a 16 px margin,
 * while the page itself stays still. When the page's head leaves less than
 * PANE_MIN, the page scrolls to a pane as tall as the window.
 */
function usePane() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;

    if (!el) return;
    window.scrollTo(0, 0);
    const html = document.documentElement;
    const was = html.style.overflow;

    const fit = () => {
      const room = Math.floor(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - 16);
      const fits = room >= PANE_MIN;

      html.style.overflow = fits ? "hidden" : was;
      setHeight(fits ? room : Math.max(PANE_MIN, window.innerHeight - 32));
    };

    fit();
    window.addEventListener("resize", fit);

    return () => {
      window.removeEventListener("resize", fit);
      html.style.overflow = was;
    };
  }, []);

  return { ref, height };
}

const list =
  "relative h-full overflow-y-auto overflow-x-clip overscroll-contain px-px [contain:strict] [overflow-anchor:none] [will-change:scroll-position] [&_diffs-container]:overflow-clip [&_diffs-container]:rounded-[10px] [&_diffs-container]:shadow-[0_0_0_1px_var(--rootline)] [&_diffs-container]:[contain:layout_paint_style]";

/**
 * A branch's or a commit's changed files (`what`). `readAgain` reads the diff again (after one stopped part way: the
 * pairs already diffed come back at once).
 */
export function FilesChanged({ repo, what, diff, ends, reading, readAgain, branch = null }: { repo: Repo; what: "branch" | "commit"; diff: Pick<FilesSoFar, "files" | "end" | "error">; ends: DiffEnds; reading: boolean; readAgain: () => void; branch?: string | null }) {
  const views = useColourViews();
  const { ref, height } = usePane();
  // Closed by the person, by path.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [target, setTarget] = useState<{ path: string; token: number } | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  // Lines chosen in a file: the bar with Why? (Understand).
  const [chosen, setChosen] = useState<ChosenLines | null>(null);
  // In the tree's order, so scrolling walks down the tree (the server streams them so, and a stable sort keeps them).
  const files = useMemo(() => diff.files.toSorted(treeOrder), [diff.files]);
  const treeFiles = useMemo(() => files.map(treeFile), [files]);
  const at = current ?? files[0]?.path ?? null;
  // Just after a choice in the tree, the list's own scrolling (to the chosen file) does not move the choice.
  const chosenAt = useRef(0);

  const choose = (path: string) => {
    chosenAt.current = performance.now();
    setCurrent(path);
    setTarget((t) => ({ path, token: (t?.token ?? 0) + 1 }));
  };

  const onTop = useCallback((path: string) => {
    if (performance.now() - chosenAt.current > 600) setCurrent(path);
  }, []);

  const toggle = useCallback((path: string) => {
    setClosed((c) => {
      const next = new Set(c);

      if (!next.delete(path)) next.add(path);

      return next;
    });
  }, []);

  useEffect(() => {
    if (current && !files.some((f) => f.path === current)) setCurrent(null);
  }, [files, current]);

  if (!files.length && diff.end) return <Empty>No files changed.</Empty>;

  const tree = <FileTree files={treeFiles} selected={at} onSelect={choose} />;

  const notes = [
    ends.too_many_files ? `The first ${files.length.toLocaleString("en-US")} of ${ends.files_total.toLocaleString("en-US")} files` : null,
    !diff.end && reading ? `Reading the files changed: ${files.length.toLocaleString("en-US")} of ${ends.files_total.toLocaleString("en-US")}` : null,
    diff.end?.truncated ? "Diffs stop at 32 MiB in all: the later files are listed without theirs" : null,
  ].filter((n) => n !== null);

  return (
    <div ref={ref} style={height === null ? undefined : { height }} className="grid grid-cols-[260px_minmax(0,1fr)] gap-6 narrow:grid-cols-[minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col narrow:hidden">{tree}</div>
      <div className="flex min-h-0 flex-col">
        <div className="mb-3.5 hidden flex-none narrow:block">
          <button type="button" aria-expanded={treeOpen} className={`${tool} gap-1.5`} onClick={() => setTreeOpen(!treeOpen)}>
            <Chevron className={`-ml-0.5 size-3 ${treeOpen ? "" : "-rotate-90"}`} />
            Files
          </button>
          {treeOpen ? <div className="mt-2 flex max-h-[50vh] flex-col overflow-hidden rounded-[10px] border border-rootline">{tree}</div> : null}
        </div>
        {notes.map((n) => (
          <p key={n} className="mb-3.5 flex-none rounded-lg bg-loam px-3.5 py-2.5 text-[13.5px] text-bark-dim">
            {n}
          </p>
        ))}
        {chosen ? <WhyBar repo={repo} ends={ends} chosen={chosen} branch={branch} what={what} /> : null}
        {diff.error ? (
          <p className="mb-3.5 flex flex-none items-baseline gap-4 rounded-lg bg-loam px-3.5 py-2.5 text-[13.5px] text-bark-dim">
            The rest could not be read: {diff.error}
            <button type="button" className={`${lnk} ml-auto flex-none`} disabled={reading} onClick={readAgain}>
              Read again
            </button>
          </p>
        ) : null}
        <section aria-label="Files changed" className="min-h-0 flex-1">
          {views ? (
            <views.DiffList
              files={files}
              closed={closed}
              target={target}
              onTop={onTop}
              onChoose={setChosen}
              className={list}
              header={(f) => <Header repo={repo} what={what} ends={ends} f={f} open={!closed.has(f.path)} current={f.path === at} toggle={() => toggle(f.path)} />}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}
