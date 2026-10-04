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

export const copyInCmd = "h-[26px] cursor-pointer rounded-md bg-loam px-2.5 font-sans text-[12px] leading-[14px] text-bark-dim hover:text-bark";

/** `$ pando clone ramos/pando` with Copy. `url` drops the `$` and lets a long URL wrap. On a phone it never runs past the screen. */
export function Cmd({ text, url = false, wide = false }: { text: string; url?: boolean; wide?: boolean }) {
  return (
    <span
      className={`items-center gap-3 rounded-lg border border-rootline pr-1 pl-3 font-mono text-[13px] leading-[16px] whitespace-nowrap text-bark ${wide ? "flex w-full" : "inline-flex phone:max-w-full"} ${url ? "min-h-[34px] py-1.5" : "h-[34px]"}`}
    >
      {url ? null : <span className="text-ash">$</span>}
      <code className={`${wide ? "min-w-0 flex-1 overflow-hidden text-ellipsis" : "phone:min-w-0 phone:overflow-hidden phone:text-ellipsis"} ${url ? "text-[12px] leading-[17px] break-all whitespace-normal" : ""}`}>{text}</code>
      <CopyButton text={text} className={copyInCmd} />
    </span>
  );
}

const btn = "inline-flex cursor-pointer items-center justify-center rounded-[7px] px-3.5 font-semibold whitespace-nowrap disabled:cursor-default disabled:opacity-40";

const BUTTON_KINDS = {
  solid: "bg-bark text-soil hover:bg-bark-hi disabled:hover:bg-bark",
  quiet: "text-bark shadow-[inset_0_0_0_1px_var(--ash-half)] hover:shadow-[inset_0_0_0_1px_var(--bark-dim)]",
  danger: "text-rust shadow-[inset_0_0_0_1px_var(--rust-half)]",
};

/** The prototype's three heights: 32 (a form's button), 30 (a page's actions), 28 (in a table row). */
const BUTTON_SIZES = { 32: "h-8 text-[13.5px] leading-[16px]", 30: "h-[30px] text-[13px] leading-[15px]", 28: "h-7 text-[12.5px] leading-[15px]" };

/** The prototype's .btn: solid (the one thing to do), quiet (outlined) or danger (Rust). */
export const button = (kind: keyof typeof BUTTON_KINDS, size: keyof typeof BUTTON_SIZES = 32) => `${btn} ${BUTTON_KINDS[kind]} ${BUTTON_SIZES[size]}`;

/** The prototype's .in: a text field or a select. */
export const field = "h-8 min-w-0 rounded-[7px] border border-rootline bg-air px-3 text-[13.5px] text-bark placeholder:text-ash focus:border-ash focus:outline-none";

/** A table's column labels, above its rows (the prototype's .thead). */
export const thead = "-mx-2.5 grid gap-4 px-2.5 pb-2 text-[12px] text-ash";

/** A table row (the prototype's .row): one faint rule above each. */
export const row = "-mx-2.5 grid min-h-11 items-center gap-4 rounded-[7px] px-2.5 py-2";

/** What a refused write said, in Rust, under its form. */
export const Refusal = ({ error }: { error: Error | null }) => (error ? <p className="mt-2 text-[13px] text-rust">{error.message}</p> : null);

export const Empty = ({ children }: { children: ReactNode }) => <p className="py-2.5 text-[13.5px] text-ash">{children}</p>;

/** A section heading with an optional count and something at its right. */
export function SectionHead({ title, count, right, className = "mb-2.5" }: { title: string; count?: number; right?: ReactNode; className?: string }) {
  return (
    <h2 className={`${className} flex items-baseline gap-2.5 text-[14px] leading-5 font-semibold`}>
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
