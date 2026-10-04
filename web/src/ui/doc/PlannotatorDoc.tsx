// Plannotator's document viewer (@plannotator/ui, owner ruling): Markdown
// through its Viewer, HTML through its HtmlViewer, read-only. This module is
// the lazy chunk (Doc.tsx loads it), so the package, its CSS and DOMPurify
// reach the browser only when a document is on screen.
import "./doc.css";
import { HtmlViewer } from "@plannotator/ui/components/html-viewer";
import bridgeScriptUrl from "@plannotator/ui/components/html-viewer/bridge-script.asset.js?url";
import { ThemeProvider, useTheme } from "@plannotator/ui/components/ThemeProvider";
import { Viewer } from "@plannotator/ui/components/Viewer";
import { configurePlannotatorUI } from "@plannotator/ui/configure";
import { extractFrontmatter, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser";
import { SHIKI_THEME_MAP } from "@plannotator/ui/utils/syntaxTheme";
import DOMPurify from "dompurify";
import { use, useEffect, useMemo } from "react";
import type { DocProps } from "./Doc";

const remote = /^(https?:|data:|blob:|mailto:)/i;

/** `path` from the file at `base` (a raw URL), as a raw URL at the same `?ref=`; web links pass through. */
function rawFrom(path: string, base?: string): string {
  if (!base || remote.test(path)) return path;
  const from = new URL(base, location.origin);
  const url = new URL(path, from);
  const ref = from.searchParams.get("ref");

  if (url.origin !== location.origin) return path;

  return url.pathname + (ref ? `?ref=${encodeURIComponent(ref)}` : "");
}

// Settings the viewer keeps (its theme pair among them) stay in memory: no
// cookies, nothing in localStorage. No identity, no agent tools on the page.
const settings = new Map<string, string>();

configurePlannotatorUI({
  webmcp: { enabled: false },
  storageBackend: {
    getItem: (key) => settings.get(key) ?? null,
    setItem: (key, value) => void settings.set(key, value),
    removeItem: (key) => void settings.delete(key),
  },
  identityProvider: { getIdentity: () => "", isCurrentUser: () => false, isEditable: () => false },
  imageSrcResolver: rawFrom,
  docPreviewFetcher: () => Promise.resolve(null),
  // KaTeX and its stylesheet load together, on a document's first formula.
  mathRendererLoader: () => Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([katex]) => katex.default),
});

/** Pando's theme is set before the page paints (public/theme.js) and does not change after. */
const pandoMode = (): "dark" | "light" => (document.documentElement.dataset.theme?.endsWith("-light") ? "light" : "dark");

/** Keeps the viewer's mode on Pando's (its code colours and diagrams follow it). */
function FollowPando() {
  const { mode, setMode } = useTheme();
  const want = pandoMode();

  useEffect(() => {
    if (mode !== want) setMode(want);
  }, [mode, want, setMode]);

  return null;
}

const none = () => undefined;

// Code fences take the code view's colours (ui/syntax.ts, the --diffs-token-*
// palette in theme.css), not a stock Shiki theme. The viewer picks a fence's
// Shiki theme from its colour theme ("plannotator" here) through this table;
// it has no setting for it, so the entry is pointed at Pando's once the theme
// is registered. A document with a fence waits for that (Pierre, which colours
// the fence, loads then anyway); one without never loads it.
let syntax: Promise<void> | null = null;

const pandoFences = () =>
  (syntax ??= import("../syntax").then(
    ({ SYNTAX_THEME }) => {
      SHIKI_THEME_MAP.plannotator = { dark: SYNTAX_THEME, light: SYNTAX_THEME };
    },
    // If the chunk cannot load (a deploy replaced it), the document still shows; its fences stay plain.
    () => undefined,
  ));

function MarkdownDoc({ text, raw, open }: { text: string; raw: string; open: (href: string) => void }) {
  const { frontmatter, blocks } = useMemo(() => ({ frontmatter: extractFrontmatter(text).frontmatter, blocks: parseMarkdownToBlocks(text) }), [text]);

  // `use` may sit in a condition: only a document with a fence waits.
  if (blocks.some((b) => b.type === "code" && !!b.language)) use(pandoFences());

  return (
    <Viewer
      blocks={blocks}
      markdown={text}
      frontmatter={frontmatter}
      annotations={[]}
      onAddAnnotation={none}
      onSelectAnnotation={none}
      selectedAnnotationId={null}
      mode="selection"
      taterMode={false}
      readOnly
      stickyActions={false}
      maxWidth={null}
      imageBaseDir={raw}
      disableCodePathValidation
      onOpenLinkedDoc={open}
    />
  );
}

/** An HTML file's text with every script removed (elements, handlers, javascript: links); its styles stay. */
const scriptless = (html: string) => DOMPurify.sanitize(html, { WHOLE_DOCUMENT: true, ADD_TAGS: ["style"] });

function HtmlDoc({ name, text, open }: { name: string; text: string; open: (href: string) => void }) {
  const html = useMemo(() => scriptless(text), [text]);

  return (
    <HtmlViewer
      rawHtml={html}
      bridgeScriptUrl={bridgeScriptUrl}
      title={name}
      annotations={[]}
      onAddAnnotation={none}
      onSelectAnnotation={none}
      selectedAnnotationId={null}
      mode="selection"
      inputMethod="drag"
      annotateModeActive={false}
      readOnly
      onOpenLink={open}
    />
  );
}

export default function PlannotatorDoc({ path, text, raw, openFile }: DocProps) {
  const name = path.slice(path.lastIndexOf("/") + 1);

  // A link in the document: a web link opens in a new tab; a relative one opens that file's page here.
  const open = (href: string) => {
    if (remote.test(href)) {
      window.open(href, "_blank", "noopener,noreferrer");

      return;
    }

    const target = new URL(href, `https://file.invalid/${path}`);

    if (target.host === "file.invalid") openFile(decodeURIComponent(target.pathname.slice(1)));
  };

  return (
    <ThemeProvider defaultTheme={pandoMode()} defaultColorTheme="plannotator">
      <FollowPando />
      {/\.html?$/i.test(name) ? (
        <div className="pn-doc isolate pb-3">
          <HtmlDoc name={name} text={text} open={open} />
        </div>
      ) : (
        <div className="pn-doc isolate">
          <MarkdownDoc text={text} raw={raw} open={open} />
        </div>
      )}
    </ThemeProvider>
  );
}
