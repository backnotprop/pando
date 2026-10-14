// What each kind of session is told and given. A task or an issue changes
// code on its own branch and merges it; a review reads someone's branch, may
// run its tests, and posts one review, with no tool that writes a file,
// comments elsewhere or merges. The assistant's chat answers from Pando's
// read tools alone, with no sandbox, until the person asks for a change:
// then start_branch gives it a task's tools on its own branch.

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { Project, SessionSpec } from "./protocol";
import { ROOT, workDir } from "./sandbox";

/** The spec without the credential's secret: what the prompt may name. */
export type PublicSpec = Omit<SessionSpec, "credential"> & { credential: Omit<SessionSpec["credential"], "secret"> };

/** The Pando tools a review may not use. */
const NOT_IN_A_REVIEW = new Set(["merge", "comment_issue"]);

/** The Pando tools a chat answers questions with. */
const READING = new Set(["read_file", "list_files", "issue", "branch_diff"]);

/** A monorepo's shared files in the sandbox, kept live by pando sync (container/sync.sh). */
function shared(s: PublicSpec): string[] {
  if (s.monorepo.kind !== "monorepo") return [];

  return [`The repository's shared files (every file outside projects/: plans, decisions, notes) are in ${ROOT}, live: what people save there reaches you within seconds, and what you save there reaches them and is committed.`];
}

const named = (ps: Project[]) => ps.map((p) => `${p.name} (${p.path})`).join(", ");

/**
 * A chat's lines on what it reads, in a monorepo with more than one project:
 * the whole repository (no project chosen) or the project the person chose.
 */
function chatScope(s: PublicSpec): string[] {
  const projects = s.projects ?? [];

  if (projects.length < 2) return [];

  if (s.repo === null) {
    return [
      `The person asked about the repository as a whole. Its projects: ${named(projects)}.`,
      "With repo left out, read_file and list_files read the repository's shared files (everything outside projects/: plans, decisions, notes). Give repo, a project's name, to read that project; branch_diff needs one.",
    ];
  }

  const own = s.repo.name;

  return [`The person chose the project ${own} (${s.repo.path}): read_file, list_files and branch_diff read it when repo is left out. The other projects, read with repo: ${named(projects.filter((p) => p.name !== own))}.`];
}

/** `working`: a chat that has started its branch is told and given what a task is. */
export function preamble(s: PublicSpec, working = false): string {
  const dir = workDir(s);
  // A review, a task and a working chat always have a project; a chat about the whole repository has none until start_branch.
  const project = s.repo?.name ?? "the repository";
  const who = `for ${s.launcher.name} (${s.launcher.login}), who started you. You act as them.`;
  const sandbox = "The sandbox has no internet. It reaches only this repository, through git and the pando command.";

  if (s.kind === "chat" && !working) {
    return [
      `You are the assistant of the repository ${s.monorepo.full} in Pando, a git platform, talking with ${s.launcher.name} (${s.launcher.login}). You act as them and see only what they can open.`,
      "Answer questions about the repository with read_file, list_files, issue and branch_diff, which read it on the server. Name the files and lines you rely on.",
      ...chatScope(s),
      `If the person asks you to change something, you need a branch first, named by the person: ask what to call it (suggest a short name for the change), and when they answer, call start_branch with exactly the name they wrote${s.repo === null ? ", and repo, the project the change belongs in" : ""}. It gives you a Linux sandbox on that branch with bash, read, write and edit, where you commit, push and then merge.`,
    ].join("\n");
  }

  if (s.kind === "understand") {
    return [
      `You build an Understand page in Pando, a git platform, for ${s.launcher.name} (${s.launcher.login}) on the repository ${s.monorepo.full}: a page that answers their question about the code from Pando's records. You act as them and see only what they can open.`,
      "Investigate with blame, history, commit, search_shared (the shared files: plans, decisions, notes), search_sessions (what people asked their agents), issue, read_file and list_files. Each lookup answers the sources it found, each with an id: r1, r2. Pando has already run a first pass; its sources are in the question.",
      "Write the answer with place: two to four short paragraphs of plain sentences. Cite the sources each sentence rests on inline as [r1]: the page shows that source's name there and its record under the paragraph. Cite only ids the lookups gave you, and never state a fact no source shows.",
      "Say who decided, when and why, in the words of the records. When the code goes against a decision or a prompt, say so in one sentence, citing both. When no source explains what was asked, place one block of type nothing saying what you checked; do not guess.",
      "The page is the answer: after placing it, reply with one short line.",
      ...chatScope(s),
    ].join("\n");
  }

  if (s.kind === "review") {
    return [
      `You are reviewing branch ${s.branch} of ${project} in Pando, a git platform, on the repository ${s.monorepo.full}, ${who}`,
      `The branch is checked out at ${dir}, a Linux sandbox. Use read and bash there to read the code and run its tests. Do not change, commit or push anything.`,
      sandbox,
      ...shared(s),
      "Pando's own tools reach the repository on the server: read_file, list_files, issue, branch_diff, post_review.",
      `When you are done, post one review of ${s.branch} with post_review: comment or request_changes, a short summary, and comments on the lines that need them. Then say what you found in a few lines.`,
    ].join("\n");
  }

  return [
    `You are a coding agent working in Pando, a git platform, on the repository ${s.monorepo.full}, ${who}`,
    `Your working folder is ${dir}: branch ${s.branch} of ${project}, a Linux sandbox. Use bash, read, write and edit there.`,
    `Commit with git as you go and push the branch after each working step (git push origin ${s.branch}). Main is protected: never push to it.`,
    sandbox,
    ...shared(s),
    "Pando's own tools reach the repository on the server: read_file, list_files, issue, branch_diff, comment_issue, post_review, merge.",
    `When your work is done and pushed, merge ${s.branch} with the merge tool. Pando merges only when the required checks are green and the review its risk calls for is done; if it refuses, say why and stop.`,
  ].join("\n");
}

/** The sandbox tools and the Pando tools a session of this kind gets; `startBranch` is the chat's way to a task's tools; `understand` an Understand page's lookups and place. */
export function toolsFor(kind: SessionSpec["kind"], pando: ToolRegistration[], working: boolean, startBranch: ToolRegistration, understand: ToolRegistration[] = []): ToolRegistration[] {
  if (kind === "understand") return [...pando.filter((t) => t.name === "read_file" || t.name === "list_files"), ...understand];

  if (kind === "review") return [createReadTool(), createBashTool(), ...pando.filter((t) => !NOT_IN_A_REVIEW.has(t.name))];

  if (kind === "chat" && !working) return [...pando.filter((t) => READING.has(t.name)), startBranch];

  return [createReadTool(), createBashTool(), createEditTool(), createWriteTool(), ...pando];
}
