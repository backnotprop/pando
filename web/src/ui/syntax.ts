// Pando's one setup for @pierre/diffs (Shiki), shared by the code view
// (-code/Colour.tsx), the diff (-code/Diff.tsx) and code fences in documents
// (doc/PlannotatorDoc.tsx), each loading it on first use:
// - the syntax theme, registered once (Pierre logs an error when a name is
//   registered twice): its tokens take the --diffs-token-* variables in
//   theme.css, so one highlighted result fits every theme;
// - the one worker that colours the code view and the diff off the main
//   thread, made on first use (making it starts the worker; fences are
//   coloured by Pierre's shared highlighter and need none);
// - the code view's metrics, which the diff shares, and the same without
//   line numbers.
import { registerCustomCSSVariableTheme } from "@pierre/diffs";
import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
import workerUrl from "@pierre/diffs/worker/worker.js?worker&url";

export const SYNTAX_THEME = "pando";

registerCustomCSSVariableTheme(SYNTAX_THEME, {});

export const codePool = () =>
  getOrCreateWorkerPoolSingleton({
    poolOptions: { workerFactory: () => new Worker(workerUrl, { type: "module" }), poolSize: 1 },
    // Owner board: a line over 1,000 characters is shown without colour.
    highlighterOptions: { theme: SYNTAX_THEME, tokenizeMaxLineLength: 1000 },
  });

// The plain lines' metrics (-code/Lines.tsx, the prototype's .src): the mono
// face at 12.5/20, 12px above and below, a 52px gutter with the number 18px
// from the code, no backgrounds, and the numbers scrolling sideways with the
// code (not pinned over it).
export const CODE_LAYOUT = `
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

// The same without line numbers (-code/Lines.tsx Plain, the prototype's
// .yaml, for a pipeline's configuration): 19px lines, 14px above and below,
// no number column, 18px at the sides.
export const BARE_LAYOUT = `${CODE_LAYOUT}
:host { --diffs-line-height: 19px; --diffs-gap-block: 14px; }
[data-file] { --diffs-grid-number-column-width: 0px; }
[data-line] { padding-inline: 18px; }
`;
