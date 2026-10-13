// The root system under the sign-in page: the landing page's living graph
// (gitpando.com's hero, research/design/pando-2026-10-02/landing/_src/graph.js,
// art-ops' original), ported as it is, with only what the sign-in page draws:
// no labels, no light, no soil specks or grass. The same 22 knots and 41
// cords, braided strands, taproots that rise to the ground, and the mesh of
// hyphae fused between them; the lockup's floor moves to the middle, under
// the mark. Seeded, so every visit grows the same roots. World units: the
// plate spans x 56 to 1544, the ground is y 286, the bottom y 612.
export type Pt = [number, number];

const TAU = Math.PI * 2;

export const GROUND = 286;

export const PLATE = { x0: 56, x1: 1544, y1: 612 } as const;

/** The middle of the plate, where the mark stands. */
export const MIDDLE = (PLATE.x0 + PLATE.x1) / 2;

// ------------------------------------------------------------------ chance --

function mulberry(seed: number) {
  let a = seed;

  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string) {
  let h = 2166136261;

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return h >>> 0;
}

interface Stream {
  (a?: number, b?: number): number;
  chance: (p: number) => boolean;
  gauss: () => number;
}

/** One stream per key, so changing one part never reshuffles another. */
function stream(...keys: string[]): Stream {
  const f = mulberry(hash(keys.join("|")));

  for (let i = 0; i < 9; i++) f();
  const r = (a = 0, b = 1) => a + f() * (b - a);

  return Object.assign(r, { chance: (p: number) => f() < p, gauss: () => (f() + f() + f() - 1.5) / 1.5 });
}

function h2(ix: number, iy: number, s: number) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s | 0, 1442695041)) | 0;

  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;

  return (h >>> 0) / 4294967296;
}

function noise(x: number, y: number, s: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);

  return h2(xi, yi, s) * (1 - u) * (1 - v) + h2(xi + 1, yi, s) * u * (1 - v) + h2(xi, yi + 1, s) * (1 - u) * v + h2(xi + 1, yi + 1, s) * u * v;
}

function fbm(x: number, y: number, s: number, octaves: number) {
  let a = 0.5;
  let f = 1;
  let t = 0;
  let n = 0;

  for (let i = 0; i < octaves; i++) {
    t += noise(x * f, y * f, s + i * 31) * a;
    n += a;
    a *= 0.5;
    f *= 2.03;
  }

  return t / n;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const smooth01 = (t: number) => t * t * (3 - 2 * t);

// ---------------------------------------------------------------- geometry --

function resample(pts: Pt[], step: number): Pt[] {
  const first = pts[0] ?? [0, 0];
  const out: Pt[] = [[first[0], first[1]]];
  let need = step;

  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i - 1] ?? first;
    const [x1, y1] = pts[i] ?? first;
    let x0 = px;
    let y0 = py;
    let d = Math.hypot(x1 - x0, y1 - y0);

    while (d >= need && d > 0) {
      const t = need / d;

      x0 += (x1 - x0) * t;
      y0 += (y1 - y0) * t;
      out.push([x0, y0]);
      d = Math.hypot(x1 - x0, y1 - y0);
      need = step;
    }

    need -= d;
  }

  const last = pts[pts.length - 1] ?? first;
  const le = out[out.length - 1] ?? first;

  if (Math.hypot(last[0] - le[0], last[1] - le[1]) > step * 0.2 || out.length < 2) out.push([last[0], last[1]]);

  return out;
}

function chaikin(pts: Pt[], times: number): Pt[] {
  let p = pts;

  for (let k = 0; k < times; k++) {
    const q: Pt[] = [p[0] ?? [0, 0]];

    for (let i = 0; i < p.length - 1; i++) {
      const [ax, ay] = p[i] ?? [0, 0];
      const [bx, by] = p[i + 1] ?? [0, 0];

      q.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }

    q.push(p[p.length - 1] ?? [0, 0]);
    p = q;
  }

  return p;
}

/** Each point's arc length from the start. */
export function cumlen(pts: Pt[]) {
  const c = new Float64Array(pts.length);

  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1] ?? [0, 0];
    const [bx, by] = pts[i] ?? [0, 0];

    c[i] = (c[i - 1] ?? 0) + Math.hypot(bx - ax, by - ay);
  }

  return c;
}

