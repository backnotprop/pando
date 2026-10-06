// The Quaking leaf: the mark of a Cloudflare-run agent and of the assistant,
// in its states (the owner's choice, 2026-10-04). Frames loop at the icon
// page's rates; with reduced motion each holds one frame that still says the
// state. `tone` draws it in one colour: quiet for a stopped agent, rust for a
// failed one.
import { useEffect, useState } from "react";
import { LEAF_COLOURS, LEAF_FRAMES } from "./leaf-frames";

export type LeafState = "idle" | "thinking" | "working" | "done" | "needs";

type FrameName = keyof typeof LEAF_FRAMES;

/** Each state's frames, its rate, and the frame it holds with reduced motion. */
const STATES: Record<LeafState, { frames: readonly FrameName[]; fps: number; still: number }> = {
  idle: { frames: ["idle-0"], fps: 1, still: 0 },
  thinking: { frames: ["thinking-0", "thinking-1", "thinking-2", "thinking-3"], fps: 6, still: 0 },
  working: { frames: ["working-0", "working-1"], fps: 4, still: 1 },
  done: { frames: ["done-0"], fps: 1, still: 0 },
  needs: { frames: ["needs-0", "needs-1"], fps: 2, still: 0 },
};

/** The leaf's eye colour. */
const EYES = "#3d1e0f";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The frame shown now: a whole frame at the state's rate, or its still one. */
function useFrame(state: LeafState): FrameName {
  const s = STATES[state];
  const [i, setI] = useState(s.still);

  useEffect(() => {
    setI(s.still);

    if (s.frames.length < 2 || reduced()) return;
    const t = setInterval(() => setI((n) => (n + 1) % s.frames.length), 1000 / s.fps);

    return () => clearInterval(t);
  }, [s]);

  return s.frames[i % s.frames.length] ?? "idle-0";
}

export function Leaf({ state, size = 16, tone, label, className = "" }: { state: LeafState; size?: number; tone?: "quiet" | "rust"; label?: string; className?: string }) {
  const frame = useFrame(state);
  const one = tone === "rust" ? "var(--rust)" : tone === "quiet" ? "var(--ash)" : null;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`inline-block flex-none [shape-rendering:crispEdges] ${className}`}
    >
      {LEAF_FRAMES[frame].flatMap(([x, y, w, h, c]) =>
        // In one colour the eyes are holes, as in the icon's mono version.
        one && LEAF_COLOURS[c] === EYES ? [] : [<rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} fill={one ?? LEAF_COLOURS[c]} />],
      )}
    </svg>
  );
}
