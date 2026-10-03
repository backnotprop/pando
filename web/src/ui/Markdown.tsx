// A small, safe Markdown view for root files (READMEs, decisions): headings,
// paragraphs, lists and task lists, fenced code, tables, bold, inline code and
// links. It builds React elements, never HTML strings, so nothing in a file
// can run. This is the seam for Plannotator's viewer (@plannotator/ui): once
// it is published with a licence, it replaces <Markdown> where files are shown.
import type { ReactNode } from "react";

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: { text: string; task: "open" | "done" | null }[] }
  | { kind: "code"; text: string }
  | { kind: "table"; rows: string[][] }
  | { kind: "rule" };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Markdown to blocks, line by line (the prototype's reading of it, plus tables). */
export function parse(src: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  let list: { text: string; task: "open" | "done" | null }[] | null = null;
  let code: string[] | null = null;
  let table: string[][] | null = null;

  const flush = () => {
    if (para.length) out.push({ kind: "paragraph", text: para.join(" ") });
    para = [];

    if (list) out.push({ kind: "list", items: list });
    list = null;

    if (table) out.push({ kind: "table", rows: table });
    table = null;
  };

  for (const line of src.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (code) {
        out.push({ kind: "code", text: code.join("\n") });
        code = null;
      } else {
        flush();
        code = [];
      }

      continue;
    }

    if (code) {
      code.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);

    if (heading) {
      flush();
      out.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!table) flush();
      table ??= [];

      if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) table.push(cells(line));
    } else if (item) {
      if (para.length || table) flush();
      list ??= [];
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(item[1] ?? "");
      list.push(task ? { text: task[2] ?? "", task: task[1] === " " ? "open" : "done" } : { text: item[1] ?? "", task: null });
    } else if (list && /^\s{2,}\S/.test(line)) {
      const last = list.at(-1);

      if (last) last.text += ` ${line.trim()}`;
    } else if (/^\s*$/.test(line)) {
      flush();
    } else if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flush();
      out.push({ kind: "rule" });
    } else if (line.startsWith(':::')) {
      continue;
    } else {
      if (list || table) flush();
      para.push(line.trim().replace(/^>\s?/, ""));
    }
  }

  if (code) out.push({ kind: "code", text: code.join("\n") });
  flush();

  return out;
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g;

/** Inline code, bold and links; everything else is text. */
function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (/^`[^`]+`$/.test(part)) {
      return (
        <code key={i} className="rounded-[4px] bg-loam px-[5px] py-px text-[13.5px] text-bark">
          {part.slice(1, -1)}
        </code>
      );
    }

    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return (
        <strong key={i} className="font-semibold text-bark">
          {inline(part.slice(2, -2))}
        </strong>
      );
    }

    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);

    if (link) {
      const href = link[2] ?? "";

      // Only web links open; a relative path or anything else stays text.
      return /^https?:\/\//.test(href) ? (
        <a key={i} href={href} rel="noopener noreferrer" className="underline decoration-ash underline-offset-3 hover:text-bark">
          {link[1]}
        </a>
      ) : (
        <span key={i}>{link[1]}</span>
      );
    }

    return part;
  });
}

const HEADINGS = [
  "mb-3.5 text-[22px] leading-7 font-semibold tracking-[-.01em]",
  "mt-7 mb-2 text-[16px] leading-6 font-semibold",
  "my-[1.33em] font-semibold",
];

function block(b: Block, i: number): ReactNode {
  switch (b.kind) {
    case "heading": {
      // "#" is the page's h2, as in the prototype; a file has no h1 of its own.
      const level = Math.min(b.level + 1, 4);
      const Tag = level === 2 ? "h2" : level === 3 ? "h3" : "h4";

      return (
        <Tag key={i} className={HEADINGS[level - 2]}>
          {inline(b.text)}
        </Tag>
      );
    }

    case "paragraph":
      return (
        <p key={i} className="mb-3 text-doc">
          {inline(b.text)}
        </p>
      );
    case "list":
      return (
        <ul key={i} className="mb-3 list-disc pl-5">
          {b.items.map((it, j) =>
            it.task ? (
              <li key={j} className="mb-2 -ml-5 flex list-none gap-2.5 text-doc">
                <i className={`mt-[5px] size-3.5 flex-none rounded-[3px] border-[1.25px] border-ash ${it.task === "done" ? "bg-ash" : ""}`} />
                <span>{inline(it.text)}</span>
              </li>
            ) : (
              <li key={j} className="mb-2 text-doc marker:text-ash">
                {inline(it.text)}
              </li>
            ),
          )}
        </ul>
      );
    case "code":
      return (
        <pre key={i} className="m-0 overflow-x-auto py-3 font-mono text-[12.5px] leading-5 text-bark">
          {b.text}
        </pre>
      );
    case "table":
      return (
        <div key={i} className="mb-3 overflow-x-auto">
          <table className="border-collapse text-[14px] leading-5">
            <tbody>
              {b.rows.map((row, j) => (
                <tr key={j} className={j === 0 ? "font-semibold text-bark" : "text-doc"}>
                  {row.map((cell, k) => (
                    <td key={k} className="border-b border-rule-faint py-1.5 pr-5 align-top">
                      {inline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr key={i} className="my-5 border-t border-rule-faint" />;
  }
}

export function Markdown({ text }: { text: string }) {
  return <div className="text-[15px] leading-6 text-bark">{parse(text).map(block)}</div>;
}
