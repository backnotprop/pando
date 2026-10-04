// Issues' reads and writes. Keys sit under ["m", owner, name, "issues"] (and
// "labels"), so the page's socket (live/issues.ts) can patch them by number.
import type { RepoName } from "@pando/contract";
import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";
import { get, type JsonBody, remove, write } from "./client";
import type { MonorepoRef } from "./names";
import * as P from "./pending";

const key = (m: MonorepoRef) => ["m", m.owner, m.name] as const;

export const issuesKey = (m: MonorepoRef) => [...key(m), "issues"] as const;

export const listKey = (m: MonorepoRef) => [...issuesKey(m), "list"] as const;

/** The list, a page at a time (More), for the filters in the address. The last list stays on screen while another loads. */
export const issueListQuery = (m: MonorepoRef, f: P.IssueFilters) =>
  infiniteQueryOptions({
    queryKey: [...listKey(m), f],
    queryFn: ({ pageParam }) => {
      const route = P.listIssues(m.owner, m.name, f, pageParam || null);

      return get(route.response, route.path);
    },
    initialPageParam: "",
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });

/** Open issues: the Issues tab's count. */
export const openCountQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...issuesKey(m), "count"],
    queryFn: () => {
      const route = P.listIssues(m.owner, m.name, { ...NO_FILTERS, state: "open" }, null, 1);

      return get(route.response, route.path).then((r) => r.counts.open);
    },
    staleTime: 60_000,
  });

export const issueKey = (m: MonorepoRef, n: number) => [...issuesKey(m), "n", n] as const;

export const issueQuery = (m: MonorepoRef, n: number) =>
  queryOptions({
    queryKey: issueKey(m, n),
    queryFn: () => {
      const route = P.getIssue(m.owner, m.name, n);

      return get(route.response, route.path);
    },
  });

/** The most timeline items a page reads (web-api is asked for a read of the newest page; until then, forward only). */
const TIMELINE_MAX = 250;

export interface TimelineRead {
  items: readonly P.TimelineItem[];
  /** More items than were read. */
  more: boolean;
}

export const timelineQuery = (m: MonorepoRef, n: number) =>
  queryOptions({
    queryKey: [...issueKey(m, n), "timeline"],
    queryFn: async (): Promise<TimelineRead> => {
      const items: P.TimelineItem[] = [];
      let cursor: string | null = null;

      do {
        const route = P.getTimeline(m.owner, m.name, n, cursor);
        const page = await get(route.response, route.path);

        items.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor && items.length < TIMELINE_MAX);

      return { items, more: cursor !== null };
    },
  });

/** The issues a branch is linked to, open or closed (its page's Issues block). */
export const linkedIssuesQuery = (m: MonorepoRef, repo: RepoName, branch: string) =>
  queryOptions({
    queryKey: [...issuesKey(m), "linked", repo, branch],
    queryFn: () => {
      const route = P.linkedIssues(m.owner, m.name, repo, branch);

      return get(route.response, route.path).then((r) => r.issues);
    },
  });

/** Open issues for a picker (a branch page's "Link an issue"), newest first. */
export const openIssuesQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...issuesKey(m), "open-100"],
    queryFn: () => {
      const route = P.listIssues(m.owner, m.name, { ...NO_FILTERS, state: "open" }, null, 100);

      return get(route.response, route.path).then((r) => r.issues);
    },
  });

export const labelsKey = (m: MonorepoRef) => [...key(m), "labels"] as const;

export const labelsQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: labelsKey(m),
    queryFn: () => {
      const route = P.listLabels(m.owner, m.name);

      return get(route.response, route.path).then((r) => r.labels);
    },
    staleTime: 60_000,
  });

export const NO_FILTERS: P.IssueFilters = { state: "open", labels: [], assignee: null, author: null, project: null, linked: null, q: "", sort: "created", order: "desc" };

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
  write(P.createIssue(m.owner, m.name), { title: issue.title, body: issue.body, labels: issue.labels, assignees: issue.assignees, project: issue.project }, idempotencyKey);

/** Any of the issue's fields in one PATCH (SPEC.md 5.1): title, body with base_version, state, labels, assignees, project, links. */
export const editIssue = (m: MonorepoRef, n: number, patch: JsonBody) => write(P.editIssue(m.owner, m.name, n), patch);

export const addComment = (m: MonorepoRef, n: number, body: string, idempotencyKey: string) => write(P.addComment(m.owner, m.name, n), { body }, idempotencyKey);

export const editComment = (m: MonorepoRef, n: number, id: string, body: string, baseVersion: number) =>
  write(P.editComment(m.owner, m.name, n, id), { body, base_version: baseVersion });

export const deleteComment = (m: MonorepoRef, n: number, id: string) => remove(P.deleteComment(m.owner, m.name, n, id));

/** Adds or takes back your reaction; answers the reactions as they are now. `comment` null: the body. */
export const react = (m: MonorepoRef, n: number, comment: string | null, content: P.ReactionContent, on: boolean) =>
  write(P.reaction(m.owner, m.name, n, comment, content, on ? "PUT" : "DELETE")).then((r) => r.reactions);

export const createLabel = (m: MonorepoRef, label: P.Label) => write(P.createLabel(m.owner, m.name), { name: label.name, color: label.color, description: label.description });

export const editLabel = (m: MonorepoRef, name: string, label: P.Label) =>
  write(P.editLabel(m.owner, m.name, name), { name: label.name, color: label.color, description: label.description });

export const deleteLabel = (m: MonorepoRef, name: string) => remove(P.deleteLabel(m.owner, m.name, name));
