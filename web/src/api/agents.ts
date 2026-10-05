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

/** The models a session may use, by id: GLM-5.3 Flash on Workers AI for now (the owner's choice, 2026-10-04). */
export const MODELS = [{ id: "@cf/zai-org/glm-5.3-flash", name: "GLM-5.3 Flash" }] as const;

/** What New agent sends: what to do, the project, a model, and an existing branch (else a new one, agent/<n>). */
export interface Launch {
  prompt: string;
  repo: string;
  model: string;
  branch: string | null;
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
  // `branch` only for an existing one: without it the server makes agent/<n>.
  const body = new Map<string, string>([["prompt", l.prompt], ["repo", l.repo], ["model", l.model]]);

  if (l.branch) body.set("branch", l.branch);

  return write(Routes.launchAgent(m.owner, m.name), Object.fromEntries(body));
}

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
