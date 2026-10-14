// The MCP tools and resources: the one registry. Each tool is a thin adapter over Pando's own /v1 API,
// called in this isolate as the person (handler.ts), so membership, checks and every rule stay where
// they are. A refusal from the API is a tool result with isError, for the model to read; a malformed
// MCP request is the SDK's protocol error. Every caller sees the same list; access is decided by the API.

import { McpServer, ProtocolError, ProtocolErrorCode, ResourceTemplate } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type * as Contract from "@pando/contract";
import type { Auth } from "../accounts/store";
import type { JsonObject } from "../parse";

/** The tools, in the order tools/list gives them. The test pins this list. */
export const TOOL_NAMES = [
  "whoami",
  "list_repositories",
  "repository",
  "branch",
  "branch_diff",
  "merge",
  "issues",
  "write_issue",
  "read_artifact",
  "comment_artifact",
  "session",
  "launch_agent",
] as const;

/** The most text a tool hands back at once (a diff, a document, a conversation); it says when there is more. */
export const TEXT_MAX = 60_000;

/** The most patch a branch_diff resource holds: 8 MiB, the most the diff route gives (a larger file is left out, and said). */
const DIFF_RESOURCE_MAX = 8 << 20;

/** Projects whose open branches `repository` lists, and open branches per project. */
const PROJECTS_SHOWN = 20;

const BRANCHES_SHOWN = 20;

/** Files `branch_diff` lists. */
const FILES_SHOWN = 300;

/** Repositories whoami names. */
const REPOS_SHOWN = 100;

/** One answer from the API. */
export interface ApiAnswer {
  status: number;
  text: string;
  type: string;
}

/** Who calls, and the API as they see it. */
export interface Caller {
  auth: Auth;
  /** The public origin (MCP_ORIGIN). */
  origin: string;
  call(method: string, path: string, body?: JsonObject): Promise<ApiAnswer>;
}

/** The API said no: its status, code and message go to the model as they are. */
class Refusal extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ErrorAnswer {
  error?: { code?: string; message?: string };
}

function refusal(a: ApiAnswer): Refusal {
  try {
    // SAFETY: Pando's error bodies are {error: {code, message}} (Contract.ErrorBody); a miss keeps the raw text.
    const e = JSON.parse(a.text) as ErrorAnswer;

    return new Refusal(a.status, e.error?.code ?? "error", e.error?.message ?? a.text.slice(0, 500));
  } catch {
    return new Refusal(a.status, "error", a.text.slice(0, 500));
  }
}

/** Text cut to `max` characters, saying so. */
function clip(s: string, max: number, what: string): { text: string; truncated: boolean } {
  return s.length <= max ? { text: s, truncated: false } : { text: `${s.slice(0, max)}\n[${what} cut at ${max} characters of ${s.length}]`, truncated: true };
}

const enc = encodeURIComponent;

/** What a tool answers: JSON, read-only arrays included (the contract's types are read-only). */
type Value = string | number | boolean | null | undefined | readonly Value[] | Output;

interface Output {
  readonly [key: string]: Value;
}

/** A tool's answer: the object as structured content, and as JSON text for hosts that read only text. */
function done(out: Output, extra: CallToolResult["content"] = []): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(out) }, ...extra], structuredContent: out };
}

function failed(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Run a tool's body; the API's refusals become results the model reads. */
async function run(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof Refusal) return failed(`Pando refused (${err.status} ${err.code}): ${err.message}`);
    throw err;
  }
}

// ── Arguments ──────────────────────────────────────────────────────────────

const repository = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/, "owner/name, such as ana/shop")
  .describe("The repository as owner/name, as whoami or list_repositories give it");

const project = z
  .string()
  .min(1)
  .max(100)
  .optional()
  .describe("The project (a code repo inside the repository), as `repository` lists them. May be left out when the repository has one project");

const branch = z.string().min(1).max(255).describe("The branch's git name, such as feature/login");

const READ = { readOnlyHint: true, openWorldHint: false } as const;

