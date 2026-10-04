// "Needs you": open branches that are ready, conflicting or failing, and the
// open issues assigned to you, one row per repository (owner ruling). Each
// row opens the branch's page, or the issues assigned to you; there is no
// Merge here (owner ruling).
import type { AssignedIssues, FullName, MonorepoId, NeedRow } from "@pando/contract";
import { Link } from "@tanstack/react-router";
import { CheckMark } from "../../ui/activity";
import { Avatar } from "../../ui/Avatar";
import { Chevron } from "../../ui/Icons";
import { OpenIcon } from "../../ui/IssueIcons";
import { branchLink, issuesLink } from "../../ui/paths";
import { since, useNow } from "../../ui/time";

/** Words first, colour second: ready in Bark, conflicts and failures in Rust. */
export function NeedState({ row }: { row: NeedRow }) {
  if (row.state === "ready") return <span className="text-[13px] font-semibold whitespace-nowrap text-bark">ready to merge</span>;

  if (row.state === "conflicts") return <span className="text-[13px] font-semibold whitespace-nowrap text-rust">conflicts with main</span>;

  const check = row.checks.failing[0] ?? "ci";

  // The CI service's mark only when that service reported it; a member's own status has none.
  return (
    <span className="text-[13px] font-semibold whitespace-nowrap text-rust">
      {row.checks.failing_apps[check] === "buildkite" ? <CheckMark /> : null}
      {check} failed
    </span>
  );
}

/** One repository's open issues assigned to you. */
export interface AssignedRow extends AssignedIssues {
  monorepo: FullName;
  monorepo_id: MonorepoId;
}

function Assigned({ row, clock }: { row: AssignedRow; clock: number }) {
  const [owner = "", name = ""] = row.monorepo.split("/");

  return (
    <li className="border-t border-rule-soft first:border-t-0">
      <Link
        {...issuesLink(row.monorepo, { assignee: "@me" })}
        className="group -mx-2 grid min-h-[60px] grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-[7px] px-2 py-2.5 phone:grid-cols-[minmax(0,1fr)]"
      >
        <div className="min-w-0">
          <p className="flex items-center gap-2.5 text-[14px] font-semibold text-bark">
            <OpenIcon className="size-4 flex-none" />
            <span className="group-hover:underline group-hover:decoration-ash group-hover:underline-offset-3 group-focus-visible:underline">
              {row.count} issue{row.count === 1 ? "" : "s"} assigned to you
            </span>
          </p>
          <p className="mt-[3px] overflow-hidden text-[13px] text-ellipsis whitespace-nowrap text-ash">
            in{" "}
            <span className="text-bark-dim">
              <span className="text-ash">{owner}/</span>
              {name}
            </span>
            , the newest #{row.newest.number} {row.newest.title}
          </p>
        </div>
        <div className="flex items-center gap-3.5 phone:hidden">
          <span className="text-[12.5px] whitespace-nowrap text-ash">{since(row.newest.updated_at, clock)}</span>
          <Chevron className="block size-3.5 -rotate-90 text-ash" />
        </div>
      </Link>
    </li>
  );
}

export function NeedsList({ rows, assigned = [] }: { rows: readonly NeedRow[]; assigned?: readonly AssignedRow[] }) {
  const clock = useNow();

  return (
    <ul className="rounded-[10px] bg-loam px-[18px] py-1">
      {rows.map((n) => {
        const [owner, name] = n.monorepo.split("/");

        return (
          <li key={`${n.monorepo_id}:${n.repo}:${n.branch}`} className="border-t border-rule-soft first:border-t-0">
            <Link
              {...branchLink(n.monorepo, n.repo_path, n.branch)}
              className="group -mx-2 grid min-h-[60px] grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-[7px] px-2 py-2.5 phone:grid-cols-[minmax(0,1fr)]"
            >
              <div>
                <p className="flex items-baseline gap-2.5 text-[14px]">
                  <span className="font-mono text-[14px] leading-[17px] text-bark group-hover:underline group-hover:decoration-ash group-hover:underline-offset-3 group-focus-visible:underline group-focus-visible:decoration-ash group-focus-visible:underline-offset-3">{n.branch}</span>
                  <NeedState row={n} />
                </p>
                <p className="mt-[3px] flex items-center gap-2 text-[13px] text-ash">
                  {n.author ? <Avatar name={n.author} size={16} /> : null}
                  <span>
                    {n.author ? <span className="text-bark-dim">{n.author}</span> : null}
                    {n.pushed_machine ? ` on ${n.pushed_machine}` : ""}, in{" "}
                    <span className="text-bark-dim">
                      <span className="text-ash">{owner}/</span>
                      {name}
                    </span>
                    {n.repo_path === "." ? "" : ` ${n.repo_path}`}
                  </span>
                </p>
              </div>
              <div className="flex items-center gap-3.5">
                <span className="text-[12.5px] whitespace-nowrap text-ash">{n.updated_at ? since(n.updated_at, clock) : ""}</span>
                <Chevron className="block size-3.5 -rotate-90 text-ash" />
              </div>
            </Link>
          </li>
        );
      })}
      {assigned.map((a) => (
        <Assigned key={a.monorepo_id} row={a} clock={clock} />
      ))}
    </ul>
  );
}