function normalAt(pts: Pt[], i: number): Pt {
  const [ax, ay] = pts[Math.max(0, i - 1)] ?? [0, 0];
  const [bx, by] = pts[Math.min(pts.length - 1, i + 1)] ?? [0, 0];
  const nx = -(by - ay);
  const ny = bx - ax;
  const l = Math.hypot(nx, ny) || 1;

  return [nx / l, ny / l];
}

// ------------------------------------------------------- the monorepo ------
// The landing's example monorepo: 22 packages placed by hand (depth runs down)
// and who depends on whom. Only the shape is used here; no name is shown.
const PACKAGES: [string, number, number, ("l" | "r")?][] = [
  ["apps/docs", 196, 352],
  ["apps/web", 470, 360],
  ["apps/mobile", 760, 346],
  ["apps/admin", 1076, 356],
  ["services/auth", 330, 430],
  ["services/notify", 636, 420],
  ["services/search", 924, 434],
  ["services/billing", 1196, 418],
  ["services/ledger", 1442, 428, "l"],
  ["tools/release", 112, 478],
  ["packages/forms", 430, 494],
  ["packages/api-client", 604, 506],
  ["packages/i18n", 796, 492],
  ["packages/telemetry", 984, 508],
  ["packages/db", 1146, 494],
  ["packages/money", 1300, 500],
  ["tools/build", 214, 540],
  ["packages/ui", 360, 566],
  ["packages/icons", 540, 580],
  ["tools/codegen", 716, 566],
  ["packages/config", 904, 576],
  ["tools/lint", 120, 590],
];

const DEPS: [string, string[]][] = [
  ["apps/web", ["packages/ui", "packages/api-client", "packages/i18n", "packages/forms", "packages/telemetry"]],
  ["apps/admin", ["packages/ui", "packages/api-client", "packages/forms", "packages/money"]],
  ["apps/docs", ["packages/ui", "packages/icons"]],
  ["apps/mobile", ["packages/api-client", "packages/i18n", "packages/icons"]],
  ["services/billing", ["packages/money", "packages/db", "packages/config", "packages/telemetry"]],
  ["services/ledger", ["packages/money", "packages/db", "packages/config"]],
  ["services/auth", ["packages/db", "packages/config", "packages/telemetry"]],
  ["services/search", ["packages/db", "packages/config"]],
  ["services/notify", ["packages/config", "packages/i18n", "packages/telemetry"]],
  ["packages/ui", ["packages/icons"]],
  ["packages/forms", ["packages/ui", "packages/i18n"]],
  ["packages/api-client", ["packages/config", "tools/codegen"]],
  ["packages/db", ["packages/config"]],
  ["packages/telemetry", ["packages/config"]],
  ["packages/money", ["packages/i18n"]],
  ["tools/build", ["packages/config", "tools/lint"]],
  ["tools/release", ["tools/build"]],
  ["tools/codegen", ["packages/config"]],
];

interface Knot {
  id: string;
  x: number;
  y: number;
  side: "l" | "r";
  deg: number;
  traffic: number;
  rk: number;
  /** Where the landing writes the knot's name (SF Mono 10.5 px): the mesh keeps clear of it, which gives the mesh its open grain. */
  box: [number, number, number, number];
}

interface Edge {
  from: Knot;
  to: Knot;
}

