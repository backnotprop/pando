// A job's log as its terminal printed it, simply: Buildkite's timestamp
// markers and every escape but colour taken out, bold and the eight basic
// colours kept (on the syntax palette, so they sit right in every theme),
// and of a line a progress bar redrew, its last state. While the job runs
// the log is read again every few seconds, and stays at its end unless the
// person scrolled up.
import { useLayoutEffect, useRef } from "react";

const ESC = String.fromCharCode(27);

const BEL = String.fromCharCode(7);

/** Buildkite's timestamp markers: ESC _bk;t=... BEL. */
const MARKER = new RegExp(`${ESC}_bk;[^${BEL}]*${BEL}`, "g");

/** Any terminal control sequence, ESC [ params final; only `m` (colour) is read. */
const CSI = new RegExp(`${ESC}\\[([0-9;?]*)([ -/]*)([@-~])`, "g");

export interface Run {
  text: string;
  bold: boolean;
  /** 0 to 7: black, red, green, yellow, blue, magenta, cyan, white; null for the log's own colour. */
  color: number | null;
}

/** A log's text in runs of one style. */
export function runsOf(log: string): Run[] {
  const text = log
    .replace(MARKER, "")
    .split("\n")
    .map((line) => line.replace(/\r$/, "").split("\r").pop() ?? "")
    .join("\n");

  const runs: Run[] = [];
  let bold = false;
  let color: number | null = null;
  let from = 0;

  for (const m of text.matchAll(CSI)) {
    if (m.index > from) runs.push({ text: text.slice(from, m.index), bold, color });
    from = m.index + m[0].length;

    if (m[3] !== "m" || m[2]) continue;

    for (const code of (m[1] || "0").split(";").map(Number)) {
      // 38 and 48 bring 256 or true colours in the codes after them: left as the log's own.
      if (code === 38 || code === 48) break;

      if (code === 0) [bold, color] = [false, null];
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = null;
      else if (code >= 30 && code <= 37) color = code - 30;
      else if (code >= 90 && code <= 97) color = code - 90;
    }
  }

  if (from < text.length) runs.push({ text: text.slice(from), bold, color });

  return runs;
}

// Red is Rust (failures). The others take the code view's syntax tones
// (theme.css), already set against Rust and Foxfire in every theme, so blue and
// magenta never sit near a theme's violet Foxfire: green is sage, yellow sand,
// blue and cyan slate, magenta wood; black and white are the log's ash and bark.
const COLORS = [
  "text-ash",
  "text-rust",
  "text-(--diffs-token-string)",
  "text-(--diffs-token-constant)",
  "text-(--diffs-token-function)",
  "text-(--diffs-token-keyword)",
  "text-(--diffs-token-function)",
  "text-bark",
];

/** The log, kept at its end while it grows unless the person scrolled up to read. */
export function LogText({ log, truncated }: { log: string | null; truncated: boolean }) {
  const pre = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const runs = log === null ? null : runsOf(log.replace(/\n+$/, ""));

  useLayoutEffect(() => {
    if (pre.current && pinned.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [log]);

  return (
    <pre
      ref={pre}
      onScroll={(e) => {
        const el = e.currentTarget;

        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
      className="m-0 max-h-[60vh] overflow-y-auto font-mono text-[12.5px] leading-[19px] whitespace-pre-wrap text-bark-dim"
    >
      {truncated ? <span className="text-ash">{"Earlier lines are in the service.\n"}</span> : null}
      {runs === null
        ? "…"
        : runs.length
          ? runs.map((r, i) =>
              r.bold || r.color !== null ? (
                <span key={i} className={`${r.bold ? "font-semibold" : ""} ${r.color === null ? "" : COLORS[r.color]}`}>
                  {r.text}
                </span>
              ) : (
                r.text
              ),
            )
          : <span className="text-ash">No output.</span>}
    </pre>
  );
}
