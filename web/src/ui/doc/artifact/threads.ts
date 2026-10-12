// Pando's comment rows as Plannotator's annotations, and back (SPEC.md 3).
// A thread's root carries the anchor the browser wrote (Plannotator's placing
// fields, opaque to the server; null for the whole artifact); a reply is an
// annotation with `inReplyTo` its root, which the panel indents under it.
// A new comment's anchor is the placing fields of the annotation the viewer
// made, the HTML ones trimmed to Plannotator's budget, plus Pando's context:
// the 48 characters of rendered text before and after the quote.
import type { ArtifactComment, ArtifactThread } from "@pando/contract";
import { parseDiagramAnchor } from "@plannotator/core/diagram-anchor";
import { parseHtmlAdditionalTargets, parseHtmlElementAnchor, parseHtmlElementContext } from "@plannotator/core/html-anchor";
import { buildPersistedHtmlAnchor } from "@plannotator/ui/components/html-viewer";
import { type Annotation, AnnotationType } from "@plannotator/ui/types";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { JsonBody } from "../../../api/json";

/** The words around a quote, as rendered when the comment was made. */
export interface Context {
  prefix: string;
  suffix: string;
}

const AROUND = 48;

/** A JSON copy: the anchor travels as the browser wrote it (undefined fields drop out). */
const json = <T,>(value: T): JsonBody => JSON.parse(JSON.stringify(value));

/** A new comment's stored anchor. */
export function anchorOf(ann: Annotation, html: boolean, context: Context | null): JsonBody {
  if (html) {
    const { anchor } = buildPersistedHtmlAnchor({ originalText: ann.originalText, htmlAnchor: ann.htmlAnchor, htmlAdditionalTargets: ann.htmlAdditionalTargets, elementContext: ann.elementContext });

    return json({ type: ann.type, ...anchor });
  }

  const placing = {
    type: ann.type,
    originalText: ann.originalText,
    blockId: ann.blockId,
    startOffset: ann.startOffset,
    endOffset: ann.endOffset,
    startMeta: ann.startMeta,
    endMeta: ann.endMeta,
    mathTargets: ann.mathTargets,
    diagramAnchor: ann.diagramAnchor,
  };

  return json(context ? { ...placing, context } : placing);
}

const squash = (s: string) => s.replace(/\s+/g, " ");

/** The rendered words before and after a highlight the viewer just painted (web-highlighter's `data-highlight-id` marks), within `root`. */
export function contextOf(root: HTMLElement, id: string): Context | null {
  const marks = root.querySelectorAll(`[data-highlight-id="${CSS.escape(id)}"]`);
  const first = marks[0];
  const last = marks[marks.length - 1];

  if (!first || !last) return null;
  const before = document.createRange();
  const after = document.createRange();

  before.setStart(root, 0);
  before.setEndBefore(first);
  after.setStartAfter(last);
  after.setEnd(root, root.childNodes.length);

  return { prefix: squash(before.toString()).slice(-AROUND), suffix: squash(after.toString()).slice(0, AROUND) };
}

const Meta = Schema.Struct({ parentTagName: Schema.String, parentIndex: Schema.Number, textOffset: Schema.Number });

/**
 * The stored anchor's Markdown fields; the HTML and diagram ones go through
 * Plannotator's own parsers (fail closed). Anything else is no anchor.
 */
const StoredAnchor = Schema.Struct({
  type: Schema.optionalKey(Schema.Literals(["COMMENT", "DELETION", "GLOBAL_COMMENT"])),
  originalText: Schema.optionalKey(Schema.String),
  blockId: Schema.optionalKey(Schema.String),
  startOffset: Schema.optionalKey(Schema.Number),
  endOffset: Schema.optionalKey(Schema.Number),
  startMeta: Schema.optionalKey(Meta),
  endMeta: Schema.optionalKey(Meta),
  mathTargets: Schema.optionalKey(Schema.Array(Schema.Struct({ blockId: Schema.String, tex: Schema.String, displayMode: Schema.Boolean }))),
  diagramAnchor: Schema.optionalKey(Schema.Unknown),
  htmlAnchor: Schema.optionalKey(Schema.Unknown),
  htmlAdditionalTargets: Schema.optionalKey(Schema.Unknown),
  elementContext: Schema.optionalKey(Schema.Unknown),
});

const readAnchor = Schema.decodeUnknownOption(StoredAnchor, { onExcessProperty: "ignore" });

const TYPES = { COMMENT: AnnotationType.COMMENT, DELETION: AnnotationType.DELETION, GLOBAL_COMMENT: AnnotationType.GLOBAL_COMMENT } as const;

const DELETED = "This comment was deleted.";

/** A thread's root as the annotation the viewer places and the panel shows: no anchor, or no quote and no element, is the whole artifact. */
export function rootAnnotation(t: ArtifactComment): Annotation {
  const a = Option.getOrNull(readAnchor(t.anchor));
  const htmlAnchor = parseHtmlElementAnchor(a?.htmlAnchor) ?? undefined;
  const originalText = a?.originalText ?? "";
  const type = a?.type && a.type !== "GLOBAL_COMMENT" && (originalText || htmlAnchor) ? TYPES[a.type] : AnnotationType.GLOBAL_COMMENT;

  return {
    id: t.id,
    blockId: a?.blockId ?? "",
    startOffset: a?.startOffset ?? 0,
    endOffset: a?.endOffset ?? 0,
    type,
    originalText,
    text: t.body ?? DELETED,
    createdA: Date.parse(t.created_at),
    author: t.author,
    startMeta: a?.startMeta,
    endMeta: a?.endMeta,
    mathTargets: a?.mathTargets ? [...a.mathTargets] : undefined,
    diagramAnchor: parseDiagramAnchor(a?.diagramAnchor) ?? undefined,
    htmlAnchor,
    htmlAdditionalTargets: a?.htmlAdditionalTargets ? parseHtmlAdditionalTargets(a.htmlAdditionalTargets) : undefined,
    elementContext: parseHtmlElementContext(a?.elementContext),
  };
}

/** A reply, threaded under its root; it carries the root's quote (its card hides it, doc.css). */
const replyAnnotation = (r: ArtifactComment, root: Annotation): Annotation => ({
  id: r.id,
  blockId: "",
  startOffset: 0,
  endOffset: 0,
  type: AnnotationType.COMMENT,
  originalText: root.originalText,
  text: r.body ?? DELETED,
  createdA: Date.parse(r.created_at),
  author: r.author,
  inReplyTo: root.id,
});

/** The panel's list: each thread's root, then its replies. */
export function panelAnnotations(threads: readonly ArtifactThread[]): Annotation[] {
  return threads.flatMap((t) => {
    const root = rootAnnotation(t);

    return [root, ...t.replies.map((r) => replyAnnotation(r, root))];
  });
}

/** Whether a root has a place in the document: a quote or an element, not the whole artifact. */
export const hasPlace = (a: Annotation) => a.type !== AnnotationType.GLOBAL_COMMENT && (!!a.originalText || !!a.htmlAnchor);

/** Every comment by id, roots and replies, with the thread each belongs to. */
export function byId(threads: readonly ArtifactThread[]): Map<string, { comment: ArtifactComment; thread: ArtifactThread }> {
  const out = new Map<string, { comment: ArtifactComment; thread: ArtifactThread }>();

  for (const t of threads) {
    out.set(t.id, { comment: t, thread: t });

    for (const r of t.replies) out.set(r.id, { comment: r, thread: t });
  }

  return out;
}
