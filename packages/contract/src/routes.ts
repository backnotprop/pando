// The routes the web reads and writes: each one's path, its method when not
// GET, and the schema of its 200 body. Names are api-v1.yaml's operationIds.
// Path segments are encoded here, so callers pass plain values; a branch's
// `/` is sent as %2F.
import { AgentModels, AgentSession, AgentSessionList, AgentTranscript } from "./agent.ts";
import { Artifact, ArtifactComment, ArtifactDetail, ArtifactList, ArtifactThreads, type ArtifactCommentState } from "./artifact.ts";
import { BranchCommits, BranchDiff, BranchDiffLine, BranchList, MergeResult, Review, ReviewList, Branch } from "./branch.ts";
import { Checks } from "./checks.ts";
import { CommitDiffLine, CommitPage } from "./commit.ts";
import { CiAnnotationList, CiArtifactList, CiBuildAnswer, CiBuildDetail, CiBuildList, CiConnected, CiJobAnswer, CiJobLog, CiOverview, CiPipelinePage, Hook } from "./ci.ts";
import { HistoryPage, LastCommits, TreePage } from "./files.ts";
import { Issue, IssueComment, IssueList, Label, LabelList, ReactionsAnswer, Timeline, type IssueState, type ReactionContent } from "./issue.ts";
import { FullName, Login, MonorepoName, RepoName } from "./ids.ts";
import { MonorepoEntry, MonorepoList, MonorepoRenamed, MonorepoSummaryList } from "./monorepo.ts";
import { Org, OrgInviteResult, OrgList, OrgMember, OrgMemberList, Owner, Profile } from "./org.ts";
import { ContributionPeriod, Contributions } from "./profile.ts";
import { EventsPage } from "./feed.ts";
import { MetaHistory, MetaTree, Restored } from "./meta.ts";
import { GithubChoices, GithubRepos, Mirror, MirrorQueued, MirrorSaved } from "./mirror.ts";
import { NeedsPage } from "./needs.ts";
import { Release, ReleaseList, RepoSummary } from "./release.ts";
import { HeadList, InviteList, InviteResult, MachineList, MemberList, MonorepoCreated, Repo, RepoList, WorktreeList } from "./repo.ts";
import { BranchSessions, PersonSessions, Session, SessionAny, SessionEntries, SessionExclusions, SessionFiles, SessionList, SessionMachines, SessionMarks, SessionsDeleted } from "./session.ts";
import { CredentialList, Me, SignedOut } from "./user.ts";
import { AuthorizationServerMetadata, OAuthClientRegistration, OAuthError, OAuthToken, ProtectedResourceMetadata } from "./mcp.ts";

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

/** GET /v1/monorepos?owner=: the person's monorepos under one owner. */
export const listOwnerMonorepos = (owner: Login) => ({ path: `/v1/monorepos${query(new URLSearchParams({ owner }))}`, response: MonorepoList });

/** GET /v1/monorepos?owner=&summary=1: the same, each with its line, most recently active first (an org's page). */
export const listOwnerMonorepoSummaries = (owner: Login) => ({
  path: `/v1/monorepos${query(new URLSearchParams({ owner, summary: "1" }))}`,
  response: MonorepoSummaryList,
});

/** POST /v1/monorepos {name, kind?, owner?} (201): `owner` is your login (the default) or an org you are in. */
export const createMonorepo = { method: "POST", path: "/v1/monorepos", response: MonorepoCreated } as const;

/**
 * GET /v1/events: a page of the activity log. `inMonorepo` narrows to one `owner/name`; `owner` to one owner's
 * monorepos (an org's page; not with `inMonorepo`); `cursor` is a page's `next`.
 */
