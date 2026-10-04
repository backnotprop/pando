// A file's text with line numbers, as the prototype's .src draws it: the
// instant first paint of every text file, and all of one over 1 MiB. And
// without them, as its .yaml draws a pipeline's configuration.

/** How many lines `text` has (one more after a last newline, as the coloured view counts). */
const countLines = (text: string) => {
  let lines = 1;

  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines++;

  return lines;
};

/**
 * The numbers and the code as two columns of one text node each, at the
 * coloured view's 20 px lines: a file of 80,000 lines is two nodes, not
 * 160,000 elements, so even 10 MiB draws at once.
 */
export function Lines({ text }: { text: string }) {
  const lines = countLines(text);
  // The number column as the coloured view sizes it (ui/syntax.ts CODE_LAYOUT): 52 px, or wider for five digits and more.
  const columns = `max(52px, calc(${String(lines).length}ch + 21px)) minmax(0, 1fr)`;

  return (
    <pre style={{ gridTemplateColumns: columns }} className="m-0 grid overflow-x-auto py-3 font-mono text-[12.5px] leading-5 text-bark">
      <span aria-hidden className="pr-[18px] text-right text-ash select-none">
        {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
      </span>
      <span>{text}</span>
    </pre>
  );
}

/** Text without line numbers (the prototype's .yaml): 12.5/19 mono, 14 px above and below, 18 px at the sides. */
export function Plain({ text }: { text: string }) {
  return <pre className="m-0 overflow-x-auto px-[18px] py-3.5 font-mono text-[12.5px] leading-[19px] whitespace-pre text-bark">{text}</pre>;
}
