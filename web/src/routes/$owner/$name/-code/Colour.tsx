// Syntax colour for a file's page, loaded on first use (FileView), the
// language from the file's name: Pierre's File in the page's flow,
// highlighted off the main thread by the shared worker (pierre.ts). The
// render cache, keyed by blob oid, outlives each page.
import { getFiletypeFromFileName } from "@pierre/diffs";
import { File, WorkerPoolContext } from "@pierre/diffs/react";
import { useMemo } from "react";
import { Lines } from "./Lines";
import { LAYOUT, pool } from "./pierre";

// Only the glyph colours differ from the plain lines.
const options = { theme: "pando", disableFileHeader: true, unsafeCSS: LAYOUT };

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