export const listActivity = (cursor: string | null, inMonorepo: FullName | null, owner: Login | null = null) => {
  const params = new URLSearchParams();

  if (cursor !== null) params.set("cursor", cursor);

  if (inMonorepo !== null) params.set("in", inMonorepo);

  if (owner !== null) params.set("owner", owner);

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
 * `kind:branch.updated` or `repo:<repo>` (at most 10; ROW_KINDS lists the row kinds), `issues` (every issue and
 * label event) or `issue:<n>` (one issue's), `agents` (every agent session's) or `agent:<n>` (one session's), `since`
 * the highest `seq` seen.
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

/** PATCH .../repos/{repo} {releases_public} (owners): "Anyone can download releases", the project's release files only, never its code. */
export const setReleasesPublic = (owner: Login, name: MonorepoName, repo: RepoName) => ({ method: "PATCH", path: repoBase(owner, name, repo), response: Repo }) as const;

/** PATCH .../repos/{repo} {ci_policy} (owners): when the project's CI builds run (every_push, on_merge, main_only). */
export const setCiPolicy = (owner: Login, name: MonorepoName, repo: RepoName) => ({ method: "PATCH", path: repoBase(owner, name, repo), response: Repo }) as const;

/** PATCH .../repos/{repo} {review: {enabled?, auto_below?, human_above?, human_for_sensitive?}} (owners): risk-based review's switch and thresholds. */
export const setRepoReview = (owner: Login, name: MonorepoName, repo: RepoName) => ({ method: "PATCH", path: repoBase(owner, name, repo), response: Repo }) as const;

// ── Builds of main and releases (research/plans/releases-2026-10-04). Made, published and deleted with the CLI or the API; the web shows them.

/** GET .../repos/{repo}/summary: main's commit and its state (or not built), the newest build on main, the latest release. */
export const getRepoSummary = (owner: Login, name: MonorepoName, repo: RepoName) => ({ path: `${repoBase(owner, name, repo)}/summary`, response: RepoSummary });

/** GET .../repos/{repo}/releases: newest first, drafts too (members), 30 a page; `cursor` is a page's next_cursor. */
export const listReleases = (owner: Login, name: MonorepoName, repo: RepoName, cursor: string | null) => ({
  path: `${repoBase(owner, name, repo)}/releases${cursor === null ? "" : query(new URLSearchParams({ cursor }))}`,
  response: ReleaseList,
});

/** GET .../releases/{tag}: one release, with its commit's checks; `latest` is the newest published one. */
export const getRelease = (owner: Login, name: MonorepoName, repo: RepoName, tag: string) => ({
  path: `${repoBase(owner, name, repo)}/releases/${encodeURIComponent(tag)}`,
  response: Release,
});

/** GET .../releases/{tag}/files/{file}: a file's bytes, as a download (members; anyone when the project's switch is on). */
export const releaseFilePath = (owner: Login, name: MonorepoName, repo: RepoName, tag: string, file: string): string =>
  `${repoBase(owner, name, repo)}/releases/${encodeURIComponent(tag)}/files/${encodeURIComponent(file)}`;

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

/** GET .../branches/{branch}/diff?patches=1: Files changed, each file with its patch. Send the last ETag as If-None-Match for a 304. */
export const branchDiff = (owner: Login, name: MonorepoName, repo: RepoName, branch: string) => ({
  path: `${branchBase(owner, name, repo, branch)}/diff?patches=1`,
  response: BranchDiff,
});

/**
 * GET .../branches/{branch}/diff?patches=1&stream=1: Files changed as NDJSON,
 * a BranchDiffLine per line (decodeBranchDiffLine), for a branch of any size.
 * Send the last ETag as If-None-Match for a 304.
 */
export const branchDiffStream = (owner: Login, name: MonorepoName, repo: RepoName, branch: string) => ({
  path: `${branchBase(owner, name, repo, branch)}/diff?patches=1&stream=1`,
  line: BranchDiffLine,
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
/** POST .../branches/{branch}/reviews {verdict, body?, comments?, head?} (201): a review on the head; an approval by a person passes risk-based review's gate. */
export const postReview = (owner: Login, name: MonorepoName, repo: RepoName, branch: string) =>
  ({ method: "POST", path: `${branchBase(owner, name, repo, branch)}/reviews`, response: Review }) as const;

export const mergeBranch = (owner: Login, name: MonorepoName, repo: RepoName, branch: string, force: boolean) =>
  ({ method: "POST", path: `${branchBase(owner, name, repo, branch)}/merge?force=${force ? "1" : "0"}`, response: MergeResult }) as const;

/** GET .../repos/{repo}/commits/{ref}/status: a commit's combined status. */
export const combinedStatus = (owner: Login, name: MonorepoName, repo: RepoName, ref: string) => ({
  path: `${repoBase(owner, name, repo)}/commits/${encodeURIComponent(ref)}/status`,
  response: Checks,
});

/**
 * GET .../repos/{repo}/commits/{sha}: one commit, the branch it came from and its checks. `sha` is a full sha or
 * 7 to 39 of its first characters (404 when none or more than one commit Pando knows starts so).
 */
export const getCommit = (owner: Login, name: MonorepoName, repo: RepoName, sha: string) => ({
  path: `${repoBase(owner, name, repo)}/commits/${encodeURIComponent(sha)}`,
  response: CommitPage,
});

/**
 * GET .../repos/{repo}/commits/{sha}/diff: what it changed against its first parent, as NDJSON, a CommitDiffLine
 * per line (decodeCommitDiffLine), with Files changed's limits. `sha` is the full sha. ETag: the sha.
 */
export const commitDiffStream = (owner: Login, name: MonorepoName, repo: RepoName, sha: string) => ({
  path: `${repoBase(owner, name, repo)}/commits/${encodeURIComponent(sha)}/diff`,
  line: CommitDiffLine,
});

/** GET .../ci/builds, newest first; narrowed to one repo, branch or commit when given. */
export const listCiBuilds = (owner: Login, name: MonorepoName, repo: RepoName | null, branch: string | null, sha: string | null = null) => {
  const params = new URLSearchParams();

  if (repo !== null) params.set("repo", repo);

  if (branch !== null) params.set("branch", branch);

  if (sha !== null) params.set("sha", sha);

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

/**
 * PATCH .../{monorepo} {owner} (owners): move it to an org you are in, or to a person who is already its own
 * owner (400 `bad_owner`). The old address keeps leading here (an alias).
 */
export const transferMonorepo = renameMonorepo;

/** PATCH {description}: a repository's one line (owners; at most 160 characters; empty or null clears it). */
export const describeMonorepo = renameMonorepo;

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

// ── Issues ──────────────────────────────────────────────────────────────────

const issuesBase = (owner: Login, name: MonorepoName): string => `${monorepoBase(owner, name)}/issues`;

const issueBase = (owner: Login, name: MonorepoName, n: number): string => `${issuesBase(owner, name)}/${n}`;

/** listIssues' filters, each optional. `assignee` and `author` take `@me`; `assignee` and `project` take `none`. */
export interface IssueFilters {
  state?: IssueState | "all";
  /** Every one must match. */
  labels?: readonly string[];
  assignee?: string;
  author?: string;
  /** A repo's name, or `none`. */
  project?: string;
  /** `<repo>:<branch>`: the issues that branch is linked to. */
  linked?: string;
  /** Words in titles and bodies (the last one a prefix), up to 10. */
  q?: string;
  sort?: "created" | "updated" | "comments";
  order?: "desc" | "asc";
  cursor?: string;
  limit?: number;
}

/** GET .../issues: a page (default the 30 newest open) and the open and closed counts for the same filters. */
export const listIssues = (owner: Login, name: MonorepoName, f: IssueFilters = {}) => {
  const params = new URLSearchParams();

  for (const [k, v] of [["state", f.state], ["assignee", f.assignee], ["author", f.author], ["project", f.project], ["linked", f.linked], ["q", f.q], ["sort", f.sort], ["order", f.order], ["cursor", f.cursor]] as const) {
    if (v !== undefined) params.set(k, v);
  }

  for (const label of f.labels ?? []) params.append("label", label);

  if (f.limit !== undefined) params.set("limit", String(f.limit));

  return { path: `${issuesBase(owner, name)}${query(params)}`, response: IssueList };
};

/**
 * POST .../issues {title, body?, labels?, assignees?, project?, link?: [{repo, branch}]} (201). Send an
 * `Idempotency-Key` header: a retry with the same key answers the first issue (200, `Pando-Replayed: true`).
 */
export const createIssue = (owner: Login, name: MonorepoName) => ({ method: "POST", path: issuesBase(owner, name), response: Issue }) as const;

/** GET .../issues/{n}. */
export const getIssue = (owner: Login, name: MonorepoName, n: number) => ({ path: issueBase(owner, name, n), response: Issue });

/**
 * PATCH .../issues/{n}: any of title, body (with base_version), project, state, state_reason, add_labels,
 * remove_labels, add_assignees, remove_assignees, link, unlink ([{repo, branch}]). 409 `edited` (ErrorBody with
 * `current`) when base_version is not the body's version now.
 */
export const updateIssue = (owner: Login, name: MonorepoName, n: number) => ({ method: "PATCH", path: issueBase(owner, name, n), response: Issue }) as const;

/** GET .../issues/{n}/timeline: oldest first; `cursor` is a page's next_cursor; `last` (instead) the newest N. */
export const issueTimeline = (owner: Login, name: MonorepoName, n: number, page: { cursor?: string; limit?: number; last?: number } = {}) => {
  const params = new URLSearchParams();

  if (page.cursor !== undefined) params.set("cursor", page.cursor);

  if (page.limit !== undefined) params.set("limit", String(page.limit));

  if (page.last !== undefined) params.set("last", String(page.last));

  return { path: `${issueBase(owner, name, n)}/timeline${query(params)}`, response: Timeline };
};

/** POST .../issues/{n}/comments {body} (201), with an `Idempotency-Key` header as createIssue. */
export const addIssueComment = (owner: Login, name: MonorepoName, n: number) => ({ method: "POST", path: `${issueBase(owner, name, n)}/comments`, response: IssueComment }) as const;

/** GET .../issues/{n}/comments/{id}: one comment, whole (a live event leaves a body over 16 KB out). */
export const getIssueComment = (owner: Login, name: MonorepoName, n: number, id: string) => ({ path: `${issueBase(owner, name, n)}/comments/${encodeURIComponent(id)}`, response: IssueComment });

/** PATCH .../issues/{n}/comments/{id} {body, base_version?}: the author only; 409 `edited` as updateIssue. */
export const updateIssueComment = (owner: Login, name: MonorepoName, n: number, id: string) =>
  ({ method: "PATCH", path: `${issueBase(owner, name, n)}/comments/${encodeURIComponent(id)}`, response: IssueComment }) as const;

/** DELETE .../issues/{n}/comments/{id} (204): the author, or an owner. */
export const deleteIssueComment = (owner: Login, name: MonorepoName, n: number, id: string) =>
  ({ method: "DELETE", path: `${issueBase(owner, name, n)}/comments/${encodeURIComponent(id)}` }) as const;

/** PUT (add yours) or DELETE (remove yours) .../issues/{n}/reactions/{content}: the issue's reactions now. */
export const issueReaction = (owner: Login, name: MonorepoName, n: number, content: ReactionContent, method: "PUT" | "DELETE") =>
  ({ method, path: `${issueBase(owner, name, n)}/reactions/${encodeURIComponent(content)}`, response: ReactionsAnswer }) as const;

/** PUT or DELETE .../issues/{n}/comments/{id}/reactions/{content}: the comment's reactions now. */
export const commentReaction = (owner: Login, name: MonorepoName, n: number, id: string, content: ReactionContent, method: "PUT" | "DELETE") =>
  ({ method, path: `${issueBase(owner, name, n)}/comments/${encodeURIComponent(id)}/reactions/${encodeURIComponent(content)}`, response: ReactionsAnswer }) as const;

const labelsBase = (owner: Login, name: MonorepoName): string => `${monorepoBase(owner, name)}/labels`;

/** GET .../labels: by name, each with its open issues. */
export const listLabels = (owner: Login, name: MonorepoName) => ({ path: labelsBase(owner, name), response: LabelList });

/** POST .../labels {name, color, description?} (201, owners). */
export const createLabel = (owner: Login, name: MonorepoName) => ({ method: "POST", path: labelsBase(owner, name), response: Label }) as const;

/** PATCH .../labels/{label} {name?, color?, description?} (owners): a rename moves the label on every issue. */
export const updateLabel = (owner: Login, name: MonorepoName, label: string) =>
  ({ method: "PATCH", path: `${labelsBase(owner, name)}/${encodeURIComponent(label)}`, response: Label }) as const;

/** DELETE .../labels/{label} (204, owners): removed from every issue. */
export const deleteLabel = (owner: Login, name: MonorepoName, label: string) => ({ method: "DELETE", path: `${labelsBase(owner, name)}/${encodeURIComponent(label)}` }) as const;

// ── Owners and organizations ───────────────────────────────────────────────

const orgBase = (org: Login): string => `/v1/orgs/${encodeURIComponent(org)}`;

/** GET /v1/users/{name}: whose `/{name}` is, a person (`type: "user"`) or an org (`type: "org"`); 404 for neither. */
export const getOwner = (name: Login) => ({ path: `/v1/users/${encodeURIComponent(name)}`, response: Owner });

/** PATCH /v1/user {name?, bio?, location?, links?}: your profile's header; a field left out is kept, null or "" clears it. */
export const updateProfile = { method: "PATCH", path: "/v1/user", response: Profile } as const;

/**
 * GET /v1/users/{login}/contributions?tz=: a person's graph and timeline for
 * the last year, as this viewer may see it. `tz`: the viewer's minutes east
 * of UTC (-getTimezoneOffset()).
 */
export const getContributions = (login: Login, tz: number) => ({
  path: `/v1/users/${encodeURIComponent(login)}/contributions${query(new URLSearchParams({ tz: String(tz) }))}`,
  response: Contributions,
});

/** GET /v1/users/{login}/contributions?tz=&day=2026-10-03: one day of the timeline (a click on a square). */
export const getContributionDay = (login: Login, tz: number, day: string) => ({
  path: `/v1/users/${encodeURIComponent(login)}/contributions${query(new URLSearchParams({ tz: String(tz), day }))}`,
  response: ContributionPeriod,
});

/** GET /v1/user/orgs: the orgs the person is in, with their role. */
export const listMyOrgs = { path: "/v1/user/orgs", response: OrgList };

/** POST /v1/orgs {login, name?} (201): the caller is its first owner. 409 `namespace_taken`, 400 `reserved_name`. */
export const createOrg = { method: "POST", path: "/v1/orgs", response: Org } as const;

/** GET /v1/orgs/{org}: its header, with the asker's role (null when not in it) and its people's count (for its people). */
export const getOrg = (org: Login) => ({ path: orgBase(org), response: Org });

/** PATCH /v1/orgs/{org} {name?, description?, website?} (owners). */
export const updateOrg = (org: Login) => ({ method: "PATCH", path: orgBase(org), response: Org }) as const;

/** GET /v1/orgs/{org}/members (its people). */
export const listOrgMembers = (org: Login) => ({ path: `${orgBase(org)}/members`, response: OrgMemberList });

/** PUT /v1/orgs/{org}/members/{login} {role} (owners): add a person by login, or change their role. 409 `last_owner`. */
export const putOrgMember = (org: Login, login: Login) => ({ method: "PUT", path: `${orgBase(org)}/members/${encodeURIComponent(login)}`, response: OrgMember }) as const;

/** DELETE /v1/orgs/{org}/members/{login} (204; owners, or the person to leave). 409 `last_owner`. */
export const removeOrgMember = (org: Login, login: Login) => ({ method: "DELETE", path: `${orgBase(org)}/members/${encodeURIComponent(login)}` }) as const;

/** POST /v1/orgs/{org}/invites {email, role} (owners): added now (200) or invited (201). */
export const orgInvite = (org: Login) => ({ method: "POST", path: `${orgBase(org)}/invites`, response: OrgInviteResult }) as const;

/** GET /v1/orgs/{org}/invites (its people): invites waiting for a first sign-in. */
export const listOrgInvites = (org: Login) => ({ path: `${orgBase(org)}/invites`, response: InviteList });

/** DELETE /v1/orgs/{org}/invites/{email} (204; owners). */
export const revokeOrgInvite = (org: Login, email: string) => ({ method: "DELETE", path: `${orgBase(org)}/invites/${encodeURIComponent(email)}` }) as const;

// ── Mirror to GitHub ───────────────────────────────────────────────────────

const mirrorBase = (owner: Login, name: MonorepoName): string => `${monorepoBase(owner, name)}/mirror`;

/** GET .../mirror (members): the connection, the mode, the switch, one row per source. */
export const getMirror = (owner: Login, name: MonorepoName) => ({ path: mirrorBase(owner, name), response: Mirror });

/** PATCH .../mirror {on} (owners): the section's switch; off pauses. */
export const setMirrorOn = (owner: Login, name: MonorepoName) => ({ method: "PATCH", path: mirrorBase(owner, name), response: Mirror }) as const;

/** PUT .../mirror/targets {mode, targets} (owners): Start mirroring, Change, a project's switch. */
export const saveMirrorTargets = (owner: Login, name: MonorepoName) => ({ method: "PUT", path: `${mirrorBase(owner, name)}/targets`, response: MirrorSaved }) as const;

/** POST .../mirror/run {repos?} (owners): Retry. */
export const retryMirror = (owner: Login, name: MonorepoName) => ({ method: "POST", path: `${mirrorBase(owner, name)}/run`, response: MirrorQueued }) as const;

/** DELETE .../mirror (owners): Disconnect; GitHub is never touched. */
export const disconnectMirror = (owner: Login, name: MonorepoName) => ({ method: "DELETE", path: mirrorBase(owner, name) }) as const;

/** GET .../mirror/github-repos (owners): the installation's repositories, for Change. */
export const listGithubRepos = (owner: Login, name: MonorepoName) => ({ path: `${mirrorBase(owner, name)}/github-repos`, response: GithubRepos });

/** GET .../mirror/choices (owners): the installations this browser proved, when there were several. */
export const getGithubChoices = (owner: Login, name: MonorepoName) => ({ path: `${mirrorBase(owner, name)}/choices`, response: GithubChoices });

/** POST .../mirror/installation {installation_id} (owners): one of those. */
export const chooseGithubInstallation = (owner: Login, name: MonorepoName) => ({ method: "POST", path: `${mirrorBase(owner, name)}/installation`, response: Mirror }) as const;

/** The address a browser goes to, to connect GitHub (or to authorize creating repositories). */
export const mirrorConnectPath = (owner: Login, name: MonorepoName, purpose: "connect" | "create" = "connect"): string => `${mirrorBase(owner, name)}/connect?purpose=${purpose}`;

// ── Cloudflare-run agents (agent.ts) ──

const agentsBase = (owner: Login, name: MonorepoName): string => `${monorepoBase(owner, name)}/agents`;

/** The Agents tab's filters (a state, who started it, what it started from), or an issue's agents. */
export interface AgentFilters {
  issue?: number;
  /** With branch: the sessions on that project's branch. */
  repo?: string;
  branch?: string;
  status?: "working" | "waiting";
  person?: Login;
  kind?: "task" | "issue" | "review";
}

/** GET .../agents: newest first; `before` is a page's next_before; `issue` only the sessions addressing it. */
export const listAgents = (owner: Login, name: MonorepoName, page: { before?: number; limit?: number } & AgentFilters = {}) => {
  const params = new URLSearchParams();

  if (page.issue !== undefined) params.set("issue", String(page.issue));

  if (page.repo !== undefined) params.set("repo", page.repo);

  if (page.branch !== undefined) params.set("branch", page.branch);

  if (page.status !== undefined) params.set("status", page.status);

  if (page.person !== undefined) params.set("person", page.person);

  if (page.kind !== undefined) params.set("kind", page.kind);

  if (page.before !== undefined) params.set("before", String(page.before));

  if (page.limit !== undefined) params.set("limit", String(page.limit));

  return { path: `${agentsBase(owner, name)}${query(params)}`, response: AgentSessionList };
};

/** GET .../agents/models: the models a session may use here (a test server adds its scripted one). */
export const agentModels = (owner: Login, name: MonorepoName) => ({ path: `${agentsBase(owner, name)}/models`, response: AgentModels });

/** POST .../agents {prompt, branch, repo?, model?} (201): launch a session acting as the caller, on the branch named (an existing one is used as it is); 400 branch_required without one. */
export const launchAgent = (owner: Login, name: MonorepoName) => ({ method: "POST", path: agentsBase(owner, name), response: AgentSession }) as const;

/**
 * POST .../issues/{n}/agent {prompt?, repo?, model?} (201): "Address with agent". Makes agent/<n>-<title words> off
 * main, linked to the issue, and launches a session on it. 409 `issue_closed` for a closed issue.
 */
export const addressIssueWithAgent = (owner: Login, name: MonorepoName, n: number) => ({ method: "POST", path: `${monorepoBase(owner, name)}/issues/${n}/agent`, response: AgentSession }) as const;

/** POST .../agents/review {branch, repo?, prompt?, model?, profile?} (201): "Review with agent" on a branch; a profile (correctness, security, tests, docs) gives it one focus. */
export const reviewWithAgent = (owner: Login, name: MonorepoName) => ({ method: "POST", path: `${agentsBase(owner, name)}/review`, response: AgentSession }) as const;

/** GET .../assistant: the caller's own chats with the repository assistant, newest first. */
export const listChats = (owner: Login, name: MonorepoName, page: { before?: number } = {}) => ({
  path: `${monorepoBase(owner, name)}/assistant${page.before === undefined ? "" : `?before=${page.before}`}`,
  response: AgentSessionList,
});

/** POST .../assistant {prompt, repo?, model?} (201): a new chat; with no repo in a monorepo of more than one project, about the whole repository. Follow-ups: sendAgent; its transcript and socket: agentTranscript, agentLivePath. */
export const newChat = (owner: Login, name: MonorepoName) => ({ method: "POST", path: `${monorepoBase(owner, name)}/assistant`, response: AgentSession }) as const;

/** GET .../agents/{n}. */
export const getAgent = (owner: Login, name: MonorepoName, n: number) => ({ path: `${agentsBase(owner, name)}/${n}`, response: AgentSession });

/** GET .../agents/{n}/transcript. */
export const agentTranscript = (owner: Login, name: MonorepoName, n: number) => ({ path: `${agentsBase(owner, name)}/${n}/transcript`, response: AgentTranscript });

/** The live view's socket for session n (open it with `Upgrade: websocket`; frames are AgentLiveFrame). */
export const agentLivePath = (owner: Login, name: MonorepoName, n: number): string => `${agentsBase(owner, name)}/${n}/live`;

/** POST .../agents/{n}/messages {prompt}: a follow-up, from the person who launched it (403 `not_launcher` for others). */
export const sendAgent = (owner: Login, name: MonorepoName, n: number) => ({ method: "POST", path: `${agentsBase(owner, name)}/${n}/messages`, response: AgentSession }) as const;

/** POST .../agents/{n}/stop: its launcher or an owner. */
export const stopAgent = (owner: Login, name: MonorepoName, n: number) => ({ method: "POST", path: `${agentsBase(owner, name)}/${n}/stop`, response: AgentSession }) as const;

// ── Recorded agent sessions (worker/src/sessions) ──

const sessionsBase = (owner: Login, name: MonorepoName): string => `${monorepoBase(owner, name)}/sessions`;

/** The Sessions tab's filters. */
export interface SessionFilters {
  state?: "active" | "inactive";
  person?: string;
  agent?: string;
  repo?: string;
  branch?: string;
  /** "yes": some commit reached main; "no": none. */
  main?: "yes" | "no";
  /** Only those whose last record is older (Settings' Delete sessions). */
  olderThanDays?: number;
  cursor?: string;
  limit?: number;
}

/** GET .../sessions: by latest activity, newest first, with Active and Inactive counts for the same filters. */
export const listSessions = (owner: Login, name: MonorepoName, f: SessionFilters = {}) => {
  const params = new URLSearchParams();

  for (const [k, v] of [["state", f.state], ["person", f.person], ["agent", f.agent], ["repo", f.repo], ["branch", f.branch], ["main", f.main], ["cursor", f.cursor]] as const) {
    if (v !== undefined) params.set(k, v);
  }

  if (f.limit !== undefined) params.set("limit", String(f.limit));

  if (f.olderThanDays !== undefined) params.set("older_than_days", String(f.olderThanDays));

  return { path: `${sessionsBase(owner, name)}${query(params)}`, response: SessionList };
};

/** GET .../sessions/{id}: a session, or its stub when deleted. */
export const getSession = (owner: Login, name: MonorepoName, id: string) => ({ path: `${sessionsBase(owner, name)}/${encodeURIComponent(id)}`, response: SessionAny });

/** GET .../sessions/{id}/entries?from=: a page of its conversation. */
export const sessionEntries = (owner: Login, name: MonorepoName, id: string, from = 0) => ({
  path: `${sessionsBase(owner, name)}/${encodeURIComponent(id)}/entries${from ? `?from=${from}` : ""}`,
  response: SessionEntries,
});

/** GET .../sessions/{id}/files: the files its commits changed. */
export const sessionFiles = (owner: Login, name: MonorepoName, id: string) => ({ path: `${sessionsBase(owner, name)}/${encodeURIComponent(id)}/files`, response: SessionFiles });

/** GET .../sessions/on-branch: a branch's numbered sessions and its commits' numbers. */
export const branchSessions = (owner: Login, name: MonorepoName, repo: RepoName, branch: string) => ({
  path: `${sessionsBase(owner, name)}/on-branch${query(new URLSearchParams({ repo, branch }))}`,
  response: BranchSessions,
});

/** DELETE .../sessions/{id}: at once and for good (its person or an owner); answers its stub. */
export const deleteSession = (owner: Login, name: MonorepoName, id: string) => ({ method: "DELETE", path: `${sessionsBase(owner, name)}/${encodeURIComponent(id)}`, response: SessionAny }) as const;

/** DELETE .../sessions/{id}/prompts/{n}: remove a turn, leaving its mark. */
export const removeSessionTurn = (owner: Login, name: MonorepoName, id: string, n: number) =>
  ({ method: "DELETE", path: `${sessionsBase(owner, name)}/${encodeURIComponent(id)}/prompts/${n}`, response: Session }) as const;

/** DELETE .../sessions?repo=&older_than_days=&everyone=1: many at once. */
export const deleteSessions = (owner: Login, name: MonorepoName, f: { repo?: string; olderThanDays?: number; everyone?: boolean }) => {
  const params = new URLSearchParams();

  if (f.repo !== undefined) params.set("repo", f.repo);

  if (f.olderThanDays !== undefined) params.set("older_than_days", String(f.olderThanDays));

  if (f.everyone) params.set("everyone", "1");

  return { method: "DELETE", path: `${sessionsBase(owner, name)}${query(params)}`, response: SessionsDeleted } as const;
};

/** GET /v1/users/{login}/sessions: a person's sessions in the repositories you both can open. */
export const personSessions = (login: Login, page: { cursor?: string; limit?: number; state?: string; agent?: string; main?: string; monorepo?: string } = {}) => {
  const params = new URLSearchParams();

  for (const [k, v] of [["state", page.state], ["agent", page.agent], ["main", page.main], ["monorepo", page.monorepo]] as const) {
    if (v !== undefined) params.set(k, v);
  }

  if (page.cursor !== undefined) params.set("cursor", page.cursor);

  if (page.limit !== undefined) params.set("limit", String(page.limit));

  return { path: `/v1/users/${encodeURIComponent(login)}/sessions${query(params)}`, response: PersonSessions };
};

/** GET /v1/users/{login}/session-marks?tz=: the profile graph's agent marks. */
export const sessionMarks = (login: Login, tz: number) => ({ path: `/v1/users/${encodeURIComponent(login)}/session-marks?tz=${tz}`, response: SessionMarks });

/** GET /v1/user/session-exclusions and PUT it (204). */
export const sessionExclusions = { path: "/v1/user/session-exclusions", response: SessionExclusions };

export const setSessionExclusions = { method: "PUT", path: "/v1/user/session-exclusions" } as const;

/** GET /v1/user/session-machines: each of your machines, as it last reported its recording. */
export const sessionMachines = { path: "/v1/user/session-machines", response: SessionMachines };

// ── Artifacts (artifact.ts): documents on a branch's page, and their comments ──

const artifactBase = (owner: Login, name: MonorepoName, id: string): string => `${monorepoBase(owner, name)}/artifacts/${encodeURIComponent(id)}`;

const artifactCommentBase = (owner: Login, name: MonorepoName, id: string): string => `${monorepoBase(owner, name)}/artifact-comments/${encodeURIComponent(id)}`;

const stateQuery = (state: ArtifactCommentState | "all"): string => (state === "all" ? "" : `?state=${state}`);

/** GET .../branches/{branch}/artifacts: the branch's artifacts, newest first, each with its newest version and comment counts. */
export const listArtifacts = (owner: Login, name: MonorepoName, repo: RepoName, branch: string) => ({ path: `${branchBase(owner, name, repo, branch)}/artifacts`, response: ArtifactList });

/**
 * POST .../branches/{branch}/artifacts, multipart: `file` (the Markdown or HTML document, or an image) and `image`
 * fields (the images it uses, each file's name its path relative to the document, `img/hero.png`). A new name is a
 * new artifact (201); a name already on the branch is its next version (200). Refused: 413 `too_large` (over
 * 10 MiB in all, or a document over 1.5 MiB), 400 `too_many_files` (over 20), 409 `too_many_artifacts` (100 on the
 * branch), 400 `bad_request` (a name, path or kind Pando does not take).
 */
export const addArtifact = (owner: Login, name: MonorepoName, repo: RepoName, branch: string) =>
  ({ method: "POST", path: `${branchBase(owner, name, repo, branch)}/artifacts`, response: Artifact }) as const;

/** GET .../artifacts/{id}: one artifact with every version. */
export const getArtifact = (owner: Login, name: MonorepoName, id: string) => ({ path: artifactBase(owner, name, id), response: ArtifactDetail });

/** DELETE .../artifacts/{id} (204): any member; every version, its bytes and its comments go, with no undo. */
export const deleteArtifact = (owner: Login, name: MonorepoName, id: string) => ({ method: "DELETE", path: artifactBase(owner, name, id) }) as const;

/**
 * GET .../artifacts/{id}/versions/{n}/files/{path}: one file's bytes (no schema), its type from its extension,
 * served with `content-security-policy: sandbox; default-src 'none'` so opening it never runs it on Pando's address.
 */
export const artifactFilePath = (owner: Login, name: MonorepoName, id: string, n: number, path: string): string =>
  `${artifactBase(owner, name, id)}/versions/${n}/files/${path.split("/").map(encodeURIComponent).join("/")}`;

/**
 * GET .../artifacts/{id}/versions/{n}/document: the version's Markdown or HTML (no schema), with the images it uses
 * from its own files written in as `data:` addresses, ready for the viewer's frame (which cannot fetch from Pando).
 * Same sandbox policy as a file. An image artifact answers its image.
 */
export const artifactDocumentPath = (owner: Login, name: MonorepoName, id: string, n: number): string => `${artifactBase(owner, name, id)}/versions/${n}/document`;

/** GET .../artifacts/{id}/comments[?state=open|resolved]: its threads on every version (the default: all). */
export const listArtifactThreads = (owner: Login, name: MonorepoName, id: string, state: ArtifactCommentState | "all" = "all") => ({
  path: `${artifactBase(owner, name, id)}/comments${stateQuery(state)}`,
  response: ArtifactThreads,
});

/** GET .../branches/{branch}/artifact-comments[?state=]: every artifact's threads on the branch (the panel's All files). */
export const listBranchArtifactThreads = (owner: Login, name: MonorepoName, repo: RepoName, branch: string, state: ArtifactCommentState | "all" = "all") => ({
  path: `${branchBase(owner, name, repo, branch)}/artifact-comments${stateQuery(state)}`,
  response: ArtifactThreads,
});

/**
 * POST .../artifacts/{id}/comments {body, version?, anchor?, quote?, in_reply_to?} (201; 200 with `pando-replayed`
 * for an `Idempotency-Key` seen before). A root takes `anchor` (Plannotator's, as written) or `quote` (plain words,
 * stored as Plannotator's external annotation); neither: on the whole artifact. `version` defaults to the newest.
 * A reply names `in_reply_to` and takes neither. Refused: 409 `too_many_threads` (500 on one version) or
 * `too_many_replies` (100 in a thread); 400 `too_many_mentions` (over 10 people named); 413 `too_large`.
 */
export const addArtifactComment = (owner: Login, name: MonorepoName, id: string) =>
  ({ method: "POST", path: `${artifactBase(owner, name, id)}/comments`, response: ArtifactComment }) as const;

/** GET .../artifact-comments/{id}: one comment, whole (a live event leaves a body over 16 KB out). */
export const getArtifactComment = (owner: Login, name: MonorepoName, id: string) => ({ path: artifactCommentBase(owner, name, id), response: ArtifactComment });

/**
 * PATCH .../artifact-comments/{id}: `{body, base_version?}` edits your own (409 `edited` with `current` when
 * base_version is stale); `{state: "resolved" | "open"}` resolves or reopens its thread (any member). Answers the
 * comment changed (the thread's root for a state change).
 */
export const updateArtifactComment = (owner: Login, name: MonorepoName, id: string) =>
  ({ method: "PATCH", path: artifactCommentBase(owner, name, id), response: ArtifactComment }) as const;

/** DELETE .../artifact-comments/{id} (204): your own. A root with replies keeps its place with its body gone. */
export const deleteArtifactComment = (owner: Login, name: MonorepoName, id: string) => ({ method: "DELETE", path: artifactCommentBase(owner, name, id) }) as const;

// ── MCP: the endpoint and its sign-in (worker/src/mcp; docs: site/docs, MCP). Not under /v1: hosts find them by
// the OAuth well-known paths. Every path answers 404 where MCP_ORIGIN is unset or names another host.

/**
 * POST /mcp: the MCP endpoint (Streamable HTTP, JSON answers, no sessions; 2026-07-28, and 2025-06-18 and
 * 2025-11-25 for 2025-era hosts). Bearer: a credential of kind mcp from the sign-in below, or a machine's.
 * GET and DELETE answer 405. Without a valid bearer: 401 with OAuthError and
 * `WWW-Authenticate: Bearer realm="Pando", resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="mcp"`.
 */
export const mcp = { method: "POST", path: "/mcp", unauthorized: OAuthError } as const;

/** GET /.well-known/oauth-protected-resource/mcp (also without /mcp), CORS *. */
export const oauthProtectedResource = { path: "/.well-known/oauth-protected-resource/mcp", response: ProtectedResourceMetadata };

/** GET /.well-known/oauth-authorization-server (also with /mcp), CORS *. */
export const oauthAuthorizationServer = { path: "/.well-known/oauth-authorization-server", response: AuthorizationServerMetadata };

/** POST /oauth/register, JSON (201), CORS *: a public client; 10 a minute per address (429 after). Refusals: OAuthError. */
export const oauthRegister = { method: "POST", path: "/oauth/register", response: OAuthClientRegistration, refusal: OAuthError } as const;

/**
 * GET /oauth/authorize?response_type=code&client_id&redirect_uri&code_challenge&code_challenge_method=S256&state&resource:
 * a page in the browser (sign in first, then "Connect <app> to Pando"), never fetched; POST is its Allow or Deny.
 * The answer goes back to the app's redirect URI with code (or error), state and iss. No CORS.
 */
export const oauthAuthorizePath = "/oauth/authorize";

/** POST /oauth/token, form (grant_type=authorization_code, code, code_verifier, client_id, redirect_uri, resource), CORS *. */
export const oauthToken = { method: "POST", path: "/oauth/token", response: OAuthToken, refusal: OAuthError } as const;

/** POST /oauth/revoke, form (token) (RFC 7009): 200 always, no body, no CORS; ends the person's whole grant to that app. */
export const oauthRevoke = { method: "POST", path: "/oauth/revoke" } as const;
