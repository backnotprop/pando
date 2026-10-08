// One WebGL renderer for every living leaf on the page. Each frame it draws
// the leaves that are on screen into tiles of one hidden canvas, then copies
// each tile into that leaf's own small 2D canvas. One context, however many
// leaves (browsers allow only about 16 WebGL contexts a page), and nothing
// runs while the tab is hidden or no animated leaf is in view.
import { NeutralToneMapping, PMREMGenerator, SRGBColorSpace, WebGLRenderer } from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { ease } from "./motion";
import { BLEND, kick, loopTime, mixPose, STATES, toned, type LeafState, type LeafTone, type Pose } from "./pose";
import { LeafRig, type Framing } from "./rig";

export interface LeafLook {
  state: LeafState;
  /** One colour for the whole leaf: which tone, and its CSS colour. */
  tone: { kind: LeafTone; colour: string } | null;
}

export interface LeafOptions extends LeafLook {
  /** CSS pixels, square. */
  size: number;
  /** Hold one still per state (prefers-reduced-motion). */
  still: boolean;
  /** Play the state's first pass (done's flourish) on mount; otherwise start in its loop at an offset of its own. */
  intro: boolean;
  /** Loop the whole state, first pass included (the preview and the renders replay done's flourish). */
  replay?: boolean;
  /** Override the framing that follows from the size (icon under 64 px). */
  framing?: Framing;
  /** Fill the canvas with this colour first (for renders); transparent otherwise. */
  ground?: string;
  /** Called once the first frame is on the canvas. */
  onDrawn?: () => void;
}

export interface LeafHandle {
  set(look: LeafLook): void;
  remove(): void;
}

interface Item {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  o: LeafOptions;
  px: number;
  /** When the current state began, on the stage clock, and the state's own time at that moment. */
  since: number;
  offset: number;
  prev: { state: LeafState; tone: LeafLook["tone"]; t: number } | null;
  inView: boolean;
  dirty: boolean;
  drawn: boolean;
  /** Its tile in the atlas this frame. */
  x: number;
  y: number;
}

let count = 0;

/** A spread of start offsets so a page of leaves does not move in step. */
const spread = () => ((count++ * 0.618034) % 1) * 7;

export class LeafStage {
  private readonly renderer: WebGLRenderer;
  private readonly rig = new LeafRig();
  private readonly items = new Set<Item>();
  private readonly seen: IntersectionObserver;
  private frame = 0;
  private atlas = { w: 0, h: 0 };
  /** The stage clock in seconds; the preview page replaces it to scrub. */
  clock: () => number = () => performance.now() / 1000;
  /** The work of the last frames in milliseconds (posing, drawing and copying), for the performance check. */
  readonly costs: number[] = [];
  lost = false;
  onLost: (() => void) | null = null;

  constructor() {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;
    const pmrem = new PMREMGenerator(this.renderer);

    this.rig.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.rig.scene.environmentIntensity = 0.35;
    pmrem.dispose();
    this.renderer.domElement.addEventListener("webglcontextlost", () => {
      this.lost = true;
      this.onLost?.();
    });
    this.seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          for (const it of this.items) {
            if (it.canvas === e.target) {
              it.inView = e.isIntersecting;
              it.dirty ||= e.isIntersecting;
            }
          }
        }

