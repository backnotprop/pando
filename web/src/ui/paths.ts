// The app's addresses, GitHub's shape (owner ruling): /{owner}/{name}, then
// /tree/, /blob/ and /history/ for a monorepo's root files and folders. Each
// helper gives TanStack Router's typed link options; raw files are the
// Worker's, so they are plain URLs.
import { linkOptions } from "@tanstack/react-router";

const split = (full: string) => {
  const [owner = "", name = ""] = full.split("/");

  return { owner, name };
};

export const ownerLink = (owner: string) => linkOptions({ to: "/$owner", params: { owner } });

/** An organization's People or Settings (its overview is ownerLink). */
export const orgLink = (org: string, tab: "people" | "settings") => linkOptions({ to: `/orgs/$org/${tab}`, params: { org } });

export const monoLink = (full: string) => linkOptions({ to: "/$owner/$name", params: split(full) });

export const treeLink = (full: string, dir: string) =>
  dir ? linkOptions({ to: "/$owner/$name/tree/$", params: { ...split(full), _splat: dir } }) : monoLink(full);

/** A file page's query (api/search.ts, fileSearch). Only the keys that are set: a key present but undefined fails the route's schema. */
interface FileQuery {
  v?: string;
  ref?: string;
  plain?: string;
}

const fileQuery = (at: FileQuery, plain: boolean): FileQuery => (plain ? { ...at, plain: "1" } : at);

/** `plain` opens a document (Markdown, HTML) on its code instead of its Preview (`?plain=1`). */
export const blobLink = (full: string, path: string, version: number | null = null, plain = false) =>
  linkOptions({ to: "/$owner/$name/blob/$", params: { ...split(full), _splat: path }, search: fileQuery(version ? { v: String(version) } : {}, plain) });

export const historyLink = (full: string, path: string) => linkOptions({ to: "/$owner/$name/history/$", params: { ...split(full), _splat: path } });

export const tabLink = (full: string, tab: "activity" | "machines" | "ci" | "members" | "settings") =>
  linkOptions({ to: `/$owner/$name/${tab}`, params: split(full) });

/** The Agents tab, with its filters (only those set). */
export const agentsLink = (full: string, search: AgentsSearch = {}) => linkOptions({ to: "/$owner/$name/agents", params: split(full), search });

/** One agent session's page. */
export const agentLink = (full: string, n: number) => linkOptions({ to: "/$owner/$name/agents/$n", params: { ...split(full), n: String(n) } });

/** The address's filters on the Agents tab: plain strings, as the list reads them. */
export interface AgentsSearch {
  status?: string;
  person?: string;
  kind?: string;
}

/** The address's filters on the issues list (`?state=closed&label=bug`): plain strings, as the list reads them. */
export interface IssuesSearch {
  state?: string;
  label?: string;
  assignee?: string;
  author?: string;
  project?: string;
  q?: string;
  sort?: string;
}

/** The issues list, with filters (only those set: a key present but undefined fails the route's schema). */
export const issuesLink = (full: string, search: IssuesSearch = {}) => linkOptions({ to: "/$owner/$name/issues", params: split(full), search });

export const issueLink = (full: string, n: number) => linkOptions({ to: "/$owner/$name/issues/$number", params: { ...split(full), number: String(n) } });

/** New issue; `project` (a repo's name, projects-pando) fills its Project. */
export const newIssueLink = (full: string, project: string | null = null) =>
  linkOptions({ to: "/$owner/$name/issues/new", params: split(full), search: project ? { project } : {} });

/** A CI pipeline's page, and one of its builds by number (/{owner}/{name}/ci/{pipeline}/{number}). */
export const ciPipelineLink = (full: string, pipeline: string) => linkOptions({ to: "/$owner/$name/ci/$pipeline", params: { ...split(full), pipeline } });

export const ciBuildLink = (full: string, pipeline: string, number: number) =>
  linkOptions({ to: "/$owner/$name/ci/$pipeline/$number", params: { ...split(full), pipeline, number: String(number) } });

// ── A repo's code: a monorepo's projects at /{owner}/{name}/projects/{project}/...,
// a plain repo's at /{owner}/{name}/... (its code is its page). `ref` is a
// branch or a commit; null is the default branch.

