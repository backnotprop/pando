// Every server read as a TanStack Query option, keyed so the live socket can
// patch or invalidate it: ["m", owner, name, ...] holds one monorepo's data,
// ["m", owner, name, "meta", ...] its root files.
import { type FullName, MetaHistory, type RepoName, Routes } from "@pando/contract";
import type * as Schema from "effect/Schema";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { get, getText } from "./client";
import type { MonorepoRef } from "./names";

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

/** Reads a route the contract names: its path and the schema of its answer. */
const read = <A, I>(route: { path: string; response: Schema.Codec<A, I> }) => get(route.response, route.path);

export const monorepoQuery = (m: MonorepoRef) => queryOptions({ queryKey: key(m), queryFn: () => read(Routes.getMonorepo(m.owner, m.name)), staleTime: 60_000 });

export const reposQuery = (m: MonorepoRef) =>
  queryOptions({ queryKey: [...key(m), "repos"], queryFn: () => read(Routes.listRepos(m.owner, m.name)).then((r) => r.repos) });

/** Each code repo's main head and when it last moved (the projects rows' time). */
export const headsQuery = (m: MonorepoRef) =>
  queryOptions({ queryKey: [...key(m), "heads"], queryFn: () => read(Routes.listHeads(m.owner, m.name)).then((r) => r.heads) });

/** A repo's open branches, counted on the first page (100). */
export const openBranchesQuery = (m: MonorepoRef, repo: RepoName) =>
  queryOptions({
    queryKey: [...key(m), "r", repo, "open-count"],
    queryFn: () => read(Routes.listBranches(m.owner, m.name, repo, "open", null)).then((r) => r.branches.length),
  });

/** The members, by login (the tab counts them). */
export const membersQuery = (m: MonorepoRef) =>
  queryOptions({ queryKey: [...key(m), "members"], queryFn: () => read(Routes.listMembers(m.owner, m.name)).then((r) => r.members) });

/** Pending invites, oldest first. */
export const invitesQuery = (m: MonorepoRef) =>
  queryOptions({ queryKey: [...key(m), "invites"], queryFn: () => read(Routes.listInvites(m.owner, m.name)).then((r) => r.invites) });

/**
 * Every machine, latest activity first (the tab counts those connected now).
 * A connect makes no activity line, so an open Machines tab asks again every
 * 5 s (pando-ops, 2026-10-03: fine for launch).
 */
export const machinesQuery = (m: MonorepoRef) =>
  queryOptions({ queryKey: [...key(m), "machines"], queryFn: () => read(Routes.listMachines(m.owner, m.name)).then((r) => r.machines) });

/** Every credential that acts as you: machines, sandboxes, browser sessions. */
export const credentialsQuery = queryOptions({
  queryKey: ["credentials"],
  queryFn: () => read(Routes.listCredentials).then((r) => r.credentials),
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
