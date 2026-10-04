// Plannotator's diff file tree (@plannotator/ui DiffFileTree), read only:
// folders, change letters and +/- counts as its code review draws them. The
// tree is its own scroller; a file chosen from outside (by scrolling the list)
// is brought into view here, inside it, never by scrolling the page.
import "./tree.css";
import { DiffFileTree } from "@plannotator/ui/components/DiffFileTree";
import { useEffect, useRef } from "react";
import type { TreeProps } from "./Tree";

export default function PlannotatorTree({ files, selected, onSelect }: TreeProps) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;

    if (!el || !selected) return;

    // After the tree has opened the folder the file is in.
    const frame = requestAnimationFrame(() => {
      const row = [...el.querySelectorAll<HTMLElement>("[role=treeitem][data-path]")].find((r) => r.dataset.path === selected);

      if (!row) return;
      const r = row.getBoundingClientRect();
      const c = el.getBoundingClientRect();

      if (r.top < c.top) el.scrollTop -= c.top - r.top;
      else if (r.bottom > c.bottom) el.scrollTop += r.bottom - c.bottom;
    });

    return () => cancelAnimationFrame(frame);
  }, [selected]);

  return (
    <div ref={box} className="pn-tree max-h-full overflow-y-auto">
      <DiffFileTree files={files} selectedPath={selected} onSelect={onSelect} />
    </div>
  );
}
