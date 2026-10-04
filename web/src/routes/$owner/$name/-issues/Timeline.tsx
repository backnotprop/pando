// The issue's timeline (SPEC.md 7.3): the body first as a comment box, then
// comments as the same boxes and events as single lines on a quiet rule, each
// with its glyph and time. A long timeline shows its first and last items with
// "Show N more" between. Each box names the person and, quietly, the machine
// (owner ruling: "ramos, sandbox-1"); its menu has Edit, Copy link and Delete.
import { ApiError, type Issue, type IssueComment, type ReactionGroup, type TimelineItem } from "@pando/contract";
import { Menu } from "@base-ui/react/menu";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { deleteComment, editComment, editIssue, issueKey, issueQuery, readComment, readGap, type TimelineRead, timelineQuery } from "../../../../api/issues";
import { takeArrived } from "../../../../live/arrivals";
import { issueArrival, withComment } from "../../../../live/issues";
import { Avatar } from "../../../../ui/Avatar";
import { button, Refusal, useCopy } from "../../../../ui/controls";
import { BranchIcon } from "../../../../ui/Icons";
import { DoneIcon, DotsIcon, NotPlannedIcon, PenIcon, PersonIcon, ReopenIcon, TagIcon } from "../../../../ui/IssueIcons";
import { MenuPopup, menuItem } from "../../../../ui/menu";
import { absolute, branchLink } from "../../../../ui/paths";
import { ago, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { Editor } from "./Editor";
import { Markdown } from "./Markdown";
import { LabelChip, useMe } from "./parts";
import { AddReaction, ReactionPills, useReactions } from "./Reactions";

/** What a box holds: the issue's body, or a comment. */
interface Said {
  id: string | null;
  author: string;
  machine: string | null;
  at: string;
  body: string | null;
  version: number;
  reactions: readonly ReactionGroup[];
}

/** A stale edit: the server's text now, and whose. */
interface Clash {
  who: string;
  text: string;
}

/** The body or a comment: its header (person, machine, time, menu), the Markdown, its reactions; Edit opens the editor in place. */
function Box({ n, said, isBody, arrival, onSaved }: { n: number; said: Said; isBody: boolean; arrival: string | null; onSaved: (text: string, version: number) => void }) {
  const { monorepo, info } = useMonorepo();
  const qc = useQueryClient();
  const clock = useNow();
  const me = useMe();
  const [editing, setEditing] = useState<string | null>(null);
  const [clash, setClash] = useState<Clash | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Only a comment that arrived live (someone else's) plays the arrival, once.
  const [fresh] = useState(() => (arrival ? takeArrived(arrival) : false));
  const [copied, copy] = useCopy("Copy link");
  const anchor = said.id ? `comment-${said.id}` : "issue-body";
  const timeline = timelineQuery(monorepo, n).queryKey;

  const save = useMutation({
    mutationFn: async (text: string) => {
      if (said.id) {
        const c = await editComment(monorepo, n, said.id, text, said.version);

        return { text: c.body ?? text, version: c.body_version };
      }

      const issue = await editIssue(monorepo, n, { body: text, base_version: said.version });

      return { text: issue.body, version: issue.body_version };
    },
    onSuccess: (out) => {
      onSaved(out.text, out.version);
      setEditing(null);
      setClash(null);
    },
    onError: async (error) => {
      if (!(error instanceof ApiError && error.code === "edited")) return;

      // Someone saved first: theirs is shown (and is what the next Save replaces), yours stays in the editor to copy.
      if (said.id) {
        const now = await readComment(monorepo, n, said.id);

        qc.setQueryData<TimelineRead>(timeline, (t) => t && { ...t, items: withComment(t.items, now) });
        setClash({ who: said.author, text: now.body ?? "" });
      } else {
        const now = await qc.fetchQuery({ ...issueQuery(monorepo, n), staleTime: 0 });

        setClash({ who: said.author, text: now.body });
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteComment(monorepo, n, said.id ?? ""),
    onSuccess: () => qc.setQueryData<TimelineRead>(timeline, (t) => t && { ...t, items: t.items.filter((x) => !(x.kind === "comment" && x.comment.id === said.id)) }),
  });

  const setReactions = (reactions: readonly ReactionGroup[]) => {
    if (said.id) {
      const id = said.id;

      qc.setQueryData<TimelineRead>(timeline, (t) => {
        const c = t?.items.find((x): x is Extract<TimelineItem, { kind: "comment" }> => x.kind === "comment" && x.comment.id === id);

        return t && c ? { ...t, items: withComment(t.items, { ...c.comment, reactions }) } : t;
      });
    } else {
      qc.setQueryData<Issue>(issueKey(monorepo, n), (issue) => issue && { ...issue, reactions });
    }
  };

  const reacting = useReactions(n, said.id, said.reactions, setReactions);
  const mine = said.author === me;
  const canDelete = !isBody && (mine || info.role === "owner");
  const href = absolute(`/${monorepo.full}/issues/${n}${isBody ? "" : `#${anchor}`}`);

  return (
    <section id={anchor} aria-label={isBody ? "Description" : `Comment by ${said.author}`} className={`relative mb-[18px] rounded-[10px] border border-rootline bg-soil ${fresh ? "arrived" : ""}`}>
      <header className="flex min-h-[42px] items-center gap-2.5 rounded-t-[10px] border-b border-rule-faint bg-loam px-3.5 py-2 text-[13.5px] text-ash">
        <Avatar name={said.author} size={20} />
        <span className="fox-cool font-semibold text-bark">{said.author}</span>
        {said.machine ? <span>{said.machine}</span> : null}
        <a href={`#${anchor}`} className="whitespace-nowrap hover:text-bark">
          {ago(said.at, clock)}
        </a>
        <span className="ml-auto flex items-center gap-2">
          {isBody ? <span className="h-5 rounded-[5px] px-[7px] text-[11.5px] leading-5 text-bark-dim shadow-[inset_0_0_0_1px_var(--rule-hi)] phone:hidden">Author</span> : null}
          <AddReaction r={reacting} />
          <Menu.Root>
            <Menu.Trigger aria-label={isBody ? "The issue's menu" : `${said.author}'s comment menu`} className="flex size-6 cursor-pointer items-center justify-center rounded-md text-ash hover:bg-pop-hi hover:text-bark data-popup-open:bg-pop-hi">
              <DotsIcon className="size-4" />
            </Menu.Trigger>
            <MenuPopup align="end">
              {mine || isBody ? (
                <Menu.Item className={menuItem} onClick={() => setEditing(said.body ?? "")}>
                  Edit
                </Menu.Item>
              ) : null}
              <Menu.Item className={menuItem} closeOnClick={false} onClick={() => copy(href)}>
                {copied}
              </Menu.Item>
              {canDelete ? (
                <Menu.Item className={`${menuItem} text-rust data-highlighted:text-rust`} onClick={() => setDeleting(true)}>
                  Delete
                </Menu.Item>
              ) : null}
            </MenuPopup>
          </Menu.Root>
        </span>
      </header>
      {deleting ? (
        <div className="flex items-center gap-3 border-b border-rule-faint px-5 py-2.5 text-[13.5px] text-bark-dim">
          Delete this comment?
          <button type="button" className={button("danger", 28)} disabled={remove.isPending} onClick={() => remove.mutate()}>
            Delete
          </button>
          <button type="button" className={button("quiet", 28)} onClick={() => setDeleting(false)}>
            Cancel
          </button>
          <Refusal error={remove.error} />
        </div>
      ) : null}
      {editing === null ? (
        <>
          <div className="px-5 pt-4 pb-1 phone:px-3.5">{said.body?.trim() ? <Markdown text={said.body} full={monorepo.full} /> : <p className="pb-3 text-[14px] text-ash italic">No description provided.</p>}</div>
          <ReactionPills r={reacting} />
        </>
      ) : (
        <div className="p-3">
          {clash ? (
            <div className="mb-3 rounded-[8px] bg-loam px-4 pt-3 pb-1">
              <p className="mb-2 text-[13.5px] text-bark">{clash.who === me ? "This was edited elsewhere while you were editing." : `${clash.who} edited this while you were editing.`} Theirs is below; yours is kept in the box.</p>
              <Markdown text={clash.text} full={monorepo.full} />
            </div>
          ) : null}
          <Editor
            label={isBody ? "Description" : "Comment"}
            value={editing}
            onChange={setEditing}
            full={monorepo.full}
            placeholder="Leave a comment"
            onSubmit={() => save.mutate(editing)}
            footer={
              <>
                <Refusal error={save.error instanceof ApiError && save.error.code === "edited" ? null : save.error} />
                <button
                  type="button"
                  className={button("quiet")}
                  onClick={() => {
                    setEditing(null);
                    setClash(null);
                  }}
                >
                  Cancel
                </button>
                <button type="button" className={button("solid")} disabled={save.isPending} onClick={() => save.mutate(editing)}>
                  Save
                </button>
              </>
            }
          />
        </div>
      )}
    </section>
  );
}

const code = "font-mono text-[13px] text-bark";

const sha = (s: string) => <code className="text-[12.5px] text-ash">{s.slice(0, 7)}</code>;

function BranchName({ repoPath, branch }: { repoPath: string; branch: string }) {
  const { monorepo } = useMonorepo();

  return (
    <Link {...branchLink(monorepo.full, repoPath, branch)} className={`${code} hover:underline hover:decoration-ash hover:underline-offset-3`}>
      {branch}
    </Link>
  );
}

/** An event's glyph and its words. Null for a kind with no line (a comment is a box). */
function eventOf(x: TimelineItem, actor: string): { glyph: ReactNode; words: ReactNode; big?: boolean } | null {
  const who = <span className="fox-cool text-bark">{actor}</span>;
  const tag = <TagIcon className="size-3.5" />;

  switch (x.kind) {
    case "comment":
      return null;
    case "labeled":
    case "unlabeled":
      return {
        glyph: tag,
        words: (
          <>
            {who} {x.kind === "labeled" ? "added" : "removed"} <LabelChip label={x.label} />
          </>
        ),
      };
    case "assigned":
    case "unassigned":
      return {
        glyph: <PersonIcon className="size-3.5" />,
        words:
          x.assignee === x.actor ? (
            <>
              {who} {x.kind === "assigned" ? "self-assigned this" : "removed their assignment"}
            </>
          ) : (
            <>
              {who} {x.kind === "assigned" ? "assigned" : "unassigned"} <span className="text-bark">{x.assignee}</span>
            </>
          ),
      };
    case "renamed":
      return {
        glyph: <PenIcon className="size-3.5" />,
        words: (
          <>
            {who} changed the title from <span className="text-bark line-through decoration-ash">{x.from}</span> to <span className="text-bark">{x.to}</span>
          </>
        ),
      };
    case "project_changed":
      return {
        glyph: <PenIcon className="size-3.5" />,
        words: x.to_path ? (
          <>
            {who} moved this to <span className="text-bark">{x.to_path}</span>
          </>
        ) : (
          <>{who} removed the project</>
        ),
      };
    case "linked":
      return {
        glyph: <BranchIcon className="size-3.5" />,
        words: (
          <>
            {who} linked <BranchName repoPath={x.repo_path} branch={x.branch} />
            {x.source === "commit" ? <> from a commit {x.sha ? sha(x.sha) : null}</> : x.source === "title" ? " named in the branch title" : null}
          </>
        ),
      };
    case "unlinked":
      return {
        glyph: <BranchIcon className="size-3.5" />,
        words: (
          <>
            {who} unlinked <BranchName repoPath={x.repo_path} branch={x.branch} />
          </>
        ),
      };
    case "closed":
      return {
        big: true,
        glyph: x.reason === "not_planned" ? <NotPlannedIcon className="size-[15px]" /> : <DoneIcon className="size-[15px]" />,
        words: x.merge ? (
          <>
            {who} closed this as completed by merging <BranchName repoPath={x.merge.repo_path} branch={x.merge.branch} /> into main {sha(x.merge.merge_commit)}
          </>
        ) : (
          <>
            {who} closed this as {x.reason === "not_planned" ? "not planned" : "completed"}
          </>
        ),
      };
    case "reopened":
      return { glyph: <ReopenIcon className="size-3.5" />, words: <>{who} reopened this</> };
    case "merge_referenced":
      return {
        glyph: <BranchIcon className="size-3.5" />,
        words: (
          <>
            {who} merged <BranchName repoPath={x.merge.repo_path} branch={x.merge.branch} /> into main, which also names this issue {sha(x.merge.merge_commit)}
          </>
        ),
      };
  }
}

function EventLine({ x, arrival }: { x: TimelineItem; arrival: string }) {
  const clock = useNow();
  const [fresh] = useState(() => takeArrived(arrival));
  const shown = eventOf(x, x.actor ?? "Pando");

  if (!shown) return null;

  return (
    <div className={`relative mb-3.5 flex min-h-9 flex-wrap items-center gap-x-1.5 gap-y-1 pl-[46px] text-[13.5px] text-bark-dim phone:pl-10 phone:text-[13px] ${shown.big ? "min-h-11 text-[14px]" : ""} ${fresh ? "arrived" : ""}`}>
      <span
        className={`absolute top-1/2 left-2 -mt-3 flex size-[25px] items-center justify-center rounded-full shadow-[0_0_0_4px_var(--soil)] phone:left-1 ${shown.big ? "bg-bark-dim text-soil" : "bg-loam text-ash"}`}
      >
        {shown.glyph}
      </span>
      {x.actor ? (
        <span className="mr-0.5 inline-flex">
          <Avatar name={x.actor} size={16} />
        </span>
      ) : null}
      {shown.words}
      <span className="ml-1 text-ash">{ago(x.at, clock)}</span>
    </div>
  );
}

const saidOf = (c: IssueComment): Said => ({ id: c.id, author: c.author, machine: c.machine, at: c.created_at, body: c.body, version: c.body_version, reactions: c.reactions });

export function Timeline({ issue, timeline }: { issue: Issue; timeline: TimelineRead }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const n = issue.number;
  const key = timelineQuery(monorepo, n).queryKey;
  const more = useMutation({ mutationFn: () => readGap(monorepo, n, timeline), onSuccess: (t) => qc.setQueryData(key, t) });
  const body: Said = { id: null, author: issue.author, machine: issue.machine, at: issue.created_at, body: issue.body, version: issue.body_version, reactions: issue.reactions };
  const gapAt = timeline.gap ? timeline.items.findIndex((x) => x.id > (timeline.gap?.after ?? 0)) : -1;

  const item = (x: TimelineItem) => {
    const arrival = issueArrival(monorepo, `item:${x.id}`);

    return x.kind === "comment" ? (
      <Box
        key={x.comment.id}
        n={n}
        said={saidOf(x.comment)}
        isBody={false}
        arrival={arrival}
        onSaved={(text, version) => qc.setQueryData<TimelineRead>(key, (t) => t && { ...t, items: withComment(t.items, { ...x.comment, body: text, body_version: version }) })}
      />
    ) : (
      <EventLine key={x.id} x={x} arrival={arrival} />
    );
  };

  return (
    <div className="relative before:absolute before:top-2 before:bottom-0 before:left-5 before:border-l before:border-rootline phone:before:left-4">
      <Box n={n} said={body} isBody arrival={null} onSaved={(text, version) => qc.setQueryData<Issue>(issueKey(monorepo, n), (i) => i && { ...i, body: text, body_version: version })} />
      {timeline.items.map((x, i) => (
        <TimelineSlot key={x.kind === "comment" ? x.comment.id : x.id} gap={i === gapAt && timeline.gap ? { count: timeline.gap.count, loading: more.isPending, load: () => more.mutate() } : null}>
          {item(x)}
        </TimelineSlot>
      ))}
    </div>
  );
}

/** An item, with "Show N more" before it where the hidden ones sit. */
function TimelineSlot({ gap, children }: { gap: { count: number; loading: boolean; load: () => void } | null; children: ReactNode }) {
  return (
    <>
      {gap ? (
        <div className="relative mb-3.5 pl-[46px] phone:pl-10">
          <button type="button" className={button("quiet", 30)} disabled={gap.loading} onClick={gap.load}>
            Show {gap.count} more
          </button>
        </div>
      ) : null}
      {children}
    </>
  );
}
