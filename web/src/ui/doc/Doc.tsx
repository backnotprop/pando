// Where a document shows: Markdown and HTML files through Plannotator's
// viewer (PlannotatorDoc.tsx), loaded on first use so a page with no document
// never downloads it.
import { type ComponentType, lazy, Suspense } from "react";

export interface DocProps {
  /** The file's path in its tree (a root file's, or a project file's), for its name and its relative links. */
  path: string;
  text: string;
  /** The file's raw URL: relative images in it are read from beside it. */
  raw: string;
  /** Opens another file of the same tree by its path. */
  openFile: (path: string) => void;
}

// A glob, not import("./PlannotatorDoc"): Vite makes the same lazy chunk, and
// web's typecheck does not follow it into @plannotator/ui's sources, which are
// not written for web's noUncheckedIndexedAccess. tsconfig.doc.json checks
// PlannotatorDoc.tsx with the package's own strictness.
const [load] = Object.values(import.meta.glob<{ default: ComponentType<DocProps> }>("./PlannotatorDoc.tsx"));

const PlannotatorDoc = lazy(() => (load ? load() : Promise.reject(new Error("PlannotatorDoc.tsx is missing"))));

/** Markdown and HTML files have a Preview; other files are shown as code. */
export const isDoc = (name: string) => /\.(md|markdown|html?)$/i.test(name);

export function Doc(props: DocProps) {
  return (
    <Suspense fallback={<div className="min-h-24" />}>
      <PlannotatorDoc {...props} />
    </Suspense>
  );
}
