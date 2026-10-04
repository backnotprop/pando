// An issue's or a comment's Markdown, through Plannotator's viewer (ui/doc,
// owner ruling), with `#12` and `@ana` made links before the viewer sees the
// text (outside code, SPEC.md 7.3). Links within Pando open in place; others
// in a new tab, as the viewer does.
import { useNavigate } from "@tanstack/react-router";
import type { MouseEvent } from "react";
import { Doc } from "../../../../ui/doc/Doc";

/** A fence's opening line: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Inline code, a Markdown link, an HTML tag or a bare URL: left as written. */
const KEEP = /(`+[^`]*`+|\[[^\]]*\]\([^)]*\)|<[^>]+>|https?:\/\/\S+)/;

/** `#12` → the issue's page; `@ana` → her page. A number or name glued to a word (abc#12, ana@pando.invalid) is not one. */
function linkLine(text: string, full: string): string {
  return text
    .split(KEEP)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/(^|[^\w/#&])#(\d+)(?!\w)/g, `$1[#$2](/${full}/issues/$2)`)
            .replace(/(^|[^\w/@.`])@([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38})(?![\w-])/gi, (_, lead: string, login: string) => `${lead}[@${login}](/${login.toLowerCase()})`),
    )
    .join("");
}

export function linkRefs(text: string, full: string): string {
  let fence: string | null = null;

  return text
    .split("\n")
    .map((line) => {
      const open = FENCE.exec(line)?.[1];

      if (fence) {
        if (open && open[0] === fence[0] && open.length >= fence.length) fence = null;

        return line;
      }

      if (open) {
        fence = open;

        return line;
      }

      return linkLine(line, full);
    })
    .join("\n");
}

/** The Markdown, shown. A link to a page of Pando's opens it here, without a reload. */
export function Markdown({ text, full }: { text: string; full: string }) {
  const navigate = useNavigate();

  const inApp = (e: MouseEvent) => {
    const a = e.target instanceof Element ? e.target.closest("a") : null;

    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const url = new URL(a.href, location.href);

    if (url.origin !== location.origin) return;
    e.preventDefault();
    e.stopPropagation();
    void navigate({ href: url.pathname + url.search + url.hash });
  };

  return (
    <div onClickCapture={inApp}>
      <Doc path="issue.md" text={linkRefs(text, full)} raw="" openFile={(path) => void navigate({ href: `/${path}` })} />
    </div>
  );
}
