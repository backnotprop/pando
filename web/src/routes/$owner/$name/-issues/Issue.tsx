// An issue's page (SPEC.md 7.3): the title with its number (Edit renames it
// in place; New issue), the state chip and who opened it; then the timeline
// with the composer at its end, and the sidebar. It is live on `issue:<n>`,
// and on the repos of its linked branches, so their states move too.
import { Menu } from "@base-ui/react/menu";
import type { Issue, IssueStateReason } from "@pando/contract";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { addComment, editIssue, issueKey, issueQuery, newKey, type TimelineRead, timelineQuery } from "../../../../api/issues";
import type { JsonBody, JsonValue } from "../../../../api/client";
import { withItems } from "../../../../live/issues";
import { fallback, useRows } from "../../../../live/rows";
import { button, field, Refusal } from "../../../../ui/controls";
import { Chevron } from "../../../../ui/Icons";
import { DoneIcon, NotPlannedIcon, OpenIcon, ReopenIcon } from "../../../../ui/IssueIcons";
import { MenuPopup, menuItem } from "../../../../ui/menu";
import { newIssueLink, ownerLink } from "../../../../ui/paths";
import { Ref } from "../../../../ui/Ref";
import { ago, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { Editor } from "./Editor";
import { useMe } from "./parts";
import { type FactChange, IssueSidebar } from "./Sidebar";
import { Timeline } from "./Timeline";

/** The state in words first, with its glyph: Open, Closed, Closed as not planned. */
function StateChip({ issue }: { issue: Issue }) {
  const chip = "inline-flex h-7 flex-none items-center gap-[7px] rounded-[14px] bg-loam pr-3 pl-2.5 text-[13px] font-semibold";

  if (issue.state === "open") {
    return (
      <span role="status" aria-label="State" className={`${chip} text-bark shadow-[inset_0_0_0_1px_var(--rule-hi)]`}>
        <OpenIcon className="size-[15px]" />
        Open
      </span>
    );
  }

  return (
    <span role="status" aria-label="State" className={`${chip} text-bark-dim`}>
      {issue.state_reason === "not_planned" ? <NotPlannedIcon className="size-[15px]" /> : <DoneIcon className="size-[15px]" />}
      {issue.state_reason === "not_planned" ? "Closed as not planned" : "Closed"}
    </span>
  );
}

/** The title, and Edit to rename it in place. */
function Head({ issue, onPatch }: { issue: Issue; onPatch: (patch: JsonBody) => Promise<Issue> }) {
  const { monorepo } = useMonorepo();
  const clock = useNow();
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const save = async () => {
    if (title === null || !title.trim() || title.trim() === issue.title) {
      setTitle(null);

      return;
    }

    try {
      await onPatch({ title: title.trim() });
      setTitle(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : null);
    }
  };

  return (
    <>
      {title === null ? (
        <div className="flex items-start justify-between gap-8 phone:flex-col phone:gap-3">
          <h1 className="max-w-[30em] text-[26px] leading-8 tracking-[-.018em] text-balance phone:text-[22px] phone:leading-7">
            {issue.title}
            <span className="ml-2 text-ash">#{issue.number}</span>
          </h1>
          <div className="flex flex-none gap-2.5 phone:hidden">
            <button type="button" className={button("quiet")} onClick={() => setTitle(issue.title)}>
              Edit
            </button>
            <Link {...newIssueLink(monorepo.full)} className={button("solid")}>
              New issue
            </Link>
          </div>
        </div>
      ) : (
        <form
          className="flex items-center gap-2.5 phone:flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input autoFocus aria-label="Title" maxLength={256} value={title} onChange={(e) => setTitle(e.target.value)} className={`${field} h-[38px] flex-1 text-[15px]`} />
          <button type="submit" className={button("solid")}>
            Save
          </button>
          <button type="button" className={button("quiet")} onClick={() => setTitle(null)}>
            Cancel
          </button>
        </form>
      )}
      <Refusal error={error} />
      <div className="mt-3.5 flex items-center gap-3 text-[14px] text-bark-dim phone:flex-wrap phone:gap-x-2.5 phone:gap-y-2 phone:text-[13.5px]">
        <StateChip issue={issue} />
        <span>
          <Ref kind="person" link={ownerLink(issue.author)}>
            {issue.author}
          </Ref>{" "}
          opened this {ago(issue.created_at, clock)} · {issue.comments} comment{issue.comments === 1 ? "" : "s"}
        </span>
      </div>
    </>
  );
}

const REASONS: { id: IssueStateReason; name: string; hint: string; icon: ReactNode }[] = [
  { id: "completed", name: "Close as completed", hint: "Done, fixed or resolved", icon: <DoneIcon className="size-4" /> },
  { id: "not_planned", name: "Close as not planned", hint: "Won't fix, can't reproduce, duplicate or stale", icon: <NotPlannedIcon className="size-4" /> },
];

/** The composer: the editor, then Close issue (a split button: completed, not planned) or Reopen issue, and Comment. */
function Composer({ issue, onPatch }: { issue: Issue; onPatch: (patch: JsonBody) => Promise<Issue> }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  // One key per comment being written, kept across its retries.
  const [attempt, setAttempt] = useState(newKey);
  const n = issue.number;
  const timeline = timelineQuery(monorepo, n).queryKey;
  const me = useMe();

  const post = async () => {
    const body = text;
    const c = await addComment(monorepo, n, body, attempt);

    // Shown at once from the answer, after every item so far; its event then puts it in its place (by the comment's id).
    qc.setQueryData<TimelineRead>(timeline, (t) => t && { ...t, items: withItems(t.items, [{ kind: "comment", id: 1e15 + Date.now(), at: c.created_at, actor: c.author, machine: c.machine, comment: c }]) });
    qc.setQueryData<Issue>(issueKey(monorepo, n), (i) => i && { ...i, comments: i.comments + 1, participants: me && !i.participants.includes(me) ? [...i.participants, me] : i.participants });
    setText("");
    setAttempt(newKey());
  };

  const act = useMutation({
    mutationFn: async (what: { comment: boolean; state?: "open" | "closed"; reason?: IssueStateReason }) => {
      if (what.comment && text.trim()) await post();

      if (what.state) await onPatch(what.state === "closed" ? { state: "closed", state_reason: what.reason ?? "completed" } : { state: "open" });
    },
  });

  const wrote = text.trim().length > 0;
  const closed = issue.state === "closed";

  const footer = (
    <>
      <Refusal error={act.error} />
      {closed ? (
        <button type="button" className={`${button("quiet")} gap-1.5`} disabled={act.isPending} onClick={() => act.mutate({ comment: true, state: "open" })}>
          <ReopenIcon className="size-4" />
          {wrote ? "Reopen with comment" : "Reopen issue"}
        </button>
      ) : (
        <span className="inline-flex">
          <button type="button" className={`${button("quiet")} gap-1.5 rounded-r-none`} disabled={act.isPending} onClick={() => act.mutate({ comment: true, state: "closed", reason: "completed" })}>
            <DoneIcon className="size-4" />
            {wrote ? "Close with comment" : "Close issue"}
          </button>
          <Menu.Root>
            <Menu.Trigger aria-label="Close as" className={`${button("quiet")} ml-px rounded-l-none px-2`} disabled={act.isPending}>
              <Chevron className="size-[13px]" />
            </Menu.Trigger>
            <MenuPopup align="end">
              {REASONS.map((r) => (
                <Menu.Item key={r.id} className={`${menuItem} h-auto items-start py-2`} onClick={() => act.mutate({ comment: true, state: "closed", reason: r.id })}>
                  <span className="mt-0.5 text-bark-dim">{r.icon}</span>
                  <span className="flex flex-col gap-0.5">
                    <span className="text-bark">{r.name}</span>
                    <span className="text-[12px] text-ash">{r.hint}</span>
                  </span>
                </Menu.Item>
              ))}
            </MenuPopup>
          </Menu.Root>
        </span>
      )}
      <button type="button" className={button("solid")} disabled={!wrote || act.isPending} onClick={() => act.mutate({ comment: true })}>
        Comment
      </button>
    </>
  );

  return (
    <div className="relative mt-[26px] bg-soil">
      <Editor label="Comment" value={text} onChange={setText} full={monorepo.full} placeholder="Add a comment" onSubmit={() => wrote && act.mutate({ comment: true })} footer={footer} />
    </div>
  );
}

export function IssuePage({ n }: { n: number }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const key = issueKey(monorepo, n);
  const cached = qc.getQueryData<Issue>(key);
  // The issue's own topic, and its linked branches' repos (their states move on their rows): at most 10.
  const topics = [`issue:${n}`, ...new Set((cached?.links ?? []).map((l) => `repo:${l.repo}`))].slice(0, 10);

  const live = useRows(monorepo, topics, () => {
    void qc.invalidateQueries({ queryKey: key });
  });

  const issue = useSuspenseQuery({ ...issueQuery(monorepo, n), refetchInterval: fallback(live) }).data;
  const timeline = useSuspenseQuery({ ...timelineQuery(monorepo, n), refetchInterval: fallback(live) }).data;

  // Every edit is one PATCH; its answer is the issue as it is now, and the event that follows confirms it.
  const patch = useMutation({
    mutationFn: (body: JsonBody) => editIssue(monorepo, n, body),
    onSuccess: (next) => qc.setQueryData(key, next),
  });

  const change = (c: FactChange) => {
    const body: [string, JsonValue][] = [];

    if (c.assignees?.add.length) body.push(["add_assignees", c.assignees.add]);

    if (c.assignees?.remove.length) body.push(["remove_assignees", c.assignees.remove]);

    if (c.labels?.add.length) body.push(["add_labels", c.labels.add]);

    if (c.labels?.remove.length) body.push(["remove_labels", c.labels.remove]);

    if (c.project !== undefined) body.push(["project", c.project]);

    if (body.length) patch.mutate(Object.fromEntries(body));
  };

  const links = (link: readonly string[], unlink: readonly string[]) => {
    const refs = (ids: readonly string[]) => ids.map((id) => ({ repo: id.slice(0, id.indexOf(":")), branch: id.slice(id.indexOf(":") + 1) }));

    patch.mutate({ link: refs(link), unlink: refs(unlink) });
  };

  return (
    <>
      <Head issue={issue} onPatch={(body) => patch.mutateAsync(body)} />
      <div className="mt-[22px] mb-7 h-px bg-rootline phone:mb-0" />
      <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-14 narrow:grid-cols-[minmax(0,1fr)_260px] narrow:gap-10 phone:grid-cols-[minmax(0,1fr)] phone:gap-[22px]">
        <section aria-label="Timeline">
          <Timeline issue={issue} timeline={timeline} />
          <Composer issue={issue} onPatch={(body) => patch.mutateAsync(body)} />
        </section>
        <aside aria-label="Details" className="phone:order-first">
          <IssueSidebar issue={issue} onChange={change} onLinks={links} />
          <Refusal error={patch.error} />
        </aside>
      </div>
    </>
  );
}
