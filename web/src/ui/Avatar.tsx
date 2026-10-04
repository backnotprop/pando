// Initials avatars (owner ruling): the name's first letter (two for a
// hyphenated name) on its slot's fill. The name's hash picks one of twelve
// slots, the same in every theme; each theme colours the slots from its own
// palette (avatars.css). People are round; a monorepo is a rounded square, as
// GitHub shows an org. Made in the browser, no network.
import type { CSSProperties } from "react";

/** FNV-1a, then mixed: the prototype's hash, so a name keeps its slot. */
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

/** The slots each theme colours (avatars.css: --av-0-fill to --av-11-letter). */
const SLOTS = 12;

function letters(name: string): string {
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  const first = parts[0] ?? name;
  const second = parts[1];

  return (second ? `${first[0]}${second[0]}` : (first[0] ?? "?")).toUpperCase();
}

type Size = 16 | 18 | 20 | 22 | 28 | 36;

export function Avatar({ name, org = false, size }: { name: string; org?: boolean; size: Size }) {
  const text = letters(name);
  const slot = hash(name) % SLOTS;
  // SAFETY: React passes custom properties through style; CSSProperties has no index for "--" names.
  const style = { "--fill": `var(--av-${slot}-fill)`, "--ink": `var(--av-${slot}-letter)`, "--s": `${size}px` } as CSSProperties;

  return (
    <span
      aria-hidden="true"
      data-slot={slot}
      style={style}
      className={`relative inline-flex flex-none items-center justify-center overflow-hidden align-middle size-(--s) bg-[var(--fill)] text-[color:var(--ink)] font-semibold leading-none shadow-[inset_0_0_0_1px_var(--av-ring)] ${text.length > 1 ? "text-[length:calc(var(--s)*.36)]" : "text-[length:calc(var(--s)*.46)]"} ${org ? "rounded-[calc(var(--s)*.22)]" : "rounded-full"}`}
    >
      {text}
    </span>
  );
}
