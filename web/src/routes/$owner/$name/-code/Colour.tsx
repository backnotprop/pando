// Syntax colour for a file's page, loaded on first use (FileView), the
// language from the file's name: Pierre's File in the page's flow,
// highlighted off the main thread by one long-lived worker on Shiki's
// JavaScript engine. Tokens carry CSS variables (theme.css), so one result
// fits every theme, and the render cache, keyed by blob oid, outlives each
// page.
import { getFiletypeFromFileName } from "@pierre/diffs";
import { File, WorkerPoolContext } from "@pierre/diffs/react";
import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
import workerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import { useMemo } from "react";
import { SYNTAX_THEME } from "../../../../ui/syntax";
import { Lines } from "./Lines";

const pool = getOrCreateWorkerPoolSingleton({
  poolOptions: { workerFactory: () => new Worker(workerUrl, { type: "module" }), poolSize: 1 },
  // Owner board: a line over 1,000 characters is shown without colour.
  highlighterOptions: { theme: SYNTAX_THEME, tokenizeMaxLineLength: 1000 },
});

// Pierre's layout set to FileView's plain lines (the prototype's .src): the
// mono face at 12.5/20, 12px above and below, a 52px gutter with the number
// 18px from the code, no backgrounds, and the numbers scrolling sideways with
// the code (not pinned over it); only the glyph colours differ.
const LAYOUT = `
:host {
  color-scheme: inherit;
  --diffs-font-family: var(--font-mono);
  --diffs-font-size: 12.5px;
  --diffs-line-height: 20px;
  --diffs-gap-block: 12px;
  --diffs-tab-size: 8;
  --diffs-fg-number-override: var(--ash);
}
[data-file] { --diffs-grid-number-column-width: 52px; }
pre, code, [data-gutter], [data-content] { background: none; }
[data-gutter] { position: relative; }
[data-column-number] { box-sizing: border-box; padding: 0 18px 0 0; border-right: 0; }
[data-line-number-content] { min-width: 0; }
[data-line] { padding-inline: 0; }
`;

const options = { theme: SYNTAX_THEME, disableFileHeader: true, unsafeCSS: LAYOUT };

/** `id` is the blob's oid: the render cache's key, with the language (one blob can sit under two names). */
export default function Colour({ name, text, id }: { name: string; text: string; id: string | null }) {
  const lang = getFiletypeFromFileName(name);
  const file = useMemo(() => ({ name, contents: text, lang, cacheKey: id ? `${id}.${lang}` : undefined }), [name, text, lang, id]);

  // A kind with no grammar stays plain.
  if (lang === "text") return <Lines text={text} />;

  return (
    <WorkerPoolContext.Provider value={pool}>
      <File file={file} options={options} />
    </WorkerPoolContext.Provider>
  );
}
