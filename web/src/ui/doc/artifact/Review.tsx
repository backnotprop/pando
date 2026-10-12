// An artifact under review (the lazy chunk ui/doc/Artifact.tsx loads): the
// document on the left, the comment panel on the right (on a phone, under
// it). Markdown: Plannotator's Viewer, which paints highlights only when told
// (ref.applySharedAnnotations after mount, again whenever the open threads
// change) and reports what it could not place (onRestoreReport). HTML: its
// HtmlViewer, driven by the annotations prop (marker numbers are its order),
// in its own frame with only Plannotator's bridge running, pinpoints armed;
// it reports what it could not place (onUnanchoredChange). An image: the
// picture on a quiet ground, comments on the whole of it. A new comment is
// stored with its anchor and, for Markdown, the words around its quote.
// First: Plannotator is configured before any of its modules renders.
import { FollowPando, pandoFences, scriptless, setPerson } from "../setup";
import "../doc.css";
import { HtmlViewer } from "@plannotator/ui/components/html-viewer";
import bridgeScriptUrl from "@plannotator/ui/components/html-viewer/bridge-script.asset.js?url";
import { ThemeProvider } from "@plannotator/ui/components/ThemeProvider";
import { Viewer, type ViewerHandle } from "@plannotator/ui/components/Viewer";
import type { Annotation } from "@plannotator/ui/types";
import { extractFrontmatter, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser";
import { type ReactNode, use, useEffect, useMemo, useRef, useState } from "react";
import { shownMode } from "../../theme";
import type { ReviewProps } from "../Artifact";
import { type Filter, Panel } from "./Panel";
import { anchorOf, contextOf, hasPlace, rootAnnotation } from "./threads";

const none = () => undefined;

/** Whether two lists place the same comments in the same words (re-painting is needed only when they do not). */
const placesKey = (list: readonly Annotation[]) => list.map((a) => `${a.id}\u0000${a.originalText}`).join("\u0001");

interface DocProps {
  text: string;
  /** The open threads' roots that have a place, in order. */
  placed: readonly Annotation[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onUnanchored: (ids: ReadonlySet<string>) => void;
  /** A new comment: its anchor, as stored. */
  onComment: (ann: Annotation, html: boolean, root: HTMLElement | null) => void;
  readOnly: boolean;
}

function MarkdownDoc({ text, placed, selected, onSelect, onUnanchored, onComment, readOnly }: DocProps) {
  const { frontmatter, blocks } = useMemo(() => ({ frontmatter: extractFrontmatter(text).frontmatter, blocks: parseMarkdownToBlocks(text) }), [text]);
  const viewer = useRef<ViewerHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const key = placesKey(placed);
  const list = useRef(placed);

  list.current = placed;

  // `use` may sit in a condition: only a document with a fence waits.
  if (blocks.some((b) => b.type === "code" && !!b.language)) use(pandoFences());

  // Painted after the document settles, and again when the open threads change (a comment, a resolve, a new version).
  useEffect(() => {
    const t = setTimeout(() => {
      viewer.current?.clearAllHighlights();

      if (list.current.length) viewer.current?.applySharedAnnotations([...list.current]);
      else onUnanchored(new Set());
    }, 100);

    return () => clearTimeout(t);
  }, [key, text, onUnanchored]);

  return (
    <div ref={box}>
      <Viewer
        ref={viewer}
        blocks={blocks}
        markdown={text}
        frontmatter={frontmatter}
        annotations={[...placed]}
        onAddAnnotation={(ann) => onComment(ann, false, box.current)}
        onSelectAnnotation={onSelect}
        selectedAnnotationId={selected}
        mode="selection"
        taterMode={false}
        readOnly={readOnly}
        stickyActions={false}
        maxWidth={null}
        disableCodePathValidation
        allowImages={false}
        quickLabels={false}
        onRestoreReport={(r) => onUnanchored(new Set(r.unanchored))}
      />
    </div>
  );
}

function HtmlDoc({ text, placed, selected, onSelect, onUnanchored, onComment, readOnly, title }: DocProps & { title: string }) {
  const html = useMemo(() => scriptless(text), [text]);

  return (
    <HtmlViewer
      rawHtml={html}
      bridgeScriptUrl={bridgeScriptUrl}
      title={title}
      annotations={[...placed]}
      onAddAnnotation={(ann) => onComment(ann, true, null)}
      onSelectAnnotation={onSelect}
      selectedAnnotationId={selected}
      mode="selection"
      inputMethod="pinpoint"
      annotateModeActive
      readOnly={readOnly}
      hideControls
      onUnanchoredChange={(ids) => onUnanchored(new Set(ids))}
      onOpenLink={(href) => window.open(href, "_blank", "noopener,noreferrer")}
    />
  );
}

const frame = "overflow-hidden rounded-[10px] border border-rootline";

export default function Review({ artifact, version, text, image, code, threads, branch, me, actions, head }: ReviewProps) {
  const [filter, setFilter] = useState<Filter>("open");
  const [selected, setSelected] = useState<string | null>(null);
  const [unanchored, setUnanchored] = useState<ReadonlySet<string>>(new Set());
  // Each version gets its own viewer (keyed below), which reports afresh.
  const [shownVersion, setShownVersion] = useState(version);

  if (shownVersion !== version) {
    setShownVersion(version);
    setUnanchored(new Set());
  }

  // The composer stamps the signed-in person, and the panel marks their cards "(me)".
  useEffect(() => setPerson(me ?? ""), [me]);

  // Only open threads with a place light up in the document; resolved ones leave it.
  const placed = useMemo(() => threads.filter((t) => t.state === "open").map(rootAnnotation).filter(hasPlace), [threads]);
  // The panel marks Unanchored only what this document was asked to place.
  const lost = useMemo(() => (code ? new Set<string>() : new Set([...unanchored].filter((id) => placed.some((a) => a.id === id)))), [code, unanchored, placed]);

  const comment = (ann: Annotation, html: boolean, root: HTMLElement | null) => {
    const context = !html && root ? contextOf(root, ann.id) : null;

    void actions.add(anchorOf(ann, html, context), ann.text ?? "").catch(none);
  };

  const doc: DocProps = { text: text ?? "", placed, selected, onSelect: setSelected, onUnanchored: setUnanchored, onComment: comment, readOnly: !me };

  let body: ReactNode;

  if (code) body = <div className={frame}>{code}</div>;
  else if (image) {
    body = (
      <div className={`${frame} flex justify-center bg-air px-6 py-8 phone:px-3 phone:py-4`}>
        <img src={image} alt={artifact.name} className="block max-w-full" />
      </div>
    );
  } else if (artifact.kind === "html") {
    body = (
      <div className={`${frame} pn-html`}>
        <HtmlDoc key={version} {...doc} title={artifact.title ?? artifact.name} />
      </div>
    );
  } else {
    body = (
      <div className={`${frame} px-12 py-10 phone:px-5 phone:py-6`}>
        <MarkdownDoc key={version} {...doc} />
      </div>
    );
  }

  return (
    <ThemeProvider defaultTheme={shownMode()} defaultColorTheme="plannotator">
      <FollowPando />
      <div className="pn-doc isolate grid grid-cols-[minmax(0,1fr)_340px] items-start gap-16 narrow:grid-cols-[minmax(0,1fr)] narrow:gap-8">
        <div className="min-w-0">
          {head}
          {body}
        </div>
        <Panel
          artifact={artifact}
          version={version}
          threads={threads}
          branch={branch}
          me={me}
          actions={actions}
          unanchored={lost}
          filter={filter}
          onFilter={setFilter}
          selected={selected}
          onSelect={setSelected}
        />
      </div>
    </ThemeProvider>
  );
}
