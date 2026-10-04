// Issue rows on a page's socket (topics `issues` and `issue:<n>`; a branch
// page's `repo:<repo>` hears its linked issues too): each event patches the
// cache where the issue shows (SPEC.md 4.3). The list replaces the row by
// number, moves it between Open and Closed, adjusts the counts and drops a row
// that no longer matches its filters; an issue page takes the row's fields,
// appends new timeline items by id, and reads the body again when its version
// moves. A list it cannot judge (a search, a row it never saw) is read again.
import type { Issue, IssueComment, IssueList, IssueRow, MonorepoEventFrame, TimelineItem } from "@pando/contract";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { issueKey, issuesKey, labelsKey, type ListFilters, listKey, openCountQuery, readComment, type TimelineRead, timelineQuery } from "../api/issues";
import type { MonorepoRef } from "../api/names";
import { meQuery } from "../api/queries";
import { markArrived } from "./arrivals";

type ListData = InfiniteData<IssueList, string>;

export type IssueFrame = Extract<MonorepoEventFrame, { collection: "issues" }>;

export type LabelFrame = Extract<MonorepoEventFrame, { collection: "labels" }>;

/** The arrival key of a row or a timeline item that came in live (ui: takeArrived). */
export const issueArrival = (m: MonorepoRef, what: string) => `${m.full}:issue:${what}`;

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether a row passes the filters other than state; null for a search, which only the server can judge. */
function passes(row: IssueRow, f: ListFilters, me: string | null): boolean | null {
  if (f.q.trim()) return null;

  if (!f.labels.every((l) => row.labels.some((x) => sameName(x.name, l)))) return false;

  const assignee = f.assignee === "@me" ? me : f.assignee;

  if (f.assignee === "none" ? row.assignees.length > 0 : assignee !== null && !row.assignees.some((a) => a === assignee)) return false;

  const author = f.author === "@me" ? me : f.author;

  if (author !== null && row.author !== author) return false;

  if (f.project === "none") return row.project === null;

  return f.project === null || row.project === f.project;
}

/** The list's order (the server's, with the number breaking ties). */
function before(a: IssueRow, b: IssueRow, f: ListFilters): boolean {
  const by = f.sort === "updated" ? a.updated_at.localeCompare(b.updated_at) : f.sort === "comments" ? a.comments - b.comments : 0;
  const order = by || a.number - b.number;

  return f.order === "desc" ? order > 0 : order < 0;
}

/** The row as the cache knew it before this event: from the issue's page, or a list. */
function known(qc: QueryClient, m: MonorepoRef, n: number): IssueRow | null {
  const page = qc.getQueryData<Issue>(issueKey(m, n));

  if (page) return page;

  for (const [, data] of qc.getQueriesData<ListData>({ queryKey: listKey(m) })) {
    const row = data?.pages.flatMap((p) => p.issues).find((r) => r.number === n);

    if (row) return row;
  }

  return null;
}

/** The row before the event, where the event itself says it: a close was of an open issue, a reopen of a closed one, a comment changes no filter. */
function previous(qc: QueryClient, m: MonorepoRef, e: IssueFrame): IssueRow | null | "new" {
  if (e.kind === "issue.opened") return "new";

  if (e.kind === "issue.closed") return { ...e.row, state: "open" };

  if (e.kind === "issue.reopened") return { ...e.row, state: "closed" };

  if (e.kind === "issue.commented") return e.row;

  return known(qc, m, e.number);
}

/** One list's pages with the row moved: out of where it was, into its place if it belongs there and that place is loaded. */
function placed(data: ListData, row: IssueRow, f: ListFilters, belongs: boolean): ListData {
  const pages = data.pages.map((p) => ({ ...p, issues: p.issues.filter((r) => r.number !== row.number) }));

  if (!belongs) return { ...data, pages };

  for (const [i, p] of pages.entries()) {
    const at = p.issues.findIndex((r) => before(row, r, f));

    if (at !== -1 || (i === pages.length - 1 && !p.next_cursor)) {
      const issues = at === -1 ? [...p.issues, row] : [...p.issues.slice(0, at), row, ...p.issues.slice(at)];

      return { ...data, pages: pages.map((x, j) => (j === i ? { ...x, issues } : x)) };
    }
  }

  // Its place is past the pages loaded: More brings it.
  return { ...data, pages };
}

const has = (data: ListData, n: number) => data.pages.some((p) => p.issues.some((r) => r.number === n));

function patchLists(qc: QueryClient, m: MonorepoRef, e: IssueFrame, prev: IssueRow | null | "new") {
  const me = qc.getQueryData(meQuery.queryKey)?.login ?? null;

  for (const query of qc.getQueryCache().findAll({ queryKey: listKey(m) })) {
    const data = qc.getQueryData<ListData>(query.queryKey);
    const f = query.meta?.filters;

    if (!data || !isFilters(f)) continue;
    const now = passes(e.row, f, me);
    const was = prev === "new" ? false : prev && passes(prev, f, me);

    // A search, or a row this list never saw change (its counts cannot be moved): read again.
    if (now === null || was === null) {
      void qc.invalidateQueries({ queryKey: query.queryKey, exact: true });
      continue;
    }

    const counts = { ...(data.pages[0]?.counts ?? { open: 0, closed: 0 }) };

    if (was && prev !== "new" && prev) counts[prev.state] = Math.max(0, counts[prev.state] - 1);

    if (now) counts[e.row.state] += 1;
    const belongs = now && e.row.state === f.state;
    const moved = placed(data, e.row, f, belongs);

    // A row that truly arrives (new to this list) plays the arrival; a row that only changed does not.
    if (belongs && !has(data, e.number) && has(moved, e.number)) markArrived(issueArrival(m, `row:${e.number}`));
    qc.setQueryData<ListData>(query.queryKey, { ...moved, pages: moved.pages.map((p) => ({ ...p, counts })) });
  }
}

