// The living leaf's acting. Each state is written as targets per moment (a
// pose: a flat set of numbers the rig reads, rig.ts), then every channel
// follows its target through a damped spring, stepped at a fixed 240 Hz and
// baked once per state into a loop table. The springs give the fluid,
// overlapping motion: the body follows its targets, the blade follows a beat
// later and overshoots, the stem later still, while the eyes lead. The
// aspen's tremble rides on top. States: idle (a faint tremble on a breeze, a
// breath, a blink, a glance), thinking (a tilt, eyes up and aside, a lazy
// sway, two taps of the stem), working (a steady beat once a second, the
// blade flexing after each, eyes on the work, the mouth going), done (a long
// wind-up, a hop with a full turn, a soft landing, a satisfied loop) and needs
// (turned to the camera, eyes wide, one gentle hop, the Gold badge pulsing
// slowly). Every pose is a function of time alone, so loops are exact.
import { blink, bump, clamp, ease, mix, ramp, sway, wave } from "./motion";

export type LeafState = "idle" | "thinking" | "working" | "done" | "needs";

export type LeafTone = "quiet" | "rust";

export interface Pose {
  /** Body offset from its spot, in blade radii; y is height above the ground. */
  x: number;
  y: number;
  /** Squash and stretch about the ground: 1 at rest, under 1 squashed. Width keeps the volume. */
  sq: number;
  /** Turns at the stem joint, in radians: lean is a roll (+ to the left), pitch a nod (+ toward the camera), yaw a turn about the stem. */
  lean: number;
  pitch: number;
  yaw: number;
  /** The blade's own flex: twist (tip against base), bend (curl along its length), cup (curl across). */
  twist: number;
  bend: number;
  cup: number;
  /** The stem's curvature: higher curls the tip further to the left and up. */
  curl: number;
  /** The face: gaze (-1 to 1 each way), blink and resting lid (0 open, 1 shut), squint (the happy arcs), eye size, mouth (0 shut, 1 open). */
  gx: number;
  gy: number;
  blink: number;
  lid: number;
  squint: number;
  wide: number;
  mouth: number;
  /** The Gold "needs you" badge, 0 hidden to 1 shown (above 1 is a pulse). */
  badge: number;
}

const REST: Pose = {
  x: 0,
  y: 0,
  sq: 1,
  lean: 0,
  pitch: 0,
  yaw: -0.2,
  twist: 0,
  bend: 0.05,
  cup: 0.1,
  curl: 1.5,
  gx: 0,
  gy: 0,
  blink: 0,
  lid: 0.12,
  squint: 0,
  wide: 1,
  mouth: 0,
  badge: 0,
};

// SAFETY: REST is a Pose literal with no other keys, so its own keys are Pose's keys.
const KEYS = Object.keys(REST) as (keyof Pose)[];

/**
 * Each channel's spring: its natural frequency in Hz and its damping (1 settles without overshoot).
 * Low and well damped, as the reference rig's; softer down the chain so each part lags the one before.
 * Blinks have none: they stay crisp.
 */
const SPRINGS: Record<keyof Pose, readonly [number, number] | null> = {
  x: [2.4, 0.8],
  y: [2.6, 0.75],
  sq: [2.8, 0.6],
  lean: [1.8, 0.75],
  pitch: [2, 0.7],
  yaw: [1.8, 0.75],
  twist: [1.5, 0.5],
  bend: [1.5, 0.45],
  cup: [1.6, 0.6],
  curl: [1.2, 0.5],
  gx: [4.5, 0.85],
  gy: [4.5, 0.85],
  blink: null,
  lid: [5, 0.9],
  squint: [3.5, 0.85],
  wide: [2.5, 0.8],
  mouth: [6, 0.7],
  badge: [1.2, 0.85],
};

interface Acting {
  /** One pass, in seconds; done's first pass is its flourish, then it loops from `hold`. */
  period: number;
  hold: number;
  /** A moment that says the state on its own: the still under reduced motion. */
  still: number;
  target: (t: number) => Pose;
  /** How strongly the aspen trembles at t. */
  shake: (t: number) => number;
}

// ------------------------------------------------------------------- idle --

const gust = (t: number) => bump(t, 0.4, 1.2, 1.7, 2.5, ease.glide) + 0.7 * bump(t, 3.2, 3.7, 4.0, 4.8, ease.glide);

