// The Pando tools: run in the session's object, not the sandbox, through
// Pando's own API with the session's credential. So they need no container
// (the assistant answers questions with them alone), and every call is
// checked by Pando as it would be for the person who launched the agent:
// membership, and merges only through the normal route, with its checks.

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { SessionSpec } from "./protocol";
import { INTERNAL_HOST } from "./sandbox";

/** The most of a file or a diff handed to the model at once; it is told when there is more. */
const TEXT_MAX = 100_000;

interface Answer {
  status: number;
  text: string;
}

interface ApiError {
  error?: { code?: string; message?: string };
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function clip(s: string, what: string): string {
  return s.length <= TEXT_MAX ? s : `${s.slice(0, TEXT_MAX)}\n[${what} cut at ${TEXT_MAX} characters of ${s.length}]`;
}

/** Pando's API as the session's credential sees it. */
export class PandoApi {
  constructor(
    private readonly pando: Fetcher,
    private readonly spec: () => SessionSpec,
  ) {}

  /** The monorepo's API path. */
  base(): string {
    return `/v1/monorepos/${this.spec().monorepo.full}`;
  }

  repo(name?: string): string {
    return `${this.base()}/repos/${encodeURIComponent(name ?? this.spec().repo.name)}`;
  }

  /** Calls Pando with an optional JSON body; a refusal becomes an Error with Pando's code and message, for the model to read. */
  async call(method: string, path: string, json?: string, headers: Record<string, string> = {}): Promise<Answer> {
    const init: RequestInit = { method, headers: { ...headers, authorization: `Bearer ${this.spec().credential.secret}` } };

    if (json !== undefined) {
      init.body = json;
      init.headers = { ...init.headers, "content-type": "application/json" };
    }

    const r = await this.pando.fetch(new Request(`http://${INTERNAL_HOST}${path}`, init));
    const out = { status: r.status, text: await r.text() };

    if (r.ok) return out;
    let why = out.text.slice(0, 2000);

    try {
      // SAFETY: Pando's error bodies are {error: {code, message}} (packages/contract, ErrorBody); a miss falls back to the raw text.
      const e = JSON.parse(out.text) as ApiError;

      if (e.error?.message) why = `${e.error.code ?? "error"}: ${e.error.message}`;
    } catch {}

    throw new Error(`Pando refused (${r.status}) ${why}`);
  }
}

/** How long the merge tool waits before trying again after a 503 (Artifacts busy with other writes to the repo). */
const MERGE_RETRY_MS = [2000, 5000];

/**
 * A merge, tried again after a 503: Pando answers repo_busy when Artifacts is
 * busy with other writes to the repo (a push just landed, another merge), and
 * says to try again. A model may not; an agent's merge right after its push
 * should not fail on that. Any other refusal is the agent's to read.
 */
async function mergeTrying(merge: () => Promise<Answer>): Promise<Answer> {
  for (const wait of MERGE_RETRY_MS) {
    try {
      return await merge();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Pando refused (503)")) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  return merge();
}

const RepoParam = Type.Optional(Type.String({ description: "A project's name; the session's own when left out." }));

export function pandoTools(api: PandoApi, spec: () => SessionSpec): ToolRegistration[] {
  const branchOf = (b?: string) => encodeURIComponent(b ?? spec().branch);

  return [
    defineTool({
      name: "read_file",
      description: "Read a file of the repository at a branch or commit, from Pando (main when ref is left out). For your own unpushed edits, use read in the sandbox.",
      parameters: Type.Object({ path: Type.String({ description: "Path from the project's root" }), ref: Type.Optional(Type.String()), repo: RepoParam }),
      replay: "safe",
      async execute({ path, ref, repo }) {
        const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
        const r = await api.call("GET", `${api.repo(repo)}/files/${path.split("/").map(encodeURIComponent).join("/")}${q}`);

        return text(clip(r.text, path));
      },
    }),
    defineTool({
      name: "list_files",
      description: "List one folder of the repository at a branch or commit, from Pando: folders first, then files.",
      parameters: Type.Object({ path: Type.Optional(Type.String({ description: "A folder; the root when left out" })), ref: Type.Optional(Type.String()), repo: RepoParam }),
      replay: "safe",
      async execute({ path, ref, repo }) {
        const q = new URLSearchParams();

        if (path) q.set("path", path);

        if (ref) q.set("ref", ref);
        const r = await api.call("GET", `${api.repo(repo)}/tree?${q}`);
        // SAFETY: the tree route answers Contract.TreePage; only its entries' names and types are read.
        const page = JSON.parse(r.text) as { entries?: { name: string; type: string }[] };
        const lines = (page.entries ?? []).map((e) => (e.type === "dir" ? `${e.name}/` : e.name));

        return text(lines.join("\n") || "(empty)");
      },
    }),
    defineTool({
      name: "issue",
      description: "Read an issue: its title, state, body and comments.",
      parameters: Type.Object({ number: Type.Integer({ minimum: 1 }) }),
      replay: "safe",
      async execute({ number }) {
        const [issue, timeline] = await Promise.all([
          api.call("GET", `${api.base()}/issues/${number}`),
          api.call("GET", `${api.base()}/issues/${number}/timeline?limit=100`),
        ]);

        // SAFETY: Contract.Issue and Contract.Timeline; only the fields named here are read.
        const i = JSON.parse(issue.text) as { number: number; title: string; state: string; author: string; body: string };
        // SAFETY: as above.
        const t = JSON.parse(timeline.text) as { items?: { kind: string; actor?: string | null; comment?: { body?: string | null; author?: string } | null }[] };
        const comments = (t.items ?? []).flatMap((x) => (x.kind === "comment" && x.comment?.body ? [`--- ${x.comment.author ?? x.actor ?? "someone"}:\n${x.comment.body}`] : []));

        return text(clip([`#${i.number} ${i.title} (${i.state}, opened by ${i.author})`, "", i.body || "(no description)", ...(comments.length ? ["", "Comments:", ...comments] : [])].join("\n"), `issue #${number}`));
      },
    }),
    defineTool({
      name: "branch_diff",
      description: "The branch's changes against main as a unified diff (GitHub's three-dot diff), from what has been pushed. The session's own branch when left out.",
      parameters: Type.Object({ branch: Type.Optional(Type.String()), repo: RepoParam }),
      replay: "safe",
      async execute({ branch, repo }) {
        const r = await api.call("GET", `${api.repo(repo)}/branches/${branchOf(branch)}/diff?format=patch&max_bytes=${TEXT_MAX}`);

        return text(r.text.trim() ? clip(r.text, "the diff") : "(no changes against main)");
      },
    }),
    defineTool({
      name: "comment_issue",
      description: "Comment on an issue, as the person who started you. Markdown.",
      parameters: Type.Object({ number: Type.Integer({ minimum: 1 }), body: Type.String({ minLength: 1 }) }),
      // The key makes a rerun after a crash answer the first comment instead of posting twice.
      replay: "safe",
      async execute({ number, body }, call) {
        const r = await api.call("POST", `${api.base()}/issues/${number}/comments`, JSON.stringify({ body }), { "idempotency-key": `agent-${spec().number}-${call.callId}`.slice(0, 64) });
        // SAFETY: Contract.IssueComment; only its id is read.
        const c = JSON.parse(r.text) as { id?: string };

        return text(`Commented on #${number} (${c.id ?? "posted"}).`);
      },
    }),
    defineTool({
      name: "post_review",
      description: "Post a review on a branch, as the person who started you: a verdict (comment or request_changes), a summary, and optional comments on lines of the diff.",
      parameters: Type.Object({
        branch: Type.Optional(Type.String()),
        repo: RepoParam,
        verdict: Type.Union([Type.Literal("comment"), Type.Literal("request_changes")]),
        body: Type.String(),
        comments: Type.Optional(Type.Array(Type.Object({ path: Type.String(), line: Type.Integer({ minimum: 1 }), side: Type.Optional(Type.Union([Type.Literal("new"), Type.Literal("old")])), body: Type.String() }))),
      }),
      async execute({ branch, repo, verdict, body, comments }) {
        await api.call("POST", `${api.repo(repo)}/branches/${branchOf(branch)}/reviews`, JSON.stringify({ verdict, body, comments: comments ?? [] }));

        return text(`Review posted on ${branch ?? spec().branch} (${verdict}).`);
      },
    }),
    defineTool({
      name: "merge",
      description: "Merge a branch into main through Pando, as the person who started you, with a merge commit. Pando refuses while required checks are red or still running; it is never forced. The session's own branch when left out.",
      parameters: Type.Object({ branch: Type.Optional(Type.String()), repo: RepoParam }),
      async execute({ branch, repo }) {
        const r = await mergeTrying(() => api.call("POST", `${api.repo(repo)}/branches/${branchOf(branch)}/merge`, "{}"));
        // SAFETY: Contract.MergeResult; only these fields are read.
        const m = JSON.parse(r.text) as { status: string; sha?: string; closes?: number[] };
        const closing = m.closes?.length ? `, closing ${m.closes.map((n) => `#${n}`).join(", ")}` : "";

        if (m.status === "up_to_date") return text(`${branch ?? spec().branch} has nothing main lacks; nothing to merge.`);

        return text(`Merged ${branch ?? spec().branch} into main (merge commit ${m.sha?.slice(0, 12) ?? "?"}${closing}).`);
      },
    }),
  ];
}
