// The web's writes. Each is a POST the Worker checks for Pando's own Origin.
import { post, postOrRefused } from "./client";
import type { MonorepoRef } from "./names";
import { ErrorBody, type RepoName, Routes } from "@pando/contract";

/** Ends this browser's session, then WorkOS's (its logout page returns to /). */
export async function signOut(): Promise<void> {
  const out = await post(Routes.logout.response, Routes.logout.path, {});
  location.assign(out.logout_url);
}

/** Writes a root file back as it was at `version`, as a new version every machine receives. */
export const restore = (m: MonorepoRef, path: string, version: number) => {
  const route = Routes.restore(m.owner, m.name);

  return post(route.response, route.path, { path, version, machine: "the web" });
};

/**
 * Merges the branch with a merge commit, exactly at `head` (409 `head_moved`
 * if it moved since the page showed it). `force` goes past red or missing
 * checks. A refusal (conflicts, checks, the head moved) is an answer.
 */
export const merge = (m: MonorepoRef, repo: RepoName, branch: string, head: string, force: boolean) => {
  const route = Routes.mergeBranch(m.owner, m.name, repo, branch, force);

  return postOrRefused(route.response, ErrorBody, route.path, { expected_head: head }, [409, 412]);
};
