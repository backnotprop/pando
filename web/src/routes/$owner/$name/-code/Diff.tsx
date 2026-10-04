// One changed file's patch as Pierre's unified diff, loaded on first use
// (FilesChanged.tsx): the code view's metrics and token colours, coloured by
// the shared worker (pierre.ts). Added lines are tinted with the inserted
// token's colour and removed ones with the deleted token's (theme.css), so
// nothing reads as Rust (conflicts, failures) or Foxfire (arrival).
import { processFile } from "@pierre/diffs";
import { FileDiff, WorkerPoolContext } from "@pierre/diffs/react";
import { useMemo } from "react";
import { LAYOUT, pool } from "./pierre";

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
[data-separator-content] { padding-inline: 52px 0; }
`;

const options = { theme: "pando", diffStyle: "unified", hunkSeparators: "line-info-basic", disableFileHeader: true, unsafeCSS: LAYOUT + DIFF } as const;

/** `id` names this patch for the render cache (its blobs on each side). */
export default function Diff({ patch, id }: { patch: string; id: string }) {
  const fileDiff = useMemo(() => processFile(patch, { cacheKey: id, isGitDiff: true }), [patch, id]);

  if (!fileDiff) return null;

  return (
    <WorkerPoolContext.Provider value={pool}>
      <FileDiff fileDiff={fileDiff} options={options} />
    </WorkerPoolContext.Provider>
  );
}
