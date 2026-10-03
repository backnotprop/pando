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
