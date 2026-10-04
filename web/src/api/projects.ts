// A project's reads (a monorepo's code repo, or a plain repo's one repo): its
// files at a ref, its branches and a branch's page. Keys sit under
// ["m", owner, name, "r", repo], so a line on the monorepo's socket can
// refresh one repo's data.
import { type BranchDiffLine, type ChangedFile, type CiBuild, type CiJob, decodeBranchDiffLine, type Repo, type RepoName, Routes } from "@pando/contract";
import { infiniteQueryOptions, queryOptions, experimental_streamedQuery as streamedQuery } from "@tanstack/react-query";
import type * as Schema from "effect/Schema";
import { codeRawHref } from "../ui/paths";
import { get, getLines, getText, isMissing } from "./client";
import type { MonorepoRef } from "./names";

/** Reads a route the contract names: its path and the schema of its answer. */
const read = <A, I>(route: { path: string; response: Schema.Codec<A, I> }) => get(route.response, route.path);

export const repoKey = (m: MonorepoRef, repo: RepoName) => ["m", m.owner, m.name, "r", repo] as const;

/** A repo's branches, open or merged, newest push first, a page at a time. */
export const branchesQuery = (m: MonorepoRef, repo: RepoName, state: "open" | "merged") =>
  infiniteQueryOptions({
    queryKey: [...repoKey(m, repo), "branches", state],
    queryFn: ({ pageParam }) => read(Routes.listBranches(m.owner, m.name, repo, state, pageParam || null)),
    initialPageParam: "",
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });

export const branchQuery = (m: MonorepoRef, repo: RepoName, branch: string) =>
  queryOptions({
    queryKey: [...repoKey(m, repo), "branch", branch],
    queryFn: () => read(Routes.getBranch(m.owner, m.name, repo, branch)),
  });

export const commitsQuery = (m: MonorepoRef, repo: RepoName, branch: string) =>
  queryOptions({ queryKey: [...repoKey(m, repo), "branch", branch, "commits"], queryFn: () => read(Routes.branchCommits(m.owner, m.name, repo, branch)) });

type DiffLine = typeof BranchDiffLine.Type;

/** Files changed as far as it has come: its start (the ends, how many files), its files in path order, its end, or why it stopped. */
export interface FilesSoFar {
  start: Extract<DiffLine, { type: "start" }> | null;
  files: readonly ChangedFile[];
  end: Extract<DiffLine, { type: "end" }> | null;
  error: string | null;
}

const NONE_YET: FilesSoFar = { start: null, files: [], end: null, error: null };

function withLines(so: FilesSoFar, lines: readonly DiffLine[]): FilesSoFar {
  const next = { ...so, files: [...so.files] };

  for (const line of lines) {
    if (line.type === "start") next.start = line;
    else if (line.type === "file") next.files.push(line);
    else if (line.type === "end") next.end = line;
    else next.error = line.message;
  }

  return next;
}

/**
 * Files changed: the branch's head against its merge base with main, each file
 * with its patch, streamed so a branch of thousands of files draws its first
 * ones at once (the data grows as lines arrive). Read again when a row brings a
 * new head (live/rows.ts), keeping what shows until the new answer is whole;
 * the browser revalidates it by its ETag (main and head), a 304 when nothing
 * moved.
 */
export const branchDiffQuery = (m: MonorepoRef, repo: RepoName, branch: string) =>
  queryOptions({
    queryKey: [...repoKey(m, repo), "branch", branch, "diff"],
    queryFn: streamedQuery({
      streamFn: ({ signal }) => getLines(Routes.branchDiffStream(m.owner, m.name, repo, branch).path, decodeBranchDiffLine, signal),
      reducer: withLines,
      initialValue: NONE_YET,
      refetchMode: "replace",
    }),
  });

export const reviewsQuery = (m: MonorepoRef, repo: RepoName, branch: string) =>
  queryOptions({
    queryKey: [...repoKey(m, repo), "branch", branch, "reviews"],
    queryFn: () => read(Routes.listReviews(m.owner, m.name, repo, branch)).then((r) => r.reviews),
  });

