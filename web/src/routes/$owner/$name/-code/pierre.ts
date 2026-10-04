// What the code view (Colour.tsx) and the diff view (Diff.tsx) share, loaded
// with them on first use: Pierre's one long-lived worker on Shiki's JavaScript
// engine, its theme of CSS variables (theme.css sets them, so one result fits
// every theme), and its metrics set to the prototype's .src.
import { registerCustomCSSVariableTheme } from "@pierre/diffs";
import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
import workerUrl from "@pierre/diffs/worker/worker.js?worker&url";

registerCustomCSSVariableTheme("pando", {});

export const pool = getOrCreateWorkerPoolSingleton({
  poolOptions: { workerFactory: () => new Worker(workerUrl, { type: "module" }), poolSize: 1 },
  // Owner board: a line over 1,000 characters is shown without colour.
  highlighterOptions: { theme: "pando", tokenizeMaxLineLength: 1000 },
});

// The plain lines' metrics (Lines.tsx, the prototype's .src): the mono face at
// 12.5/20, 12px above and below, a 52px gutter with the number 18px from the
// code, no backgrounds, and the numbers scrolling sideways with the code (not
// pinned over it).
export const LAYOUT = `
:host {
  color-scheme: inherit;
  --diffs-font-family: var(--font-mono);
  --diffs-font-size: 12.5px;
  --diffs-line-height: 20px;
  --diffs-gap-block: 12px;
  --diffs-tab-size: 8;
  --diffs-fg-number-override: var(--ash);
}
[data-file], [data-diff] { --diffs-grid-number-column-width: 52px; }
pre, code, [data-gutter], [data-content] { background: none; }
[data-gutter] { position: relative; }
[data-column-number] { box-sizing: border-box; padding: 0 18px 0 0; border-right: 0; }
[data-line-number-content] { min-width: 0; }
[data-line] { padding-inline: 0; }
`;
