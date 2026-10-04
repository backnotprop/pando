// Pando's one setup for @pierre/diffs (Shiki), shared by the code view
// (-code/Colour.tsx), Files changed (-code/DiffList.tsx) and code fences in
// documents (doc/PlannotatorDoc.tsx), each loading it on first use:
// - the syntax theme, registered once (Pierre logs an error when a name is
//   registered twice): its tokens take the --diffs-token-* variables in
//   theme.css, so one highlighted result fits every theme;
// - the one worker pool that colours the code view and Files changed off the
//   main thread, made on first use (making it starts the workers; fences are
//   coloured by Pierre's shared highlighter and need none);
// - the code view's metrics, which the diff shares, and the same without
//   line numbers.
import { registerCustomCSSVariableTheme } from "@pierre/diffs";
import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
import workerUrl from "@pierre/diffs/worker/worker.js?worker&url";

export const SYNTAX_THEME = "pando";

registerCustomCSSVariableTheme(SYNTAX_THEME, {});

/**
 * Code with more lines than this on a side (a file, or a side of a diff) is
 * shown without colour (owner limit, boarded): the worker's coloured answer
 * reaches the page in one message, which blocks it about 4 ms per 1,000 lines
 * as the code comes into view, so beyond this a scroll would stall past 100 ms.
 */
export const COLOUR_MAX_LINES = 12_000;

/**
 * Workers in the pool: up to three, one fewer than the cores, as DiffsHub and
 * Plannotator's review size theirs; one on a phone. A large Files changed
 * colours its files in parallel.
 */
const POOL_SIZE = matchMedia("(pointer: coarse)").matches ? 1 : Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));

export const codePool = () =>
  getOrCreateWorkerPoolSingleton({
    poolOptions: { workerFactory: () => new Worker(workerUrl, { type: "module" }), poolSize: POOL_SIZE },
    // Owner board: a line over 1,000 characters is shown without colour.
    highlighterOptions: { theme: SYNTAX_THEME, tokenizeMaxLineLength: 1000 },
  });

/**
 * A few lines in each language most code here is written in. The worker
 * colours them once while the app is idle (-code/coloured.ts), so its first
 * real file in each is coloured at once: the first file in a language cost
 * the worker 100 to 200 ms (its grammar, and compiling the grammar's patterns
 * on first use), the next one 15 ms. Other languages pay it on first use.
 */
const WARM = [
  {
    name: "warm.ts",
    lang: "typescript",
    contents: [
      "// A line comment, then a block one.",
      "/** Its doc, with a @param tag. */",
      'import { type A, b } from "./b";',
      'import * as C from "c";',
      "",
      "export interface D<T> extends A {",
      "  readonly e?: T[];",
      '  f: "g" | "h";',
      "}",
      "",
      "type I = Record<string, number | null>;",
      "",
      "enum J {",
      "  K = 1,",
      "}",
      "",
      "export class L<T> implements D<T> {",
      '  f = "g" as const;',
      "  private m = new Map<string, T>();",
      "",
      "  constructor(readonly n: number) {}",
      "",
      "  async o(p: T[], q = 2): Promise<T | undefined> {",
      "    for (const [i, r] of p.entries()) if (i > q && r) return r;",
      "    switch (this.n) {",
      "      case 0:",
      "        break;",
      "      default:",
      "        throw new Error(`no ${this.n}`);",
      "    }",
      "",
      "    return /^\\d+$/.test(String(p.length)) ? p.at(-1) : this.m.get(\"s\")?.valueOf();",
      "  }",
      "}",
      "",
      "export const t = (u: number, ...v: string[]): string => `${u}:${v.join(\",\")}`;",
      "const w = { x: true, y: [1, 2.5, 0x1f], z: null, ...C } satisfies object;",
      "",
    ].join("\n"),
  },
  {
    name: "warm.tsx",
    lang: "tsx",
    contents: `import { useState } from "react";\n\nexport function F({ g }: { g: string }) {\n  const [h] = useState(1);\n\n  return <p className="i">{g} {h}</p>;\n}\n`,
  },
  { name: "warm.md", lang: "markdown", contents: "# Title\n\nSome **bold** text, a [link](./a.md) and `code`.\n\n- one\n- two\n\n```sh\nnpm test\n```\n" },
  { name: "warm.go", lang: "go", contents: `package a\n\nimport "fmt"\n\n// B says hello.\nfunc B(c int) (string, error) {\n\treturn fmt.Sprintf("%d", c), nil\n}\n` },
] as const;

/** Colours the warm-up files in the worker, one after another, off the main thread; the cache keeps them (4 of its 100). */
export function warmGrammars(pool: ReturnType<typeof codePool>): Promise<void> {
  return WARM.reduce<Promise<void>>((after, f) => after.then(() => pool.primeFileHighlightCache({ ...f, cacheKey: `warm:${f.name}` })), Promise.resolve());
}

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