// ── The API, typed by the contract ─────────────────────────────────────────

type Me = typeof Contract.Me.Encoded;

type MonorepoList = typeof Contract.MonorepoList.Encoded;

type MonorepoSummaryList = typeof Contract.MonorepoSummaryList.Encoded;

type MonorepoEntry = typeof Contract.MonorepoEntry.Encoded;

type RepoList = typeof Contract.RepoList.Encoded;

type BranchList = typeof Contract.BranchList.Encoded;

type Branch = typeof Contract.Branch.Encoded;

type BranchSessions = typeof Contract.BranchSessions.Encoded;

type ArtifactList = typeof Contract.ArtifactList.Encoded;

type ArtifactDetail = typeof Contract.ArtifactDetail.Encoded;

type ArtifactThreads = typeof Contract.ArtifactThreads.Encoded;

type ArtifactComment = typeof Contract.ArtifactComment.Encoded;

type IssueList = typeof Contract.IssueList.Encoded;

type Issue = typeof Contract.Issue.Encoded;

type IssueComment = typeof Contract.IssueComment.Encoded;

type Timeline = typeof Contract.Timeline.Encoded;

type MergeResult = typeof Contract.MergeResult.Encoded;

type SessionAny = typeof Contract.SessionAny.Encoded;

type SessionEntries = typeof Contract.SessionEntries.Encoded;

type AgentSession = typeof Contract.AgentSession.Encoded;

/** The JSON form of GET .../branches/{branch}/diff (no contract schema: the web reads ?patches=1). */
interface DiffSummary {
  base_branch: string;
  head: string;
  merge_base: string;
  truncated: boolean;
  stats: { files: number; additions: number; deletions: number };
  files: { path: string; old_path?: string; status: string; binary?: boolean; additions?: number | null; deletions?: number | null }[];
}

class Api {
  constructor(private caller: Caller) {}

  async text(method: string, path: string, body?: JsonObject): Promise<ApiAnswer> {
    const a = await this.caller.call(method, path, body);

    if (a.status >= 400) throw refusal(a);

    return a;
  }

  async json<T>(path: string, method = "GET", body?: JsonObject): Promise<T> {
    // SAFETY: each caller names the contract type of the route it asks (packages/contract/src/routes.ts).
    return JSON.parse((await this.text(method, path, body)).text) as T;
  }

  /** The same, or null when the API refuses (a part of a page that may be missing). */
  async maybe<T>(path: string): Promise<T | null> {
    try {
      return await this.json<T>(path);
    } catch (err) {
      if (err instanceof Refusal) return null;
      throw err;
    }
  }
}

const base = (repo: string) => {
  const [o, m] = repo.split("/");

  return `/v1/monorepos/${enc(o.toLowerCase())}/${enc(m.toLowerCase())}`;
};

const branchPath = (repo: string, proj: string, b: string) => `${base(repo)}/repos/${enc(proj)}/branches/${enc(b)}`;

/** The project named, or the only one; a refusal naming them when there are several. */
async function projectOf(api: Api, repo: string, proj: string | undefined): Promise<string> {
  if (proj) return proj;
  const list = await api.json<RepoList>(`${base(repo)}/repos`);

  if (list.repos.length === 1) return list.repos[0].name;

  throw new Refusal(400, "project_required", list.repos.length === 0 ? `${repo} has no projects yet` : `${repo} has ${list.repos.length} projects; name one in project: ${list.repos.map((r) => r.name).join(", ")}`);
}

const checksOf = (c: Branch["checks"]) => ({
  state: c.state,
  required: c.required,
  missing: c.missing,
  statuses: c.statuses.map((s) => ({ context: s.context, state: s.state, description: s.description, target_url: s.target_url })),
  checks_unknown: c.checks_unknown,
});

// ── Resources' addresses ───────────────────────────────────────────────────

export const fileUri = (repo: string, proj: string, ref: string, path: string) => `pando://${repo}/${enc(proj)}/${enc(ref)}/${path.split("/").map(enc).join("/")}`;

