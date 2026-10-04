// Every changed file of a branch as one virtualized list: Pierre's CodeView,
// as DiffsHub and Plannotator's review draw large diffs. Only the files and
// lines near the window are in the page, so a branch of thousands of files
// and a file of 20,000 changed lines scroll alike; the shared worker colours
// what shows (ui/syntax.ts). Loaded with the code view (coloured.ts).
//
// Each file is one item. Its id carries its blobs, so a file a push changed
// is a new item rather than an updated one (Pierre 1.3.6 throws when a
// virtualized diff is replaced in place, issue #1115). Its header (44 px,
// sticky while its lines scroll by) is drawn by the page.
import { type CodeViewDiffItem, type CodeViewOptions, type FileDiffMetadata, processFile } from "@pierre/diffs";
import { CodeView, type CodeViewHandle, WorkerPoolContext } from "@pierre/diffs/react";
import type { ChangedFile } from "@pando/contract";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { CODE_LAYOUT, codePool, COLOUR_MAX_LINES, SYNTAX_THEME } from "../../../../ui/syntax";

const pool = codePool();

// Line and number tints alike, a little quieter than Pierre's (15% of the
// token's colour in the dark, 10% in the light); the unchanged lines between
// hunks on a Loam strip, their count lined up with the code.
const DIFF = `
:host {
  --diffs-light-bg: var(--soil);
  --diffs-dark-bg: var(--soil);
  --diffs-addition-color-override: var(--diffs-token-inserted);
  --diffs-deletion-color-override: var(--diffs-token-deleted);
  --diffs-bg-separator-override: var(--loam);
}
[data-line], [data-no-newline], [data-gutter-buffer], [data-column-number] { --mix-dark: 85%; --mix-light: 90%; }
[data-separator-content] { padding-inline: max(52px, calc(var(--diffs-min-number-column-width-default, 4ch) + 21px)) 0; }
`;

/** The header the page draws for each file: its height, which the list's layout counts on. */
export const HEADER_HEIGHT = 44;

const options: CodeViewOptions<undefined> = {
  theme: SYNTAX_THEME,
  // A side over COLOUR_MAX_LINES lines is shown without colour (ui/syntax.ts).
  tokenizeMaxLength: COLOUR_MAX_LINES,
  diffStyle: "unified",
  hunkSeparators: "line-info-basic",
  unsafeCSS: CODE_LAYOUT + DIFF,
  stickyHeaders: true,
  // The code view's metrics (CODE_LAYOUT): 20 px lines, 12 px above and below, and the page's header.
  itemMetrics: { lineHeight: 20, spacing: 12, diffHeaderHeight: HEADER_HEIGHT },
  layout: { paddingTop: 1, paddingBottom: 24, gap: 16 },
};

/** The item for a file: its blobs and path, as the render cache's key too. */
export const itemId = (f: ChangedFile) => `${f.old_sha ?? "none"}..${f.new_sha ?? "none"}:${f.path}`;

/** A file shown without lines (binary, too large, past the budget, a pure rename): its patch's header only. */
function headerOnly(f: ChangedFile): string {
  const from = f.old_path ?? f.path;
  const kind = f.status === "added" ? "new file mode 100644\n" : f.status === "deleted" ? "deleted file mode 100644\n" : "";
  const rename = f.status === "renamed" ? `similarity index 100%\nrename from ${from}\nrename to ${f.path}\n` : "";

  return `diff --git a/${from} b/${f.path}\n${kind}${rename}`;
}

/** A file's parsed diff: its patch, or its header alone. */
function diffOf(f: ChangedFile): FileDiffMetadata {
  const key = itemId(f);
  const d = (f.patch !== null ? processFile(f.patch, { cacheKey: key, isGitDiff: true }) : undefined) ?? processFile(headerOnly(f), { cacheKey: `${key}:header`, isGitDiff: true });

  if (!d) throw new Error(`no diff for ${f.path}`);

  return d;
}

export interface DiffListProps {
  files: readonly ChangedFile[];
  /** Paths the person closed. */
  closed: ReadonlySet<string>;
  /** A file's header: its path, what happened to it, its counts, and opening and closing it. */
  header: (f: ChangedFile) => ReactNode;
  /** A file to bring to the top (chosen in the tree); a new `token` asks again for the same file. */
  target: { path: string; token: number } | null;
  /** The file at the top of the list, as it scrolls. */
  onTop: (path: string) => void;
  className?: string;
}

export default function DiffList({ files, closed, header, target, onTop, className }: DiffListProps) {
  const handle = useRef<CodeViewHandle<undefined>>(null);
  const items = useRef(new Map<string, CodeViewDiffItem>());
  const byId = useMemo(() => new Map(files.map((f) => [itemId(f), f])), [files]);

  // One item per id, kept while its file is listed (a new answer for the same head, or a push that left the
  // file alone, reads it again as a new object): the same item, and the same parsed diff when only its closed
  // state changes, so the list redraws only what changed.
  const list = useMemo(() => {
    const next = new Map<string, CodeViewDiffItem>();

    const out = files.map((f) => {
      const id = itemId(f);
      const collapsed = closed.has(f.path);
      const was = items.current.get(id);

      const item: CodeViewDiffItem =
        was && (was.collapsed ?? false) === collapsed
          ? was
          : { id, type: "diff", fileDiff: was?.fileDiff ?? diffOf(f), collapsed, version: (was?.version ?? 0) + 1 };

      next.set(id, item);

      return item;
    });

    items.current = next;

    return out;
  }, [files, closed]);

  useEffect(() => {
    const id = target && files.find((f) => f.path === target.path);

    if (id) handle.current?.scrollTo({ type: "item", id: itemId(id), align: "start" });
  }, [target, files]);

  // The file at the top: the last drawn file whose top is at or above the scroll position, once a frame at most.
  const frame = useRef(0);

  const scrolled = (scrollTop: number) => {
    if (frame.current) return;

    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const view = handle.current?.getInstance();
      const drawn = view?.getRenderedItems() ?? [];

      if (!view || !drawn.length) return;
      let top = drawn[0]?.id;

      for (const d of drawn) if ((view.getTopForItem(d.id) ?? Infinity) <= scrollTop + 8) top = d.id;

      // At the bottom, the last file, though its top may never reach the top of the window.
      if (view.getScrollTop() + view.getHeight() >= view.getScrollHeight() - 2) top = drawn.at(-1)?.id;
      const f = top === undefined ? undefined : byId.get(top);

      if (f) onTop(f.path);
    });
  };

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return (
    <WorkerPoolContext.Provider value={pool}>
      <CodeView
        ref={handle}
        items={list}
        options={options}
        onScroll={scrolled}
        className={className}
        renderCustomHeader={(item) => {
          const f = byId.get(item.id);

          return f ? header(f) : null;
        }}
      />
    </WorkerPoolContext.Provider>
  );
}
