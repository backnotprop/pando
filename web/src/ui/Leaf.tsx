// The Quaking leaf: the mark of a Cloudflare-run agent and of the assistant,
// in its states (the owner's choice, 2026-10-04). From 24 px up, where WebGL
// is available, it is the living leaf (./leaf3d, three.js, approved by the
// owner 2026-10-07), loaded on its own after the page; below 24 px, without
// WebGL and while that loads, it is the 16 px pixel flip-book. With reduced
// motion each holds one still that says the state. `tone` draws it in one
// colour: quiet for a stopped agent, rust for a failed one.
import { useEffect, useRef, useState, type RefObject } from "react";
import type { LeafHandle } from "./leaf3d/stage";
import type { LeafState } from "./leaf3d/pose";
import { LEAF_COLOURS, LEAF_FRAMES } from "./leaf-frames";

export type { LeafState };

type Tone = "quiet" | "rust";

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

/** The smallest size drawn living; under it the pixels read better. */
const LIVING_FROM = 24;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

let gl: boolean | null = null;

/** Whether this browser can draw WebGL, asked once. */
function webgl() {
  if (gl === null) {
    try {
      const c = document.createElement("canvas");

      gl = !!(c.getContext("webgl2") ?? c.getContext("webgl"));
    } catch {
      gl = false;
    }
  }

  return gl;
}

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

function Pixels({ state, size, one, label, className = "" }: { state: LeafState; size: number; one: string | null; label?: string; className?: string }) {
  const frame = useFrame(state);

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

/** A CSS colour as rgb() (themes write some in oklch, which the 3D side does not read). */
function rgb(css: string) {
  const c = document.createElement("canvas");

  c.width = c.height = 1;
  const g = c.getContext("2d", { willReadFrequently: true });

  if (!g || !css) return null;

  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;

  return `rgb(${r ?? 0}, ${gr ?? 0}, ${b ?? 0})`;
}

/** The tone's colour now, from the page's theme (it follows a theme change). */
function useToneColour(el: RefObject<HTMLElement | null>, tone: Tone | undefined) {
  const [colour, setColour] = useState<string | null>(null);

  useEffect(() => {
    if (!tone) {
      setColour(null);

      return;
    }

    const read = () => {
      if (el.current) setColour(rgb(getComputedStyle(el.current).getPropertyValue(tone === "rust" ? "--rust" : "--ash").trim()));
    };

    read();

    return window.pandoTheme?.subscribe(() => requestAnimationFrame(read));
  }, [el, tone]);

  return colour;
}

/** The living leaf: a canvas the page's one leaf stage draws into, with the pixels in its place until the first frame. */
function Living({ state, size, tone, onLost }: { state: LeafState; size: number; tone: Tone | undefined; onLost: () => void }) {
  const box = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<LeafHandle | null>(null);
  const [drawn, setDrawn] = useState(false);
  const colour = useToneColour(box, tone);
  const look = useRef({ state, tone: tone && colour ? { kind: tone, colour } : null });

  look.current = { state, tone: tone && colour ? { kind: tone, colour } : null };

  useEffect(() => {
    let gone = false;

    import("./leaf3d/stage")
      .then(({ leafStage }) => {
        if (gone || !canvas.current) return;

        // Mounted already done (a page that opens on a merged agent), the flourish is skipped; it plays when the state changes to done here.
        handle.current = leafStage().add(canvas.current, {
          ...look.current,
          size,
          still: reduced(),
          intro: false,
          onDrawn: () => setDrawn(true),
          onLost,
        });
      })
      .catch(onLost);

    return () => {
      gone = true;
      handle.current?.remove();
      handle.current = null;
    };
  }, [size, onLost]);

  useEffect(() => {
    handle.current?.set(look.current);
  }, [state, tone, colour]);

  const one = tone ? (colour ?? (tone === "rust" ? "var(--rust)" : "var(--ash)")) : null;

  return (
    <span ref={box} className="relative inline-block flex-none" style={{ width: size, height: size }}>
      <canvas ref={canvas} className="absolute inset-0 size-full" />
      {drawn ? null : <Pixels state={state} size={size} one={one} className="absolute inset-0" />}
    </span>
  );
}

export function Leaf({ state, size = 16, tone, label, className = "" }: { state: LeafState; size?: number; tone?: Tone; label?: string; className?: string }) {
  const [lost, setLost] = useState(false);
  const [onLost] = useState(() => () => setLost(true));
  const living = size >= LIVING_FROM && !lost && webgl();
  const one = tone === "rust" ? "var(--rust)" : tone === "quiet" ? "var(--ash)" : null;

  if (!living) return <Pixels state={state} size={size} one={one} label={label} className={className} />;

  return (
    <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={`inline-flex flex-none ${className}`}>
      <Living state={state} size={size} tone={tone} onLost={onLost} />
    </span>
  );
}