const idle: Acting = {
  period: 5,
  hold: 0,
  still: 0.5,
  shake: (t) => 0.2 + 0.45 * gust(t),
  target: (t) => {
    const p = { ...REST };
    const breath = wave(t, 5, 2) + 0.3 * wave(t, 5, 4, 0.2);
    // A glance aside: the eyes get there first (their spring is quick), the body after.
    const look = bump(t, 2.5, 2.75, 3.4, 3.85, ease.glide);

    p.sq += 0.008 * breath;
    p.cup += 0.017 * breath;
    p.lean += 0.016 * sway(t, 5, 1, 0.1) + 0.012 * gust(t) - 0.027 * look;
    p.gx = 0.5 * look;
    p.gy = 0.13 * look;
    p.yaw += 0.12 * look;
    p.blink = blink(t, [1.4, 3.5]);

    return p;
  },
};

// --------------------------------------------------------------- thinking --

/** A tap of the stem at t0: the tip lifts slowly, comes down, the body takes the contact. */
function tap(p: Pose, t: number, t0: number) {
  p.curl += 0.75 * bump(t, t0 - 0.32, t0 - 0.12, t0 - 0.1, t0, ease.inn);
  p.sq -= 0.02 * bump(t, t0, t0 + 0.06, t0 + 0.06, t0 + 0.35, ease.glide);
  p.pitch += 0.02 * bump(t, t0 - 0.15, t0, t0, t0 + 0.4, ease.glide);
}

const thinking: Acting = {
  period: 5,
  hold: 0,
  still: 0.4,
  shake: () => 0.2,
  target: (t) => {
    const p = { ...REST };

    p.lean = 0.11 + 0.027 * sway(t, 5, 1);
    p.yaw += 0.065 * sway(t, 5, 1, 0.25);
    p.x = 0.02 * sway(t, 5, 1);
    p.sq += 0.007 * wave(t, 5, 3);
    p.gx = -0.5 + 0.08 * sway(t, 5, 1, 0.3);
    p.gy = 0.6;
    p.lid = 0.05;
    p.cup = 0.12;
    tap(p, t, 1.2);
    tap(p, t, 1.58);
    p.blink = blink(t, [3.4]);

    return p;
  },
};

// ---------------------------------------------------------------- working --

/** One beat a second, five to a loop, each a little different; the mouth says something on each. */
const BEAT = 1;

const HEIGHTS = [1, 0.85, 1, 0.9, 0.95];

const SAYS = [0.9, 0.5, 1, 0.6, 0.75];

const HIT = 0.8;

/** The weight of a hit, dh seconds after it: a quick press, then a long release. */
const press = (dh: number) => (dh < 0.06 ? ease.glide(dh / 0.06) : Math.exp(-(dh - 0.06) / 0.16));

const working: Acting = {
  period: 5,
  hold: 0,
  still: 0.3,
  shake: () => 0.18,
  target: (t) => {
    const p = { ...REST };
    const i = Math.floor(t / BEAT) % 5;
    const u = (t % BEAT) / BEAT;
    const a = HEIGHTS[i] ?? 1;
    // A long rise (the anticipation), a short, eased fall, the hit at 0.8 of the beat.
    const h = u < 0.55 ? ease.glide(u / 0.55) : u < HIT ? 1 - ease.inn((u - 0.55) / (HIT - 0.55)) : 0;
    const hit = press((u - HIT + 1) % 1);
    const side = i % 2 ? 1 : -1;

    p.y = 0.035 * h * a;
    p.sq = 1 + 0.03 * h * a - 0.045 * hit;
    p.pitch = 0.06 - 0.05 * h + 0.07 * hit;
    p.bend = 0.05 - 0.09 * hit;
    p.twist = 0.04 * side * h;
    p.lean = 0.03 * sway(t, 5, 1);
    p.yaw = -0.12;
    p.gx = 0.25 + 0.04 * side * h;
    p.gy = -0.45;
    p.lid = 0.14;
    p.mouth = (SAYS[i] ?? 0) * bump(u, 0.08, 0.3, 0.5, 0.78, ease.glide);
    p.blink = blink(t, [2.4]);

    return p;
  },
};

// ------------------------------------------------------------------- done --

