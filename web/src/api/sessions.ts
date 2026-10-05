// Recorded agent sessions' reads and writes. Keys sit under ["m", owner, name, "sessions"]; a session.* frame on the
// page's socket reads them again (live/rows.ts). A person's sessions and the graph's marks key under ["u", login].
import { type Login, type RepoName, Routes } from "@pando/contract";
import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";
import { get, remove } from "./client";
import type { MonorepoRef } from "./names";

export const sessionsKey = (m: MonorepoRef) => ["m", m.owner, m.name, "sessions"] as const;

/** The Sessions tab's list, a page at a time (More), for the filters in the address. */
export const sessionListQuery = (m: MonorepoRef, f: Routes.SessionFilters) =>
  infiniteQueryOptions({
    queryKey: [...sessionsKey(m), "list", f],
    queryFn: ({ pageParam }) => {
      const route = Routes.listSessions(m.owner, m.name, pageParam ? { ...f, cursor: pageParam } : f);

      return get(route.response, route.path);
    },
    initialPageParam: "",
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });

/** Active sessions: the tab's count. */
export const activeCountQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...sessionsKey(m), "active"],
    queryFn: () => {
      const route = Routes.listSessions(m.owner, m.name, { limit: 1 });

      return get(route.response, route.path).then((r) => r.counts.active);
    },
    staleTime: 60_000,
  });

export const sessionQuery = (m: MonorepoRef, id: string) =>
  queryOptions({
    queryKey: [...sessionsKey(m), "id", id],
    queryFn: () => {
      const route = Routes.getSession(m.owner, m.name, id);

      return get(route.response, route.path);
    },
  });

/** Its conversation, a page of pieces at a time. */
export const sessionEntriesQuery = (m: MonorepoRef, id: string) =>
  infiniteQueryOptions({
    queryKey: [...sessionsKey(m), "id", id, "entries"],
    queryFn: ({ pageParam }) => {
      const route = Routes.sessionEntries(m.owner, m.name, id, pageParam);

      return get(route.response, route.path);
    },
    initialPageParam: 0,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });

export const sessionFilesQuery = (m: MonorepoRef, id: string) =>
  queryOptions({
    queryKey: [...sessionsKey(m), "id", id, "files"],
    queryFn: () => {
      const route = Routes.sessionFiles(m.owner, m.name, id);

      return get(route.response, route.path).then((r) => r.files);
    },
    staleTime: 60_000,
  });

export const branchSessionsQuery = (m: MonorepoRef, repo: RepoName, branch: string) =>
  queryOptions({
    queryKey: [...sessionsKey(m), "branch", repo, branch],
    queryFn: () => {
      const route = Routes.branchSessions(m.owner, m.name, repo, branch);

      return get(route.response, route.path);
    },
  });

export async function deleteSession(m: MonorepoRef, id: string): Promise<void> {
  await remove(Routes.deleteSession(m.owner, m.name, id));
}

export async function removeTurn(m: MonorepoRef, id: string, n: number): Promise<void> {
  await remove(Routes.removeSessionTurn(m.owner, m.name, id, n));
}

export async function deleteMany(m: MonorepoRef, f: { repo?: string; olderThanDays?: number; everyone?: boolean }): Promise<void> {
  await remove(Routes.deleteSessions(m.owner, m.name, f));
}

export const personSessionsQuery = (login: Login, limit: number) =>
  infiniteQueryOptions({
    queryKey: ["u", login, "sessions", limit],
    queryFn: ({ pageParam }) => {
      const route = Routes.personSessions(login, pageParam ? { cursor: pageParam, limit } : { limit });

      return get(route.response, route.path);
    },
    initialPageParam: "",
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });

export const sessionMarksQuery = (login: Login, tz: number) =>
  queryOptions({
    queryKey: ["u", login, "session-marks", tz],
    queryFn: () => {
      const route = Routes.sessionMarks(login, tz);

      return get(route.response, route.path);
    },
    staleTime: 5 * 60_000,
  });

export const sessionMachinesQuery = queryOptions({
  queryKey: ["user", "session-machines"],
  queryFn: () => get(Routes.sessionMachines.response, Routes.sessionMachines.path).then((r) => r.machines),
});

export const sessionExclusionsQuery = queryOptions({
  queryKey: ["user", "session-exclusions"],
  queryFn: () => get(Routes.sessionExclusions.response, Routes.sessionExclusions.path).then((r) => r.exclusions),
});