function repo() {
  const nodes: Knot[] = PACKAGES.map(([id, x, y, side = "r"]) => ({ id, x, y, side, deg: 0, traffic: 0, rk: 0, box: [0, 0, 0, 0] }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: Edge[] = [];

  for (const [a, bs] of DEPS) {
    const to = byId.get(a);

    for (const b of bs) {
      const from = byId.get(b);

      // Grown from the dependency to its dependent.
      if (from && to) edges.push({ from, to });
    }
  }

  const dependents = (id: string) => edges.flatMap((e) => (e.from.id === id ? [e.to.id] : []));

  /** Everything that depends on id, directly or through others. */
  const closure = (id: string) => {
    const seen = new Set<string>();
    const st = [id];

    for (let next = st.pop(); next !== undefined; next = st.pop()) {
      for (const d of dependents(next)) {
        if (!seen.has(d)) {
          seen.add(d);
          st.push(d);
        }
      }
    }

    seen.delete(id);

    return seen;
  };

  for (const n of nodes) {
    n.deg = edges.filter((e) => e.from === n || e.to === n).length;
    n.traffic = closure(n.id).size;
    n.rk = 4.2 + 1.45 * Math.sqrt(n.deg);
    const w = n.id.length * 6.32;
    const x = n.side === "l" ? n.x - n.rk - 11 - w : n.x + n.rk + 11 - 2;

    n.box = [x - 3, n.y + 3.6 - 10, x + w + 3, n.y + 3.6 + 3];
  }

  return { nodes, edges };
}

// ------------------------------------------------------------ growing ------

/** A cord walks from P to Q through the soil's grain: nearby cords bend the same way. */
function grownPath(P: Pt, Q: Pt, key: string, bounds: readonly number[]) {
  const r = stream("path", key);
  const D0 = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
  let [x, y] = P;
  let h = Math.atan2(Q[1] - y, Q[0] - x) + r(-0.8, 0.8);
  let walked = 0;
  const pts: Pt[] = [[x, y]];
  const step = 3;
  const [, top = 0, , bottom = 0] = bounds;

  for (let k = 0; k < 3000; k++) {
    const dx = Q[0] - x;
    const dy = Q[1] - y;
    const d = Math.hypot(dx, dy);

    if (d < step * 1.6) break;
    const to = Math.atan2(dy, dx);
    const grain = (fbm(x * 0.0052, y * 0.0052, 7, 3) - 0.5) * 3.4;
    const near = clamp(1 - d / Math.min(200, D0 * 0.62), 0, 1);
    let target = to + grain * (1 - near);

    // Stay in the soil: lean away from its edges.
    if (y < top + 14) target = lerp(target, Math.PI / 2, 0.5);

    if (y > bottom - 10) target = lerp(target, -Math.PI / 2, 0.5);
    let diff = target - h;

    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    h += diff * (0.07 + 0.55 * near * near + 0.4 * clamp(walked / D0 - 1.35, 0, 1));
    x += Math.cos(h) * step;
    y += Math.sin(h) * step;
    walked += step;
    pts.push([x, y]);
  }

  pts.push([Q[0], Q[1]]);

  return resample(chaikin(pts, 2), 3);
}

/** A cord is a few strands braided round its path, gathered tight where it meets a knot. */
function braid(M: Pt[], n: number, W: number, key: string) {
  const r = stream("braid", key);
  const c = cumlen(M);
  const L = c[c.length - 1] ?? 1;
  const strands: Pt[][] = [];

  for (let i = 0; i < n; i++) {
    const a = r(0.45, 1);
    const wl = r(55, 120);
    const ph = r(0, TAU);
    const b = r(-0.3, 0.3);
    const tr = r(0.15, 0.35);

    strands.push(
      M.map(([px, py], j) => {
        const cj = c[j] ?? 0;
        const env = Math.pow(Math.sin((Math.PI * cj) / L), 0.55);
        const [nx, ny] = normalAt(M, j);
        const o = (a * Math.sin((cj / wl) * TAU + ph) + b) * W * env + r(-tr, tr);

        return [px + nx * o, py + ny * o];
      }),
    );
  }

  return strands;
}

interface Generation {
  branch?: number;
  min: number;
  max: number;
  wander: number;
  grain?: number;
  free?: Seed[];
}

/** x, y, heading, and the id of what it grows from (-1: a free hypha in open soil). */
type Seed = [number, number, number, number];

interface Tip {
  x: number;
  y: number;
  h: number;
  src: number;
  id: number;
  pts: Pt[];
  len: number;
  max: number;
  done: boolean;
  into: number;
  cells: number[];
  turn: number;
  pair: Tip | null;
}

interface MeshSpec {
  bounds: [number, number, number, number];
  cell: number;
  cords: Pt[][][];
  discs: [number, number, number][];
  seeds: Seed[];
  seed: string;
  blocked: (x: number, y: number) => boolean;
  step: number;
  minRun: number;
  gens: Generation[];
}

const EDGE = -5;

/**
 * Hyphae: threads grow out of the cords (and out of each other, in
 * generations) through the soil's grain, all at once, a step at a time. A tip
 * that runs into another thread fuses with it and stops; a tip that never
 * meets anything is cut away, and so is anything that fused into it. Every
 * thread that survives joins two others: a true mesh, no loose ends.
 */
function hyphae(o: MeshSpec) {
  const r = stream("hyphae", o.seed);
  const cs = o.cell;
  const [X0, Y0, X1, Y1] = o.bounds;
  const gw = Math.ceil((X1 - X0) / cs) + 1;
  const gh = Math.ceil((Y1 - Y0) / cs) + 1;
  const occ = new Int32Array(gw * gh).fill(-1);
  const idx = (x: number, y: number) => (x < X0 || y < Y0 || x > X1 || y > Y1 ? -2 : Math.floor((y - Y0) / cs) * gw + Math.floor((x - X0) / cs));
  const cell = (q: number) => occ[q] ?? -1;

  const stamp = (pts: Pt[], id: number) => {
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1] ?? [0, 0];
      const [bx, by] = pts[i] ?? [0, 0];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (cs * 0.5)));

      for (let k = 0; k <= n; k++) {
        const q = idx(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);

        if (q >= 0) occ[q] = id;
      }
    }
  };

  let next = 0;

  // A cord is a group of strands with one id.
  for (const group of o.cords) {
    const id = next++;

    for (const p of group) stamp(p, id);
  }

  for (const [x, y, rad] of o.discs) {
    const id = next++;

    for (let yy = y - rad; yy <= y + rad; yy += cs * 0.5) {
      for (let xx = x - rad; xx <= x + rad; xx += cs * 0.5) {
        if (Math.hypot(xx - x, yy - y) <= rad) {
          const q = idx(xx, yy);

          if (q >= 0) occ[q] = id;
        }
      }
    }
  }

  // Ids below this are cords and knots: always alive.
  const fixed = next;
  const alive = new Set<number>();
  const kept: { pts: Pt[]; g: number }[] = [];
  let seeds: Seed[] = [...o.seeds, ...(o.gens[0]?.free ?? [])];
  const { step, minRun } = o;

  for (const [g, G] of o.gens.entries()) {
    const mk = (x: number, y: number, h: number, src: number, max: number): Tip => ({
      x,
      y,
      h,
      src,
      id: next++,
      pts: [[x, y]],
      len: 0,
      max,
      done: false,
      into: -1,
      cells: [],
      turn: r(-0.04, 0.04),
      pair: null,
    });

    const tips: Tip[] = [];

    for (const [sx, sy, sh, src] of seeds) {
      if (src >= 0) {
        tips.push(mk(sx, sy, sh, src, r(G.min, G.max)));
        continue;
      }

      // A free hypha in open soil grows both ways; it lives only if both ends find the network.
      const a = mk(sx, sy, sh, -1, r(G.min, G.max) * 1.2);
      const b = mk(sx, sy, sh + Math.PI, -1, r(G.min, G.max) * 1.2);

      a.pair = b;
      b.pair = a;
      tips.push(a, b);
    }

    for (let active = tips.length; active; ) {
      active = 0;

      for (const t of tips) {
        if (t.done) continue;
        const grain = TAU * fbm(t.x * 0.0065, t.y * 0.0065, 41 + g, 2) * 1.6;
        let d = grain - t.h;

        d = Math.atan2(Math.sin(d), Math.cos(d));
        t.h += d * (G.grain ?? 0.05) + t.turn + r(-G.wander, G.wander);

        // Homing: a tip senses a thread just ahead and bends to meet it (only the settled network, not siblings still growing).
        if (t.len > minRun) {
          let best: { da: number; dd: number } | null = null;

          for (const da of [-0.32, -0.16, 0, 0.16, 0.32]) {
            for (const dd of [6, 10, 14]) {
              const sq = idx(t.x + Math.cos(t.h + da) * dd, t.y + Math.sin(t.h + da) * dd);

              if (sq < 0) continue;
              const sv = cell(sq);

              if (sv >= 0 && sv !== t.src && (sv < fixed || alive.has(sv)) && (!best || dd < best.dd)) best = { da, dd };
            }
          }

          if (best) t.h += best.da * 0.45;
        }

        const nx = t.x + Math.cos(t.h) * step;
        const ny = t.y + Math.sin(t.h) * step;

        t.len += step;
        const q = idx(nx, ny);

        // Runs on past the section's cut.
        if (q === -2 && t.len > minRun) {
          t.pts.push([clamp(nx, X0, X1), clamp(ny, Y0, Y1)]);
          t.done = true;
          t.into = EDGE;
          continue;
        }

        if (q === -2 || o.blocked(nx, ny)) {
          t.done = true;
          continue;
        }

        const v = cell(q);

        // A tip runs free a little before it can fuse.
        if (v >= 0 && v !== t.id && t.len > minRun) {
          t.pts.push([nx, ny]);
          t.done = true;
          t.into = v;
          continue;
        }

        t.x = nx;
        t.y = ny;
        t.pts.push([nx, ny]);

        if (v < 0) {
          occ[q] = t.id;
          t.cells.push(q);
        }

        if (t.len >= t.max) {
          // Last reach: the nearest thread within a short hop, or nothing.
          t.done = true;
          let best: { dd: number; x: number; y: number; v: number } | null = null;

          for (let a = 0; a < 16; a++) {
            for (let dd = 4; dd <= 16; dd += 3) {
              const sx = t.x + Math.cos(t.h + (a - 8) * 0.2) * dd;
              const sy = t.y + Math.sin(t.h + (a - 8) * 0.2) * dd;
              const sq = idx(sx, sy);

              if (sq < 0) continue;
              const sv = cell(sq);

              if (sv >= 0 && sv !== t.id && sv !== t.src && (!best || dd < best.dd)) {
                best = { dd, x: sx, y: sy, v: sv };
                break;
              }
            }
          }

          if (best && !o.blocked((t.x + best.x) / 2, (t.y + best.y) / 2)) {
            t.pts.push([(t.x + best.x) / 2 + r(-1, 1), (t.y + best.y) / 2 + r(-1, 1)], [best.x, best.y]);
            t.into = best.v;
          }

          continue;
        }

        active++;
      }
    }

    // A thread lives if it fused into something alive; settle that until nothing changes.
    const byId = new Map(tips.map((t) => [t.id, t]));
    const live = new Set(tips.flatMap((t) => (t.into === -1 ? [] : [t.id])));

    for (let changed = true; changed; ) {
      changed = false;

      for (const id of live) {
        const t = byId.get(id);

        if (!t) continue;
        const v = t.into;

        if ((v < fixed || alive.has(v) || live.has(v)) && (!t.pair || live.has(t.pair.id))) continue;
        live.delete(id);
        changed = true;
      }
    }

    for (const t of tips) {
      if (live.has(t.id)) {
        alive.add(t.id);

        if (!t.pair) kept.push({ pts: t.pts, g });
        else if (t.id < t.pair.id) kept.push({ pts: [...t.pts].reverse().concat(t.pair.pts.slice(1)), g });
      } else {
        for (const q of t.cells) if (occ[q] === t.id) occ[q] = -1;
      }
    }

    // The next generation branches off this one.
    seeds = [];
    const B = o.gens[g + 1];

    if (B) {
      for (const t of tips) {
        if (!live.has(t.id)) continue;

        for (let i = 4; i < t.pts.length - 3; i += 2) {
          if (!r.chance(B.branch ?? 0)) continue;
          const [ax, ay] = t.pts[i - 1] ?? [0, 0];
          const [bx, by] = t.pts[i + 1] ?? [0, 0];
          const [px, py] = t.pts[i] ?? [0, 0];
          const dir = Math.atan2(by - ay, bx - ax);

          seeds.push([px, py, dir + (r.chance(0.5) ? 1 : -1) * r(0.5, 1.3), t.id]);
        }
      }

      seeds.push(...(B.free ?? []));
    }
  }

  return kept;
}

