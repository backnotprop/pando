// A file's text with line numbers, as the prototype's .src draws it: the
// instant first paint of every text file, and all of one over 1 MiB.
export function Lines({ text }: { text: string }) {
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
