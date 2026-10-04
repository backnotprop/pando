// Issues' icons, drawn for Pando in the prototype's line (the mocks,
// research/design/pando-ui-2026-10-03/issues/mocks.html). States in words
// first, colour second: open is a ring in Bark, completed a check in
// Bark-dim, not planned a slash in Ash; never Foxfire's green or Rust's red.
import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement>;

const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const OpenIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <circle cx="8" cy="8" r="6.25" {...line} />
    <circle cx="8" cy="8" r="1.6" fill="currentColor" />
  </svg>
);

export const DoneIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g {...line}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.3 8.2l1.8 1.8 3.6-3.8" />
    </g>
  </svg>
);

export const NotPlannedIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g {...line}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M4.1 11.9l7.8-7.8" />
    </g>
  </svg>
);

export const ReopenIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g {...line}>
      <path d="M13.5 8A5.5 5.5 0 1 1 11.6 3.8" />
      <path d="M11.8 1.6v2.6H9.2" />
    </g>
  </svg>
);

export const TagIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M2.5 3.5v4.1l6.4 6.4 5.1-5.1-6.4-6.4H3.5a1 1 0 0 0-1 1z" />
      <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
    </g>
  </svg>
);

export const PersonIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="5.5" r="2.7" />
      <path d="M2.8 13.8c.8-2.6 2.8-4 5.2-4s4.4 1.4 5.2 4" />
    </g>
  </svg>
);

export const GearIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
    </g>
  </svg>
);

export const DotsIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="currentColor">
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </g>
  </svg>
);

export const SearchIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g {...line}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.4 10.4l3.1 3.1" />
    </g>
  </svg>
);

export const MergeIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="10.5" r="1.6" />
      <path d="M4.5 5.1v5.8M5.6 4.7c1 2.8 2.8 5 4.3 5.6" />
    </g>
  </svg>
);

export const PenIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2z" />
  </svg>
);

/** Add a reaction. */
export const SmileIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M5.6 9.6c.6.9 1.4 1.3 2.4 1.3s1.8-.4 2.4-1.3" />
    </g>
    <circle cx="6" cy="6.6" r=".9" fill="currentColor" />
    <circle cx="10" cy="6.6" r=".9" fill="currentColor" />
  </svg>
);

/** An issue's state glyph, coloured by its state: open, completed or not planned. */
export function StateGlyph({ state, reason, className = "size-4" }: { state: "open" | "closed"; reason: "completed" | "not_planned" | null; className?: string }) {
  if (state === "open") return <OpenIcon className={`${className} flex-none text-bark`} />;

  if (reason === "not_planned") return <NotPlannedIcon className={`${className} flex-none text-ash`} />;

  return <DoneIcon className={`${className} flex-none text-bark-dim`} />;
}
