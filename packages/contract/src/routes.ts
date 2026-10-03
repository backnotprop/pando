// The routes the web reads and writes: each one's path, its method when not
// GET, and the schema of its 200 body. Names are api-v1.yaml's operationIds.
// Path segments are encoded here, so callers pass plain values; a branch's
// `/` is sent as %2F.
import { BranchCommits, BranchList, MergeResult, ReviewList, Branch } from "./branch.ts";
import { Checks } from "./checks.ts";
import { CiBuildList } from "./ci.ts";
import { FullName, Login, MonorepoName, RepoName } from "./ids.ts";
import { MonorepoEntry, MonorepoList, MonorepoSummaryList } from "./monorepo.ts";
import { EventsPage } from "./feed.ts";
import { MetaHistory, MetaTree, Restored } from "./meta.ts";
import { NeedsPage } from "./needs.ts";
import { MachineList, MemberList, Repo, RepoList } from "./repo.ts";
import { Me, SignedOut } from "./user.ts";

const query = (params: URLSearchParams): string => {
  const text = params.toString();

  return text === "" ? "" : `?${text}`;
};

const monorepoBase = (owner: Login, name: MonorepoName): string => `/v1/monorepos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

const metaBase = (owner: Login, name: MonorepoName): string => `${monorepoBase(owner, name)}/meta`;

const repoBase = (owner: Login, name: MonorepoName, repo: RepoName): string => `${monorepoBase(owner, name)}/repos/${encodeURIComponent(repo)}`;

const branchBase = (owner: Login, name: MonorepoName, repo: RepoName, branch: string): string =>
  `${repoBase(owner, name, repo)}/branches/${encodeURIComponent(branch)}`;

/** GET /v1/user. A 401 here means: show the sign-in button. */
export const me = { path: "/v1/user", response: Me };

/** GET /v1/monorepos. */
export const listMonorepos = { path: "/v1/monorepos", response: MonorepoList };

/** GET /v1/monorepos?summary=1: the home's list, each with its line. */
export const listMonorepoSummaries = { path: "/v1/monorepos?summary=1", response: MonorepoSummaryList };

/** GET /v1/events: a page of the activity log. `inMonorepo` narrows to one `owner/name`; `cursor` is a page's `next`. */
export const listActivity = (cursor: string | null, inMonorepo: FullName | null) => {
  const params = new URLSearchParams();

  if (cursor !== null) params.set("cursor", cursor);

  if (inMonorepo !== null) params.set("in", inMonorepo);

  return { path: `/v1/events${query(params)}`, response: EventsPage };
};

/** The person's socket: the same path with `Upgrade: websocket`; frames are ActivityFrame. */
export const activitySocketPath = "/v1/events";

/** GET /v1/branches: "Needs you", open branches that are ready, conflicting or failing. */
export const listNeeds = (inMonorepo: FullName | null) => {
  const params = new URLSearchParams();

  if (inMonorepo !== null) params.set("in", inMonorepo);

  return { path: `/v1/branches${query(params)}`, response: NeedsPage };
};

/** GET .../meta/tree?dir=<folder>: one folder of root files (`""` is the root), with its subfolders on the first page. */
export const metaTree = (owner: Login, name: MonorepoName, dir: string, after: string | null) => {
  const params = new URLSearchParams({ dir });

  if (after !== null) params.set("after", after);

  return { path: `${metaBase(owner, name)}/tree${query(params)}`, response: MetaTree };
};

/** GET .../meta/history?path=<path>: a root file's versions, newest first; `before` is a version to page from. */
export const metaHistory = (owner: Login, name: MonorepoName, path: string, before: number | null) => {
  const params = new URLSearchParams({ path });

  if (before !== null) params.set("before", String(before));

  return { path: `${metaBase(owner, name)}/history${query(params)}`, response: MetaHistory };
};

/** GET .../meta/file?path=<path>: raw bytes (no schema); MetaFileHeaders reads its version headers. `version` null: now. */
export const metaFilePath = (owner: Login, name: MonorepoName, path: string, version: number | null): string => {
  const params = new URLSearchParams({ path });

  if (version !== null) params.set("version", String(version));

  return `${metaBase(owner, name)}/file${query(params)}`;
};

/** A large monorepo's activity socket: its event stream with `topics=feed` (frames: MonorepoFeedFrame). `feedSince`: the last `n` seen. */
export const monorepoFeedSocketPath = (owner: Login, name: MonorepoName, feedSince: number | null): string => {
  const params = new URLSearchParams({ topics: "feed" });

  if (feedSince !== null) params.set("feed_since", String(feedSince));

  return `/v1/monorepos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/events${query(params)}`;
};

/** GET /{owner}/{name}/raw/{path}?v=<version>: a root file's bytes (no schema; members only). `version` null: now. Path segments keep their slashes. */
export const metaRawPath = (owner: Login, name: MonorepoName, path: string, version: number | null): string => {
  const params = new URLSearchParams();

  if (version !== null) params.set("v", String(version));

  return `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/raw/${path.split("/").map(encodeURIComponent).join("/")}${query(params)}`;
};

/** POST /v1/logout with `Accept: application/json` and Pando's own Origin: the session ends; open logout_url to end WorkOS's too. */
export const logout = { method: "POST", path: "/v1/logout", response: SignedOut } as const;

/** GET /v1/monorepos/{owner}/{monorepo}: the monorepo and the person's role in it; an old name answers with the current one. */
export const getMonorepo = (owner: Login, name: MonorepoName) => ({ path: monorepoBase(owner, name), response: MonorepoEntry });

/** GET .../repos: every code repo. */
export const listRepos = (owner: Login, name: MonorepoName) => ({ path: `${monorepoBase(owner, name)}/repos`, response: RepoList });

/** GET .../repos/{repo}: one repo, with its required_checks. */
export const getRepo = (owner: Login, name: MonorepoName, repo: RepoName) => ({ path: repoBase(owner, name, repo), response: Repo });

/** GET .../members. */
export const listMembers = (owner: Login, name: MonorepoName) => ({ path: `${monorepoBase(owner, name)}/members`, response: MemberList });

/** GET .../machines: the Machines tab. */
export const listMachines = (owner: Login, name: MonorepoName) => ({ path: `${monorepoBase(owner, name)}/machines`, response: MachineList });

/** POST .../meta/restore with {path, version}: a root file written back as it was. */
export const restore = (owner: Login, name: MonorepoName) => ({ method: "POST", path: `${metaBase(owner, name)}/restore`, response: Restored }) as const;

/** GET .../repos/{repo}/branches?state=open|merged|all; `cursor` is a page's next_cursor. */
export const listBranches = (owner: Login, name: MonorepoName, repo: RepoName, state: "open" | "merged" | "all", cursor: string | null) => {
  const params = new URLSearchParams({ state });

  if (cursor !== null) params.set("cursor", cursor);

  return { path: `${repoBase(owner, name, repo)}/branches${query(params)}`, response: BranchList };
};

/** GET .../branches/{branch}. */
export const getBranch = (owner: Login, name: MonorepoName, repo: RepoName, branch: string) => ({ path: branchBase(owner, name, repo, branch), response: Branch });

/** GET .../branches/{branch}/commits: the branch's own commits, newest first. */
export const branchCommits = (owner: Login, name: MonorepoName, repo: RepoName, branch: string) => ({
  path: `${branchBase(owner, name, repo, branch)}/commits`,
  response: BranchCommits,
});

/** GET .../branches/{branch}/reviews: oldest first. */
export const listReviews = (owner: Login, name: MonorepoName, repo: RepoName, branch: string) => ({
  path: `${branchBase(owner, name, repo, branch)}/reviews`,
  response: ReviewList,
});

/**
 * POST .../branches/{branch}/merge with {expected_head}: MergeResult. Refused:
 * 412 checks_not_green (ErrorBody with `checks`), 409 head_moved or conflicts
 * (with `paths`). `force` merges past red or missing checks.
 */
export const mergeBranch = (owner: Login, name: MonorepoName, repo: RepoName, branch: string, force: boolean) =>
  ({ method: "POST", path: `${branchBase(owner, name, repo, branch)}/merge?force=${force ? "1" : "0"}`, response: MergeResult }) as const;

/** GET .../repos/{repo}/commits/{ref}/status: a commit's combined status. */
export const combinedStatus = (owner: Login, name: MonorepoName, repo: RepoName, ref: string) => ({
  path: `${repoBase(owner, name, repo)}/commits/${encodeURIComponent(ref)}/status`,
  response: Checks,
});

/** GET .../ci/builds, newest first; narrowed to one branch (and repo) when given. */
export const listCiBuilds = (owner: Login, name: MonorepoName, repo: RepoName | null, branch: string | null) => {
  const params = new URLSearchParams();

  if (repo !== null) params.set("repo", repo);

  if (branch !== null) params.set("branch", branch);

  return { path: `${monorepoBase(owner, name)}/ci/builds${query(params)}`, response: CiBuildList };
};
