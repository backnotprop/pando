// The living leaf's acting: each state is a short loop written as a pose per
// moment. A pose is a flat set of numbers the rig reads (rig.ts). States:
// idle (the quaking tremble, a breath, a blink, a glance), thinking (a tilt,
// eyes up and aside, a slow sway, two taps of the stem), working (a brisk beat
// with weight, the blade flexing, eyes on the work, the mouth going), done (a
// crouch, a hop with a full turn, a landing that settles into a satisfied
// still) and needs (turned to the camera, eyes wide, two small hops, the Gold
// badge). Every pose is a function of time alone, so loops are exact.
import { blink, bump, clamp, ease, mix, ramp, settle, wave } from "./motion";

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
  /** The face: gaze (-1 to 1 each way), blink and resting lid (0 open, 1 shut), squint (lower lids up: happy), eye size, mouth (0 shut, 1 open). */
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

/** The aspen's flutter on its flat stem: a fast twist and turn, k whole cycles per loop so it loops. */
function flutter(p: Pose, t: number, period: number, amount: number) {
  const k = (hz: number) => Math.round(hz * period);

  p.twist += amount * (0.1 * wave(t, period, k(5.3)) + 0.045 * wave(t, period, k(7.9), 0.3));
  p.yaw += amount * (0.04 * wave(t, period, k(4.1), 0.6) + 0.018 * wave(t, period, k(6.7), 0.1));
  p.lean += amount * 0.012 * wave(t, period, k(3.2), 0.45);
}

function idle(t: number): Pose {
  const p = { ...REST };
  // A breeze comes and goes twice a loop; the tremble rides it.
  const gust = 0.3 + 0.7 * (bump(t, 0.6, 1.3, 2.0, 2.9) + 0.7 * bump(t, 3.9, 4.4, 4.8, 5.7));

  flutter(p, t, 6, gust);
  p.sq += 0.012 * wave(t, 6, 2);
  p.cup += 0.025 * wave(t, 6, 2, 0.1);
  p.lean += 0.022 * wave(t, 6, 1, 0.1) + 0.02 * gust;
  // A glance aside: the eyes lead, the body follows a beat later and comes back.
  const look = bump(t, 3.0, 3.16, 4.0, 4.22);
  const follow = bump(t, 3.08, 3.5, 4.05, 4.55);

  p.gx = 0.75 * look;
  p.gy = 0.2 * look;
  p.yaw += 0.18 * follow;
  p.lean -= 0.04 * follow;
  p.blink = blink(t, [1.7, 4.12]);

  return p;
}

/** A tap of the stem at t0: the tip lifts, comes down, and the body takes the contact. */
function tap(p: Pose, t: number, t0: number) {
  p.curl += 1.1 * bump(t, t0 - 0.2, t0 - 0.08, t0 - 0.06, t0, ease.inn);
  p.sq -= 0.03 * Math.max(0, settle(t, t0, 5, 9));
  p.pitch += 0.03 * bump(t, t0 - 0.1, t0, t0, t0 + 0.2);
}

function thinking(t: number): Pose {
  const p = { ...REST };

  flutter(p, t, 4, 0.3);
  p.lean = 0.17 + 0.04 * wave(t, 4, 1);
  p.yaw += 0.1 * wave(t, 4, 1, 0.25);
  p.x = 0.03 * wave(t, 4, 1);
  p.sq += 0.01 * wave(t, 4, 2);
  p.gx = -0.6 + 0.12 * wave(t, 4, 1, 0.3);
  p.gy = 0.75;
  p.lid = 0.04;
  p.cup = 0.13;
  tap(p, t, 0.95);
  tap(p, t, 1.28);
  p.blink = blink(t, [2.6]);

  return p;
}

const BEAT = 0.5;

const SAYS = [0.9, 0.45, 1, 0.4, 0.8, 0.6];

function working(t: number): Pose {
  const p = { ...REST };
  const i = Math.floor(t / BEAT) % 6;
  const u = (t % BEAT) / BEAT;
  // The last beat of six lands harder: a little accent in the rhythm.
  const accent = i === 5 ? 1.3 : 1;
  // Up on an ease out, down on an ease in (it falls), the hit at 0.7 of the beat.
  const h = u < 0.5 ? ease.out(u / 0.5) : u < 0.7 ? 1 - ease.inn((u - 0.5) / 0.2) : 0;
  const hit = t - (t % BEAT) + 0.7 * BEAT;
  const s = settle(t, hit, 6, 10) + settle(t, hit - BEAT, 6, 10);
  const side = i % 2 ? 1 : -1;

  flutter(p, t, 3, 0.25);
  p.y = 0.06 * h * accent;
  p.sq = 1 + 0.05 * h * accent - 0.08 * s * accent;
  p.pitch = 0.08 - 0.08 * h + 0.12 * Math.max(0, s) * accent;
  p.bend = 0.05 - 0.2 * settle(t, hit + 0.04, 4, 7) - 0.2 * settle(t, hit + 0.04 - BEAT, 4, 7);
  p.twist += 0.07 * side * h;
  p.lean = 0.05 * wave(t, 3, 3);
  p.yaw = -0.12;
  p.gx = 0.25 + 0.06 * side * h;
  p.gy = -0.45;
  p.lid = 0.14;
  p.mouth = (SAYS[i] ?? 0) * bump(u, 0.04, 0.22, 0.42, 0.68);
  p.blink = blink(t, [2.27]);

  return p;
}

/** Done is a flourish (0 to about 1.9 s) that lands in a satisfied pose, then loops from DONE_HOLD. */
const DONE_HOLD = 2;

