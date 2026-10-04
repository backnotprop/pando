// Issues' reads and writes. Keys sit under ["m", owner, name, "issues"] (and
// "labels"), so the page's socket (live/issues.ts) can patch them by number.
import { type Label, type ReactionContent, type RepoName, Routes, type TimelineItem } from "@pando/contract";
import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";
import { get, type JsonBody, remove, write } from "./client";
import type { MonorepoRef } from "./names";

/** The list's filters as the page holds them (the address keeps them: ?state=closed&label=bug). */
export interface ListFilters {
  state: "open" | "closed";
  labels: readonly string[];
  assignee: string | null;
  author: string | null;
  project: string | null;
  q: string;
  sort: "created" | "updated" | "comments";
  order: "desc" | "asc";
}

export const NO_FILTERS: ListFilters = { state: "open", labels: [], assignee: null, author: null, project: null, q: "", sort: "created", order: "desc" };

/** The filters as listIssues takes them: only those set. */
function asked(f: ListFilters): Routes.IssueFilters {
  const out: Routes.IssueFilters = { state: f.state, labels: f.labels, sort: f.sort, order: f.order };

  if (f.assignee) out.assignee = f.assignee;

  if (f.author) out.author = f.author;

  if (f.project) out.project = f.project;

  if (f.q.trim()) out.q = f.q.trim();

  return out;
}

const key = (m: MonorepoRef) => ["m", m.owner, m.name] as const;

export const issuesKey = (m: MonorepoRef) => [...key(m), "issues"] as const;

export const listKey = (m: MonorepoRef) => [...issuesKey(m), "list"] as const;

/** The list, a page at a time (More), for the filters in the address. The last list stays on screen while another loads. */
export const issueListQuery = (m: MonorepoRef, f: ListFilters) =>
  infiniteQueryOptions({
    queryKey: [...listKey(m), f],
    queryFn: ({ pageParam }) => {
      const route = Routes.listIssues(m.owner, m.name, pageParam ? { ...asked(f), cursor: pageParam } : asked(f));

      return get(route.response, route.path);
    },
    initialPageParam: "",
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    // The socket's patches read the filters from here (live/issues.ts).
    meta: { filters: f },
  });

/** Open issues: the Issues tab's count. */
export const openCountQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...issuesKey(m), "count"],
    queryFn: () => {
      const route = Routes.listIssues(m.owner, m.name, { state: "open", limit: 1 });

      return get(route.response, route.path).then((r) => r.counts.open);
    },
    staleTime: 60_000,
  });

export const issueKey = (m: MonorepoRef, n: number) => [...issuesKey(m), "n", n] as const;

export const issueQuery = (m: MonorepoRef, n: number) =>
  queryOptions({
    queryKey: issueKey(m, n),
    queryFn: () => {
      const route = Routes.getIssue(m.owner, m.name, n);

      return get(route.response, route.path);
    },
  });

/** A long timeline shows its first and last items, with "Show N more" between (GitHub's way, SPEC.md 7.3). */
const ENDS = 30;

/** The timeline as read: items in order, and the items not read yet after `after` (by `cursor`), if any. */
export interface TimelineRead {
  items: readonly TimelineItem[];
  gap: { after: number; count: number; cursor: string } | null;
}

export const timelineQuery = (m: MonorepoRef, n: number) =>
  queryOptions({
    queryKey: [...issueKey(m, n), "timeline"],
    queryFn: async (): Promise<TimelineRead> => {
      const read = (page: { cursor?: string; limit?: number; last?: number }) => {
        const route = Routes.issueTimeline(m.owner, m.name, n, page);

        return get(route.response, route.path);
      };

      const head = await read({ limit: ENDS });

      if (!head.next_cursor) return { items: head.items, gap: null };

      // Up to twice the ends: all of it. Past that: the last ones too, and the gap between.
      if (head.total <= ENDS * 2) return { items: [...head.items, ...(await read({ cursor: head.next_cursor, limit: ENDS * 2 })).items], gap: null };
      const last = await read({ last: ENDS });
      const after = head.items.at(-1)?.id ?? 0;

      return { items: [...head.items, ...last.items.filter((x) => x.id > after)], gap: { after, count: Math.max(0, head.total - head.items.length - last.items.length), cursor: head.next_cursor } };
    },
  });