const project = (repoPath: string) => repoPath.replace(/^projects\//, "");

const refOf = (ref: string | null) => (ref ? { ref } : {});

export const codeLink = (full: string, repoPath: string, dir: string, ref: string | null = null) => {
  const at = { ...split(full), project: project(repoPath) };

  if (repoPath === ".") {
    return dir
      ? linkOptions({ to: "/$owner/$name/tree/$", params: { ...split(full), _splat: dir }, search: refOf(ref) })
      : linkOptions({ to: "/$owner/$name", params: split(full), search: refOf(ref) });
  }

  return dir
    ? linkOptions({ to: "/$owner/$name/projects/$project/tree/$", params: { ...at, _splat: dir }, search: refOf(ref) })
    : linkOptions({ to: "/$owner/$name/projects/$project", params: at, search: refOf(ref) });
};

export const repoLink = (full: string, repoPath: string) => codeLink(full, repoPath, "");

export const codeBlobLink = (full: string, repoPath: string, path: string, ref: string | null, plain = false) => {
  const search = fileQuery(refOf(ref), plain);

  return repoPath === "."
    ? linkOptions({ to: "/$owner/$name/blob/$", params: { ...split(full), _splat: path }, search })
    : linkOptions({ to: "/$owner/$name/projects/$project/blob/$", params: { ...split(full), project: project(repoPath), _splat: path }, search });
};

export const codeHistoryLink = (full: string, repoPath: string, path: string, ref: string | null) =>
  repoPath === "."
    ? linkOptions({ to: "/$owner/$name/history/$", params: { ...split(full), _splat: path }, search: refOf(ref) })
    : linkOptions({ to: "/$owner/$name/projects/$project/history/$", params: { ...split(full), project: project(repoPath), _splat: path }, search: refOf(ref) });

export const branchesLink = (full: string, repoPath: string, merged = false) =>
  repoPath === "."
    ? linkOptions({ to: "/$owner/$name/branches", params: split(full), search: merged ? { tab: "merged" } : {} })
    : linkOptions({ to: "/$owner/$name/projects/$project/branches", params: { ...split(full), project: project(repoPath) }, search: merged ? { tab: "merged" } : {} });

/** A repo's Releases tab. */
export const releasesLink = (full: string, repoPath: string) =>
  repoPath === "."
    ? linkOptions({ to: "/$owner/$name/releases", params: split(full) })
    : linkOptions({ to: "/$owner/$name/projects/$project/releases", params: { ...split(full), project: project(repoPath) } });

/** One release's page, by its tag. */
export const releaseLink = (full: string, repoPath: string, tag: string) =>
  repoPath === "."
    ? linkOptions({ to: "/$owner/$name/releases/$tag", params: { ...split(full), tag } })
    : linkOptions({ to: "/$owner/$name/projects/$project/releases/$tag", params: { ...split(full), project: project(repoPath), tag } });

/** A branch's page: the pull request; `files` for its Files changed tab. */
export const branchLink = (full: string, repoPath: string, branch: string, files = false) =>
  repoPath === "."
    ? linkOptions({ to: "/$owner/$name/branches/$", params: { ...split(full), _splat: branch }, search: files ? { tab: "files" } : {} })
    : linkOptions({
        to: "/$owner/$name/projects/$project/branches/$",
        params: { ...split(full), project: project(repoPath), _splat: branch },
        search: files ? { tab: "files" } : {},
      });

/** A commit's page (/commit/{sha}, as GitHub's): its message, checks and the files it changed. */
export const commitLink = (full: string, repoPath: string, sha: string) =>
  repoPath === "."
    ? linkOptions({ to: "/$owner/$name/commit/$sha", params: { ...split(full), sha } })
    : linkOptions({ to: "/$owner/$name/projects/$project/commit/$sha", params: { ...split(full), project: project(repoPath), sha } });

/** A branch's Sessions tab. */
export const branchSessionsLink = (full: string, repoPath: string, branch: string) =>
  repoPath === "."
    ? linkOptions({ to: "/$owner/$name/branches/$", params: { ...split(full), _splat: branch }, search: { tab: "sessions" } })
    : linkOptions({ to: "/$owner/$name/projects/$project/branches/$", params: { ...split(full), project: project(repoPath), _splat: branch }, search: { tab: "sessions" } });

/** A code file's bytes (the Worker's raw route; members only). */
export const codeRawHref = (full: string, repoPath: string, path: string, ref: string | null) =>
  `/${full}${repoPath === "." ? "" : `/projects/${project(repoPath)}`}/raw/${path.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;

/** The Sessions tab's filters in the address (`?state=inactive&agent=codex&branch=projects-web:fix-login&main=yes&group=branch`). */
export interface SessionsSearch {
  state?: string;
  person?: string;
  agent?: string;
  branch?: string;
  main?: string;
  group?: string;
}

/** A repository's Sessions tab, with filters (only those set). */
export const sessionsLink = (full: string, search: SessionsSearch = {}) => linkOptions({ to: "/$owner/$name/sessions", params: split(full), search });

/** A recorded session's page. */
export const sessionLink = (full: string, id: string) => linkOptions({ to: "/$owner/$name/sessions/$id", params: { ...split(full), id } });

/** A person's sessions, in the repositories the viewer can open too. */
export const personSessionsLink = (login: string) => linkOptions({ to: "/$owner/sessions", params: { owner: login } });

export type AppLink =
  | ReturnType<typeof ownerLink>
  | ReturnType<typeof orgLink>
  | ReturnType<typeof monoLink>
  | ReturnType<typeof treeLink>
  | ReturnType<typeof blobLink>
  | ReturnType<typeof historyLink>
  | ReturnType<typeof tabLink>
  | ReturnType<typeof issuesLink>
  | ReturnType<typeof agentsLink>
  | ReturnType<typeof agentLink>
  | ReturnType<typeof issueLink>
  | ReturnType<typeof newIssueLink>
  | ReturnType<typeof ciPipelineLink>
  | ReturnType<typeof ciBuildLink>
  | ReturnType<typeof codeLink>
  | ReturnType<typeof codeBlobLink>
  | ReturnType<typeof codeHistoryLink>
  | ReturnType<typeof branchesLink>
  | ReturnType<typeof releasesLink>
  | ReturnType<typeof releaseLink>
  | ReturnType<typeof branchLink>
  | ReturnType<typeof branchSessionsLink>
  | ReturnType<typeof commitLink>
  | ReturnType<typeof sessionsLink>
  | ReturnType<typeof sessionLink>
  | ReturnType<typeof personSessionsLink>;

/** A monorepo's own project: the one named after it (projects/pando in ramos/pando); lists put it first and leave its name off. */
export const isHomeProject = (repoPath: string | null, monorepoName: string) => repoPath?.split("/").pop() === monorepoName;

/** The full address, for Copy link and Copy raw link. */
export const absolute = (href: string) => new URL(href, location.origin).toString();

/** Docs, the changelog and the quiet links: the Worker sends /docs/<path> to the docs site (worker/wrangler.jsonc DOCS_URL, its one setting). */
export const DOCS = "/docs";