/** The worktree checked out on this branch, if one is reported. */
export const worktreeQuery = (m: MonorepoRef, repoPath: string, branch: string) =>
  queryOptions({
    queryKey: ["m", m.owner, m.name, "worktrees", repoPath, branch],
    queryFn: () => read(Routes.listWorktrees(m.owner, m.name, repoPath)).then((r) => r.worktrees.find((w) => w.branch === branch) ?? null),
  });

/** The job that reports a check on the branch's head, and its build (for its page). */
export interface CheckRun {
  job: CiJob;
  build: CiBuild;
}

/** The branch's head's builds (by Pando's id), and each check's run among them. */
export interface CheckRuns {
  builds: ReadonlyMap<string, CiBuild>;
  runs: ReadonlyMap<string, CheckRun>;
}

/** Whether `job` of `build` reports its check over `held`: the newest build's job does; a retried job never. */
export const reports = (job: CiJob, build: CiBuild, held: CheckRun | undefined) =>
  !job.retried && (!held || held.build.id === build.id || (build.created_at ?? "") > (held.build.created_at ?? ""));

/**
 * Each check's run on the branch's head, from the CI service's stored builds
 * (Pando's rows, no call to the service). The page's row socket keeps it
 * current from ci.build and ci.job rows (live/rows.ts).
 */
export const checkRunsQuery = (m: MonorepoRef, repo: RepoName, branch: string, sha: string) =>
  queryOptions({
    queryKey: [...repoKey(m, repo), "runs", sha],
    queryFn: async (): Promise<CheckRuns> => {
      const builds = (await read(Routes.listCiBuilds(m.owner, m.name, repo, branch))).builds.filter((b) => b.sha === sha);
      const runs = new Map<string, CheckRun>();

      for (const b of builds) {
        for (const j of (await read(Routes.getCiBuild(m.owner, m.name, b.id))).jobs) {
          if (j.check && reports(j, b, runs.get(j.check))) runs.set(j.check, { job: j, build: b });
        }
      }

      return { builds: new Map(builds.map((b) => [b.id, b])), runs };
    },
  });

/** One folder at a ref (the default branch when null); null for the root of a repo with no commits yet. */
export const codeTreeQuery = (m: MonorepoRef, repo: RepoName, ref: string | null, dir: string) =>
  queryOptions({
    queryKey: [...repoKey(m, repo), "tree", ref, dir],
    queryFn: () =>
      read(Routes.getTree(m.owner, m.name, repo, ref, dir || null)).catch((error: Error) => {
        if (!ref && !dir && isMissing(error)) return null;

        throw error;
      }),
  });

/** Each entry's last commit; while the walk is incomplete, ask again when the server says. */
export const lastCommitsQuery = (m: MonorepoRef, repo: RepoName, commit: string, dir: string) =>
  queryOptions({
    queryKey: [...repoKey(m, repo), "last", commit, dir],
    queryFn: () => read(Routes.getLastCommits(m.owner, m.name, repo, commit, dir || null)),
    staleTime: (q) => (q.state.data?.complete ? Infinity : 0),
    refetchInterval: (q) => (q.state.data && !q.state.data.complete ? (q.state.data.retry_after_ms ?? 2000) : false),
  });

/** The commits that changed a path at a ref, newest first, a page at a time. */
export const codeHistoryQuery = (m: MonorepoRef, repo: RepoName, ref: string | null, path: string) =>
  infiniteQueryOptions({
    queryKey: [...repoKey(m, repo), "history", ref, path],
    queryFn: ({ pageParam }) => read(Routes.getHistory(m.owner, m.name, repo, ref, path, pageParam || null)),
    initialPageParam: "",
    getNextPageParam: (page) => page.next ?? undefined,
  });

/**
 * A file's text at a commit, or null for binary bytes: read from the raw URL
 * pinned to the commit's sha, which the browser keeps (immutable) and the edge
 * caches by blob.
 */
export const codeFileQuery = (m: MonorepoRef, repo: Repo, commit: string, path: string) =>
  queryOptions({
    queryKey: [...repoKey(m, repo.name), "file", commit, path],
    queryFn: () => getText(codeRawHref(m.full, repo.path, path, commit)),
    staleTime: Infinity,
  });
