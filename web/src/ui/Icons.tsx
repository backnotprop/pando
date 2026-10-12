// The prototype's icons. File and chevron are Pierre's (@pierre/trees, Apache
// 2.0, unchanged); folder, repo and the quiet links' icons were drawn for Pando.
import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement>;

export const MARK =
  "M1 56.5 H58 L62.05 52 H52.45 A3.2 3.2 0 0 1 49.25 48.8 V24 L42.75 29.2 V48.8 A3.2 3.2 0 0 1 39.55 52 H37.95 A3.2 3.2 0 0 1 34.75 48.8 V5 L28.25 10.2 V48.8 A3.2 3.2 0 0 1 25.05 52 H23.45 A3.2 3.2 0 0 1 20.25 48.8 V16 L13.75 21.2 V48.8 A3.2 3.2 0 0 1 10.55 52 H5.05Z";

export const Mark = (p: Props) => (
  <svg width="20" height="20" viewBox="0 2 64 64" aria-hidden="true" {...p}>
    <path d={MARK} fill="currentColor" />
  </svg>
);

/** The chosen row in a menu. */
export const CheckIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Chevron = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <path
      fill="currentColor"
      d="M12.4697 5.46973C12.7626 5.17684 13.2374 5.17684 13.5303 5.46973C13.8232 5.76262 13.8232 6.23738 13.5303 6.53028L8.53028 11.5303C8.23738 11.8232 7.76262 11.8232 7.46973 11.5303L2.46973 6.53028C2.17684 6.23738 2.17684 5.76262 2.46973 5.46973C2.76262 5.17684 3.23738 5.17684 3.53028 5.46973L8 9.93946L12.4697 5.46973Z"
    />
  </svg>
);

export const FileIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <path fill="currentColor" opacity=".5" d="M8 1v3a3 3 0 0 0 3 3h3v5.5a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 12.5v-9A2.5 2.5 0 0 1 4.5 1z" />
    <path fill="currentColor" d="M9.5 1a.5.5 0 0 1 .354.146l4 4A.5.5 0 0 1 14 5.5V6h-3a2 2 0 0 1-2-2V1z" />
  </svg>
);

export const FolderIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <path
      fill="currentColor"
      opacity=".6"
      d="M1.75 4.25A1.75 1.75 0 0 1 3.5 2.5h2.55c.47 0 .91.19 1.24.51l.83.83c.14.14.33.22.53.22h3.85a1.75 1.75 0 0 1 1.75 1.75v6.44a1.75 1.75 0 0 1-1.75 1.75H3.5a1.75 1.75 0 0 1-1.75-1.75z"
    />
  </svg>
);

export const RepoIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <path
      fill="currentColor"
      d="M1.75 4.25A1.75 1.75 0 0 1 3.5 2.5h2.55c.47 0 .91.19 1.24.51l.83.83c.14.14.33.22.53.22h3.85a1.75 1.75 0 0 1 1.75 1.75v6.44a1.75 1.75 0 0 1-1.75 1.75H3.5a1.75 1.75 0 0 1-1.75-1.75z"
    />
    <path fill="var(--soil)" d="M5.5 11.5V8.2l1.2-.9v4.2zM7.4 11.5V6.7l1.2-.9v5.7zM9.3 11.5V7.7l1.2-.9v4.7z" />
  </svg>
);

export const BookIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M2.5 3.2c1.9-.6 3.8-.4 5.5.9v9c-1.7-1.3-3.6-1.5-5.5-.9z" />
      <path d="M13.5 3.2c-1.9-.6-3.8-.4-5.5.9v9c1.7-1.3 3.6-1.5 5.5-.9z" />
    </g>
  </svg>
);

export const LaptopIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <rect x="3" y="3.5" width="10" height="7" rx="1" />
      <path d="M1.5 12.5h13" />
    </g>
  </svg>
);

/** A terminal: Settings' Sessions. */
export const TerminalIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6.5 6.5 8.25 4.5 10M8 10h3" />
    </g>
  </svg>
);

export const ChatIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <path
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      d="M2.5 4.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z"
    />
  </svg>
);

export const CommitIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="2.6" />
      <path d="M1 8h4.4M10.6 8H15" />
    </g>
  </svg>
);

export const BranchIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="4.5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 6.1c0 3.1-2.5 3.7-6.1 4.7" />
    </g>
  </svg>
);

/** An org's facts (the mocks' org header): its website, its people, its repositories. */
export const LinkIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9" />
      <path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.5 8.8a2.6 2.6 0 0 0 3.7 3.7l.9-.9" />
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

export const RepoBookIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round">
      <path d="M3.25 2.75h8.5a1 1 0 0 1 1 1v9.5H4.5a1.25 1.25 0 0 1-1.25-1.25z" />
      <path d="M3.25 12a1.25 1.25 0 0 1 1.25-1.25h8.25" />
    </g>
  </svg>
);

/** Copy, where a command's box has no room for the word (the org page's side column). */
export const CopyIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.35">
      <rect x="5.25" y="5.25" width="8" height="8" rx="1.5" />
      <path d="M10.75 5.25V4.25a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h1" />
    </g>
  </svg>
);

/** A profile's facts (the profile mock): where a person is, when they joined, an org in the timeline, a review. */
export const PinIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.35">
      <path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 9.8 8 14 8 14z" />
      <circle cx="8" cy="6.5" r="1.6" />
    </g>
  </svg>
);

export const CalendarIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.35">
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.6" />
      <path d="M2.5 6.75h11M5.5 2v3M10.5 2v3" />
    </g>
  </svg>
);

export const OrgIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round">
      <rect x="2.75" y="2.75" width="10.5" height="10.5" rx="2" />
      <path d="M5.75 6h1M9.25 6h1M5.75 8.75h1M9.25 8.75h1M7 13.25v-2h2v2" />
    </g>
  </svg>
);

export const ReviewIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" strokeLinecap="round">
      <path d="M2.5 4.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M5.9 7.1l1.4 1.4 2.8-2.9" />
    </g>
  </svg>
);

/** An HTML artifact: angle brackets. */
export const CodeIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** An image artifact: a frame with a hill and a sun. */
export const ImageIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="m2.5 11 3.2-3.2 2.8 2.8 1.6-1.6 3.4 3.2" />
    </g>
    <circle cx="10.5" cy="6" r="1.1" fill="currentColor" />
  </svg>
);

/** Add, upload: an arrow up from a line. */
export const UploadIcon = (p: Props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <path d="M8 11V3M4.5 6.5 8 3l3.5 3.5M3 13.5h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
