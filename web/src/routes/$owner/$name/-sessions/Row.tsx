// One recorded session as a line, the same everywhere (owner, 2026-10-05): the repository's Sessions tab, a person's
// sessions, the branch's Sessions tab. Left to right, aligned like a table whose columns take their content's width:
// the agent's mark, the branch it leads with (at most 300 px, the full name on hover; "repository folder" when there is
// none), the issue's number (its title and state on hover), agent and model, the person (or the repository, on a
// person's page), its commits, then its start and span, or "active · 2 min ago". No title: nothing on it is written by
// a model. The whole line opens the session.
import type { Session } from "@pando/contract";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AgentMark, agentAndModel, modelName } from "../../../../ui/AgentMark";
import { Avatar } from "../../../../ui/Avatar";
import { branchLink, issueLink, sessionLink } from "../../../../ui/paths";
import { Ref } from "../../../../ui/Ref";
import { ago, useNow } from "../../../../ui/time";

/**
 * The table: mark, lead, issue, agent, who, commits, time, as the Agents table sizes its columns. `numbered` puts the
 * session's number first (the branch's tab).
 */
export const sessionTable = (numbered = false) =>
  numbered
    ? "grid w-fit max-w-full gap-x-6 grid-cols-[auto_16px_fit-content(300px)_auto_auto_auto_auto_auto] phone:w-full phone:gap-x-3 phone:grid-cols-[auto_16px_minmax(0,1fr)_auto]"
    : "grid w-fit max-w-full gap-x-6 grid-cols-[16px_fit-content(300px)_auto_auto_auto_auto_auto] phone:w-full phone:gap-x-3 phone:grid-cols-[16px_minmax(0,1fr)_auto]";

// The row is one link stretched under its cells; the cells let a click through to it, and their own links (the branch,
// the issue) sit above it.
const ROW = "relative col-span-full grid grid-cols-subgrid items-center min-h-[46px] border-t border-rule-faint px-1 text-[13.5px] text-bark-dim phone:gap-y-0.5 phone:py-2.5 [&>span]:pointer-events-none [&_a]:pointer-events-auto";

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "12 min", "2 h 10 min", "1 d 3 h": a span on the clock, idle time included (DETERMINISM.md row 8). */
export function span(fromIso: string, toIso: string): string {
  const m = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));

  if (m < 1) return "under 1 min";

  if (m < 60) return `${m} min`;

  if (m < 1440) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;

  return `${Math.floor(m / 1440)} d${Math.floor((m % 1440) / 60) ? ` ${Math.floor((m % 1440) / 60)} h` : ""}`;
}

/** "3 commits, 2 on main", "1 commit", "no commits". */
export function commitsText(commits: Session["commits"]): string {
  if (!commits.length) return "no commits";
  const on = commits.filter((c) => c.on_main).length;

  return `${commits.length} commit${commits.length === 1 ? "" : "s"}${on ? `, ${on} on main` : ""}`;
}

export const clockTime = (iso: string) => time.format(Date.parse(iso));

/** Active: "active · 2 min ago"; else its start and span, "14:31 · 12 min". */
export function When({ s }: { s: Session }) {
  const clock = useNow();

  if (s.state === "active" && s.last_at) {
    return (
      <span className="inline-flex items-center gap-1.5 text-bark">
        <span aria-hidden="true" className="inline-block size-[9px] rounded-full border-2 border-bark-dim bg-bark" />
        active · {ago(s.last_at, clock)}
      </span>
    );
  }

  return (
    <span className="text-ash">
      {s.started_at ? clockTime(s.started_at) : ""}
      {s.started_at && s.last_at ? ` · ${span(s.started_at, s.last_at)}` : ""}
    </span>
  );
}

export interface RowWhere {
  /** owner/name. */
  full: string;
  /** Repo name to its folder (projects/web), for the branch's link. */
  paths: ReadonlyMap<string, string>;
}

/** The lead: the branch (mono, a link to its page), or "repository folder". */
function Lead({ s, at }: { s: Session; at: RowWhere }) {
  const { repo, branch } = s.lead;

  if (!branch) return <span className="text-ash">repository folder</span>;
  const path = repo ? at.paths.get(repo) : undefined;

  return path ? (
    <Ref kind="object" mono above link={branchLink(at.full, path, branch)} className="block max-w-[300px] overflow-hidden text-ellipsis whitespace-nowrap" label={branch}>
      <span title={branch}>{branch}</span>
    </Ref>
  ) : (
    <span title={branch} className="block max-w-[300px] overflow-hidden font-mono text-[13px] text-ellipsis whitespace-nowrap text-link">
      {branch}
    </span>
  );
}

