// The conversation (the mocks accepted 2026-10-05, prompt treatment A): one
// quiet, progressively disclosed view of a conversation with an agent, for a
// live agent session, the assistant's chat and a recorded session. The
// person's words sit on a soft background; the agent's words are the page;
// its steps fold to one line each run (rules.ts), and open on a click to
// their arguments and kept output. The agent's program and model show once
// after each prompt; every time is on hover.
import { useState } from "react";
import { Markdown } from "../routes/$owner/$name/-issues/Markdown";
import { Avatar } from "../ui/Avatar";
import { CheckIcon, Chevron } from "../ui/Icons";
import { Leaf } from "../ui/Leaf";
import { failedVerb, foldParts, presentVerb, type StepWords, stepWords } from "./rules";
import type { ConversationItem, StepItem } from "./shape";

/** A kept output's lines shown before "Show all". */
const OUT_LINES = 12;

const clockTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

const hhmm = (at: number) => clockTime.format(at);

const lineCls = "flex min-w-0 items-center gap-[7px] text-[13px] leading-5 text-ash";

const atCls = "ml-auto pl-3 text-[12px] whitespace-nowrap text-ash/80";

function StepObject({ w }: { w: StepWords }) {
  if (!w.object) return null;

  if (w.look === "command") return <code className="font-mono text-[12.5px] text-bark-dim"> {w.object}</code>;

  return <span className="text-bark-dim"> {w.object}</span>;
}

/** Rule 4: a step opened, its arguments as recorded and its kept output. */
function Opened({ s }: { s: StepItem }) {
  const [all, setAll] = useState(false);
  const lines = s.out?.split("\n") ?? [];
  const shown = all ? lines : lines.slice(0, OUT_LINES);
  const args = Object.entries(s.args);

  return (
    <div className="ml-[19px] grid gap-2">
      {s.tool === "bash" || s.tool === "Bash" ? (
        <pre className="font-mono text-[12px] leading-[18px] break-words whitespace-pre-wrap text-bark-dim">$ {s.args.command}</pre>
      ) : args.length ? (
        <pre className="font-mono text-[12px] leading-[18px] break-words whitespace-pre-wrap text-bark-dim">{args.map(([k, v]) => `${k}: ${v}`).join("\n")}</pre>
      ) : null}
      {s.notKept ? (
        <p className="text-[12.5px] text-ash">Output not kept: {s.notKept}</p>
      ) : s.out ? (
        <pre className="rounded-lg bg-air px-3 py-2.5 font-mono text-[12px] leading-[18px] break-words whitespace-pre-wrap text-bark-dim">
          {shown.join("\n").split("[redacted]").flatMap((part, i) => (i ? [<span key={i} className="rounded bg-rule-soft px-1.5 font-sans text-[11.5px] text-ash">redacted</span>, part] : [part]))}
        </pre>
      ) : null}
      {lines.length > OUT_LINES && !all ? (
        <button type="button" className="justify-self-start text-[12.5px] text-link" onClick={() => setAll(true)}>
          Show all {lines.length} lines
        </button>
      ) : null}
    </div>
  );
}

/** One step's line (rules 1 and 3); a click opens it. */
function Step({ s }: { s: StepItem }) {
  const [open, setOpen] = useState(false);
  const w = stepWords(s);

  if (s.running) {
    return (
      <p className={`${lineCls} text-bark-dim`} data-step="running">
        <Leaf state="working" size={12} />
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {presentVerb(w.verb)}
          <StepObject w={w} />
        </span>
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`${lineCls} cursor-pointer text-left ${s.error || open ? "text-bark-dim" : ""}`}>
        <Chevron className={`size-3 flex-none opacity-70 transition-transform ${open ? "" : "-rotate-90"}`} />
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {s.error ? <span className="font-semibold text-rust">{failedVerb(w.verb)}</span> : w.verb}
          <StepObject w={w} />
          {s.notKept && !s.error ? <span className="text-ash"> · not kept</span> : null}
        </span>
        <span className={atCls}>{hhmm(s.at)}</span>
      </button>
      {s.error && !open && s.out ? <p className="-mt-1.5 ml-[19px] overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-rust">{s.out.split("\n")[0]}</p> : null}
      {open ? <Opened s={s} /> : null}
    </div>
  );
}

