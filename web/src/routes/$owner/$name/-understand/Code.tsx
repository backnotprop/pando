// The lines asked about: Pando's code view (its ring, its mono face, its
// colour once the colour views are loaded) with a gutter of the commit that
// last changed each run of lines (its short sha, at the run's first line,
// opening the record on the page or the commit) and the line numbers. Every
// sha is the server's blame.
import type { UnderstandPage } from "@pando/contract";
import { Link } from "@tanstack/react-router";
import { useColourViews } from "../-code/coloured";
import { Plain } from "../-code/Lines";
import type { Names } from "./Records";
import { commitLink } from "../../../../ui/paths";

type Lines = NonNullable<UnderstandPage["lines"]>;

export function Code({ lines, page, names }: { lines: Lines; page: UnderstandPage; names: Names }) {
  const views = useColourViews();
  const text = `${lines.lines.map((l) => l.text).join("\n")}\n`;
  // A run's sha links to its record when the answer shows it, else to the commit's page.
  const shownAt = (sha: string) => page.refs.find((r) => r.card?.kind === "commit" && r.card.sha === sha && page.blocks.some((b) => b.cites.includes(r.id)))?.id;

  return (
    <div className="overflow-hidden rounded-[10px] shadow-[0_0_0_1px_var(--rootline)]" aria-label="The lines asked about, with the commit that last changed each">
      <div className="grid grid-cols-[auto_auto_minmax(0,1fr)]">
        <div className="py-3.5 pl-3.5 font-mono text-[12.5px] leading-[19px] text-ash" aria-label="Last changed in">
          {lines.lines.map((l, i) => {
            const run = l.sha !== null && l.sha !== lines.lines[i - 1]?.sha;
            const at = run && l.sha ? shownAt(l.sha) : undefined;

            return (
              <div key={l.n} className="h-[19px] pr-3.5 whitespace-pre">
                {run && l.sha ? (
                  at ? (
                    <a href={`#source-${at}`} className="hover:text-link" title={`${l.by ?? ""}${l.at ? `, ${l.at.slice(0, 10)}` : ""}`}>
                      {l.sha.slice(0, 7)}
                    </a>
                  ) : (
                    <Link {...commitLink(names.full, names.repoPath(lines.repo), l.sha)} className="hover:text-link">
                      {l.sha.slice(0, 7)}
                    </Link>
                  )
                ) : (
                  " ".repeat(7)
                )}
              </div>
            );
          })}
        </div>
        <div aria-hidden className="py-3.5 pr-1 text-right font-mono text-[12.5px] leading-[19px] text-ash select-none">
          {lines.lines.map((l) => (
            <div key={l.n} className="h-[19px]">
              {l.n}
            </div>
          ))}
        </div>
        <div className="min-w-0 overflow-x-auto">{views ? <views.Colour name={lines.path} text={text} id={null} numbers={false} /> : <Plain text={text} />}</div>
      </div>
      {lines.older ? <p className="border-t border-rule-faint px-3.5 py-2 text-[12.5px] text-ash">Some lines are {lines.older}.</p> : null}
    </div>
  );
}
