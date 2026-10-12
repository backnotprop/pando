// Plannotator's document viewer (@plannotator/ui, owner ruling): Markdown
// through its Viewer, HTML through its HtmlViewer, read-only. This module is
// the lazy chunk (Doc.tsx loads it), so the package, its CSS and DOMPurify
// reach the browser only when a document is on screen.
// First: Plannotator is configured before any of its modules renders.
import { FollowPando, pandoFences, remote, scriptless } from "./setup";
import "./doc.css";
import { HtmlViewer } from "@plannotator/ui/components/html-viewer";
import bridgeScriptUrl from "@plannotator/ui/components/html-viewer/bridge-script.asset.js?url";
import { ThemeProvider } from "@plannotator/ui/components/ThemeProvider";
import { Viewer } from "@plannotator/ui/components/Viewer";
import { extractFrontmatter, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser";
import { use, useMemo } from "react";
import { shownMode } from "../theme";
import type { DocProps } from "./Doc";

const none = () => undefined;

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
    <ThemeProvider defaultTheme={shownMode()} defaultColorTheme="plannotator">
      <FollowPando />
      {/\.html?$/i.test(name) ? (
        <div className="pn-doc isolate">
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