/** Done's flourish runs to about 2.4 s and lands in a satisfied loop from DONE_HOLD. */
const DONE_HOLD = 2.5;

const done: Acting = {
  period: DONE_HOLD + 2.5,
  hold: DONE_HOLD,
  still: 2.8,
  shake: () => 0.17,
  target: (t) => {
    const p = { ...REST };
    const h = t - DONE_HOLD;
    // The satisfied pose, faded in as the landing settles: a small proud lean, chin up, happy eyes, a slow breath.
    const pleased = ramp(t, 1.5, 2.4, ease.glide);
    // The full turn. Its yaw stays a whole turn on after it, so the springs never unwind it; the rig reads it modulo a turn.
    const spin = ramp(t, 0.66, 1.42, ease.glide);
    const crouch = bump(t, 0, 0.55, 0.55, 0.68, ease.glide);
    const air = clamp((t - 0.62) / 0.85);

    p.lean += 0.047 * pleased + 0.01 * sway(h, 2.5, 1) * pleased;
    p.pitch = -0.047 * pleased + 0.08 * crouch - 0.05 * bump(t, 0.7, 0.9, 1.1, 1.4, ease.glide);
    p.yaw = mix(-0.2, -0.08, pleased) + Math.PI * 2 * spin;
    p.sq += 0.008 * wave(h, 2.5, 1, 0.2) - 0.09 * crouch - 0.07 * bump(t, 1.45, 1.52, 1.52, 1.95, ease.glide);
    p.sq += air > 0 && air < 1 ? 0.06 * Math.abs(2 * air - 1) : 0;
    p.y = 0.42 * 4 * air * (1 - air);
    p.twist = -0.2 * Math.sin(Math.PI * spin);
    p.curl += 0.75 * bump(t, 0.7, 0.9, 1.2, 1.45, ease.glide);
    p.bend += -0.07 * bump(t, 0.62, 0.8, 0.9, 1.2, ease.glide);
    p.squint = ramp(t, 1.45, 1.8, ease.glide);
    p.lid = 0.05;
    p.blink = Math.max(0.85 * bump(t, 0.1, 0.4, 0.5, 0.66, ease.glide), blink(t, [1.25]));

    return p;
  },
};

// ------------------------------------------------------------------ needs --

const needs: Acting = {
  period: 5,
  hold: 0,
  still: 2,
  shake: () => 0.25,
  target: (t) => {
    const p = { ...REST };
    // One gentle hop: a slow crouch, a low arc, a soft landing.
    const air = (t - 0.45) / 0.4;

    p.yaw = 0.015 * sway(t, 5, 1);
    p.pitch = -0.05;
    p.lean = 0.022 * sway(t, 5, 1, 0.2);
    p.wide = 1.2;
    p.lid = 0;
    p.gy = 0.06;
    p.sq += 0.008 * wave(t, 5, 2) - 0.05 * bump(t, 0.15, 0.42, 0.42, 0.5, ease.glide) - 0.05 * bump(t, 0.83, 0.9, 0.9, 1.25, ease.glide);

    if (air > 0 && air < 1) {
      p.y = 0.09 * 4 * air * (1 - air);
      p.sq += 0.025 * Math.abs(2 * air - 1);
    }

    // The badge pulses slowly, twice a loop.
    p.badge = 1 + 0.08 * wave(t, 5, 2, -0.25);
    p.blink = blink(t, [2.6]);

    return p;
  },
};

// ---------------------------------------------------------------- springs --

const HZ = 240;

/** The aspen's flutter on its flat stem: a fast twist and turn, k whole cycles per loop so it loops. */
function flutter(p: Pose, t: number, period: number, amount: number) {
  const k = (hz: number) => Math.round(hz * period);

  p.twist += amount * (0.1 * wave(t, period, k(5.3)) + 0.045 * wave(t, period, k(7.9), 0.3));
  p.yaw += amount * (0.04 * wave(t, period, k(4.1), 0.6) + 0.018 * wave(t, period, k(6.7), 0.1));
  p.lean += amount * 0.012 * wave(t, period, k(3.2), 0.45);
}

interface Baked {
  /** The first pass (only for a state that loops from a hold). */
  first: Float32Array | null;
  /** One loop, in its steady state. */
  loop: Float32Array;
}

