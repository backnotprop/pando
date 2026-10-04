// Links as the owner ruled (links R, "Signal, edited"): each theme's Link
// colour (theme.css, --link) marks the thing a line is about, at rest, on a
// phone too. Three kinds:
//   - name:   a row's name; the row is the link, the name is Link, semibold,
//             and underlines under the pointer (the row's or its own);
//   - object: what a line is about (a branch, an issue, a file); in running
//             text it keeps a faint underline in its own colour, so it never
//             rests on colour alone (WCAG 1.4.1);
//   - person: who (a person's page, or a check): semibold Bark, Link under
//             the pointer.
// Places in a sentence ("in projects/web", "from ana-mbp") are plain text,
// not links; actions keep Lnk (controls.tsx). A branch is SF Mono at 13 px
// everywhere (the mono ruling).
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { DoneIcon, NotPlannedIcon, OpenIcon } from "./IssueIcons";
import { type AppLink, issueLink } from "./paths";

export type RefKind = "name" | "object" | "person";

const KINDS: Record<RefKind, string> = {
  name: "font-semibold text-link group-hover:underline hover:underline",
  object: "text-link hover:underline hover:decoration-current",
  person: "font-semibold text-bark hover:text-link hover:underline",
};

interface RefProps {
  kind: RefKind;
  /** A page of the app; or `href`, a page elsewhere (opens in a new tab). */
  link?: AppLink;
  href?: string;
  /** In running text: the faint underline, at rest. */
  text?: boolean;
  /** A branch (or a commit id): SF Mono, 13 px. */
  mono?: boolean;
  /** In a row whose own link is stretched under it: drawn above that link. */
  above?: boolean;
  label?: string;
  className?: string;
  children: ReactNode;
}

/** A kind's look, for text inside a row that is itself one link (a name the row's link carries). */
export const refClass = (kind: RefKind, { text = false, mono = false }: { text?: boolean; mono?: boolean } = {}) =>
  [KINDS[kind], "decoration-1 underline-offset-3", text ? "underline decoration-link-line" : "", mono ? "font-mono text-[13px] font-normal" : ""].join(" ");

export function Ref({ kind, link, href, text = false, mono = false, above = false, label, className = "", children }: RefProps) {
  const cls = `${refClass(kind, { text, mono })} ${above ? "relative z-10" : ""} ${className}`;

  if (link) {
    return (
      <Link {...link} aria-label={label} className={cls}>
        {children}
      </Link>
    );
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label} className={cls}>
      {children}
    </a>
  );
}

/** An issue's state as its reference shows it: open in the link's own colour, completed in Bark-dim, not planned in Ash. */
export interface IssueState {
  state: "open" | "closed";
  reason?: "completed" | "not_planned" | null;
}

function Glyph({ state, reason }: IssueState) {
  const size = "inline-block size-[13px] flex-none align-[-2px]";

  if (state === "open") return <OpenIcon className={size} />;

  if (reason === "not_planned") return <NotPlannedIcon className={`${size} text-ash`} />;

  return <DoneIcon className={`${size} text-bark-dim`} />;
}

/** `#12` with its state glyph, opening the issue: an issue reference anywhere (links R: "issue references carry their open or closed mark"). */
export function IssueRef({ full, number, state, reason = null, text = false, above = false, className = "" }: { full: string; number: number; text?: boolean; above?: boolean; className?: string } & IssueState) {
  return (
    <Ref kind="object" link={issueLink(full, number)} above={above} label={`#${number}, ${state === "open" ? "open" : reason === "not_planned" ? "closed as not planned" : "closed"}`} className={`inline-flex items-baseline gap-1 no-underline ${className}`}>
      <Glyph state={state} reason={reason} />
      <span className={text ? "underline decoration-link-line decoration-1 underline-offset-3" : ""}>#{number}</span>
    </Ref>
  );
}
