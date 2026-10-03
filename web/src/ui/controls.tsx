// Small shared pieces: the quiet underlined link, a command to copy, a copy
// button that says "Copied", the empty line, and a section heading.
import { Link, type LinkProps } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

export const lnk = "cursor-pointer border-b border-ash-half pb-px text-bark-dim hover:border-bark hover:text-bark";

export const Lnk = ({ className = "", ...props }: LinkProps & { className?: string }) => <Link className={`${lnk} ${className}`} {...props} />;

/** The text a copy button shows: its label, then "Copied" for 1.2 s. */
export function useCopy(label: string): [string, (text: string) => void] {
  const [copied, setCopied] = useState(false);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return [copied ? "Copied" : label, copy];
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className: string }) {
  const [shown, copy] = useCopy(label);

  return (
    <button type="button" className={className} onClick={() => copy(text)}>
      {shown}
    </button>
  );
}

const copyInCmd = "h-[26px] cursor-pointer rounded-md bg-loam px-2.5 font-sans text-[12px] leading-[14px] text-bark-dim hover:text-bark";

/** `$ pando clone ramos/pando` with Copy. `url` drops the `$` and lets a long URL wrap. */
export function Cmd({ text, url = false, wide = false }: { text: string; url?: boolean; wide?: boolean }) {
  return (
    <span
      className={`items-center gap-3 rounded-lg border border-rootline pr-1 pl-3 font-mono text-[13px] leading-[16px] whitespace-nowrap text-bark ${wide ? "flex w-full" : "inline-flex"} ${url ? "min-h-[34px] py-1.5" : "h-[34px]"}`}
    >
      {url ? null : <span className="text-ash">$</span>}
      <code className={`${wide ? "min-w-0 flex-1 overflow-hidden text-ellipsis" : ""} ${url ? "text-[12px] leading-[17px] break-all whitespace-normal" : ""}`}>{text}</code>
      <CopyButton text={text} className={copyInCmd} />
    </span>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="py-2.5 text-[13.5px] text-ash">{children}</p>;

/** A section heading with an optional count and something at its right. */
export function SectionHead({ title, count, right }: { title: string; count?: number; right?: ReactNode }) {
  return (
    <h2 className="mb-2.5 flex items-baseline gap-2.5 text-[14px] leading-5 font-semibold">
      {title}
      {count === undefined ? null : <span className="font-mono text-[12.5px] leading-[15px] font-normal text-ash">{count}</span>}
      {right ? <span className="ml-auto text-[13px] font-normal">{right}</span> : null}
    </h2>
  );
}

/** A time in the lists' mono style. */
export const Time = ({ children, left = false }: { children: ReactNode; left?: boolean }) => (
  <span className={`font-mono text-[12.5px] whitespace-nowrap text-ash ${left ? "text-left" : "text-right"}`}>{children}</span>
);