// ============================================================ THE WORLD =====

export interface Thread {
  pts: Pt[];
  w: number;
  a: number;
}

export interface Cord {
  strands: Pt[][];
  w: number;
  lift: number;
}

export interface RootKnot {
  x: number;
  y: number;
  rk: number;
  coils: Pt[][];
}

export interface Roots {
  threads: Thread[];
  cords: Cord[];
  taps: Pt[][][];
  knots: RootKnot[];
}

/** Grows the root system: about 200 ms of work, so the page runs it in a worker. */
export function grow(): Roots {
  const { nodes, edges } = repo();
  const soil = [62, GROUND + 14, 1538, PLATE.y1 - 6] as const;
  const paths = edges.map((e) => grownPath([e.from.x, e.from.y], [e.to.x, e.to.y], `${e.from.id}>${e.to.id}`, soil));

  const cords = edges.map((e, i) => {
    const tr = e.from.traffic;
    const n = 2 + Math.min(4, Math.round(Math.sqrt(tr) * 0.9));

    return {
      path: paths[i] ?? [],
      strands: braid(paths[i] ?? [], n, 1.6 + 1.05 * Math.sqrt(tr), `${e.from.id}>${e.to.id}`),
      w: 0.55 + 0.1 * Math.sqrt(tr),
      lift: Math.min(1, 0.55 + 0.12 * Math.sqrt(tr)),
    };
  });

  // Taproots: every deployable (apps/*, services/*) reaches up to the ground, where it ships.
  const taps: { path: Pt[]; strands: Pt[][] }[] = [];

  for (const n of nodes) {
    if (!/^(apps|services)\//.test(n.id)) continue;
    const r = stream("tap", n.id);

    // The root rises where it passes no other knot.
    const clear = (gx: number) =>
      nodes.every((m) => m === n || [0.2, 0.4, 0.6, 0.8].every((t) => Math.hypot(lerp(n.x, gx, t) - m.x, lerp(n.y, GROUND, t) - m.y) > m.rk + 14));

    const tries = [0, 8, -8, 16, -16, 24, -24, 32, -32, 44, -44].map((d) => n.x + d + r(-4, 4));
    const gx = tries.find(clear) ?? tries[0] ?? n.x;
    // A taproot rises nearly straight: a gentle sway, never a wander.
    const pts: Pt[] = [];
    const H = n.y - GROUND;
    const ph = r(0, TAU);
    const amp = r(3, 6);
    const steps = Math.ceil(H / 3);
    const sway = r(1.2, 1.3);

    for (let k = 0; k <= steps; k++) {
      const t = k / steps;

      pts.push([lerp(n.x, gx, smooth01(t)) + Math.sin(t * Math.PI * sway + ph) * amp * Math.sin(Math.PI * t), lerp(n.y, GROUND + 1, t)]);
    }

    const path = resample(pts, 3);

    taps.push({ path, strands: braid(path, 2, 1.6, `tap/${n.id}`) });
  }

  // Knots: tight coils of hyphae where cords meet.
  const knots = nodes.map((n) => {
    const r = stream("knot", n.id);
    const coils: Pt[][] = [];

    for (let k = 0; k < 24 + 7 * n.deg; k++) {
      const d = Math.abs(r.gauss()) * n.rk * 0.9;
      const a = r(0, TAU);
      const cx = n.x + Math.cos(a) * d;
      const cy = n.y + Math.sin(a) * d;
      const rr = r(1.2, 3.6);
      const a0 = r(0, TAU);
      const span = r(1.6, 4.2);
      const pts: Pt[] = [];

      for (let s = 0; s <= 8; s++) {
        const t = a0 + (span * s) / 8;

        pts.push([cx + Math.cos(t) * rr, cy + Math.sin(t) * rr * r(0.7, 1)]);
      }

      coils.push(pts);
    }

    return { x: n.x, y: n.y, rk: n.rk, coils };
  });

  // The mesh: hyphae grown out of every cord, every knot and the mark's floor, fused where they meet.
  const floor: Pt[] = [
    [MIDDLE - 30, GROUND + 6],
    [MIDDLE + 30, GROUND + 6],
  ];

  const groups = [...cords.map((c) => [...c.strands, c.path]), [floor], ...taps.map((t) => [...t.strands, t.path])];
  const discs = nodes.map((n): [number, number, number] => [n.x, n.y, n.rk + 1]);
  const inBox = (x: number, y: number, [x0, y0, x1, y1]: Knot["box"]) => x > x0 - 2 && x < x1 + 2 && y > y0 - 2 && y < y1 + 2;
  const blocked = (x: number, y: number) => nodes.some((n) => inBox(x, y, n.box));
  const rh = stream("hyphae-seeds");
  const seeds: Seed[] = [];

  const along = (p: Pt[], odds: number, id: number) => {
    for (let j = 3; j < p.length - 3; j += 1) {
      if (!rh.chance(odds)) continue;
      const [nx, ny] = normalAt(p, j);
      const side = rh.chance(0.5) ? 1 : -1;
      const [px, py] = p[j] ?? [0, 0];

      seeds.push([px + nx * side * 2, py + ny * side * 2, Math.atan2(ny * side, nx * side) + rh(-0.7, 0.7), id]);
    }
  };

  for (const [ei, c] of cords.entries()) along(c.path, 0.48, ei);

  for (const [ni, n] of nodes.entries()) {
    for (let k = 0; k < 6 + 2 * n.deg; k++) {
      const a = rh(0, TAU);

      seeds.push([n.x + Math.cos(a) * (n.rk + 1.5), n.y + Math.sin(a) * (n.rk + 1.5), a + rh(-0.3, 0.3), groups.length + ni]);
    }
  }

  for (let x = MIDDLE - 26; x < MIDDLE + 26; x += 3) if (rh.chance(0.5)) seeds.push([x, GROUND + 8, Math.PI / 2 + rh(-0.8, 0.8), cords.length]);

  for (const [ti, t] of taps.entries()) along(t.path, 0.4, cords.length + 1 + ti);

  // Free hyphae in the open soil, thicker where cords run close, thinning toward the deep and the edges.
  const hc = 20;
  const hg = new Map<string, Pt[]>();

  for (const c of cords) {
    for (let j = 0; j < c.path.length; j += 3) {
      const p = c.path[j];

      if (!p) continue;
      const k = `${Math.floor(p[0] / hc)},${Math.floor(p[1] / hc)}`;
      const list = hg.get(k) ?? [];

      list.push(p);
      hg.set(k, list);
    }
  }

  const cordDist = (x: number, y: number) => {
    let d = 1e9;
    const gx = Math.floor(x / hc);
    const gy = Math.floor(y / hc);

    for (let j = -5; j <= 5; j++) {
      for (let i = -5; i <= 5; i++) {
        for (const [px, py] of hg.get(`${gx + i},${gy + j}`) ?? []) d = Math.min(d, (px - x) ** 2 + (py - y) ** 2);
      }
    }

    return Math.sqrt(d);
  };

  const freeSeeds = (n: number) => {
    const out: Seed[] = [];

    for (let k = 0; out.length < n && k < n * 6; k++) {
      const x = rh(soil[0] + 6, soil[2] - 6);
      const y = rh(soil[1] + 4, soil[3] - 4);

      if (blocked(x, y)) continue;
      const d = cordDist(x, y);
      const surface = 1 - clamp((y - GROUND - 20) / 90, 0, 1);
      const deep = clamp((y - GROUND - 200) / 120, 0, 1);

      if (!rh.chance(clamp(0.4 + 0.6 * (1 - smooth01(clamp(d / 110, 0, 1))) + 0.4 * surface - 0.15 * deep, 0, 1))) continue;
      out.push([x, y, rh(0, TAU), -1]);
    }

    return out;
  };

  const hy = hyphae({
    bounds: [PLATE.x0 + 1, GROUND + 3, PLATE.x1 - 1, PLATE.y1 - 1],
    cell: 2.4,
    cords: groups,
    discs,
    seeds,
    seed: "hero",
    blocked,
    step: 2.2,
    minRun: 14,
    gens: [
      { min: 70, max: 300, wander: 0.08, grain: 0.03, free: freeSeeds(4200) },
      { branch: 0.2, min: 30, max: 170, wander: 0.09, grain: 0.03, free: freeSeeds(2400) },
      { branch: 0.18, min: 22, max: 110, wander: 0.11, free: freeSeeds(1600) },
      { branch: 0.16, min: 14, max: 70, wander: 0.13 },
      { branch: 0.14, min: 10, max: 44, wander: 0.15 },
    ],
  });

  const GW = [0.62, 0.52, 0.45, 0.4, 0.35];
  const GA = [0.62, 0.54, 0.47, 0.41, 0.35];

  const threads = hy.map((h) => {
    const [x, y] = h.pts[h.pts.length >> 1] ?? [0, 0];
    const band = fbm(x * 0.004, y * 0.004, 21, 3);
    const deep = clamp((y - GROUND - 60) / 260, 0, 1);

    return { pts: chaikin(h.pts, 1), w: GW[h.g] ?? 0.35, a: clamp((GA[h.g] ?? 0.35) * (1 - 0.3 * deep) + 0.1 * (band - 0.5), 0.1, 0.6) };
  });

  return { threads, cords: cords.map(({ strands, w, lift }) => ({ strands, w, lift })), taps: taps.map((t) => t.strands), knots };
}