function done(t: number): Pose {
  const p = { ...REST };
  const h = Math.max(0, t - DONE_HOLD);
  // The satisfied pose, faded in as the landing settles: a small proud lean, chin up, happy eyes.
  const pleased = ramp(t, 1.15, 1.9);

  flutter(p, t, 3, 0.25);
  p.lean += 0.07 * pleased + 0.015 * wave(h, 3, 1) * pleased;
  p.pitch = -0.07 * pleased;
  p.yaw = mix(-0.2, -0.08, pleased);
  p.sq += 0.012 * wave(h, 3, 1, 0.2) * pleased;
  p.squint = ramp(t, 1.12, 1.4);
  p.lid = 0.05;

  if (t >= DONE_HOLD) return p;

  // The flourish: a crouch, a hop with a full turn on the stem, a landing.
  const crouch = bump(t, 0, 0.3, 0.3, 0.42, ease.out);
  const air = clamp((t - 0.36) / 0.82);
  const spin = ramp(t, 0.38, 1.08, ease.io);
  const land = settle(t, 1.18, 3.5, 5.5);

  p.y = 0.62 * 4 * air * (1 - air);
  p.sq += -0.12 * crouch + (air > 0 && air < 1 ? 0.12 * Math.abs(2 * air - 1) : 0) - 0.16 * Math.max(0, land) + 0.05 * Math.min(0, land);
  p.yaw += spin < 1 ? Math.PI * 2 * spin : 0;
  p.twist += -0.35 * Math.sin(Math.PI * spin) + 0.16 * settle(t, 1.18, 4, 5);
  p.curl += 1.1 * bump(t, 0.4, 0.6, 0.95, 1.16);
  p.pitch += 0.12 * crouch - 0.08 * bump(t, 0.42, 0.6, 0.9, 1.1) + 0.07 * Math.max(0, land);
  p.bend += -0.1 * bump(t, 0.36, 0.5, 0.6, 0.9) + 0.08 * Math.max(0, land);
  p.blink = Math.max(0.85 * bump(t, 0.05, 0.22, 0.34, 0.46), blink(t, [1.0]));

  return p;
}

/** A small hop at t0: anticipation, an arc, a stretch in flight and a squash on landing. */
function hop(p: Pose, t: number, t0: number) {
  const air = (t - t0) / 0.3;

  p.sq -= 0.08 * bump(t, t0 - 0.1, t0 - 0.02, t0 - 0.02, t0 + 0.02);

  if (air > 0 && air < 1) {
    p.y += 0.16 * 4 * air * (1 - air);
    p.sq += 0.06 * Math.abs(2 * air - 1);
  }

  p.sq -= 0.09 * Math.max(0, settle(t, t0 + 0.3, 5, 9));
  p.badge += 0.2 * bump(t, t0 + 0.28, t0 + 0.36, t0 + 0.36, t0 + 0.6);
}

function needs(t: number): Pose {
  const p = { ...REST };

  flutter(p, t, 3, 0.35);
  p.yaw = 0.02 * wave(t, 3, 1);
  p.pitch = -0.06;
  p.lean = 0.03 * wave(t, 3, 1, 0.2);
  p.wide = 1.22;
  p.lid = 0;
  p.gy = 0.08;
  p.badge = 1;
  hop(p, t, 0.12);
  hop(p, t, 0.52);
  p.blink = blink(t, [2.05]);

  return p;
}

export interface StateSpec {
  /** One loop, in seconds. */
  period: number;
  /** Where the loop restarts after the first pass (done plays its flourish once). */
  hold: number;
  /** A moment that says the state on its own: the still under reduced motion. */
  still: number;
  pose: (t: number) => Pose;
}

export const STATES: Record<LeafState, StateSpec> = {
  idle: { period: 6, hold: 0, still: 0.5, pose: idle },
  thinking: { period: 4, hold: 0, still: 0.3, pose: thinking },
  working: { period: 3, hold: 0, still: 0.15, pose: working },
  done: { period: 5, hold: DONE_HOLD, still: 2.5, pose: done },
  needs: { period: 3, hold: 0, still: 1.5, pose: needs },
};

/** A state's own time for time since it began: the first pass whole, then looping from its hold. */
export function loopTime(state: LeafState, t: number) {
  const s = STATES[state];

  if (t < s.period) return t;

  return s.hold + ((t - s.hold) % (s.period - s.hold));
}

export function mixPose(a: Pose, b: Pose, p: number): Pose {
  const out = { ...a };

  for (const k of KEYS) out[k] = mix(a[k], b[k], p);

  return out;
}

/** How long a change of state takes. */
export const BLEND = 0.45;

/** The beat on a change of state: a small dip before, a small lift after. */
export function kick(p: Pose, since: number) {
  p.sq += -0.05 * bump(since, 0, 0.12, 0.12, 0.3) + 0.03 * bump(since, 0.28, 0.42, 0.42, 0.62);
}

/** The one-colour tones hold still: a stopped leaf dozes, a failed one droops. */
export function toned(p: Pose, tone: LeafTone): Pose {
  const out = { ...p, blink: 0, mouth: 0, badge: 0, squint: 0, wide: 1 };

  if (tone === "quiet") return { ...out, lid: 0.55, pitch: 0.06, lean: 0.05, gy: -0.2, gx: 0 };

  return { ...out, lid: 0.32, pitch: 0.16, lean: -0.1, bend: 0.16, curl: 2.1, gy: -0.5, gx: 0.1, sq: 0.97 };
}
