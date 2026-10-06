// A branch's Sessions tab (owner, 2026-10-05; sessions/branch-c-tab.html): the sessions its commits name, numbered 1,
// 2, 3 by their earliest commit there (DETERMINISM.md row 28), each the list's one-line row led by its number, latest
// activity first; its commits behind one disclosure ("3 commits"), closed unless the branch has one session; opened,
// each commit one quiet line with its sha, git title and its own checks. Then sessions that ran in its worktree with no
// commit there yet, and a last line naming the commits with no session recorded. The Overview's commits carry the
// same numbers (SessionNumbers).
import type { BranchSessions, Commit, Repo, SessionCommit } from "@pando/contract";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AgentMark, agentAndModel } from "../../../../ui/AgentMark";
import { sessionLink } from "../../../../ui/paths";
import { useMonorepo } from "../-frame/heads";
import { dayClock, Person, When } from "./Row";
import { CommitChecks } from "./Session";

/** A session's number in a small box, as the Overview and the tab show it. */
export const Num = ({ n }: { n: number }) => (
  <span className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-[4px] px-1 text-[11.5px] leading-none text-bark-dim shadow-[inset_0_0_0_1px_var(--rule-hi)] tabular-nums">{n}</span>
);

/** The Overview's numbers on a commit: each session line's number, in the order of its lines. */
export function SessionNumbers({ sha, on }: { sha: string; on: BranchSessions | undefined }) {
  const nums = on?.commits.find((c) => c.sha === sha)?.sessions.filter((n) => n > 0) ?? [];

  return nums.length ? (
    <span className="mr-2 inline-flex gap-1 align-[1px]" aria-label={`Session ${nums.join(" and ")}`}>
      {nums.map((n) => (
        <Num key={n} n={n} />
      ))}
    </span>
  ) : null;
}

const ROW = "col-span-full grid grid-cols-subgrid items-center min-h-[46px] border-t border-rule-faint px-1 text-[13.5px] text-bark-dim";

function CommitLines({ repo, commits }: { repo: Repo; commits: readonly SessionCommit[] }) {
  return (
    <ul aria-label="Its commits on this branch" className="col-span-full grid grid-cols-subgrid pb-2">
      {commits.map((c) => (
        <li key={c.sha} className="col-span-full grid grid-cols-[subgrid] items-center py-1 text-[13px]">
          <span className="col-start-2 col-end-4 flex min-w-0 gap-4 pl-1">
            <span className="font-mono text-[12.5px] text-ash">{c.sha.slice(0, 7)}</span>
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-bark-dim">{c.title}</span>
          </span>
          <span className="col-start-4 col-end-[-1] text-right text-[12.5px] whitespace-nowrap">
            <CommitChecks repo={repo.name} sha={c.sha} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function SessionLine({ n, id, s, commits, repo, merged, open: first }: { n: number | null; id: string; s: BranchSessions["sessions"][number]["session"]; commits: readonly SessionCommit[]; repo: Repo; merged: boolean; open: boolean }) {
  const { monorepo } = useMonorepo();
  const [open, setOpen] = useState(first);
  const count = `${commits.length} commit${commits.length === 1 ? "" : "s"}${merged ? `, ${commits.filter((c) => c.on_main).length} on main` : ""}`;

  const disclosure = commits.length ? (
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-bark-dim hover:text-bark">
      <span aria-hidden="true" className={`inline-block text-ash transition-transform ${open ? "rotate-90" : ""}`}>
        ›
      </span>
      {count}
    </button>
  ) : (
    <span className="text-ash">no commits here</span>
  );

  return (
    <li data-branch-session={id} className="col-span-full grid grid-cols-subgrid">
      <div className={ROW}>
        {s && s.state !== "deleted" ? <AgentMark program={s.program} /> : <span />}
        <span className="flex items-center gap-2.5 whitespace-nowrap">
          {n === null ? null : <Num n={n} />}
          <Link {...sessionLink(monorepo.full, id)} className="font-semibold text-bark hover:underline">
            Session{n === null ? "" : ` ${n}`}
          </Link>
        </span>
        {s && s.state !== "deleted" ? (
          <>
            <span className="whitespace-nowrap phone:hidden">{agentAndModel(s.program, s.models)}</span>
            <span className="flex items-center gap-[7px] whitespace-nowrap text-bark phone:hidden">
              <Person login={s.person} />
            </span>
            {disclosure}
            <span className="text-right text-[13px] whitespace-nowrap tabular-nums">
              <When s={s} />
            </span>
          </>
        ) : (
          <>
            <span className="col-span-2 text-ash phone:hidden">{s ? `Session deleted by ${s.deleted_by}, ${dayClock(s.deleted_at)}` : "No record of this session here"}</span>
            {disclosure}
            <span />
          </>
        )}
      </div>
      {open && commits.length ? <CommitLines repo={repo} commits={commits} /> : null}
    </li>
  );
}

export function BranchSessionsTab({ repo, branch, merged, on, commits }: { repo: Repo; branch: string; merged: boolean; on: BranchSessions | undefined; commits: readonly Commit[] }) {
  if (!on) return null;
  // Latest activity first; a session with no record here (or deleted) by its number.
  const lastOf = (x: BranchSessions["sessions"][number]) => (x.session && x.session.state !== "deleted" ? (x.session.last_at ?? "") : "");
  const rows = [...on.sessions].sort((a, b) => lastOf(b).localeCompare(lastOf(a)) || (a.number ?? 0) - (b.number ?? 0));
  const named = new Set(on.commits.map((c) => c.sha));
  const none = commits.filter((c) => !named.has(c.sha));

  if (!rows.length) return <p className="py-2.5 text-[13.5px] text-ash">No agent sessions on {branch}.</p>;

  return (
    <>
      <ul aria-label="Sessions on this branch" className="grid w-fit max-w-full grid-cols-[16px_auto_auto_auto_auto_auto] gap-x-6 border-b border-rule-faint phone:w-full phone:grid-cols-[16px_minmax(0,1fr)_auto_auto]">
        {rows.map((x) => (
          <SessionLine key={x.id} n={x.number} id={x.id} s={x.session} commits={x.commits} repo={repo} merged={merged} open={rows.length === 1} />
        ))}
      </ul>
      {none.length ? (
        <p className="mt-6 text-[13.5px] text-ash">
          No session recorded:{" "}
          {none.map((c, i) => (
            <span key={c.sha}>
              {i ? ", " : ""}
              <code className="text-bark-dim">{c.sha.slice(0, 7)}</code> {c.title}
            </span>
          ))}
        </p>
      ) : null}
    </>
  );
}
