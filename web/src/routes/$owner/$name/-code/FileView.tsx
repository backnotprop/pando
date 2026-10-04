// A file's page body, shared by root files and a repo's code: the tools bar
// (Raw, Copy, Copy link, Copy raw link) and the file itself: Markdown rendered,
// other text with line numbers (plain at once, coloured when Colour.tsx has
// loaded and the highlighter answers), images as images, other binary bytes
// not shown.
import { useLocation } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { MAX_SHOWN } from "../../../../api/client";
import { CopyButton } from "../../../../ui/controls";
import { Markdown } from "../../../../ui/Markdown";
import { absolute } from "../../../../ui/paths";
import { Lines } from "./Lines";

// If the chunk cannot load (a deploy replaced it while the tab was open), the plain lines stay.
const Colour = lazy(() => import("./Colour").catch(() => ({ default: Lines })));

/** Owner board, code view limits: colour up to 1 MiB, plain text to 10 MiB (MAX_SHOWN), Raw only past it. */
const MAX_COLOURED = 1024 * 1024;

/** The kinds the raw route serves as images. */
const IMAGE = /\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i;

const quiet = "px-5 py-7 text-[13.5px] text-ash";

export const tool =
  "inline-flex h-7 cursor-pointer items-center rounded-md border border-rootline bg-soil px-2.5 text-[12.5px] leading-[15px] whitespace-nowrap text-bark-dim hover:border-rule-hi hover:text-bark";

/** `raw` is the Worker's raw URL for these bytes; `text` null means binary (no Copy). */
export function FileTools({ name, text, raw }: { name: string; text: string | null; raw: string }) {
  const location = useLocation();

  return (
    // On a phone: the name on its own line, the four tools on one row below (design review, 2026-10-03).
    <div className="flex min-h-11 items-center gap-2 border-y border-rule-faint py-1.5 pr-2.5 pl-4 phone:flex-wrap phone:pb-2.5">
      <span className="mr-auto overflow-hidden font-mono text-[12.5px] leading-[15px] text-ellipsis whitespace-nowrap text-ash phone:basis-full">{name}</span>
      <span className="flex flex-wrap gap-1.5 phone:flex-nowrap">
        <a href={raw} className={tool}>
          Raw
        </a>
        {text === null ? null : <CopyButton text={text} className={tool} />}
        <CopyButton text={absolute(location.href)} label="Copy link" className={tool} />
        <CopyButton text={absolute(raw)} label="Copy raw link" className={tool} />
      </span>
    </div>
  );
}

/**
 * `size` is the file's bytes (from FileText; the text's length when absent).
 * `id` is the blob's oid, the colour cache's key. `raw` shows an image.
 */
export function FileBody({ name, text, size, id = null, raw }: { name: string; text: string | null; size?: number; id?: string | null; raw?: string }) {
  if (text === null) {
    if (size !== undefined && size > MAX_SHOWN) return <p className={quiet}>Over 10 MiB: open it with Raw.</p>;

    if (raw && IMAGE.test(name)) {
      return (
        <div className="px-5 py-7">
          <img src={raw} alt={name} className="max-w-full" />
        </div>
      );
    }

    return <p className={quiet}>No preview for this file.</p>;
  }

  if (/\.(md|markdown)$/i.test(name)) {
    return (
      <div className="px-[26px] pt-[22px] pb-2.5">
        <Markdown text={text} />
      </div>
    );
  }

  if ((size ?? text.length) > MAX_COLOURED) {
    return (
      <>
        <p className="border-b border-rule-faint px-4 py-2.5 text-[12.5px] leading-5 text-ash">Over 1 MiB: shown without colour.</p>
        <Lines text={text} />
      </>
    );
  }

  return (
    <Suspense fallback={<Lines text={text} />}>
      <Colour name={name} text={text} id={id} />
    </Suspense>
  );
}