        this.wake();
      },
      { rootMargin: "64px" },
    );
    document.addEventListener("visibilitychange", () => this.wake());
  }

  add(canvas: HTMLCanvasElement, o: LeafOptions): LeafHandle {
    const ctx = canvas.getContext("2d");

    if (!ctx) throw new Error("no 2D canvas");

    const px = Math.round(o.size * Math.min(2, Math.max(1, devicePixelRatio || 1)));

    canvas.width = canvas.height = px;
    const loops = STATES[o.state];

    const it: Item = {
      canvas,
      ctx,
      o,
      px,
      since: this.clock(),
      offset: o.intro ? 0 : loops.hold + (spread() % (loops.period - loops.hold)),
      prev: null,
      inView: true,
      dirty: true,
      drawn: false,
      x: 0,
      y: 0,
    };

    this.items.add(it);
    this.seen.observe(canvas);
    this.wake();

    return {
      set: (look) => {
        if (look.state === it.o.state && look.tone?.colour === it.o.tone?.colour) return;

        const now = this.clock();

        it.prev = { state: it.o.state, tone: it.o.tone, t: it.offset + (now - it.since) };
        it.since = now;
        it.offset = 0;
        it.o = { ...it.o, ...look };
        it.dirty = true;
        this.wake();
      },
      remove: () => {
        this.items.delete(it);
        this.seen.unobserve(canvas);
      },
    };
  }

  /** Draw every leaf now, at the stage clock (the preview and the renders call this directly). */
  draw() {
    this.render(true);
  }

  private wake() {
    if (this.frame || document.hidden || this.lost) return;

    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const more = this.render(false);

      if (more) this.wake();
    });
  }

  /** A leaf moves when it is animated, or while it blends from its last state. */
  private moving(it: Item, now: number) {
    const blending = now - it.since < BLEND + 0.7;

    return blending || (!it.o.still && !it.o.tone);
  }

  private poseOf(it: Item, now: number): Pose {
    const dt = now - it.since;

    const at = (state: LeafState, tone: LeafLook["tone"], t: number, still: boolean) => {
      const spec = STATES[state];
      const p = spec.pose(still || tone ? spec.still : it.o.replay ? t % spec.period : loopTime(state, t));

      return tone ? toned(p, tone.kind) : p;
    };

    const cur = at(it.o.state, it.o.tone, it.offset + dt, it.o.still);

    if (!it.prev || dt >= BLEND + 0.7) return cur;

    const before = at(it.prev.state, it.prev.tone, it.prev.t + dt, it.o.still);
    const p = mixPose(before, cur, ease.smooth(dt / BLEND));

    if (!it.o.still) kick(p, dt);

    return p;
  }

  /** Lay the tiles out in shelves and grow the hidden canvas to hold them. */
  private layout(list: Item[]) {
    list.sort((a, b) => b.px - a.px);
    const w = Math.max(512, list[0]?.px ?? 0);
    let x = 0;
    let y = 0;
    let shelf = 0;

    for (const it of list) {
      if (x + it.px > w) {
        x = 0;
        y += shelf;
        shelf = 0;
      }

      it.x = x;
      it.y = y;
      x += it.px;
      shelf = Math.max(shelf, it.px);
    }

    const h = y + shelf;

    if (w > this.atlas.w || h > this.atlas.h) {
      this.atlas = { w: Math.max(w, this.atlas.w), h: Math.ceil(Math.max(h, this.atlas.h) / 128) * 128 };
      this.renderer.setSize(this.atlas.w, this.atlas.h, false);
    }
  }

  /** One frame: returns whether anything still moves. */
  private render(all: boolean) {
    if (this.lost) return false;

    const start = performance.now();
    const now = this.clock();
    const list = [...this.items].filter((it) => it.inView && (all || it.dirty || this.moving(it, now)));

    if (!list.length) return false;

    this.layout(list);
    const r = this.renderer;
    const { rig } = this;

    r.setScissorTest(false);
    r.clear();
    r.setScissorTest(true);

    for (const it of list) {
      const gy = this.atlas.h - it.y - it.px;

      r.setViewport(it.x, gy, it.px, it.px);
      r.setScissor(it.x, gy, it.px, it.px);
      rig.frame(it.o.framing ?? (it.o.size < 64 ? "icon" : "hero"));
      rig.pose(this.poseOf(it, now), it.o.tone?.colour ?? null);
      r.render(rig.scene, rig.camera);
    }

    for (const it of list) {
      const { ctx, px } = it;

      ctx.clearRect(0, 0, px, px);

      if (it.o.ground) {
        ctx.fillStyle = it.o.ground;
        ctx.fillRect(0, 0, px, px);
      }

      ctx.drawImage(r.domElement, it.x, it.y, px, px, 0, 0, px, px);
      it.dirty = false;

      if (!it.drawn) {
        it.drawn = true;
        it.o.onDrawn?.();
      }
    }

    this.costs.push(performance.now() - start);

    if (this.costs.length > 240) this.costs.shift();

    return list.some((it) => this.moving(it, now));
  }
}

let stage: LeafStage | null = null;

/** The page's one stage, made on first use. */
export function leafStage() {
  stage ??= new LeafStage();

  return stage;
}
