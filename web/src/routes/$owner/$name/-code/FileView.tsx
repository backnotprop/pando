// A file's page body, shared by root files and a repo's code: the tools bar
// (Preview and Code for a document, Raw, Copy, Copy link, Copy raw link) and
// the file itself: a document (Markdown, HTML) through Plannotator's viewer,
// other text with line numbers (plain at once, coloured when Colour.tsx has
// loaded and the highlighter answers), images as images, other binary bytes
// not shown.
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { MAX_SHOWN } from "../../../../api/client";
import { CopyButton } from "../../../../ui/controls";
import { Doc, isDoc } from "../../../../ui/doc/Doc";
import { absolute, type AppLink } from "../../../../ui/paths";
import { Lines, Plain } from "./Lines";

/** Without colour: the plain lines, numbered or not. */
const Uncoloured = ({ text, numbers = true }: { text: string; numbers?: boolean }) => (numbers ? <Lines text={text} /> : <Plain text={text} />);

// If the chunk cannot load (a deploy replaced it while the tab was open), the plain lines stay.
const Colour = lazy(() => import("./Colour").catch(() => ({ default: Uncoloured })));

/** Owner board, code view limits: colour up to 1 MiB, plain text to 10 MiB (MAX_SHOWN), Raw only past it. */
const MAX_COLOURED = 1024 * 1024;

/** The kinds the raw route serves as images. */
const IMAGE = /\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i;

const quiet = "px-5 py-7 text-[13.5px] text-ash";

export const tool =
  "inline-flex h-7 cursor-pointer items-center rounded-md border border-rootline bg-soil px-2.5 text-[12.5px] leading-[15px] whitespace-nowrap text-bark-dim hover:border-rule-hi hover:text-bark";

/** A document's two views: Preview (the default) and Code (`?plain=1`, GitHub's word). */
export interface Views {
  preview: AppLink;
  code: AppLink;
  plain: boolean;
}

const part = "inline-flex items-center px-2.5 whitespace-nowrap";

const on = `${part} bg-loam text-bark`;

const off = `${part} bg-soil text-bark-dim hover:text-bark`;

/** Preview | Code, a quiet two-part control in the tools' own look. The router marks the one shown (aria-current="page"); `exact` keeps Preview's link from matching Code's page too. */
function ViewSwitch({ views }: { views: Views }) {
  return (
    <span role="group" aria-label="View" className="inline-flex h-7 flex-none overflow-hidden rounded-md border border-rootline text-[12.5px] leading-[15px]">
      <Link {...views.preview} activeOptions={{ exact: true }} className={views.plain ? off : on}>
        Preview
      </Link>
      <Link {...views.code} activeOptions={{ exact: true }} className={`border-l border-rootline ${views.plain ? on : off}`}>
        Code
      </Link>
    </span>
  );
}

/** `raw` is the Worker's raw URL for these bytes; `text` null means binary (no Copy). */
export function FileTools({ name, text, raw, views }: { name: string; text: string | null; raw: string; views?: Views }) {
  const location = useLocation();

  return (
    // On a phone: the name (with Preview | Code) on its own line, the four tools on one row below (design review, 2026-10-03).
    // On a phone the row's padding is the prototype's 10 px above and below (its .ftool phone rule).
    <div className="flex min-h-11 items-center gap-2 border-y border-rule-faint py-1.5 pr-2.5 pl-4 phone:flex-wrap phone:pt-2.5 phone:pb-2.5">
      <span
        className={`mr-auto overflow-hidden text-[12.5px] leading-[15px] text-ellipsis whitespace-nowrap text-ash ${views ? "phone:min-w-0 phone:flex-1" : "phone:basis-full"}`}
      >
        {name}
      </span>
      {views ? <ViewSwitch views={views} /> : null}
      <span className="flex flex-wrap gap-1.5 phone:basis-full phone:flex-nowrap">
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
 * The file as code. `size` is the file's bytes (from FileText; the text's
 * length when absent). `id` is the blob's oid, the colour cache's key. `raw`
 * shows an image.
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

/** Text coloured by its name's kind, without line numbers (a pipeline's YAML, as the prototype draws it): plain at once, coloured when Colour.tsx has loaded. */
export function BareCode({ name, text }: { name: string; text: string }) {
  return (
    <Suspense fallback={<Plain text={text} />}>
      <Colour name={name} text={text} id={null} numbers={false} />
    </Suspense>
  );
}

/**
 * What a file's page shows: a document's Preview unless `?plain=1`, else
 * FileBody (its code, with the code view's limits and cache). `raw` is the
 * bytes' URL at the commit shown; `fileLink` is another file's page by its path.
 */
export function FileShown({
  path,
  text,
  size,
  id,
  raw,
  views,
  fileLink,
}: {
  path: string;
  text: string | null;
  size?: number;
  id: string | null;
  raw: string;
  views: Views;
  fileLink: (path: string) => AppLink;
}) {
  const navigate = useNavigate();

  if (text !== null && isDoc(path) && !views.plain) {
    return (
      <div className="px-[26px] pt-[22px] pb-2.5">
        <Doc path={path} text={text} raw={raw} openFile={(to) => void navigate(fileLink(to))} />
      </div>
    );
  }

  return <FileBody name={path.slice(path.lastIndexOf("/") + 1)} text={text} size={size} id={id} raw={raw} />;
}
