// The routes the web reads and writes: each one's path, its method when not
// GET, and the schema of its 200 body. Names are api-v1.yaml's operationIds.
// Path segments are encoded here, so callers pass plain values; a branch's
// `/` is sent as %2F.
import { BranchCommits, BranchList, MergeResult, ReviewList, Branch } from "./branch.ts";
import { Checks } from "./checks.ts";
import { CiAnnotationList, CiArtifactList, CiBuildAnswer, CiBuildDetail, CiBuildList, CiConnected, CiJobAnswer, CiJobLog, CiOverview, CiPipelinePage, Hook } from "./ci.ts";
import { HistoryPage, LastCommits, TreePage } from "./files.ts";
import { FullName, Login, MonorepoName, RepoName } from "./ids.ts";
import { MonorepoEntry, MonorepoList, MonorepoRenamed, MonorepoSummaryList } from "./monorepo.ts";
import { EventsPage } from "./feed.ts";
import { MetaHistory, MetaTree, Restored } from "./meta.ts";
import { NeedsPage } from "./needs.ts";
import { HeadList, InviteList, InviteResult, MachineList, MemberList, Repo, RepoList, WorktreeList } from "./repo.ts";
import { CredentialList, Me, SignedOut } from "./user.ts";

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

/**
 * A monorepo's event socket for row updates (open it with `Upgrade: websocket`): `topics` such as
 * `kind:branch.updated` or `repo:<repo>` (at most 10; ROW_KINDS lists the row kinds), `since` the highest `seq` seen.
 */
