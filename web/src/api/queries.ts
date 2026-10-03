// Every server read as a TanStack Query option, keyed so the live socket can
// patch or invalidate it: ["m", owner, name, ...] holds one monorepo's data,
// ["m", owner, name, "meta", ...] its root files.
import { type FullName, MetaHistory, Routes } from "@pando/contract";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { get, getText } from "./client";
import type { MonorepoRef } from "./names";
import * as P from "./pending";

const enc = encodeURIComponent;

const base = (m: MonorepoRef) => `/v1/monorepos/${enc(m.owner)}/${enc(m.name)}`;

const key = (m: MonorepoRef) => ["m", m.owner, m.name] as const;

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => get(Routes.me.response, Routes.me.path),
  staleTime: 5 * 60_000,
});

export const monoreposQuery = queryOptions({
  queryKey: ["monorepos"],
  queryFn: () => get(Routes.listMonorepoSummaries.response, Routes.listMonorepoSummaries.path).then((r) => r.monorepos),
});

/** "Needs you", across the person's monorepos or in one. */
export const needsQuery = (inMonorepo: FullName | null) =>
  queryOptions({
    queryKey: ["needs", inMonorepo],
    queryFn: () => {
      const route = Routes.listNeeds(inMonorepo);

      return get(route.response, route.path).then((r) => r.branches);
    },
  });

/** The activity log, newest first, a page at a time. */
export const activityQuery = (inMonorepo: FullName | null) =>
  infiniteQueryOptions({
    queryKey: ["activity", inMonorepo],
    queryFn: ({ pageParam }) => {
      const route = Routes.listActivity(pageParam || null, inMonorepo);

      return get(route.response, route.path);
    },
    initialPageParam: "",
    getNextPageParam: (page) => page.next ?? undefined,
  });

export const monorepoQuery = (m: MonorepoRef) =>
  queryOptions({ queryKey: key(m), queryFn: () => get(P.Monorepo, base(m)), staleTime: 60_000 });

export const reposQuery = (m: MonorepoRef) =>
  queryOptions({ queryKey: [...key(m), "repos"], queryFn: () => get(P.Repos, `${base(m)}/repos`).then((r) => r.repos) });

/** Each code repo's main head and when it last moved (the projects rows' time). */
export const headsQuery = (m: MonorepoRef) =>
  queryOptions({ queryKey: [...key(m), "heads"], queryFn: () => get(P.Heads, `${base(m)}/heads`).then((r) => r.heads) });

export const openBranchesQuery = (m: MonorepoRef, repo: string) =>
  queryOptions({
    queryKey: [...key(m), "branches", repo],
    queryFn: () => get(P.BranchNames, `${base(m)}/repos/${enc(repo)}/branches?state=open&limit=500`).then((r) => r.branches.length),
  });

export const membersQuery = (m: MonorepoRef) =>
  queryOptions({ queryKey: [...key(m), "members"], queryFn: () => get(P.Members, `${base(m)}/members`).then((r) => r.members.length) });

export const machinesQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...key(m), "machines"],
    queryFn: () => get(P.Machines, `${base(m)}/machines`).then((r) => r.machines.filter((x) => x.connected).length),
  });

/** One folder of root files: its files, and its subfolders (with their newest save, once the API has it). */
export const treeQuery = (m: MonorepoRef, dir: string) =>
  queryOptions({
    queryKey: [...key(m), "meta", "tree", dir],
    queryFn: async () => {
      const route = Routes.metaTree(m.owner, m.name, dir, null);
      const tree = await get(route.response, route.path);

      return { ...tree, folders: tree.folders ?? [] };
    },
  });

/** The newest change anywhere in the root files (the root's latest-change bar). */
export const latestQuery = (m: MonorepoRef, head: number) =>
  queryOptions({
    queryKey: [...key(m), "meta", "latest", head],
    queryFn: () => get(MetaHistory, `${base(m)}/meta/history?since=${Math.max(head - 1, 0)}&limit=1`).then((r) => r.versions[0] ?? null),
  });

/** The version of a root file a page shows: the newest, or the newest at or before `version`. */
export const entryQuery = (m: MonorepoRef, path: string, version: number | null) =>
  queryOptions({
    queryKey: [...key(m), "meta", "entry", path, version],
    queryFn: () => {
      const route = Routes.metaHistory(m.owner, m.name, path, version === null ? null : version + 1);

      return get(route.response, `${route.path}&limit=1`).then((r) => r.versions[0] ?? null);
    },
  });

/** A root file's versions, newest first, a page at a time. */
export const historyQuery = (m: MonorepoRef, path: string) =>
  infiniteQueryOptions({
    queryKey: [...key(m), "meta", "history", path],
    queryFn: ({ pageParam }) => {
      const route = Routes.metaHistory(m.owner, m.name, path, pageParam || null);

      return get(route.response, `${route.path}&limit=50`);
    },
    initialPageParam: 0,
    getNextPageParam: (page) => (page.versions.length === 50 ? page.versions.at(-1)?.version : undefined),
  });

/** A root file's text at a version (now when null). */
export const fileQuery = (m: MonorepoRef, path: string, version: number | null) =>
  queryOptions({
    queryKey: [...key(m), "meta", "file", path, version],
    queryFn: () => getText(Routes.metaFilePath(m.owner, m.name, path, version)),
    staleTime: version === null ? 0 : Infinity,
  });

export const restorePath = (m: MonorepoRef) => `${base(m)}/meta/restore`;
