// Initials avatars (owner ruling): the name's first letter (two for a
// hyphenated name) on a tint of the name's hue. People are round; a monorepo
// is a rounded square, as GitHub shows an org. Made in the browser, no network.
import type { CSSProperties } from "react";

/** FNV-1a, then mixed: the prototype's hash, so a name keeps its colour. */
function hash(name: string): number {
  let h = 0x811c9dc5;

  for (const ch of name) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193);
  }

  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;

  return h >>> 0;
}

// Twelve oklch hues; Rust's reds (under 48, over 340) and Foxfire's band (112
// to 140) are left out, so no avatar reads as a failure or an arrival.
const HUES = [54, 72, 90, 144, 162, 189, 207, 225, 252, 270, 297, 315];

function letters(name: string): string {
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  const first = parts[0] ?? name;
  const second = parts[1];

  return (second ? `${first[0]}${second[0]}` : (first[0] ?? "?")).toUpperCase();
}

type Size = 16 | 18 | 20 | 22 | 28 | 36;

export function Avatar({ name, org = false, size }: { name: string; org?: boolean; size: Size }) {
  const text = letters(name);
  // SAFETY: React passes custom properties through style; CSSProperties has no index for "--" names.
  const style = { "--h": HUES[hash(name) % HUES.length], "--s": `${size}px` } as CSSProperties;

  return (
    <span
      aria-hidden="true"
      style={style}
      className={`relative inline-flex flex-none items-center justify-center overflow-hidden align-middle size-(--s) bg-[oklch(var(--av-fill-l)_var(--av-fill-c)_var(--h))] text-[color:oklch(var(--av-letter-l)_var(--av-letter-c)_var(--h))] font-semibold leading-none shadow-[inset_0_0_0_1px_var(--av-ring)] ${text.length > 1 ? "text-[length:calc(var(--s)*.36)]" : "text-[length:calc(var(--s)*.46)]"} ${org ? "rounded-[calc(var(--s)*.22)]" : "rounded-full"}`}
    >
      {text}
    </span>
  );
}
