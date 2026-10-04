// Syntax colour for a file's page, loaded on first use (FileView), the
// language from the file's name: Pierre's File in the page's flow,
// highlighted off the main thread by the shared worker (ui/syntax.ts). The
// render cache, keyed by blob oid, outlives each page.
import { getFiletypeFromFileName } from "@pierre/diffs";
import { File, WorkerPoolContext } from "@pierre/diffs/react";
import { useMemo } from "react";
import { BARE_LAYOUT, CODE_LAYOUT, codePool, SYNTAX_THEME } from "../../../../ui/syntax";
import { Lines, Plain } from "./Lines";

const pool = codePool();

// Only the glyph colours differ from the plain lines.
const options = { theme: SYNTAX_THEME, disableFileHeader: true, unsafeCSS: CODE_LAYOUT };

// Without line numbers, as Plain draws text (a pipeline's YAML).
const bareOptions = { theme: SYNTAX_THEME, disableFileHeader: true, disableLineNumbers: true, unsafeCSS: BARE_LAYOUT };

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

  return (
    <WorkerPoolContext.Provider value={pool}>
      <File file={file} options={numbers ? options : bareOptions} />
    </WorkerPoolContext.Provider>
  );
}
