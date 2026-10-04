// Syntax colour for a file's page, loaded on first use (FileView), the
// language from the file's name: Pierre's File in the page's flow,
// highlighted off the main thread by the shared worker (ui/syntax.ts). The
// render cache, keyed by blob oid, outlives each page. A long file is
// virtualized on the page's own scroll: only the lines near the window are in
// the page, so a file of 30,000 lines opens and scrolls like a short one.
import { getFiletypeFromFileName, Virtualizer } from "@pierre/diffs";
import { File, VirtualizerContext, WorkerPoolContext } from "@pierre/diffs/react";
import { useMemo } from "react";
import { BARE_LAYOUT, CODE_LAYOUT, codePool, COLOUR_MAX_LINES, SYNTAX_THEME } from "../../../../ui/syntax";
import { Lines, Plain } from "./Lines";

const pool = codePool();

// Only the glyph colours differ from the plain lines; over COLOUR_MAX_LINES lines, none (ui/syntax.ts).
const options = { theme: SYNTAX_THEME, disableFileHeader: true, unsafeCSS: CODE_LAYOUT, tokenizeMaxLength: COLOUR_MAX_LINES };

// Without line numbers, as Plain draws text (a pipeline's YAML).
const bareOptions = { theme: SYNTAX_THEME, disableFileHeader: true, disableLineNumbers: true, unsafeCSS: BARE_LAYOUT, tokenizeMaxLength: COLOUR_MAX_LINES };

/** A file of more lines than this is virtualized; a shorter one is drawn whole, as before. */
const VIRTUAL_FROM_LINES = 2_000;

// The code view's metrics (CODE_LAYOUT): 20 px lines, 12 px above and below, no header.
const metrics = { hunkLineCount: 50, lineHeight: 20, diffHeaderHeight: 0, spacing: 12 };

/** One virtualizer for the page's own scroll, made on first use; files join and leave it as they mount. */
let onPage: Virtualizer | null = null;

function pageVirtualizer(): Virtualizer {
  if (!onPage) {
    onPage = new Virtualizer();
    onPage.setup(document);
  }

  return onPage;
}

const lineCount = (text: string) => {
  let n = 1;

  for (let at = text.indexOf("\n"); at !== -1 && n <= VIRTUAL_FROM_LINES; at = text.indexOf("\n", at + 1)) n++;

  return n;
};

/**
 * `id` is the blob's oid: the render cache's key, with the language (one blob
 * can sit under two names). `numbers` false draws it without line numbers.
 */
export default function Colour({ name, text, id, numbers = true }: { name: string; text: string; id: string | null; numbers?: boolean }) {
  const lang = getFiletypeFromFileName(name);
  // Drawn bare, the text's last newline ends its last line, as a <pre> shows it, rather than opening an empty one.
  const contents = numbers ? text : text.replace(/\n$/, "");
  const file = useMemo(() => ({ name, contents, lang, cacheKey: id ? `${id}.${lang}` : undefined }), [name, contents, lang, id]);

  // A kind with no grammar stays plain.
  if (lang === "text") return numbers ? <Lines text={text} /> : <Plain text={text} />;

  const view = <File file={file} options={numbers ? options : bareOptions} metrics={metrics} />;

  return (
    <WorkerPoolContext.Provider value={pool}>
      {lineCount(text) > VIRTUAL_FROM_LINES ? <VirtualizerContext.Provider value={pageVirtualizer()}>{view}</VirtualizerContext.Provider> : view}
    </WorkerPoolContext.Provider>
  );
}