/** A run of steps: one line if one, else the fold (rule 2), its failed steps under it and the running one after. */
function Run({ steps }: { steps: readonly StepItem[] }) {
  const [open, setOpen] = useState(false);
  const done = steps.filter((s) => !s.running);
  const running = steps.filter((s) => s.running);
  const failed = done.filter((s) => s.error);

  if (done.length < 2) return steps.map((s) => <Step key={s.key} s={s} />);
  const fold = foldParts(done);

  return (
    <div className="grid gap-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`${lineCls} cursor-pointer text-left ${open ? "text-bark-dim" : ""}`}>
        <Chevron className={`size-3 flex-none opacity-70 transition-transform ${open ? "" : "-rotate-90"}`} />
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          <b className="font-semibold text-bark-dim">{done.length} steps</b>
          {failed.length ? <span className="font-semibold text-rust"> {failed.length} failed ·</span> : null}{" "}
          {fold.parts.map((p, i) => (
            <span key={p.verb}>
              {i ? ", " : ""}
              {p.verb}
              {p.count ? ` ${p.count}` : p.object ? <StepObject w={p.object} /> : null}
            </span>
          ))}
          {fold.more ? ", and more" : ""}
        </span>
        <span className={atCls}>{hhmm(done[0]?.at ?? 0)}</span>
      </button>
      {open ? (
        <div className="grid gap-1.5 pl-[19px]">
          {done.map((s) => (
            <Step key={s.key} s={s} />
          ))}
        </div>
      ) : (
        failed.map((s) => (
          <div key={s.key} className="pl-[19px]">
            <Step s={s} />
          </div>
        ))
      )}
      {running.map((s) => (
        <Step key={s.key} s={s} />
      ))}
    </div>
  );
}

/** The items grouped: each run of steps together, everything else on its own. */
type Block = { kind: "run"; key: string; steps: StepItem[] } | { kind: "one"; key: string; item: Exclude<ConversationItem, StepItem> };

function blocks(items: readonly ConversationItem[]): Block[] {
  const out: Block[] = [];

  for (const it of items) {
    const last = out.at(-1);

    if (it.kind !== "step") out.push({ kind: "one", key: it.key, item: it });
    else if (last?.kind === "run") last.steps.push(it);
    else out.push({ kind: "run", key: it.key, steps: [it] });
  }

  return out;
}

/**
 * The conversation. `full` is the repository's owner/name, for its links;
 * `compact` is the assistant's panel (smaller type, no by-line).
 */
export function Conversation({ items, full, compact = false }: { items: readonly ConversationItem[]; full: string; compact?: boolean }) {
  // Rule 5: the agent's by-line once after each prompt.
  let byShown = false;

  return (
    <div className={`grid min-w-0 grid-cols-[minmax(0,1fr)] ${compact ? "gap-4" : "gap-[22px]"}`} data-conversation>
      {blocks(items).map((b) => {
        if (b.kind === "run") return <Run key={b.key} steps={b.steps} />;
        const it = b.item;

        if (it.kind === "prompt" || it.kind === "turn") byShown = false;

        switch (it.kind) {
          case "prompt":
          case "turn":
            return (
              <div key={it.key} data-prompt className="grid gap-1.5 rounded-xl bg-loam px-3.5 py-3">
                <p className="flex items-center gap-2 text-[12.5px] text-ash">
                  <Avatar name={it.who} size={18} />
                  <span className="text-[13px] text-bark">{it.who}</span>
                  {it.n ? <span className="text-bark-dim">Prompt {it.n}</span> : null}
                  <span className="ml-auto">{hhmm(it.at)}</span>
                </p>
                <div className={`whitespace-pre-wrap text-bark ${compact ? "text-[14px] leading-[21px]" : "text-[15px] leading-[23px]"} ${it.kind === "turn" ? "line-clamp-2 text-bark-dim" : ""}`}>{it.text}</div>
                {it.kind === "prompt" && it.images ? <p className="text-[12.5px] text-ash">{it.images === 1 ? "Image" : `${it.images} images`}, not kept</p> : null}
                {it.kind === "turn" ? (
                  <p className={lineCls}>
                    <b className="font-semibold text-bark-dim">{it.steps} steps</b>
                    {it.commits?.length ? <span> · {it.commits.join(" ")}</span> : null}
                  </p>
                ) : null}
              </div>
            );

          case "prose": {
            const by = !compact && !byShown;

            byShown = true;

            return (
              <div key={it.key} className="grid gap-1" title={hhmm(it.at)}>
                {by ? (
                  <p className="text-[12px] text-ash">
                    {it.program}, {it.model} · {hhmm(it.at)}
                  </p>
                ) : null}
                <div className={`text-doc ${compact ? "text-[14px] leading-[22px]" : "text-[15px] leading-6"}`}>
                  <Markdown text={it.text} full={full} />
                </div>
              </div>
            );
          }

          case "note":
            return (
              <p key={it.key} className="flex items-center gap-2 text-[13px] text-bark-dim">
                <CheckIcon className="size-[13px] flex-none text-ash" />
                <span>
                  <b className="font-semibold text-bark">Pando</b> {it.text}
                </span>
                <span className={atCls}>{hhmm(it.at)}</span>
              </p>
            );

          case "removed":
            return (
              <p key={it.key} className="text-[13px] text-ash">
                Prompt {it.n} and its answers were removed by {it.by}, {hhmm(it.at)}
              </p>
            );
        }
      })}
    </div>
  );
}
