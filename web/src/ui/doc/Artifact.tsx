// An artifact under review: the document (Plannotator's Markdown viewer, its
// HTML viewer, or an image) and the comment panel beside it (Plannotator's
// AnnotationPanel with Pando's threads, reply box and resolved state). The
// review is a lazy chunk (artifact/Review.tsx), as Doc.tsx loads the file
// page's viewer, so @plannotator/ui reaches the browser only here.
import type { Artifact, ArtifactThread } from "@pando/contract";
import { type ComponentType, lazy, type ReactNode, Suspense } from "react";
import type { JsonBody } from "../../api/json";

export interface ReviewActions {
  /** A new thread on the shown version: Plannotator's anchor with Pando's context, or null for the whole artifact. */
  add: (anchor: JsonBody | null, body: string) => Promise<void>;
  reply: (root: string, body: string) => Promise<void>;
  setState: (root: string, state: "open" | "resolved") => Promise<void>;
  edit: (id: string, body: string, baseVersion: number) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Opens a version of this artifact ("Made on v2"). */
  openVersion: (n: number) => void;
  /** Opens another artifact of the branch (a card under All files). */
  openArtifact: (name: string) => void;
}

export interface ReviewProps {
  artifact: Artifact;
  /** The version on screen. */
  version: number;
  /** The version's document, its images written in; null for an image. */
  text: string | null;
  /** An image artifact's picture. */
  image: string | null;
  /** Shown instead of the viewer: the document's code (Code). Comments then list without places. */
  code: ReactNode | null;
  /** This artifact's threads, every version, open and resolved. */
  threads: readonly ArtifactThread[];
  /** Every artifact on the branch and their threads, for All files; null until read. */
  branch: { artifacts: readonly Artifact[]; threads: readonly ArtifactThread[] } | null;
  /** The signed-in person; null: comments are read only. */
  me: string | null;
  actions: ReviewActions;
  /** Above the document, in its column: the name, the version menu, Preview and Code, Raw. */
  head: ReactNode;
}

// A glob, as Doc.tsx does: web's typecheck does not follow it into
// @plannotator/ui's sources; tsconfig.doc.json checks the review.
const [load] = Object.values(import.meta.glob<{ default: ComponentType<ReviewProps> }>("./artifact/Review.tsx"));

const Review = lazy(() => (load ? load() : Promise.reject(new Error("artifact/Review.tsx is missing"))));

export function ArtifactReview(props: ReviewProps) {
  return (
    <Suspense fallback={<div className="min-h-24" />}>
      <Review {...props} />
    </Suspense>
  );
}
