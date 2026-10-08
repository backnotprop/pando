// The living leaf's motion kit: easings, holds and bumps, blinks and settles.
// Every value is a pure function of time in seconds: no clocks, no randomness,
// so a loop repeats exactly and any frame can be drawn in any order.

export const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

export const mix = (a: number, b: number, p: number) => a + (b - a) * p;

const TAU = Math.PI * 2;

/** Easings. `inn` accelerates (a fall), `out` decelerates (a rise), `back` overshoots. */
export const ease = {
  smooth: (x: number) => {
    const c = clamp(x);

    return c * c * c * (c * (c * 6 - 15) + 10);
  },
  io: (x: number) => {
    const c = clamp(x);

    return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
  },
  /** Leaves gently and arrives on a long tail: never symmetric, never linear. */
  glide: (x: number) => 1 - (1 - clamp(x) ** 1.6) ** 2.6,
  inn: (x: number) => clamp(x) ** 2,
  out: (x: number) => 1 - (1 - clamp(x)) ** 3,
  back: (x: number) => {
    const c = clamp(x);
    const k = 1.7;

    return 1 + (k + 1) * (c - 1) ** 3 + k * (c - 1) ** 2;
  },
};

type Ease = (x: number) => number;

/** 0 before a, rises to 1 by b, holds to c, falls back to 0 by d. */
export function bump(t: number, a: number, b: number, c: number, d: number, e: Ease = ease.smooth) {
  if (t <= a || t >= d) return 0;

  if (t < b) return e((t - a) / (b - a));

  return t <= c ? 1 : 1 - e((t - c) / (d - c));
}

/** 0 before a, 1 after b. */
export const ramp = (t: number, a: number, b: number, e: Ease = ease.smooth) => e((t - a) / (b - a));

/** A loop-safe wave: k whole cycles per period p. */
export const wave = (t: number, p: number, k: number, phase = 0) => Math.sin(TAU * ((k * t) / p + phase));

/** A lazy sway: a wave with its second harmonic, so it lingers at one side and swings through the other. */
export const sway = (t: number, p: number, k: number, phase = 0) => 0.85 * wave(t, p, k, phase) + 0.22 * wave(t, p, 2 * k, phase + 0.15);

/** A blink centred on each time: a fast close, a frame shut, a slower open. */
export function blink(t: number, times: readonly number[]) {
  let c = 0;

  for (const b of times) {
    const x = t - b;

    if (x < -0.07 || x > 0.2) continue;

    const v = x < 0 ? ease.inn(1 + x / 0.07) : x < 0.03 ? 1 : 1 - ease.out((x - 0.03) / 0.17);

    c = Math.max(c, v);
  }

  return c;
}
