// The root system under the sign-in page's ground line: the landing page's
// own (./graph.ts), grown in a worker, then drawn on one canvas. It grows once,
// from the ground down, in about 2.6 seconds, and then holds still; with
// reduced motion it is drawn whole at once. It follows a theme change and a
// resize by drawing again, whole. data-roots says what it shows: "growing",
// then "grown" ("still" with reduced motion), for the e2e.
import { useEffect, useRef } from "react";
import { cumlen, GROUND, MIDDLE, PLATE, type Pt, type Roots as Grown } from "./graph";
import GrowRoots from "./roots.worker?worker";

/** Milliseconds from the first thread to the last. */
const GROW_MS = 2600;

const DEPTH = PLATE.y1 - GROUND;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

type Rgb = [number, number, number];

/** A CSS colour as its red, green and blue (themes write some in oklch or color-mix, which a canvas may not read). */
function rgbOf(css: string): Rgb {
  const c = document.createElement("canvas");

  c.width = c.height = 1;
  const g = c.getContext("2d", { willReadFrequently: true });

  if (!g) return [128, 128, 128];
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r = 0, gr = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;

  return [r, gr, b];
}

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${a})`;

/** A line with its arc lengths and its highest point, where the growth front first reaches it. */
interface Line {
  pts: Pt[];
  c: Float64Array;
  top: number;
}

/** A line, turned to start at its shallower end so it grows down from there. */
function line(pts: Pt[]): Line {
  const first = pts[0]?.[1] ?? 0;
  const last = pts[pts.length - 1]?.[1] ?? 0;
  const down = first <= last ? pts : [...pts].reverse();

  return { pts: down, c: cumlen(down), top: Math.min(...pts.map((p) => p[1])) };
}

/** What is drawn, ready to draw at any moment of the growth. Threads are bucketed by width and alpha, one stroke each. */
interface Scene {
  threads: { w: number; a: number; lines: Line[] }[];
  cords: { w: number; lift: number; lines: Line[] }[];
  taps: Line[];
  knots: Grown["knots"];
}

function sceneOf(roots: Grown): Scene {
  const buckets = new Map<string, Scene["threads"][number]>();

  for (const t of roots.threads) {
    const a = Math.round(t.a * 20) / 20;
    const key = `${t.w}|${a}`;
    const b = buckets.get(key) ?? { w: t.w, a, lines: [] };

    b.lines.push(line(t.pts));
    buckets.set(key, b);
  }

  return {
    threads: [...buckets.values()],
    cords: roots.cords.map((c) => ({ w: c.w, lift: c.lift, lines: c.strands.map(line) })),
    taps: roots.taps.flatMap((strands) => strands.map(line)),
    knots: roots.knots,
  };
}

/** The points of a line, up to `upto` units along it. */
function trace(ctx: CanvasRenderingContext2D, pts: Pt[], c: Float64Array | null, upto: number) {
  const [x0, y0] = pts[0] ?? [0, 0];

  ctx.moveTo(x0, y0);

  for (let i = 1; i < pts.length && (!c || (c[i] ?? 0) <= upto); i++) {
    const [x, y] = pts[i] ?? [0, 0];

    ctx.lineTo(x, y);
  }
}

/** A line as far as the growth front has grown it (`rate` units of line per unit of depth past `from`); all of it once everything has grown. */
function grown(ctx: CanvasRenderingContext2D, l: Line, front: number, from: number, rate: number) {
  if (front === Infinity) trace(ctx, l.pts, null, 0);
  else if (front > from) trace(ctx, l.pts, l.c, (front - from) * rate);
}

/** Draws the roots as far as the growth front (a depth in world units; Infinity for all of it). */
function draw(ctx: CanvasRenderingContext2D, s: Scene, front: number) {
  const css = getComputedStyle(document.documentElement);
  const bark = rgbOf(css.getPropertyValue("--bark").trim());
  const ash = rgbOf(css.getPropertyValue("--ash").trim());
  const soil = rgbOf(css.getPropertyValue("--soil").trim());
  // A light page takes the mesh at a little over half its night strength, so it reads as pencil, not ink.
  const dark = soil[0] + soil[1] + soil[2] < 384;

  ctx.clearRect(PLATE.x0 - 2000, GROUND - 4, PLATE.x1 - PLATE.x0 + 4000, DEPTH + 8);

  for (const b of s.threads) {
    ctx.strokeStyle = rgba(ash, b.a * (dark ? 0.9 : 0.5));
    ctx.lineWidth = b.w;
    ctx.beginPath();

    for (const l of b.lines) grown(ctx, l, front, l.top, 2.2);
    ctx.stroke();
  }

  for (const c of s.cords) {
    ctx.strokeStyle = rgba(bark, (dark ? 0.34 : 0.26) * c.lift);
    ctx.lineWidth = c.w;
    ctx.beginPath();

    for (const l of c.lines) grown(ctx, l, front, l.top, 3);
    ctx.stroke();
  }

  ctx.strokeStyle = rgba(bark, 0.4);
  ctx.lineWidth = 0.55;
  ctx.beginPath();

  for (const l of s.taps) grown(ctx, l, front, GROUND, 1.6);
  ctx.stroke();

  for (const k of s.knots) {
    const shown = Math.min(1, Math.max(0, (front - k.y) / 40));

    if (!shown) continue;
    ctx.fillStyle = rgba(soil, shown);
    ctx.beginPath();
    ctx.arc(k.x, k.y, k.rk * 0.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = rgba(bark, 0.55 * shown);
    ctx.lineWidth = 0.6;
    ctx.beginPath();

    for (const p of k.coils) trace(ctx, p, null, 0);
    ctx.stroke();
    ctx.fillStyle = rgba(bark, shown);
    ctx.beginPath();
    ctx.arc(k.x, k.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Sizes the canvas to its box and maps the world onto it: the plate's middle under the page's middle, its depth filling the box. */
function fit(canvas: HTMLCanvasElement) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const dpr = Math.min(2, Math.max(1, devicePixelRatio || 1));
  const k = h / DEPTH;

  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");

  if (!ctx) return null;
  ctx.setTransform(k * dpr, 0, 0, k * dpr, (w / 2 - MIDDLE * k) * dpr, -GROUND * k * dpr);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  return ctx;
}

export function Roots() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;

    if (!el) return;
    const worker = new GrowRoots();
    let scene: Scene | null = null;
    let frame = 0;
    let width = 0;

    const whole = () => {
      cancelAnimationFrame(frame);
      const ctx = scene && fit(el);

      if (!scene || !ctx) return;
      width = el.clientWidth;
      draw(ctx, scene, Infinity);
      el.dataset.roots = reduced() ? "still" : "grown";
    };

    const grow = () => {
      const ctx = scene && fit(el);

      if (!scene || !ctx) return;
      width = el.clientWidth;
      el.dataset.roots = "growing";
      const s = scene;
      const start = performance.now();

      const step = (now: number) => {
        const t = Math.min(1, (now - start) / GROW_MS);

        // The front runs a quarter past the bottom, so the deepest threads finish too; it slows as it goes down.
        draw(ctx, s, t >= 1 ? Infinity : GROUND + DEPTH * 1.25 * (1 - Math.pow(1 - t, 2.2)));

        if (t < 1) frame = requestAnimationFrame(step);
        else el.dataset.roots = "grown";
      };

      frame = requestAnimationFrame(step);
    };

    worker.onmessage = (e: MessageEvent<Grown>) => {
      worker.terminate();
      scene = sceneOf(e.data);

      if (reduced()) whole();
      else grow();
    };

    // A new width draws again whole (a change of height alone, a phone's toolbar, does not change the drawing's scale).
    const resized = new ResizeObserver(() => {
      if (scene && el.clientWidth !== width) whole();
    });

    resized.observe(el);
    const unsubscribe = window.pandoTheme?.subscribe(() => requestAnimationFrame(whole));

    return () => {
      worker.terminate();
      cancelAnimationFrame(frame);
      resized.disconnect();
      unsubscribe?.();
    };
  }, []);

  // The soil is as deep as the plate at the page's width (326 world units at 1448 to the page), and never shallower than 261 px.
  return <canvas ref={canvas} aria-hidden="true" className="block h-[max(22.5vw,261px)] w-full" />;
}
