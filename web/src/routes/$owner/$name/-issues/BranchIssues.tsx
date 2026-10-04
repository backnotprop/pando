// A branch page's Issues block (SPEC.md 3.6 and 7.7), between the Merge box
// and Checks: each issue the branch is linked to, its state in words and
// whether the merge closes it; "Closed #34" once the merge did. "Link an
// issue" links one more. It moves live on the page's `repo:<repo>` socket.
import type { Branch, IssueRow, Repo } from "@pando/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { editIssue, linkedIssuesQuery, openIssuesQuery } from "../../../../api/issues";
import { lnk, Refusal, SectionHead } from "../../../../ui/controls";
import { StateGlyph } from "../../../../ui/IssueIcons";
import { issueLink } from "../../../../ui/paths";
import { refClass } from "../../../../ui/Ref";
import { useMonorepo } from "../-frame/heads";
import { Picker } from "./Picker";

/** "Open · closes on merge", "Closed by this merge", "Closed as not planned". */
function stateWords(row: IssueRow, b: Branch): string {
  if (row.state === "open") return b.state === "merged" ? "Open" : "Open · closes on merge";

  if (row.closed_by_merge?.branch === b.name) return "Closed by this merge";

  return row.state_reason === "not_planned" ? "Closed as not planned" : "Closed";
}

export function BranchIssues({ repo, b }: { repo: Repo; b: Branch }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const linked = useQuery(linkedIssuesQuery(monorepo, repo.name, b.name)).data ?? [];
  const open = useQuery({ ...openIssuesQuery(monorepo), enabled: b.state !== "merged" }).data ?? [];
  const merged = b.state === "merged";

  const link = useMutation({
    mutationFn: (n: number) => editIssue(monorepo, n, { link: [{ repo: repo.name, branch: b.name }] }),
    onSuccess: () => qc.invalidateQueries({ queryKey: linkedIssuesQuery(monorepo, repo.name, b.name).queryKey }),
  });

  const options = open.filter((i) => !linked.some((l) => l.number === i.number)).map((i) => ({ id: String(i.number), text: `#${i.number} ${i.title}` }));

  return (
    <div className="mt-10">
      <SectionHead title="Issues" count={linked.length || undefined} />
      {linked.length ? (
        <ul aria-label="Linked issues" className="mb-2.5">
          {linked.map((row) => (
            <li key={row.number} className="py-2">
              <Link {...issueLink(monorepo.full, row.number)} className="group grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 gap-y-[3px] text-[13.5px]">
                <span className="mt-0.5">
                  <StateGlyph state={row.state} reason={row.state_reason} className="size-[15px]" />
                </span>
                <span>
                  {merged && row.closed_by_merge?.branch === b.name ? <span className="text-bark-dim">Closed </span> : null}
                  <span className={refClass("name")}>#{row.number}</span> <span className={`${refClass("object")} group-hover:underline`}>{row.title}</span>
                </span>
                <span className="col-start-2 text-[12.5px] text-ash">{stateWords(row, b)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-2.5 text-[13px] text-ash">No linked issues.</p>
      )}
      {merged ? null : (
        <Picker
          label="Link an issue"
          heading="Link an issue"
          trigger="Link an issue"
          triggerClass={`${lnk} text-[13px]`}
          options={options}
          selected={[]}
          align="start"
          findAt={0}
          onDone={([n]) => n && link.mutate(Number(n))}
        />
      )}
      <Refusal error={link.error} />
    </div>
  );
}