/** Runs the springs from t = 0 through the first pass and three loops, and keeps the first pass and the last loop. */
function bake(a: Acting): Baked {
  const n = KEYS.length;
  const loopLen = a.period - a.hold;
  const firstSteps = Math.round(a.period * HZ);
  const loopSteps = Math.round(loopLen * HZ);
  const total = firstSteps + 3 * loopSteps;
  const first = a.hold > 0 ? new Float32Array((firstSteps + 1) * n) : null;
  const loop = new Float32Array((loopSteps + 1) * n);
  const start = a.target(0);
  const pos = KEYS.map((k) => start[k]);
  const vel = KEYS.map(() => 0);
  const dt = 1 / HZ;

  for (let s = 0; s <= total; s++) {
    const t = s * dt;
    const local = t < a.period ? t : a.hold + ((t - a.hold) % loopLen);
    const target = a.target(local);

    KEYS.forEach((k, j) => {
      const spring = SPRINGS[k];

      if (!spring) {
        pos[j] = target[k];

        return;
      }

      const w = 2 * Math.PI * spring[0];
      const acc = w * w * (target[k] - (pos[j] ?? 0)) - 2 * spring[1] * w * (vel[j] ?? 0);

      vel[j] = (vel[j] ?? 0) + acc * dt;
      pos[j] = (pos[j] ?? 0) + (vel[j] ?? 0) * dt;
    });

    if (first && s <= firstSteps) first.set(pos, s * n);

    if (s >= total - loopSteps) loop.set(pos, (s - (total - loopSteps)) * n);
  }

  return { first, loop };
}

function read(table: Float32Array, t: number): Pose {
  const n = KEYS.length;
  const rows = table.length / n - 1;
  const x = clamp(t * HZ, 0, rows);
  const i = Math.min(rows - 1, Math.floor(x));
  const f = x - i;
  const p = { ...REST };

  KEYS.forEach((k, j) => {
    p[k] = mix(table[i * n + j] ?? 0, table[(i + 1) * n + j] ?? 0, f);
  });

  return p;
}

export interface StateSpec {
  period: number;
  hold: number;
  still: number;
  /** The pose at time t since the state began: the first pass, then the loop. */
  pose: (t: number) => Pose;
}

function spec(a: Acting): StateSpec {
  let baked: Baked | null = null;
  const loopLen = a.period - a.hold;

  return {
    period: a.period,
    hold: a.hold,
    still: a.still,
    pose: (t) => {
      baked ??= bake(a);
      const local = t < a.period ? t : a.hold + ((t - a.hold) % loopLen);
      const p = baked.first && t < a.period ? read(baked.first, t) : read(baked.loop, local - a.hold);

      flutter(p, local, loopLen, a.shake(local));
      // The full turn of done leaves its yaw a turn on: read it back near zero.
      p.yaw = Math.atan2(Math.sin(p.yaw), Math.cos(p.yaw));

      return p;
    },
  };
}

export const STATES: Record<LeafState, StateSpec> = {
  idle: spec(idle),
  thinking: spec(thinking),
  working: spec(working),
  done: spec(done),
  needs: spec(needs),
};

export function mixPose(a: Pose, b: Pose, p: number): Pose {
  const out = { ...a };

  for (const k of KEYS) out[k] = mix(a[k], b[k], p);

  return out;
}

/** How long a change of state takes. */
export const BLEND = 0.7;

/** The beat on a change of state: a small dip before, a small lift after. */
export function kick(p: Pose, since: number) {
  p.sq += -0.025 * bump(since, 0, 0.18, 0.18, 0.42, ease.glide) + 0.015 * bump(since, 0.36, 0.55, 0.55, 0.9, ease.glide);
}

/** The one-colour tones hold still: a stopped leaf dozes, a failed one droops. */
export function toned(p: Pose, tone: LeafTone): Pose {
  const out = { ...p, blink: 0, mouth: 0, badge: 0, squint: 0, wide: 1 };

  if (tone === "quiet") return { ...out, lid: 0.55, pitch: 0.06, lean: 0.05, gy: -0.2, gx: 0 };

  return { ...out, lid: 0.32, pitch: 0.16, lean: -0.1, bend: 0.16, curl: 2.1, gy: -0.5, gx: 0.1, sq: 0.97 };
}
