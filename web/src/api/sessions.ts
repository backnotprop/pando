// Recorded agent sessions' reads and writes. Keys sit under ["m", owner, name, "sessions"]; a session.* frame on the
// page's socket reads them again (live/rows.ts). A person's sessions and the graph's marks key under ["u", login].
import { type Login, type RepoName, Routes, type SessionDeleted } from "@pando/contract";
import { infiniteQueryOptions, keepPreviousData, type QueryClient, queryOptions } from "@tanstack/react-query";
import { get, put, remove, write } from "./client";
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

/** Deletes a session; the answer is its stub. */
export async function deleteSession(m: MonorepoRef, id: string) {
  return await write(Routes.deleteSession(m.owner, m.name, id));
}

/** Sessions' lists and pages read again. */
export function sessionsChanged(qc: QueryClient, m: MonorepoRef): void {
  void qc.invalidateQueries({ queryKey: sessionsKey(m) });
}

/**
 * A session was deleted: its page shows the stub at once, and its conversation and files are not read again (they are
 * gone, and the server answers 410). The rest read again.
 */
export function sessionGone(qc: QueryClient, m: MonorepoRef, row: SessionDeleted): void {
  const at = sessionsKey(m).length;

  qc.setQueryData(sessionQuery(m, row.id).queryKey, row);
  void qc.invalidateQueries({ queryKey: sessionsKey(m), predicate: (q) => !(q.queryKey[at] === "id" && q.queryKey[at + 1] === row.id) });
}

export async function removeTurn(m: MonorepoRef, id: string, n: number): Promise<void> {
  await remove(Routes.removeSessionTurn(m.owner, m.name, id, n));
}

export async function deleteMany(m: MonorepoRef, f: { repo?: string; olderThanDays?: number; everyone?: boolean }): Promise<void> {
  await remove(Routes.deleteSessions(m.owner, m.name, f));
}

/** A person's sessions; `f` holds the page's filters (state, agent, main, and `repository` as owner/name). */
export const personSessionsQuery = (login: Login, limit: number, f: { state?: string; agent?: string; main?: string; repository?: string }) =>
  infiniteQueryOptions({
    queryKey: ["u", login, "sessions", limit, f],
    queryFn: ({ pageParam }) => {
      const { repository, ...rest } = f;
      const asked = repository ? { ...rest, monorepo: repository, limit } : { ...rest, limit };
      const route = Routes.personSessions(login, pageParam ? { ...asked, cursor: pageParam } : asked);

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

/** Replace the person's list of what is not recorded (owner/name, and a project's path or null for the whole repository). */
export async function setExclusions(list: readonly { monorepo: string; project: string | null }[]): Promise<void> {
  await put(Routes.setSessionExclusions, { exclusions: list.map((x) => ({ monorepo: x.monorepo, project: x.project })) });
}
