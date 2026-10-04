// Where a diff's file tree shows (Files changed): Plannotator's own tree
// (PlannotatorTree.tsx), loaded on first use with its scoped styles.
import { type ComponentType, lazy, Suspense } from "react";

export interface TreeFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "binary";
  additions: number;
  deletions: number;
}

export interface TreeProps {
  files: readonly TreeFile[];
  /** The file chosen, in the tree or by scrolling the list. */
  selected: string | null;
  onSelect: (path: string) => void;
}

// A glob, as in Doc.tsx: web's typecheck does not follow it into
// @plannotator/ui's sources; tsconfig.doc.json checks PlannotatorTree.tsx.
const [load] = Object.values(import.meta.glob<{ default: ComponentType<TreeProps> }>("./PlannotatorTree.tsx"));

const PlannotatorTree = lazy(() => (load ? load() : Promise.reject(new Error("PlannotatorTree.tsx is missing"))));

export function FileTree(props: TreeProps) {
  return (
    <Suspense fallback={null}>
      <PlannotatorTree {...props} />
    </Suspense>
  );
}
