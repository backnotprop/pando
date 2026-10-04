// A file's page body, shared by root files and a repo's code: the tools bar
// (Raw, Copy, Copy link, Copy raw link) and the file itself, Markdown rendered,
// other text with line numbers, binary bytes not shown.
import { useLocation } from "@tanstack/react-router";
import { CopyButton } from "../../../../ui/controls";
import { Markdown } from "../../../../ui/Markdown";
import { absolute } from "../../../../ui/paths";

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

export function FileBody({ name, text }: { name: string; text: string | null }) {
  if (text === null) return <p className="px-5 py-7 text-[13.5px] text-ash">No preview for this file.</p>;

  if (/\.(md|markdown)$/i.test(name)) {
    return (
      <div className="px-[26px] pt-[22px] pb-2.5">
        <Markdown text={text} />
      </div>
    );
  }

  return <Lines text={text} />;
}
