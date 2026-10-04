// The issue's sidebar (SPEC.md 7.3): Assignees, Labels, Project, Development
// and Participants. Each heading opens a picker; a change applies as one PATCH
// when it closes. On a phone the facts come first, as compact rows, so a
// linked branch shows without scrolling (7.9). New issue uses the same three
// pickers on its own draft (`draft`).
import type { Issue, IssueLink, Label } from "@pando/contract";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { labelsQuery, linkableBranchesQuery } from "../../../../api/issues";
import { membersQuery, reposQuery } from "../../../../api/queries";
import { Avatar } from "../../../../ui/Avatar";
import { lnk } from "../../../../ui/controls";
import { BranchIcon } from "../../../../ui/Icons";
import { GearIcon, MergeIcon } from "../../../../ui/IssueIcons";
import { branchLink } from "../../../../ui/paths";
import { ago, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { type PickOption, Picker } from "./Picker";
import { LabelChip, useMe } from "./parts";

const heading = "flex w-full cursor-pointer items-center justify-between text-[13px] leading-[18px] font-semibold text-bark-dim hover:text-bark data-popup-open:text-bark phone:font-normal phone:text-ash";

/** A section: its heading (the picker's trigger when there is one) and its value. */
function Section({ title, picker, children, wide = false }: { title: string; picker?: (trigger: ReactNode) => ReactNode; children: ReactNode; wide?: boolean }) {
  const trigger = (
    <>
      {title}
      <GearIcon className="size-3.5 text-ash phone:hidden" />
    </>
  );

  return (
    <section
      aria-label={title}
      className={`mb-[18px] border-b border-rule-faint pb-[18px] last:border-b-0 phone:m-0 phone:grid phone:grid-cols-[96px_minmax(0,1fr)] phone:items-start phone:gap-3 phone:py-2.5 phone:last:border-b ${wide ? "phone:hidden" : ""}`}
    >
      <div className="mb-2.5 phone:mb-0">{picker ? picker(trigger) : <h3 className={heading}>{title}</h3>}</div>
      <div className="flex flex-col gap-2 text-[13.5px] text-bark">{children}</div>
    </section>
  );
}

/** The draft or the issue's assignees, labels and project, and how a pick changes them. */
export interface Facts {
  assignees: readonly string[];
  labels: readonly Label[];
  project: string | null;
  projectPath: string | null;
}

export interface FactChange {
  assignees?: { add: readonly string[]; remove: readonly string[] };
  labels?: { add: readonly string[]; remove: readonly string[] };
  project?: string | null;
}

const diff = (was: readonly string[], now: readonly string[]) => ({ add: now.filter((x) => !was.includes(x)), remove: was.filter((x) => !now.includes(x)) });

export function FactSections({ facts, onChange }: { facts: Facts; onChange: (change: FactChange) => void }) {
  const { monorepo, info } = useMonorepo();
  const me = useMe();
  const members = useQuery(membersQuery(monorepo)).data ?? [];
  const labels = useQuery(labelsQuery(monorepo)).data ?? [];
  const repos = useQuery({ ...reposQuery(monorepo), enabled: info.kind === "monorepo" }).data ?? [];

  const people: PickOption[] = [...members]
    .sort((a, b) => Number(b.login === me) - Number(a.login === me) || a.login.localeCompare(b.login))
    .map((p) => ({
      id: p.login,
      text: p.login,
      node: (
        <>
          <Avatar name={p.login} size={18} />
          <span className="text-bark">{p.login}</span>
          {p.name ? <span className="text-[12px] text-ash">{p.name}</span> : null}
        </>
      ),
    }));

  const labelOptions: PickOption[] = labels.map((l) => ({ id: l.name, text: l.name, node: <LabelChip label={l} />, hint: l.description ?? undefined }));
  const projects: PickOption[] = [{ id: "", text: "No project" }, ...repos.filter((r) => r.path !== ".").map((r) => ({ id: r.name, text: r.path }))];
  const names = facts.labels.map((l) => l.name);

  return (
    <>
      <Section
        title="Assignees"
        picker={(t) => (
          <Picker label="Assignees" heading="Assign up to 10 people" trigger={t} triggerClass={heading} options={people} selected={facts.assignees} multi onDone={(next) => onChange({ assignees: diff(facts.assignees, next) })} />
        )}
      >
        {facts.assignees.length ? (
          facts.assignees.map((a) => (
            <span key={a} className="flex items-center gap-2">
              <Avatar name={a} size={20} />
              {a}
            </span>
          ))
        ) : (
          <span className="text-[13px] text-ash">
            No one
            {me ? (
              <>
                ,{" "}
                <button type="button" className={lnk} onClick={() => onChange({ assignees: { add: [me], remove: [] } })}>
                  assign yourself
                </button>
              </>
            ) : null}
          </span>
        )}
      </Section>
      <Section
        title="Labels"
        picker={(t) => <Picker label="Labels" heading="Labels" trigger={t} triggerClass={heading} options={labelOptions} selected={names} multi onDone={(next) => onChange({ labels: diff(names, next) })} />}
      >
        {facts.labels.length ? (
          <span className="flex flex-wrap gap-1.5">
            {facts.labels.map((l) => (
              <LabelChip key={l.name} label={l} full={monorepo.full} />
            ))}
          </span>
        ) : (
          <span className="text-[13px] text-ash">None yet</span>
        )}
      </Section>
      {info.kind === "monorepo" ? (
        <Section
          title="Project"
          picker={(t) => <Picker label="Project" heading="Project" trigger={t} triggerClass={heading} options={projects} selected={[facts.project ?? ""]} onDone={([next = ""]) => onChange({ project: next || null })} />}
        >
          {facts.projectPath ? <span>{facts.projectPath}</span> : <span className="text-[13px] text-ash">None</span>}
        </Section>
      ) : null}
    </>
  );
}

const STATE_WORDS: Record<IssueLink["branch_state"], { text: string; tone: string }> = {
  open: { text: "Open", tone: "text-ash" },
  ready: { text: "Ready to merge", tone: "font-semibold text-bark" },
  conflicts: { text: "Conflicts with main", tone: "font-semibold text-rust" },
  failing: { text: "Checks failing", tone: "font-semibold text-rust" },
  merged: { text: "Merged", tone: "text-bark-dim" },
  deleted: { text: "Deleted", tone: "text-ash" },
};

/** How a branch is linked, quietly: "from a commit", "named in the branch title", "linked by ana". */
const howLinked = (l: IssueLink) =>
  l.sources.map((s) => (s === "commit" ? "from a commit" : s === "title" ? "named in the branch title" : `linked by ${l.linked_by ?? "someone"}`)).join(", ");

function DevRow({ link }: { link: IssueLink }) {
  const { monorepo } = useMonorepo();
  const clock = useNow();
  const word = STATE_WORDS[link.branch_state];
  const merged = link.branch_state === "merged";

  return (
    <div className="flex flex-col gap-[3px]">
      <span className="flex min-w-0 items-center gap-2">
        {merged ? <MergeIcon className="size-3.5 flex-none text-ash" /> : <BranchIcon className="size-3.5 flex-none text-ash" />}
        {link.branch_state === "deleted" ? (
          <code className="overflow-hidden text-[13px] text-ellipsis text-bark-dim">{link.branch}</code>
        ) : (
          <Link {...branchLink(monorepo.full, link.repo_path, link.branch)} className="overflow-hidden font-mono text-[13px] text-ellipsis whitespace-nowrap text-bark hover:underline hover:decoration-ash hover:underline-offset-3">
            {link.branch}
          </Link>
        )}
        <span className={`text-[12.5px] whitespace-nowrap ${word.tone}`}>{word.text}</span>
      </span>
      <span className="pl-[22px] text-[12.5px] text-ash">
        {link.repo_path === "." ? "" : link.repo_path}
        {merged && link.merged_at ? `${link.repo_path === "." ? "" : " · "}into main, ${ago(link.merged_at, clock)}` : ""}
      </span>
      <span className="pl-[22px] text-[12.5px] text-ash">
        <span className="text-bark-dim">{merged ? (link.closed_issue ? "Closed this issue" : "Merged") : link.branch_state === "deleted" ? "Deleted" : "Closes this issue on merge"}</span>
        {` · ${howLinked(link)}`}
      </span>
    </div>
  );
}

/** Development: the linked branches, and a picker of open branches to link (or unlink, for an explicit link). */
function Development({ issue, onLinks }: { issue: Issue; onLinks: (link: readonly string[], unlink: readonly string[]) => void }) {
  const { monorepo } = useMonorepo();
  const repos = (useQuery(reposQuery(monorepo)).data ?? []).filter((r) => r.path !== "meta");
  const open = useQueries({ queries: repos.map((r) => linkableBranchesQuery(monorepo, r.name)) });
  const branches = repos.flatMap((r, i) => (open[i]?.data ?? []).map((branch) => ({ repo: r, branch })));
  const id = (repo: string, branch: string) => `${repo}:${branch}`;
  const explicit = issue.links.filter((l) => l.sources.includes("link")).map((l) => id(l.repo, l.branch));

  const options: PickOption[] = branches.map((b) => ({
    id: id(b.repo.name, b.branch),
    text: `${b.branch} ${b.repo.path}`,
    node: (
      <>
        <code className="text-[13px] text-bark">{b.branch}</code>
        {b.repo.path === "." ? null : <span className="text-[12px] text-ash">{b.repo.path}</span>}
      </>
    ),
  }));

  const picker = (trigger: ReactNode, cls: string) => (
    <Picker
      label="Link a branch"
      heading="Link a branch"
      trigger={trigger}
      triggerClass={cls}
      options={options}
      selected={explicit}
      multi
      findAt={0}
      onDone={(next) => onLinks(next.filter((x) => !explicit.includes(x)), explicit.filter((x) => !next.includes(x)))}
    />
  );

  return (
    <Section title="Development" picker={(t) => picker(t, heading)}>
      {issue.links.map((l) => (
        <DevRow key={id(l.repo, l.branch)} link={l} />
      ))}
      <span className="phone:hidden">{picker("Link a branch", `${lnk} text-[13px]`)}</span>
    </Section>
  );
}

export function IssueSidebar({ issue, onChange, onLinks }: { issue: Issue; onChange: (change: FactChange) => void; onLinks: (link: readonly string[], unlink: readonly string[]) => void }) {
  return (
    <>
      <FactSections facts={{ assignees: issue.assignees, labels: issue.labels, project: issue.project, projectPath: issue.project_path }} onChange={onChange} />
      <Development issue={issue} onLinks={onLinks} />
      <Section title="Participants" wide>
        <span className="flex flex-wrap gap-1.5" aria-label="Participants">
          {issue.participants.map((p) => (
            <span key={p} title={p}>
              <Avatar name={p} size={22} />
            </span>
          ))}
        </span>
      </Section>
    </>
  );
}
