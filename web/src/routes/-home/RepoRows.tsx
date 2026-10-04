// Repositories in a list (owner ruling, links R): the name first, in Link,
// semibold; the owner's avatar beside it (a person round, an organization
// square), none on the owner's own page; its one-line description, when it has
// one; then a quiet row of facts, each led
// by its glyph and each a link to its page where one exists: projects, open
// branches, what is ready or failing (in their state colours), machines
// connected now, open issues. Zeros are left out, except open branches.
// The home's column draws them narrow (counts); an organization's page wide
// (words, and when it last moved), as GitHub lists an organization's.
import type { MonorepoSummary } from "@pando/contract";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Avatar } from "../../ui/Avatar";
import { Empty } from "../../ui/controls";
import { BranchIcon, LaptopIcon, RepoIcon } from "../../ui/Icons";
import { OpenIcon } from "../../ui/IssueIcons";
import { type AppLink, branchesLink, issuesLink, monoLink, tabLink, treeLink } from "../../ui/paths";
import { Ref } from "../../ui/Ref";
import { ago, since, useNow } from "../../ui/time";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One fact: its glyph and its count (or words), a quiet link when it has a page. `tone` colours a state. */
function Fact({ icon, link, tone = "", title, children }: { icon: ReactNode; link?: AppLink | { to: "/"; search: { in: string } }; tone?: string; title: string; children: ReactNode }) {
  const cls = `relative z-10 inline-flex items-center gap-[5px] whitespace-nowrap *:[svg]:size-[14px] *:[svg]:flex-none ${tone || "text-ash"}`;

  return link ? (
    <Link {...link} title={title} className={`${cls} decoration-1 underline-offset-3 hover:text-link hover:underline`}>
      {icon}
      {children}
    </Link>
  ) : (
    <span title={title} className={cls}>
      {icon}
      {children}
    </span>
  );
}

/** The facts of a repository's line; `words` spells them out (the wide rows). Nothing until the summary has its counts. */
function Facts({ m, words }: { m: MonorepoSummary; words: boolean }) {
  const full = m.full_name;
  const plain = m.kind === "repo";

  if (m.open_branches == null || m.repos == null) return null;
  const open = m.open_branches;
  const needs = m.needs ?? { ready: 0, conflicts: 0, failing: 0 };
  const say = (n: number, text: string) => (words ? text : String(n));
  // The repository narrowed on the home: its Needs you and its activity.
  const here = { to: "/" as const, search: { in: full } };

  return (
    <>
      {plain ? null : (
        <Fact icon={<RepoIcon />} link={treeLink(full, "projects")} title={plural(m.repos, "project", "projects")}>
          {say(m.repos, plural(m.repos, "project", "projects"))}
        </Fact>
      )}
      <Fact icon={<BranchIcon />} link={plain ? branchesLink(full, ".") : undefined} title={plural(open, "open branch", "open branches")}>
        {say(open, open ? plural(open, "open branch", "open branches") : "no open branches")}
      </Fact>
      {needs.ready ? (
        <Fact icon={<BranchIcon />} link={here} tone="text-bark" title={`${needs.ready} ready to merge`}>
          {words ? `${needs.ready} ready to merge` : `${needs.ready} ready`}
        </Fact>
      ) : null}
      {needs.conflicts ? (
        <Fact icon={<BranchIcon />} link={here} tone="text-rust" title={plural(needs.conflicts, "conflict with main", "conflicts with main")}>
          {plural(needs.conflicts, "conflict", "conflicts")}
        </Fact>
      ) : null}
      {needs.failing ? (
        <Fact icon={<BranchIcon />} link={here} tone="text-rust" title={`${needs.failing} with a failed check`}>
          {needs.failing} failing
        </Fact>
      ) : null}
      {m.machines_active ? (
        <Fact icon={<LaptopIcon />} link={plain ? undefined : tabLink(full, "machines")} title={plural(m.machines_active, "machine connected now", "machines connected now")}>
          {say(m.machines_active, `${m.machines_active} connected`)}
        </Fact>
      ) : null}
      {m.open_issues ? (
        <Fact icon={<OpenIcon />} link={issuesLink(full)} title={plural(m.open_issues, "open issue", "open issues")}>
          {say(m.open_issues, plural(m.open_issues, "open issue", "open issues"))}
        </Fact>
      ) : null}
    </>
  );
}

/**
 * The home's column: each row's link is stretched under it, so its facts can
 * be links of their own above it.
 */
export function MonorepoList({ lines }: { lines: readonly MonorepoSummary[] }) {
  const clock = useNow();

  if (!lines.length) return <Empty>No repositories yet.</Empty>;

  return (
    <ul aria-label="Repositories">
      {lines.map((m) => (
        <li key={m.id} className="border-t border-rule-faint first:border-t-0">
          <div className="group relative -mx-2.5 grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 rounded-[7px] px-2.5 py-2 hover:bg-air">
            <Link {...monoLink(m.full_name)} aria-hidden="true" tabIndex={-1} className="absolute inset-0 rounded-[7px]" />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="flex min-w-0 items-center gap-2 overflow-hidden text-[14px] leading-[18px] text-ellipsis whitespace-nowrap">
                <Avatar name={m.owner} org={m.owner_type === "org"} size={16} />
                <Ref kind="name" link={monoLink(m.full_name)} above className="min-w-0 overflow-hidden text-ellipsis">
                  <span className="font-normal">{m.owner}/</span>
                  {m.name}
                </Ref>
              </span>
              {m.description ? <span className="overflow-hidden text-[13px] leading-[17px] text-ellipsis whitespace-nowrap text-bark-dim">{m.description}</span> : null}
              <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] leading-[17px]">
                <Facts m={m} words={false} />
              </span>
            </span>
            <span className="text-[12.5px] whitespace-nowrap text-ash">{m.last_activity_at ? since(m.last_activity_at, clock) : ""}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** An organization's repositories, as GitHub lists them: the name alone (the page is the owner's), larger, then its facts in words and when it last moved. */
export function RepoRows({ lines }: { lines: readonly MonorepoSummary[] }) {
  const clock = useNow();

  if (!lines.length) return <Empty>No repositories yet.</Empty>;

  return (
    <ul aria-label="Repositories">
      {lines.map((m) => (
        <li key={m.id} className="border-t border-rule-faint first:border-t-0">
          <div className="group relative -mx-2.5 flex flex-col gap-2 rounded-[7px] px-2.5 py-4 hover:bg-air">
            <Link {...monoLink(m.full_name)} aria-hidden="true" tabIndex={-1} className="absolute inset-0 rounded-[7px]" />
            <Ref kind="name" link={monoLink(m.full_name)} above className="self-start text-[17px] leading-[22px]">
              {m.name}
            </Ref>
            {m.description ? <p className="max-w-[60em] text-[14px] leading-[20px] text-bark-dim">{m.description}</p> : null}
            <span className="flex flex-wrap items-center gap-x-[18px] gap-y-1.5 text-[13px] leading-[18px]">
              <Facts m={m} words />
              {m.last_activity_at ? <span className="text-ash">Updated {ago(m.last_activity_at, clock)}</span> : null}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
