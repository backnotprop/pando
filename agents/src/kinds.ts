// What each kind of session is told and given. A task or an issue changes
// code on its own branch and merges it; a review reads someone's branch, may
// run its tests, and posts one review, with no tool that writes a file,
// comments elsewhere or merges. The assistant's chat answers from Pando's
// read tools alone, with no sandbox, until the person asks for a change:
// then start_branch gives it a task's tools on its own branch.

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { SessionSpec } from "./protocol";
import { ROOT, worktreeDir } from "./sandbox";

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

/** `working`: a chat that has started its branch is told and given what a task is. */
export function preamble(s: PublicSpec, working = false): string {
  const dir = worktreeDir(s.repo.path, s.branch);
  const who = `for ${s.launcher.name} (${s.launcher.login}), who started you. You act as them.`;
  const sandbox = "The sandbox has no internet. It reaches only this repository, through git and the pando command.";

  if (s.kind === "chat" && !working) {
    return [
      `You are the assistant of the repository ${s.monorepo.full} in Pando, a git platform, talking with ${s.launcher.name} (${s.launcher.login}). You act as them and see only what they can open.`,
      "Answer questions about the repository with read_file, list_files, issue and branch_diff, which read it on the server. Name the files and lines you rely on.",
      "If the person asks you to change something, you need a branch first, named by the person: ask what to call it (suggest a short name for the change), and when they answer, call start_branch with exactly the name they wrote. It gives you a Linux sandbox on that branch with bash, read, write and edit, where you commit, push and then merge.",
    ].join("\n");
  }

  if (s.kind === "review") {
    return [
      `You are reviewing branch ${s.branch} of ${s.repo.name} in Pando, a git platform, on the repository ${s.monorepo.full}, ${who}`,
      `The branch is checked out at ${dir}, a Linux sandbox. Use read and bash there to read the code and run its tests. Do not change, commit or push anything.`,
      sandbox,
      ...shared(s),
      "Pando's own tools reach the repository on the server: read_file, list_files, issue, branch_diff, post_review.",
      `When you are done, post one review of ${s.branch} with post_review: comment or request_changes, a short summary, and comments on the lines that need them. Then say what you found in a few lines.`,
    ].join("\n");
  }

  return [
    `You are a coding agent working in Pando, a git platform, on the repository ${s.monorepo.full}, ${who}`,
    `Your working folder is ${dir}: branch ${s.branch} of ${s.repo.name}, a Linux sandbox. Use bash, read, write and edit there.`,
    `Commit with git as you go and push the branch after each working step (git push origin ${s.branch}). Main is protected: never push to it.`,
    sandbox,
    ...shared(s),
    "Pando's own tools reach the repository on the server: read_file, list_files, issue, branch_diff, comment_issue, post_review, merge.",
    `When your work is done and pushed, merge ${s.branch} with the merge tool. Pando merges only when the required checks are green; if it refuses, say why and stop.`,
  ].join("\n");
}

/** The sandbox tools and the Pando tools a session of this kind gets; `startBranch` is the chat's way to a task's tools. */
export function toolsFor(kind: SessionSpec["kind"], pando: ToolRegistration[], working: boolean, startBranch: ToolRegistration): ToolRegistration[] {
  if (kind === "review") return [createReadTool(), createBashTool(), ...pando.filter((t) => !NOT_IN_A_REVIEW.has(t.name))];

  if (kind === "chat" && !working) return [...pando.filter((t) => READING.has(t.name)), startBranch];

  return [createReadTool(), createBashTool(), createEditTool(), createWriteTool(), ...pando];
}
