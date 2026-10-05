// What each kind of session is told and given. A task or an issue changes
// code on its own branch and merges it; a review reads someone's branch, may
// run its tests, and posts one review, with no tool that writes a file,
// comments elsewhere or merges.

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { SessionSpec } from "./protocol";
import { worktreeDir } from "./sandbox";

/** The spec without the credential's secret: what the prompt may name. */
export type PublicSpec = Omit<SessionSpec, "credential"> & { credential: Omit<SessionSpec["credential"], "secret"> };

/** The Pando tools a review may not use. */
const NOT_IN_A_REVIEW = new Set(["merge", "comment_issue"]);

export function preamble(s: PublicSpec): string {
  const dir = worktreeDir(s.repo.path, s.branch);
  const who = `for ${s.launcher.name} (${s.launcher.login}), who started you. You act as them.`;
  const sandbox = "The sandbox has no internet. It reaches only this repository, through git and the pando command.";

  if (s.kind === "review") {
    return [
      `You are reviewing branch ${s.branch} of ${s.repo.name} in Pando, a git platform, on the repository ${s.monorepo.full}, ${who}`,
      `The branch is checked out at ${dir}, a Linux sandbox. Use read and bash there to read the code and run its tests. Do not change, commit or push anything.`,
      sandbox,
      "Pando's own tools reach the repository on the server: read_file, list_files, issue, branch_diff, post_review.",
      `When you are done, post one review of ${s.branch} with post_review: comment or request_changes, a short summary, and comments on the lines that need them. Then say what you found in a few lines.`,
    ].join("\n");
  }

  return [
    `You are a coding agent working in Pando, a git platform, on the repository ${s.monorepo.full}, ${who}`,
    `Your working folder is ${dir}: branch ${s.branch} of ${s.repo.name}, a Linux sandbox. Use bash, read, write and edit there.`,
    `Commit with git as you go and push the branch after each working step (git push origin ${s.branch}). Main is protected: never push to it.`,
    sandbox,
    "Pando's own tools reach the repository on the server: read_file, list_files, issue, branch_diff, comment_issue, post_review, merge.",
    `When your work is done and pushed, merge ${s.branch} with the merge tool. Pando merges only when the required checks are green; if it refuses, say why and stop.`,
  ].join("\n");
}

/** The sandbox tools and the Pando tools a session of this kind gets. */
export function toolsFor(kind: SessionSpec["kind"], pando: ToolRegistration[]): ToolRegistration[] {
  if (kind === "review") return [createReadTool(), createBashTool(), ...pando.filter((t) => !NOT_IN_A_REVIEW.has(t.name))];

  return [createReadTool(), createBashTool(), createEditTool(), createWriteTool(), ...pando];
}