/** "Opus 5.5 +1": the model alone (the mark names the agent), for a phone's second line. */
const modelOnly = (models: Session["models"]) => (models[0] ? `${modelName(models[0].model)}${models.length > 1 ? ` +${models.length - 1}` : ""}` : null);

export function SessionRow({ s, at, who, whoText, number }: { s: Session; at: RowWhere; who: ReactNode; whoText?: string; number?: number | null }) {
  const issue = s.issues[0];
  const more = s.issues.length - 1;

  return (
    <li data-session={s.id} className={`${ROW} hover:bg-loam/60`}>
      <Link {...sessionLink(at.full, s.id)} aria-label={`Session on ${s.lead.branch ?? "the repository folder"}, ${agentAndModel(s.program, s.models)}, ${s.person}`} className="absolute inset-0 rounded-md" />
      {number === undefined ? null : <span className="font-semibold text-bark tabular-nums">{number === null ? "" : number}</span>}
      <AgentMark program={s.program} />
      <span className="min-w-0 phone:col-start-[span_1]">
        <Lead s={s} at={at} />
      </span>
      <span className="whitespace-nowrap phone:hidden" title={issue ? `#${issue.number} ${issue.title} (${issue.state})${more > 0 ? `, and ${more} more` : ""}` : undefined}>
        {issue ? (
          <Ref kind="object" above link={issueLink(at.full, issue.number)} className="text-ash hover:text-bark">
            #{issue.number}
            {more > 0 ? ` +${more}` : ""}
          </Ref>
        ) : null}
      </span>
      <span className="whitespace-nowrap text-bark-dim phone:hidden">{agentAndModel(s.program, s.models)}</span>
      <span className="flex min-w-0 items-center gap-[7px] whitespace-nowrap text-bark phone:hidden">{who}</span>
      <span className="whitespace-nowrap phone:hidden">{commitsText(s.commits)}</span>
      <span className="text-right text-[13px] whitespace-nowrap tabular-nums">
        <When s={s} />
      </span>
      {/* A phone: the rest on one quiet line under the branch. */}
      <span className="hidden min-w-0 overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-ash phone:col-span-2 phone:col-start-2 phone:block">
        {[issue ? `#${issue.number}` : null, modelOnly(s.models), whoText ?? s.person, commitsText(s.commits)].filter((x) => x).join(" · ")}
      </span>
    </li>
  );
}

/** The person column: their avatar and login. */
export const Person = ({ login }: { login: string }) => (
  <>
    <Avatar name={login} size={18} />
    <span className="overflow-hidden text-ellipsis">{login}</span>
  </>
);

/** "Today", "Yesterday", "Oct 3", or "Oct 3, 2025": a day header by last activity, in the browser's zone. */
export function dayLabel(iso: string, clock: number): string {
  const d = new Date(iso);
  const today = new Date(clock);
  const key = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const yesterday = new Date(clock - 86_400_000);

  if (key(d) === key(today)) return "Today";

  if (key(d) === key(yesterday)) return "Yesterday";

  return d.toLocaleDateString("en-US", d.getFullYear() === today.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** Sessions grouped by the day of their last activity, in order. */
export function byDay<T extends { last_at: string | null }>(rows: readonly T[], clock: number): { day: string; rows: T[] }[] {
  const out: { day: string; rows: T[] }[] = [];

  for (const r of rows) {
    const label = r.last_at ? dayLabel(r.last_at, clock) : "";
    const last = out.at(-1);

    if (last && last.day === label) last.rows.push(r);
    else out.push({ day: label, rows: [r] });
  }

  return out;
}

/** A day's (or a branch's) header across the table. */
export const GroupHead = ({ title, count, children }: { title: ReactNode; count: string; children?: ReactNode }) => (
  <div className="col-span-full flex items-baseline gap-3 border-t border-rule-faint px-1 pt-6 pb-2.5 text-[13.5px]">
    <span className="font-semibold text-bark">{title}</span>
    <span className="text-ash">{count}</span>
    {children}
  </div>
);
