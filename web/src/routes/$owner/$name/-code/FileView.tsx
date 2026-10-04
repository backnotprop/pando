// A file's page body, shared by root files and a repo's code: the tools bar
// (Preview and Code for a document, Raw, Copy, Copy link, Copy raw link) and
// the file itself: a document through Plannotator's viewer, other text with
// line numbers, binary bytes not shown.
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { CopyButton } from "../../../../ui/controls";
import { Doc, isDoc } from "../../../../ui/doc/Doc";
import { absolute, type AppLink } from "../../../../ui/paths";

const tool =
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
    <div className="flex min-h-11 items-center gap-2 border-y border-rule-faint py-1.5 pr-2.5 pl-4 phone:flex-wrap phone:pb-2.5">
      <span
        className={`mr-auto overflow-hidden font-mono text-[12.5px] leading-[15px] text-ellipsis whitespace-nowrap text-ash ${views ? "phone:min-w-0 phone:flex-1" : "phone:basis-full"}`}
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

function Lines({ text }: { text: string }) {
  return (
    <pre className="m-0 overflow-x-auto py-3 font-mono text-[12.5px] leading-5 text-bark">
      {text.split("\n").map((line, i) => (
        <span key={i} className="grid grid-cols-[52px_minmax(0,1fr)] whitespace-pre">
          <i className="pr-[18px] text-right text-ash not-italic select-none">{i + 1}</i>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

/** The file as code: its lines, numbered. (`name` is for the code's colour, web-colour's lane.) */
export function FileBody({ text }: { name: string; text: string | null }) {
  if (text === null) return <p className="px-5 py-7 text-[13.5px] text-ash">No preview for this file.</p>;

  return <Lines text={text} />;
}

/** What a file's page shows: a document's Preview unless `?plain=1`, else its code. `fileLink` is another file's page by its path. */
export function FileShown({ path, text, raw, views, fileLink }: { path: string; text: string | null; raw: string; views: Views; fileLink: (path: string) => AppLink }) {
  const navigate = useNavigate();

  if (text !== null && isDoc(path) && !views.plain) {
    return (
      <div className="px-[26px] pt-[22px] pb-2.5 phone:px-4">
        <Doc path={path} text={text} raw={raw} openFile={(to) => void navigate(fileLink(to))} />
      </div>
    );
  }

  return <FileBody name={path.slice(path.lastIndexOf("/") + 1)} text={text} />;
}
