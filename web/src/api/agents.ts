// Cloudflare-run agents: the Agents tab's list and launching one. Keys sit
// under ["m", owner, name, "agents"], so an agent.updated row on the page's
// socket (live/rows.ts) can patch them.
import { type AgentSession, type AgentSessionList, type Checks, Routes } from "@pando/contract";
import { infiniteQueryOptions, keepPreviousData, queryOptions, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { get, write } from "./client";
import type { MonorepoRef } from "./names";

/** The list's filters as the address holds them (?status=working&person=ana&kind=issue). */
export type AgentFilters = Routes.AgentFilters;

export const agentsKey = (m: MonorepoRef) => ["m", m.owner, m.name, "agents"] as const;

const listKey = (m: MonorepoRef) => [...agentsKey(m), "list"] as const;

/** The Agents tab's list, newest first, a page at a time (More); the counts come with each page. */
export const agentListQuery = (m: MonorepoRef, f: AgentFilters) =>
  infiniteQueryOptions({
    queryKey: [...listKey(m), f],
    queryFn: ({ pageParam }) => {
      const route = Routes.listAgents(m.owner, m.name, pageParam ? { ...f, before: pageParam } : f);

      return get(route.response, route.path);
    },
    initialPageParam: 0,
    getNextPageParam: (page) => page.next_before ?? undefined,
    placeholderData: keepPreviousData,
  });

/** Agents working now: the Agents tab's count. */
export const workingCountQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...agentsKey(m), "working"],
    queryFn: () => {
      const route = Routes.listAgents(m.owner, m.name, { limit: 1 });

      return get(route.response, route.path).then((r) => r.counts.working);
    },
    staleTime: 30_000,
  });

/** The models a session may use here, as the server lists them (GLM-5.3 Flash on Workers AI first, the owner's choice). */
export const agentModelsQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...agentsKey(m), "models"],
    queryFn: () => {
      const route = Routes.agentModels(m.owner, m.name);

      return get(route.response, route.path).then((r) => r.models);
    },
    staleTime: 300_000,
  });

/** A branch name git and Pando take: git's characters, not main, no "..", no leading or trailing slash (the server's rule). */
export const BRANCH_NAME = /^(?!main$)(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

/** What New agent sends: what to do, the project, a model, and the branch named for the change (new or existing). */
export interface Launch {
  prompt: string;
  repo: string;
  model: string;
  branch: string;
}

/** A branch's checks in words, as a row or a picker shows them; "" when they are unknown. */
export function checksWords(state: Checks["state"]): string {
  switch (state) {
    case "success":
      return "checks passed";
    case "failure":
    case "error":
      return "checks failed";
    case "pending":
    case "missing":
      return "checks running";
    default:
      return "";
  }
}

export function launchAgent(m: MonorepoRef, l: Launch): Promise<AgentSession> {
  return write(Routes.launchAgent(m.owner, m.name), { prompt: l.prompt, repo: l.repo, model: l.model, branch: l.branch });
}

/** What Address with agent sends: the branch (prefilled from the issue), a model, and the project and words to add when given. */
export interface Address {
  branch: string;
  model: string;
  repo: string | null;
  prompt: string;
}

export function addressIssue(m: MonorepoRef, n: number, a: Address): Promise<AgentSession> {
  const body = new Map<string, string>([["branch", a.branch], ["model", a.model]]);

  if (a.repo) body.set("repo", a.repo);

  if (a.prompt) body.set("prompt", a.prompt);

  return write(Routes.addressIssueWithAgent(m.owner, m.name, n), Object.fromEntries(body));
}

/** What Review with agent sends: the branch and its project, a model, and words to add when given. */
export interface ReviewAsk {
  branch: string;
  repo: string;
  model: string;
  prompt: string;
}

export function reviewBranch(m: MonorepoRef, r: ReviewAsk): Promise<AgentSession> {
  const body = new Map<string, string>([["branch", r.branch], ["repo", r.repo], ["model", r.model]]);

  if (r.prompt) body.set("prompt", r.prompt);

  return write(Routes.reviewWithAgent(m.owner, m.name), Object.fromEntries(body));
}

/** The person's own chats with the assistant, newest first (its first page; the list is short). */
export const chatsQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...agentsKey(m), "chats"],
    queryFn: () => {
      const route = Routes.listChats(m.owner, m.name);

      return get(route.response, route.path).then((r) => r.sessions);
    },
  });

/** One session, as its page or the assistant's panel shows it. */
export const agentQuery = (m: MonorepoRef, n: number) =>
  queryOptions({
    queryKey: [...agentsKey(m), "n", n],
    queryFn: () => {
      const route = Routes.getAgent(m.owner, m.name, n);

      return get(route.response, route.path);
    },
  });

/** A new chat with the assistant, starting with the person's first message: about one project, or (null) the whole repository. */
export const newChat = (m: MonorepoRef, prompt: string, project: string | null): Promise<AgentSession> =>
  write(Routes.newChat(m.owner, m.name), project === null ? { prompt } : { prompt, repo: project });

/** A person's follow-up to a session (taken after the current step). */
export const sendAgent = (m: MonorepoRef, n: number, prompt: string): Promise<AgentSession> => write(Routes.sendAgent(m.owner, m.name, n), { prompt });

/** Stop a session: its run ends, its sandbox stops; the transcript stays. */
export const stopAgent = (m: MonorepoRef, n: number): Promise<AgentSession> => write(Routes.stopAgent(m.owner, m.name, n), {});

type ListData = InfiniteData<AgentSessionList, number>;

/**
 * A session's row came on the socket (agent.updated): it replaces the row in
 * every list that shows it, keeping the branch facts the list read (the
 * event's row has none). A new session, or a state change that moves the
 * counts, has the lists read again, with the tab's count.
 */
export function applyAgentRow(qc: QueryClient, m: MonorepoRef, row: AgentSession) {
  let known = false;

  for (const [key, data] of qc.getQueriesData<ListData>({ queryKey: listKey(m) })) {
    if (!data) continue;

    const pages = data.pages.map((p) => ({
      ...p,
      sessions: p.sessions.map((s) => {
        if (s.number !== row.number) return s;
        known = known || s.status === row.status;

        return { ...row, branch_facts: s.branch_facts };
      }),
    }));

    qc.setQueryData<ListData>(key, { ...data, pages });
  }

  if (!known) void qc.invalidateQueries({ queryKey: agentsKey(m) });
}