export const diffUri = (repo: string, proj: string, b: string) => `pando-diff://${repo}/${enc(proj)}/${enc(b)}`;

export const artifactUri = (repo: string, id: string, version: number) => `pando-artifact://${repo}/${enc(id)}/${version}`;

/** The server's instructions: whoami first, within the 2,048 characters a host keeps. */
export function instructions(origin: string): string {
  return [
    "Call whoami first: it says who you act as (a Pando person, through this connection) and which repositories you can reach. Every action here is done as that person, with their access.",
    "To find your way: list_repositories, then repository (its projects, open branches and counts), then branch (checks, merge state, sessions, artifacts, linked issues) and branch_diff (the files changed and the patch). A repository is owner/name; a project is a code repo inside it; a branch is its git name.",
    "merge lands a branch on its project's default branch with a merge commit, as the web and the CLI do. Pando refuses while required checks are failing, pending or missing; force overrides that, so use it only when the person asked.",
    "issues reads issues; write_issue opens one or comments. read_artifact reads a document on a branch (a plan, a report) with its open comments; comment_artifact adds one. session reads a recorded agent conversation. launch_agent starts a cloud agent on a branch, as the person.",
    "Long text is cut (each tool says where); the resources pando://, pando-diff:// and pando-artifact:// hold it whole.",
    `These tools are one door. Git, the pando CLI and the REST API (${origin}/v1/openapi.yaml) do the rest: read ${origin}/docs/mcp before working around a gap here.`,
  ].join("\n\n");
}