/** "Show N more": the next hundred hidden items; the gap closes once they reach the last ones. */
export async function readGap(m: MonorepoRef, n: number, t: TimelineRead): Promise<TimelineRead> {
  if (!t.gap) return t;
  const route = Routes.issueTimeline(m.owner, m.name, n, { cursor: t.gap.cursor, limit: 100 });
  const page = await get(route.response, route.path);
  const known = new Set(t.items.map((x) => x.id));
  const fresh = page.items.filter((x) => !known.has(x.id));
  const reached = fresh.length < page.items.length || !page.next_cursor;
  const items = [...t.items, ...fresh].sort((a, b) => a.id - b.id);
  const after = fresh.at(-1)?.id ?? t.gap.after;

  return { items, gap: reached || !page.next_cursor ? null : { after, count: Math.max(0, t.gap.count - fresh.length), cursor: page.next_cursor } };
}

/** The issues a branch is linked to, open or closed (its page's Issues block). */
export const linkedIssuesQuery = (m: MonorepoRef, repo: RepoName, branch: string) =>
  queryOptions({
    queryKey: [...issuesKey(m), "linked", repo, branch],
    queryFn: () => {
      const route = Routes.listIssues(m.owner, m.name, { state: "all", linked: `${repo}:${branch}`, limit: 100 });

      return get(route.response, route.path).then((r) => r.issues);
    },
  });

/** A repo's open branches (the first hundred), for the Development box's "Link a branch". */
export const linkableBranchesQuery = (m: MonorepoRef, repo: RepoName) =>
  queryOptions({
    queryKey: [...key(m), "r", repo, "branches", "linkable"],
    queryFn: () => {
      const route = Routes.listBranches(m.owner, m.name, repo, "open", null);

      return get(route.response, route.path).then((r) => r.branches.map((b) => b.name));
    },
  });

/** Open issues for a picker (a branch page's "Link an issue"), newest first. */
export const openIssuesQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...issuesKey(m), "open-100"],
    queryFn: () => {
      const route = Routes.listIssues(m.owner, m.name, { state: "open", limit: 100 });

      return get(route.response, route.path).then((r) => r.issues);
    },
  });

export const labelsKey = (m: MonorepoRef) => [...key(m), "labels"] as const;

export const labelsQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: labelsKey(m),
    queryFn: () => {
      const route = Routes.listLabels(m.owner, m.name);

      return get(route.response, route.path).then((r) => r.labels);
    },
    staleTime: 60_000,
  });

/** A comment, whole: a live event leaves a body over 16 KB out. */
export const readComment = (m: MonorepoRef, n: number, id: string) => {
  const route = Routes.getIssueComment(m.owner, m.name, n, id);

  return get(route.response, route.path);
};

// ── Writes ────────────────────────────────────────────────────────────────

/** A key made once per attempt, kept across its retries, so a lost answer never makes a second issue or comment. */
export const newKey = () => crypto.randomUUID();

export interface NewIssue {
  title: string;
  body: string;
  labels: readonly string[];
  assignees: readonly string[];
  project: string | null;
}

export const createIssue = (m: MonorepoRef, issue: NewIssue, idempotencyKey: string) =>
  write(Routes.createIssue(m.owner, m.name), { title: issue.title, body: issue.body, labels: issue.labels, assignees: issue.assignees, project: issue.project }, idempotencyKey);

/** Any of the issue's fields in one PATCH (SPEC.md 5.1): title, body with base_version, state, labels, assignees, project, links. */
export const editIssue = (m: MonorepoRef, n: number, patch: JsonBody) => write(Routes.updateIssue(m.owner, m.name, n), patch);

export const addComment = (m: MonorepoRef, n: number, body: string, idempotencyKey: string) => write(Routes.addIssueComment(m.owner, m.name, n), { body }, idempotencyKey);

export const editComment = (m: MonorepoRef, n: number, id: string, body: string, baseVersion: number) =>
  write(Routes.updateIssueComment(m.owner, m.name, n, id), { body, base_version: baseVersion });

export const deleteComment = (m: MonorepoRef, n: number, id: string) => remove(Routes.deleteIssueComment(m.owner, m.name, n, id));

/** Adds or takes back your reaction; answers the reactions as they are now. `comment` null: the body. */
export const react = (m: MonorepoRef, n: number, comment: string | null, content: ReactionContent, on: boolean) => {
  const method = on ? "PUT" : "DELETE";
  const route = comment ? Routes.commentReaction(m.owner, m.name, n, comment, content, method) : Routes.issueReaction(m.owner, m.name, n, content, method);

  return write(route).then((r) => r.reactions);
};

export const createLabel = (m: MonorepoRef, label: Label) => write(Routes.createLabel(m.owner, m.name), { name: label.name, color: label.color, description: label.description });

export const editLabel = (m: MonorepoRef, name: string, label: Label) =>
  write(Routes.updateLabel(m.owner, m.name, name), { name: label.name, color: label.color, description: label.description });

export const deleteLabel = (m: MonorepoRef, name: string) => remove(Routes.deleteLabel(m.owner, m.name, name));
