// A project's releases and the strip over its files (research/plans/releases-2026-10-04): main's build
// state and the latest release, the releases newest first, one release with its commit's checks, and the
// switch "Anyone can download releases". Keys sit under the repo's, so its socket rows refresh them
// (live/rows.ts). Making, publishing and deleting releases stay with the CLI and the API.
import { type RepoName, Routes } from "@pando/contract";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type * as Schema from "effect/Schema";
import { get, write } from "./client";
import type { MonorepoRef } from "./names";
import { repoKey } from "./projects";

const read = <A, I>(route: { path: string; response: Schema.Codec<A, I> }) => get(route.response, route.path);

export const releasesKey = (m: MonorepoRef, repo: RepoName) => [...repoKey(m, repo), "releases"] as const;

/** main's commit, its state (or not built), the newest build on main, the latest release. */
export const summaryQuery = (m: MonorepoRef, repo: RepoName) =>
  queryOptions({ queryKey: [...releasesKey(m, repo), "summary"], queryFn: () => read(Routes.getRepoSummary(m.owner, m.name, repo)) });

/** The releases, newest first (a draft by when it was made, a published one by when it was published), 30 a page. */
export const releasesQuery = (m: MonorepoRef, repo: RepoName) =>
  infiniteQueryOptions({
    queryKey: [...releasesKey(m, repo), "list"],
    queryFn: ({ pageParam }) => read(Routes.listReleases(m.owner, m.name, repo, pageParam || null)),
    initialPageParam: "",
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });

/** One release, with its commit's checks. */
export const releaseQuery = (m: MonorepoRef, repo: RepoName, tag: string) =>
  queryOptions({ queryKey: [...releasesKey(m, repo), "one", tag], queryFn: () => read(Routes.getRelease(m.owner, m.name, repo, tag)) });

/** The repo with its switch (releases_public). */
export const repoQuery = (m: MonorepoRef, repo: RepoName) =>
  queryOptions({ queryKey: [...releasesKey(m, repo), "repo"], queryFn: () => read(Routes.getRepo(m.owner, m.name, repo)) });

/** "Anyone can download releases" on or off (owners). */
export const setReleasesPublic = (m: MonorepoRef, repo: RepoName, on: boolean) => write(Routes.setReleasesPublic(m.owner, m.name, repo), { releases_public: on });

/** A file's download address (the Worker's; the session cookie rides along, or none when the switch is on). */
export const releaseFileHref = (m: MonorepoRef, repo: RepoName, tag: string, file: string) => Routes.releaseFilePath(m.owner, m.name, repo, tag, file);

/** "8.0 MB", "388 bytes": decimal units, as the 100,000,000-byte limit is written. */
export function fileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} byte${bytes === 1 ? "" : "s"}`;

  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;

  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