/** A fresh server for one request, as this caller. */
export function buildServer(caller: Caller): McpServer {
  const api = new Api(caller);

  const server = new McpServer(
    { name: "pando", title: "Pando", version: "1.0.0", websiteUrl: caller.origin },
    {
      instructions: instructions(caller.origin),
      // No change events: the lists never change while a server runs, and subscriptions/listen is refused.
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      // The same for every caller: what a person may see is decided inside each call.
      cacheHints: {
        "server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
        "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "resources/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "resources/templates/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "resources/read": { ttlMs: 0, cacheScope: "private" },
      },
    },
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "Who you act as in Pando: the person (login, name, email), this connection's credential (kind mcp, named after your app), and the repositories they can reach with their role in each. Call it first.",
      annotations: READ,
    },
    () =>
      run(async () => {
        const [me, list] = await Promise.all([api.json<Me>("/v1/user"), api.json<MonorepoList>("/v1/monorepos")]);

        return done({
          login: me.login,
          name: me.name,
          email: me.email,
          credential: { kind: me.credential.kind, name: me.credential.name },
          repositories: list.monorepos.slice(0, REPOS_SHOWN).map((m) => ({ repository: m.full_name, kind: m.kind, role: m.role })),
          total_repositories: list.monorepos.length,
        });
      }),
  );

  server.registerTool(
    "list_repositories",
    {
      title: "List repositories",
      description: "The repositories you can open, most recently active first: kind (monorepo or plain repo), your role, its one-line description, its projects, open branches and open issues, people, and last activity. owner narrows to one person's or organization's.",
      inputSchema: z.object({ owner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).optional().describe("A login or organization, to list only theirs") }),
      annotations: READ,
    },
    ({ owner }) =>
      run(async () => {
        const list = await api.json<MonorepoSummaryList>(`/v1/monorepos?summary=1${owner ? `&owner=${enc(owner.toLowerCase())}` : ""}`);

        return done({
          repositories: list.monorepos.map((m) => ({
            repository: m.full_name,
            kind: m.kind,
            role: m.role,
            description: m.description,
            projects: m.repos,
            open_branches: m.open_branches,
            open_issues: m.open_issues,
            people: m.members,
            last_activity_at: m.last_activity_at,
          })),
        });
      }),
  );

  server.registerTool(
    "repository",
    {
      title: "Repository",
      description: `One repository: its projects (code repos, each with its default branch and clone URL) and each project's open branches with their checks and merge state, and its open and closed issue counts. At most ${PROJECTS_SHOWN} projects and ${BRANCHES_SHOWN} open branches each are listed.`,
      inputSchema: z.object({ repository }),
      annotations: READ,
    },
    ({ repository: repo }) =>
      run(async () => {
        const [entry, repos, issues] = await Promise.all([
          api.json<MonorepoEntry>(base(repo)),
          api.json<RepoList>(`${base(repo)}/repos`),
          api.maybe<IssueList>(`${base(repo)}/issues?state=open&limit=1`),
        ]);

        const shown = repos.repos.slice(0, PROJECTS_SHOWN);
        const lists = await Promise.all(shown.map((r) => api.maybe<BranchList>(`${base(repo)}/repos/${enc(r.name)}/branches?state=open&limit=${BRANCHES_SHOWN}`)));

        return done({
          repository: entry.full_name,
          kind: entry.kind,
          role: entry.role,
          description: entry.description,
          counts: { projects: repos.repos.length, open_issues: issues?.counts.open ?? null, closed_issues: issues?.counts.closed ?? null },
          projects: shown.map((r, i) => ({
            project: r.name,
            path: r.path,
            default_branch: r.default_branch,
            clone_url: r.clone_url,
            description: r.description,
            open_branches: (lists[i]?.branches ?? []).map((b) => ({
              branch: b.name,
              title: b.title,
              author: b.author,
              checks: b.checks.state,
              mergeable: b.stale ? b.last_mergeable : b.mergeable,
              ahead: b.ahead,
              behind: b.behind,
              updated_at: b.updated_at,
            })),
            more_open_branches: lists[i]?.next_cursor !== null && lists[i]?.next_cursor !== undefined,
          })),
          more_projects: repos.repos.length > shown.length,
        });
      }),
  );

  server.registerTool(
    "branch",
    {
      title: "Branch",
      description: "One branch, as its page shows it: head and merge base, ahead and behind, merge state (clean, conflicts and their paths, up_to_date), required checks and each status, whether merged and by whom, the agent sessions that made it, its artifacts (documents with comment counts) and the issues it is linked to.",
      inputSchema: z.object({ repository, project, branch }),
      annotations: READ,
    },
    ({ repository: repo, project: p, branch: name }) =>
      run(async () => {
        const proj = await projectOf(api, repo, p);
        const path = branchPath(repo, proj, name);

        const [b, sessions, artifacts, issues] = await Promise.all([
          api.json<Branch>(path),
          api.maybe<BranchSessions>(`${base(repo)}/sessions/on-branch?${new URLSearchParams({ repo: proj, branch: name })}`),
          api.maybe<ArtifactList>(`${path}/artifacts`),
          api.maybe<IssueList>(`${base(repo)}/issues?${new URLSearchParams({ linked: `${proj}:${name}`, state: "all", limit: "20" })}`),
        ]);

        return done({
          repository: repo,
          project: proj,
          branch: b.name,
          title: b.title,
          description: b.description,
          author: b.author,
          state: b.state,
          head: b.head,
          merge_base: b.base,
          ahead: b.ahead,
          behind: b.behind,
          mergeable: b.mergeable,
          stale: b.stale,
          conflict_paths: b.conflict_paths,
          checks: checksOf(b.checks),
          merged: b.state === "merged" ? { merge_commit: b.merge_commit, merged_by: b.merged_by, merged_at: b.merged_at, forced: b.forced } : null,
          pushed_machine: b.pushed_machine,
          updated_at: b.updated_at,
          sessions: (sessions?.sessions ?? []).map((s) => ({
            number: s.number,
            id: s.id,
            person: s.session && s.session.state !== "deleted" ? s.session.person : null,
            program: s.session && s.session.state !== "deleted" ? s.session.program : null,
            state: s.session?.state ?? null,
            prompts: s.session && s.session.state !== "deleted" ? s.session.prompts : null,
            commits: s.commits.length,
          })),
          artifacts: (artifacts?.artifacts ?? []).map((a) => ({ id: a.id, name: a.name, kind: a.kind, title: a.title, versions: a.versions, open_comments: a.comments.open, updated_at: a.updated_at })),
          issues: (issues?.issues ?? []).map((i) => ({ number: i.number, title: i.title, state: i.state })),
        });
      }),
  );

  server.registerTool(
    "branch_diff",
    {
      title: "Branch diff",
      description: `A branch's changes against its project's default branch (from the merge base, as a pull request shows them): each file changed with its status and line counts (at most ${FILES_SHOWN}), and the unified patch cut at ${TEXT_MAX} characters. The resource it links holds the whole patch.`,
      inputSchema: z.object({ repository, project, branch }),
      annotations: READ,
    },
    ({ repository: repo, project: p, branch: name }) =>
      run(async () => {
        const proj = await projectOf(api, repo, p);
        const path = branchPath(repo, proj, name);
        const [summary, patch] = await Promise.all([api.json<DiffSummary>(`${path}/diff`), api.text("GET", `${path}/diff?format=patch&max_bytes=${TEXT_MAX}`)]);
        const cut = clip(patch.text, TEXT_MAX, "the patch");
        const uri = diffUri(repo, proj, name);

        return done(
          {
            repository: repo,
            project: proj,
            branch: name,
            base_branch: summary.base_branch,
            head: summary.head,
            merge_base: summary.merge_base,
            stats: summary.stats,
            files: summary.files.slice(0, FILES_SHOWN).map((f) => ({ path: f.path, old_path: f.old_path ?? null, status: f.status, binary: f.binary ?? false, additions: f.additions ?? null, deletions: f.deletions ?? null })),
            more_files: summary.truncated || summary.files.length > FILES_SHOWN,
            patch: cut.text,
            patch_truncated: cut.truncated,
            full_diff: uri,
          },
          [{ type: "resource_link", uri, name: `${repo} ${proj} ${name}.diff`, mimeType: "text/x-patch" }],
        );
      }),
  );

  server.registerTool(
    "merge",
    {
      title: "Merge a branch",
      description: "Merge a branch into its project's default branch with a merge commit, as you. Pando refuses while required checks are failing, pending or missing, or the branch conflicts, or its risk calls for a review (review_required: tell the person; risk_pending: retry soon); force: true merges past red or missing checks (never past conflicts), so only when the person asked. expected_head refuses if the branch moved since you read it. Linked open issues close.",
      inputSchema: z.object({
        repository,
        project,
        branch,
        force: z.boolean().default(false).describe("Merge even though required checks are not green. Only when the person asked"),
        expected_head: z.string().regex(/^[0-9a-f]{40}$/).optional().describe("The head sha you reviewed (branch gives it); refused if the branch moved"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ repository: repo, project: p, branch: name, force, expected_head }) =>
      run(async () => {
        const proj = await projectOf(api, repo, p);
        const body: JsonObject = { expected_head };
        const m = await api.json<MergeResult>(`${branchPath(repo, proj, name)}/merge${force ? "?force=1" : ""}`, "POST", body);

        return done({
          repository: repo,
          project: proj,
          branch: m.branch,
          status: m.status,
          merge_commit: m.sha ?? null,
          head: m.head,
          forced: m.forced ?? false,
          merged_by: m.merged_by ?? null,
          closes_issues: m.closes ?? [],
        });
      }),
  );

  server.registerTool(
    "issues",
    {
      title: "Issues",
      description: "Read issues. With number: that issue with its body, labels, assignees, linked branches count and its comments (oldest first, up to 100). Without: a page of issues (open by default, newest first) and the open and closed counts; q searches titles and bodies, project narrows to one project.",
      inputSchema: z.object({
        repository,
        number: z.number().int().min(1).optional().describe("One issue's number"),
        state: z.enum(["open", "closed", "all"]).default("open").describe("For a list; defaults to open"),
        q: z.string().max(200).optional().describe("Words to find in titles and bodies"),
        project: z.string().max(100).optional().describe("A project's name, or none for issues about the whole repository"),
        limit: z.number().int().min(1).max(100).default(30).describe("For a list; at most 100"),
      }),
      annotations: READ,
    },
    ({ repository: repo, number, state, q, project: p, limit }) =>
      run(async () => {
        if (number !== undefined) {
          const [i, t] = await Promise.all([api.json<Issue>(`${base(repo)}/issues/${number}`), api.json<Timeline>(`${base(repo)}/issues/${number}/timeline?limit=100`)]);
          const body = clip(i.body, TEXT_MAX, "the body");

          return done({
            number: i.number,
            title: i.title,
            state: i.state,
            author: i.author,
            project: i.project,
            labels: i.labels.map((l) => l.name),
            assignees: i.assignees,
            linked_branches: i.linked_branches,
            created_at: i.created_at,
            body: body.text,
            comments: t.items.flatMap((x) => (x.kind === "comment" ? [{ id: x.comment.id, author: x.comment.author, body: x.comment.body, created_at: x.comment.created_at }] : [])),
            more_timeline: t.next_cursor !== null,
          });
        }

        const params = new URLSearchParams({ state, limit: String(limit) });

        if (q) params.set("q", q);

        if (p) params.set("project", p);
        const list = await api.json<IssueList>(`${base(repo)}/issues?${params}`);

        return done({
          issues: list.issues.map((i) => ({ number: i.number, title: i.title, state: i.state, author: i.author, project: i.project, labels: i.labels.map((l) => l.name), assignees: i.assignees, comments: i.comments, updated_at: i.updated_at })),
          counts: list.counts,
          more: list.next_cursor !== null,
        });
      }),
  );

  server.registerTool(
    "write_issue",
    {
      title: "Open or comment on an issue",
      description: "Write to issues as you. action open: a new issue with title and body (Markdown), optionally about one project and linked to branches. action comment: a comment (body, Markdown) on issue number. Answers the issue's number or the comment's id.",
      inputSchema: z.object({
        repository,
        action: z.enum(["open", "comment"]).describe("open a new issue, or comment on one"),
        number: z.number().int().min(1).optional().describe("For comment: the issue's number"),
        title: z.string().min(1).max(256).optional().describe("For open: the title"),
        body: z.string().max(65_536).default("").describe("Markdown"),
        project: z.string().max(100).optional().describe("For open: the project it is about"),
        link: z.array(z.object({ project: z.string(), branch: z.string() })).max(10).optional().describe("For open: branches to link; merging one closes the issue"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ repository: repo, action, number, title, body, project: p, link }) =>
      run(async () => {
        if (action === "comment") {
          if (number === undefined) return failed("comment needs number: the issue to comment on.");

          if (body.trim() === "") return failed("comment needs a body.");
          const c = await api.json<IssueComment>(`${base(repo)}/issues/${number}/comments`, "POST", { body });

          return done({ issue: number, comment: c.id, author: c.author });
        }

        if (!title) return failed("open needs a title.");
        const b: JsonObject = { title, body, project: p, link: link?.map((l) => ({ repo: l.project, branch: l.branch })) };
        const i = await api.json<Issue>(`${base(repo)}/issues`, "POST", b);

        return done({ issue: i.number, title: i.title, state: i.state });
      }),
  );

  server.registerTool(
    "read_artifact",
    {
      title: "Read an artifact",
      description: `An artifact on a branch (a Markdown or HTML document such as a plan or report; branch lists them by id): its versions, the document's text (the newest version unless version is given, cut at ${TEXT_MAX} characters) and its comment threads with replies (open ones by default).`,
      inputSchema: z.object({
        repository,
        artifact: z.string().min(1).max(100).describe("The artifact's id, from branch"),
        version: z.number().int().min(1).optional().describe("A version number; the newest when left out"),
        comments: z.enum(["open", "resolved", "all"]).default("open").describe("Which threads; defaults to open"),
      }),
      annotations: READ,
    },
    ({ repository: repo, artifact, version, comments }) =>
      run(async () => {
        const a = await api.json<ArtifactDetail>(`${base(repo)}/artifacts/${enc(artifact)}`);
        const n = version ?? a.latest.n;

        const [doc, threads] = await Promise.all([
          a.kind === "image" ? null : api.text("GET", `${base(repo)}/artifacts/${enc(artifact)}/versions/${n}/document`),
          api.json<ArtifactThreads>(`${base(repo)}/artifacts/${enc(artifact)}/comments${comments === "all" ? "" : `?state=${comments}`}`),
        ]);

        const text = doc ? clip(doc.text, TEXT_MAX, "the document") : null;
        const uri = artifactUri(repo, a.id, n);

        return done(
          {
            id: a.id,
            name: a.name,
            kind: a.kind,
            title: a.title,
            repository: repo,
            project: a.repo,
            branch: a.branch,
            version: n,
            versions: a.all_versions.map((v) => ({ n: v.n, uploaded_by: v.uploaded_by, created_at: v.created_at })),
            document: text ? text.text : null,
            document_truncated: text?.truncated ?? false,
            note: a.kind === "image" ? "An image: open it in the web." : null,
            threads: threads.threads.map((t) => ({
              id: t.id,
              version: t.version,
              author: t.author,
              body: t.body,
              state: t.state,
              replies: t.replies.map((r) => ({ id: r.id, author: r.author, body: r.body })),
            })),
            comment_counts: threads.counts,
          },
          [{ type: "resource_link", uri, name: `${a.name} v${n}`, mimeType: a.kind === "html" ? "text/html" : "text/markdown" }],
        );
      }),
  );

  server.registerTool(
    "comment_artifact",
    {
      title: "Comment on an artifact",
      description: "Comment on an artifact as you: on the whole document, on a quoted passage (quote: the exact words), or as a reply to a thread (in_reply_to: a comment id from read_artifact). Markdown; @login names a member. The newest version unless version is given.",
      inputSchema: z.object({
        repository,
        artifact: z.string().min(1).max(100).describe("The artifact's id"),
        body: z.string().min(1).max(65_536).describe("Markdown"),
        quote: z.string().min(1).max(2000).optional().describe("The exact words the comment is about"),
        in_reply_to: z.string().min(1).max(100).optional().describe("A thread's comment id, to reply"),
        version: z.number().int().min(1).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ repository: repo, artifact, body, quote, in_reply_to, version }) =>
      run(async () => {
        const b: JsonObject = { body, quote, in_reply_to, version };
        const c = await api.json<ArtifactComment>(`${base(repo)}/artifacts/${enc(artifact)}/comments`, "POST", b);

        return done({ comment: c.id, thread: c.thread, artifact: c.artifact, version: c.version });
      }),
  );

  server.registerTool(
    "session",
    {
      title: "Read a session",
      description: `A recorded agent session (branch lists them by id, s_...): who ran it with which program and models, its branch and commits, and its conversation (prompts, answers, tool calls) from entry \`from\`, cut at ${TEXT_MAX} characters; next_from continues.`,
      inputSchema: z.object({
        repository,
        id: z.string().regex(/^s_[0-9A-HJKMNP-TV-Z]{26}$/).describe("The session's id, s_ and 26 characters"),
        from: z.number().int().min(0).default(0).describe("The entry to start at; 0 is the first"),
      }),
      annotations: READ,
    },
    ({ repository: repo, id, from }) =>
      run(async () => {
        const path = `${base(repo)}/sessions/${enc(id)}`;
        const [s, page] = await Promise.all([api.json<SessionAny>(path), api.maybe<SessionEntries>(`${path}/entries${from ? `?from=${from}` : ""}`)]);

        if (s.state === "deleted") return done({ id: s.id, state: "deleted", deleted_by: s.deleted_by, deleted_at: s.deleted_at });
        const entries: JsonObject[] = [];
        let size = 0;
        let next: number | null = page?.next_cursor ?? null;

        for (const [i, e] of (page?.entries ?? []).entries()) {
          const item: JsonObject = { kind: e.kind, at: e.at, text: e.text, tool: e.tool, input: e.input, result: e.result, ok: e.ok };
          size += JSON.stringify(item).length;

          if (size > TEXT_MAX && entries.length > 0) {
            next = from + i;
            break;
          }

          entries.push(item);
        }

        return done({
          id: s.id,
          state: s.state,
          person: s.person,
          machine: s.machine,
          program: s.program,
          models: s.models.map((m) => m.model),
          project: s.repo,
          branch: s.branch,
          started_at: s.started_at,
          last_at: s.last_at,
          prompts: s.prompts,
          commits: s.commits.map((c) => ({ project: c.repo, sha: c.sha, title: c.title, on_main: c.on_main })),
          entries,
          next_from: next,
        });
      }),
  );

  server.registerTool(
    "launch_agent",
    {
      title: "Launch a cloud agent",
      description: "Start a Pando cloud agent on a branch (made from the default branch if new), acting as you: it works in its own sandbox, pushes to the branch, and can merge as you would. Answers its number and status; its progress shows on the repository's Agents page.",
      inputSchema: z.object({
        repository,
        project,
        branch,
        prompt: z.string().min(1).max(20_000).describe("What the agent should do"),
        model: z.string().max(100).optional().describe("A model the repository offers; its default when left out"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ repository: repo, project: p, branch: name, prompt, model }) =>
      run(async () => {
        const proj = await projectOf(api, repo, p);
        const a = await api.json<AgentSession>(`${base(repo)}/agents`, "POST", { prompt, branch: name, repo: proj, model });

        return done({ agent: a.number, status: a.status, project: a.repo, branch: a.branch, model: a.model, launched_by: a.launched_by });
      }),
  );

  // ── Resources: the whole text the tools cut ──────────────────────────────

  /** A resource's text; the API's refusal (no such file, not a member) is the request's error. */
  const read = async (path: string) => {
    try {
      return await api.text("GET", path);
    } catch (err) {
      if (err instanceof Refusal) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Pando refused (${err.status} ${err.code}): ${err.message}`);
      throw err;
    }
  };

  server.registerResource(
    "file",
    new ResourceTemplate("pando://{owner}/{name}/{project}/{ref}/{+path}", { list: undefined }),
    { title: "A file at a branch or commit", description: "pando://owner/name/project/ref/path: a file's bytes (ref: a branch, tag or sha, its slashes as %2F)" },
    async (uri, v) => {
      const repo = `${v.owner}/${v.name}`;
      const a = await read(`${base(repo)}/repos/${enc(String(v.project))}/files/${String(v.path)}?ref=${enc(decodeURIComponent(String(v.ref)))}`);

      return { contents: [{ uri: uri.href, mimeType: a.type || "text/plain", text: a.text }] };
    },
  );

  server.registerResource(
    "branch_diff",
    new ResourceTemplate("pando-diff://{owner}/{name}/{project}/{branch}", { list: undefined }),
    { title: "A branch's whole diff", description: "pando-diff://owner/name/project/branch: the unified patch against the default branch, up to 8 MiB (the branch's slashes as %2F)", mimeType: "text/x-patch" },
    async (uri, v) => {
      const a = await read(`${branchPath(`${v.owner}/${v.name}`, decodeURIComponent(String(v.project)), decodeURIComponent(String(v.branch)))}/diff?format=patch&max_bytes=${DIFF_RESOURCE_MAX}`);

      return { contents: [{ uri: uri.href, mimeType: "text/x-patch", text: a.text }] };
    },
  );

  server.registerResource(
    "artifact",
    new ResourceTemplate("pando-artifact://{owner}/{name}/{id}/{version}", { list: undefined }),
    { title: "An artifact's document", description: "pando-artifact://owner/name/id/version: the Markdown or HTML of one version, its images written in" },
    async (uri, v) => {
      const a = await read(`${base(`${v.owner}/${v.name}`)}/artifacts/${enc(decodeURIComponent(String(v.id)))}/versions/${enc(String(v.version))}/document`);

      return { contents: [{ uri: uri.href, mimeType: a.type || "text/markdown", text: a.text }] };
    },
  );

  return server;
}