export const monorepoEventsSocketPath = (owner: Login, name: MonorepoName, topics: readonly string[], since: number | null): string => {
  const params = new URLSearchParams({ topics: topics.join(",") });

  if (since !== null) params.set("since", String(since));

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

/** GET .../heads: every code repo's main, with its head commit's title when known (no Artifacts read). */
export const listHeads = (owner: Login, name: MonorepoName) => ({ path: `${monorepoBase(owner, name)}/heads`, response: HeadList });

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

/** GET .../ci/builds/{build}: a build (Pando's `cib_` id) and its jobs. */
export const getCiBuild = (owner: Login, name: MonorepoName, build: string) => ({
  path: `${monorepoBase(owner, name)}/ci/builds/${encodeURIComponent(build)}`,
  response: CiBuildDetail,
});

/** ref and path as the file routes take them: the default branch and the root when null. */
const fileQuery = (ref: string | null, path: string | null, more: [string, string][] = []): string => {
  const params = new URLSearchParams();

  if (ref !== null) params.set("ref", ref);

  if (path !== null && path !== "") params.set("path", path);

  for (const [k, v] of more) params.set(k, v);

  return query(params);
};

/** GET .../repos/{repo}/tree: a folder at a ref (default: the default branch's root); `cursor` is a page's `next`. */
export const getTree = (owner: Login, name: MonorepoName, repo: RepoName, ref: string | null, path: string | null, cursor: string | null = null) => ({
  path: `${repoBase(owner, name, repo)}/tree${fileQuery(ref, path, cursor === null ? [] : [["cursor", cursor]])}`,
  response: TreePage,
});

/** GET .../repos/{repo}/tree/last-commits: each entry's last commit; `names` narrows to one page of a large folder. */
export const getLastCommits = (owner: Login, name: MonorepoName, repo: RepoName, ref: string | null, path: string | null, names: string[] | null = null) => ({
  path: `${repoBase(owner, name, repo)}/tree/last-commits${fileQuery(ref, path, names === null ? [] : [["names", names.join(",")]])}`,
  response: LastCommits,
});

/** GET .../repos/{repo}/history: commits that changed a path (a file or a folder; the root when null); `cursor` is a page's `next`. */
export const getHistory = (owner: Login, name: MonorepoName, repo: RepoName, ref: string | null, path: string | null, cursor: string | null = null) => ({
  path: `${repoBase(owner, name, repo)}/history${fileQuery(cursor === null ? ref : null, path, cursor === null ? [] : [["cursor", cursor]])}`,
  response: HistoryPage,
});

/** GET .../worktrees: every worktree; `repo` (a repo path, `projects/web`) narrows to one repo's. */
export const listWorktrees = (owner: Login, name: MonorepoName, repoPath: string | null) => ({
  path: `${monorepoBase(owner, name)}/worktrees${repoPath === null ? "" : `?${new URLSearchParams({ repo: repoPath })}`}`,
  response: WorktreeList,
});

// ── Your machines ──────────────────────────────────────────────────────────

/** GET /v1/user/credentials: the person's machines, sandboxes and browser sessions; `Me.credential.id` is this session's. */
export const listCredentials = { path: "/v1/user/credentials", response: CredentialList };

/** DELETE /v1/user/credentials/{id} (204): the credential stops working at once. */
export const revokeCredential = (id: string) => ({ method: "DELETE", path: `/v1/user/credentials/${encodeURIComponent(id)}` }) as const;

// ── Members and settings (owners only, but for the lists) ─────────────────

/** GET .../invites: invites not yet accepted. */
export const listInvites = (owner: Login, name: MonorepoName) => ({ path: `${monorepoBase(owner, name)}/invites`, response: InviteList });

/** POST .../invites {email, role}: added now (200) or invited (201). */
export const invite = (owner: Login, name: MonorepoName) => ({ method: "POST", path: `${monorepoBase(owner, name)}/invites`, response: InviteResult }) as const;

/** DELETE .../invites/{email} (204). */
export const revokeInvite = (owner: Login, name: MonorepoName, email: string) =>
  ({ method: "DELETE", path: `${monorepoBase(owner, name)}/invites/${encodeURIComponent(email)}` }) as const;

/** DELETE .../members/{login} (204): they lose access at once. */
export const removeMember = (owner: Login, name: MonorepoName, login: Login) =>
  ({ method: "DELETE", path: `${monorepoBase(owner, name)}/members/${encodeURIComponent(login)}` }) as const;

/** PATCH .../{monorepo} {name}: rename; the old name keeps leading here (an alias). */
export const renameMonorepo = (owner: Login, name: MonorepoName) => ({ method: "PATCH", path: monorepoBase(owner, name), response: MonorepoRenamed }) as const;

/** DELETE .../{monorepo}?confirm=owner/name (204): the monorepo, its repos and their history. */
export const deleteMonorepo = (owner: Login, name: MonorepoName) =>
  ({ method: "DELETE", path: `${monorepoBase(owner, name)}?${new URLSearchParams({ confirm: `${owner}/${name}` })}` }) as const;

// ── CI ─────────────────────────────────────────────────────────────────────

const ciBase = (owner: Login, name: MonorepoName): string => `${monorepoBase(owner, name)}/ci`;

const buildBase = (owner: Login, name: MonorepoName, build: string): string => `${ciBase(owner, name)}/builds/${encodeURIComponent(build)}`;

/** GET .../ci: services, connections (with their webhook URL and last event), pipelines and required checks. */
export const getCi = (owner: Login, name: MonorepoName) => ({ path: ciBase(owner, name), response: CiOverview });

/** GET .../ci/pipelines/{pipeline}: its configuration and a page of its builds; `cursor` is a page's `next_cursor`. */
export const getCiPipeline = (owner: Login, name: MonorepoName, pipeline: string, cursor: string | null = null) => ({
  path: `${ciBase(owner, name)}/pipelines/${encodeURIComponent(pipeline)}${cursor === null ? "" : `?${new URLSearchParams({ cursor })}`}`,
  response: CiPipelinePage,
});

/**
 * GET .../ci/builds?pipeline=&number=: a build by its page address (`/{owner}/{name}/ci/{pipeline}/{number}`).
 * A number is unique within one pipeline on one connection; two connections with the same pipeline slug can both
 * answer, and `connection` narrows to one.
 */
export const findCiBuild = (owner: Login, name: MonorepoName, pipeline: string, number: number, connection: string | null = null) => {
  const params = new URLSearchParams({ pipeline, number: String(number) });

  if (connection !== null) params.set("connection", connection);

  return { path: `${ciBase(owner, name)}/builds${query(params)}`, response: CiBuildList };
};

/** POST .../ci/pipelines/{pipeline}/builds {branch} (201): New build, of the branch's head as Pando has it (default: the repo's default branch). */
export const startCiBuild = (owner: Login, name: MonorepoName, pipeline: string) =>
  ({ method: "POST", path: `${ciBase(owner, name)}/pipelines/${encodeURIComponent(pipeline)}/builds`, response: CiBuildAnswer }) as const;

/** POST .../repos/{repo}/hooks {type: "buildkite", buildkite: {organization, pipeline}} (201, owners): Add pipeline, so pushes start its builds. */
export const addHook = (owner: Login, name: MonorepoName, repo: RepoName) => ({ method: "POST", path: `${repoBase(owner, name, repo)}/hooks`, response: Hook }) as const;

/** GET .../ci/builds/{build}/jobs/{job}/log: the log's last 1 MiB, read on demand. */
export const getCiJobLog = (owner: Login, name: MonorepoName, build: string, job: string) => ({
  path: `${buildBase(owner, name, build)}/jobs/${encodeURIComponent(job)}/log`,
  response: CiJobLog,
});

/** GET .../ci/builds/{build}/annotations, read on demand. */
export const listCiAnnotations = (owner: Login, name: MonorepoName, build: string) => ({ path: `${buildBase(owner, name, build)}/annotations`, response: CiAnnotationList });

/** GET .../ci/builds/{build}/artifacts, read on demand. */
export const listCiArtifacts = (owner: Login, name: MonorepoName, build: string) => ({ path: `${buildBase(owner, name, build)}/artifacts`, response: CiArtifactList });

/** An artifact's Download link: a 302 to the service's signed URL (good for about 60 s), so open it when clicked. */
export const ciArtifactDownloadPath = (owner: Login, name: MonorepoName, build: string, artifact: string): string =>
  `${buildBase(owner, name, build)}/artifacts/${encodeURIComponent(artifact)}/download`;

/** POST .../ci/builds/{build}/rebuild (201): a new build of the same commit, with fresh tokens. */
export const rebuildCiBuild = (owner: Login, name: MonorepoName, build: string) => ({ method: "POST", path: `${buildBase(owner, name, build)}/rebuild`, response: CiBuildAnswer }) as const;

/** POST .../ci/builds/{build}/cancel (202); 409 `ci_finished` once it has finished. */
export const cancelCiBuild = (owner: Login, name: MonorepoName, build: string) => ({ method: "POST", path: `${buildBase(owner, name, build)}/cancel`, response: CiBuildAnswer }) as const;

/** POST .../ci/builds/{build}/jobs/{job}/retry (202). */
export const retryCiJob = (owner: Login, name: MonorepoName, build: string, job: string) =>
  ({ method: "POST", path: `${buildBase(owner, name, build)}/jobs/${encodeURIComponent(job)}/retry`, response: CiJobAnswer }) as const;

/** POST .../ci/connections {service, organization} (201, owners): the webhook token is in this answer only. */
export const connectCi = (owner: Login, name: MonorepoName) => ({ method: "POST", path: `${ciBase(owner, name)}/connections`, response: CiConnected }) as const;

/** DELETE .../ci/connections/{connection} (204, owners). */
export const disconnectCi = (owner: Login, name: MonorepoName, connection: string) =>
  ({ method: "DELETE", path: `${ciBase(owner, name)}/connections/${encodeURIComponent(connection)}` }) as const;