/** A list query's filters, kept in its meta (issueListQuery). */
const isFilters = (f: unknown): f is ListFilters => typeof f === "object" && f !== null && "sort" in f && "labels" in f;

/** Items in their order, each once: a newer copy of an item (or of a comment, by its id) replaces the old in place. */
export function withItems(list: readonly TimelineItem[], items: readonly TimelineItem[], removed: readonly number[] = []): TimelineItem[] {
  const out = list.filter((x) => !removed.includes(x.id));

  for (const item of items) {
    const at = out.findIndex((x) => x.id === item.id || (x.kind === "comment" && item.kind === "comment" && x.comment.id === item.comment.id));

    if (at === -1) out.push(item);
    else out[at] = item;
  }

  return out.sort((a, b) => a.id - b.id);
}

/** A comment changed (edited, or its reactions): in place, by its id. */
export const withComment = (list: readonly TimelineItem[], c: IssueComment): TimelineItem[] =>
  list.map((x) => (x.kind === "comment" && x.comment.id === c.id ? { ...x, comment: c } : x));

function patchIssuePage(qc: QueryClient, m: MonorepoRef, e: IssueFrame) {
  const key = issueKey(m, e.number);
  const issue = qc.getQueryData<Issue>(key);

  if (!issue) return;
  // Links and participants are not in the row: a link change or a merge's close reads the issue again; so does a new body.
  const reread = e.body_version > issue.body_version || e.items.some((x) => ["linked", "unlinked", "closed", "merge_referenced"].includes(x.kind));

  qc.setQueryData<Issue>(key, { ...issue, ...e.row, reactions: e.reactions ?? issue.reactions });

  if (reread) void qc.invalidateQueries({ queryKey: key, exact: true });
  const timeline = timelineQuery(m, e.number).queryKey;

  qc.setQueryData<TimelineRead>(timeline, (t) => {
    if (!t) return t;

    for (const x of e.items) {
      // Your own comment is on the page already (from its answer): it does not arrive again.
      const shown = t.items.some((y) => y.id === x.id || (x.kind === "comment" && y.kind === "comment" && y.comment.id === x.comment.id));

      if (!shown) markArrived(issueArrival(m, `item:${x.id}`));
    }

    const items = withItems(t.items, e.items, e.removed);

    return { ...t, items: e.comment ? withComment(items, e.comment) : items };
  });

  // A comment over 16 KB came without its body: read it whole.
  const partial = [...e.items.flatMap((x) => (x.kind === "comment" ? [x.comment] : [])), ...(e.comment ? [e.comment] : [])].filter((c) => c.body === null);

  for (const c of partial) {
    void readComment(m, e.number, c.id).then((whole) => qc.setQueryData<TimelineRead>(timeline, (t) => t && { ...t, items: withComment(t.items, whole) }));
  }
}

/** The tab's count moves with the state: opened and reopened add one, closed takes one. */
function patchCount(qc: QueryClient, m: MonorepoRef, e: IssueFrame) {
  const by = e.kind === "issue.closed" ? -1 : e.kind === "issue.reopened" || (e.kind === "issue.opened" && e.row.state === "open") ? 1 : 0;

  if (by) qc.setQueryData(openCountQuery(m).queryKey, (n) => (n === undefined ? n : Math.max(0, n + by)));
}

export function applyIssueFrame(qc: QueryClient, m: MonorepoRef, f: IssueFrame | LabelFrame) {
  if (f.collection === "labels") {
    // Rare (an owner's Settings): a renamed or deleted label moves on every issue, so issues are read again.
    void qc.invalidateQueries({ queryKey: labelsKey(m) });
    void qc.invalidateQueries({ queryKey: issuesKey(m) });

    return;
  }

  patchLists(qc, m, f, previous(qc, m, f));
  patchIssuePage(qc, m, f);
  patchCount(qc, m, f);
  // A branch page's Issues block: which issues a branch is linked to is not in the row.
  void qc.invalidateQueries({ queryKey: [...issuesKey(m), "linked"] });
}

/** A branch changed (its state, a merge): an issue page whose Development box shows it reads the issue again. */
export function touchLinkedIssues(qc: QueryClient, m: MonorepoRef, repo: string, branch: string) {
  for (const query of qc.getQueryCache().findAll({ queryKey: [...issuesKey(m), "n"] })) {
    const issue = query.queryKey.length === 6 ? qc.getQueryData<Issue>(query.queryKey) : undefined;

    if (issue?.links.some((l) => l.repo === repo && l.branch === branch)) void qc.invalidateQueries({ queryKey: query.queryKey, exact: true });
  }
}
